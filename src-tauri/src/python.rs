//! Tauri IPC bridge for the OS-native sandboxed Python REPL.
//!
//! Security boundaries:
//! - Every command enforces `ensure_main_webview(&webview)` so embedded browser
//!   and preview sub-webviews can never execute Python.
//! - Each chat session gets an isolated `0700` scratch workspace that is deleted
//!   on reset, session switch, or app exit.
//! - Staged `present_file()` outputs are canonicalized and verified to stay
//!   strictly inside the session workspace before Rust reads them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

use crate::browser::ensure_main_webview;
use crate::python_runtime::{
    ManagedPythonStatus, ensure_managed_python, is_managed_venv_ready, managed_python_status,
    reset_managed_python,
};
use crate::python_sandbox::{SandboxConfig, SandboxedWorker, StagedFile};

const PHASE_EVENT: &str = "python://phase";
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_PRESENTED_FILES: usize = 10;
const MAX_PRESENTED_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_UPLOAD_FILES: usize = 50;
const MAX_UPLOAD_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES: u64 = 250 * 1024 * 1024;
const INTERRUPT_ESCALATION_MS: u64 = 600;

struct ActiveWorker {
    session_id: Option<String>,
    worker: SandboxedWorker,
    workspace_dir: PathBuf,
}

impl Drop for ActiveWorker {
    fn drop(&mut self) {
        self.worker.kill();
        let _ = std::fs::remove_dir_all(&self.workspace_dir);
    }
}

struct SessionUploads {
    session_id: Option<String>,
    dir: PathBuf,
    files: HashMap<String, String>,
    used_names: HashSet<String>,
    total_bytes: u64,
}

impl SessionUploads {
    fn create(session_id: Option<String>, dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create uploads dir: {e}"))?;
        let canonical =
            std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize uploads dir: {e}"))?;
        set_dir_mode(&canonical, 0o500)?;
        Ok(Self {
            session_id,
            dir: canonical,
            files: HashMap::new(),
            used_names: HashSet::new(),
            total_bytes: 0,
        })
    }

    fn stage(&mut self, file_id: &str, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
        if let Some(existing) = self.files.get(file_id) {
            return Ok(existing.clone());
        }
        let size = bytes.len() as u64;
        if size > MAX_UPLOAD_FILE_BYTES {
            return Err(format!(
                "uploaded file {raw_name} exceeds the 50 MB sandbox limit"
            ));
        }
        if self.files.len() >= MAX_UPLOAD_FILES {
            return Err(format!(
                "at most {MAX_UPLOAD_FILES} uploaded files can be mounted per session"
            ));
        }
        if self.total_bytes.saturating_add(size) > MAX_UPLOAD_TOTAL_BYTES {
            return Err("total mounted upload size exceeds the 250 MB session limit".into());
        }

        let sanitized = sanitize_upload_name(raw_name);
        let mounted_name = dedupe_upload_name(&sanitized, &mut self.used_names);
        let target = self.dir.join(&mounted_name);

        // Temporarily make directory writable while placing the read-only file.
        set_dir_mode(&self.dir, 0o700)?;
        let write_result = (|| -> Result<(), String> {
            std::fs::write(&target, bytes)
                .map_err(|e| format!("write upload {}: {e}", target.display()))?;
            set_file_mode(&target, 0o400)?;
            Ok(())
        })();
        let _ = set_dir_mode(&self.dir, 0o500);
        write_result?;

        self.total_bytes = self.total_bytes.saturating_add(size);
        self.files.insert(file_id.to_string(), mounted_name.clone());
        Ok(mounted_name)
    }
}

impl Drop for SessionUploads {
    fn drop(&mut self) {
        let _ = set_dir_mode(&self.dir, 0o700);
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let _ = set_file_mode(&entry.path(), 0o600);
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn set_dir_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    set_dir_mode(path, mode)
}

fn sanitize_upload_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.');
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    }
}

fn dedupe_upload_name(name: &str, used: &mut HashSet<String>) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, Some(e)),
        _ => (name, None),
    };
    let mut n = 2u32;
    loop {
        let candidate = match ext {
            Some(e) => format!("{stem}_{n}.{e}"),
            None => format!("{stem}_{n}"),
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

struct PythonManager {
    worker: Mutex<Option<ActiveWorker>>,
    uploads: Mutex<Option<SessionUploads>>,
    active_pgid: AtomicI32,
    run_seq: AtomicU64,
    workspace_seq: AtomicU64,
}

impl Default for PythonManager {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
            uploads: Mutex::new(None),
            active_pgid: AtomicI32::new(0),
            run_seq: AtomicU64::new(0),
            workspace_seq: AtomicU64::new(1),
        }
    }
}

#[derive(Default)]
pub struct PythonState {
    manager: Arc<PythonManager>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentedFilePayload {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRunResponse {
    pub stdout: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub interrupted: bool,
    pub restarted: bool,
    pub images: Vec<String>,
    pub dropped: u64,
    pub files: Vec<PresentedFilePayload>,
}

#[derive(Debug, Clone)]
struct ResolvedPython {
    executable: PathBuf,
    read_only_paths: Vec<PathBuf>,
}

fn candidate_python_binaries(app_data_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(env_py) = std::env::var("DEEPSEEK_PYTHON") {
        let trimmed = env_py.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }
    if let Some(dir) = app_data_dir {
        candidates.push(dir.join("python").join("venv").join("bin").join("python3"));
        candidates.push(dir.join("python").join("bin").join("python3"));
    }
    candidates.push(PathBuf::from("python3"));
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
        candidates.push(PathBuf::from("/usr/bin/python3"));
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
    }
    candidates
}

fn probe_python_binary(candidate: &Path) -> Option<ResolvedPython> {
    // Use `sys.executable` (not realpath) so venv symlinks preserve `pyvenv.cfg` discovery,
    // while including the realpath prefixes in `read_only_paths`.
    let output = Command::new(candidate)
        .args([
            "-s",
            "-c",
            "import sys, os; print(os.path.join(os.path.realpath(os.path.dirname(sys.executable)), os.path.basename(sys.executable))); print(os.path.realpath(sys.prefix)); print(os.path.realpath(sys.base_prefix))",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let mut lines = text.lines();
    let exe = PathBuf::from(lines.next()?.trim());
    if !exe.is_file() {
        return None;
    }
    let mut ro = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            ro.push(PathBuf::from(trimmed));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for dir in [
            "/opt/homebrew/opt",
            "/opt/homebrew/Cellar",
            "/usr/local/opt",
        ] {
            let p = PathBuf::from(dir);
            if p.exists() {
                ro.push(p);
            }
        }
    }
    Some(ResolvedPython {
        executable: exe,
        read_only_paths: ro,
    })
}

fn resolve_python_runtime(app_data_dir: Option<&Path>) -> Result<ResolvedPython, String> {
    if let Ok(env_py) = std::env::var("DEEPSEEK_PYTHON") {
        let trimmed = env_py.trim();
        if !trimmed.is_empty() {
            if let Some(resolved) = probe_python_binary(Path::new(trimmed)) {
                return Ok(resolved);
            }
            return Err(format!(
                "DEEPSEEK_PYTHON={trimmed} is not a usable Python 3 interpreter"
            ));
        }
    }

    let mut provision_err: Option<String> = None;
    if let Some(dir) = app_data_dir {
        match ensure_managed_python(dir) {
            Ok(managed_py) => {
                if let Some(resolved) = probe_python_binary(&managed_py) {
                    return Ok(resolved);
                }
                provision_err = Some(format!(
                    "Managed Python at {} failed to start",
                    managed_py.display()
                ));
            }
            Err(err) => {
                log::warn!(
                    "Managed Python provisioning failed, falling back to system Python: {err}"
                );
                provision_err = Some(err);
            }
        }
    }

    for candidate in candidate_python_binaries(app_data_dir) {
        if let Some(resolved) = probe_python_binary(&candidate) {
            return Ok(resolved);
        }
    }

    match provision_err {
        Some(err) => Err(format!(
            "Failed to provision managed Python ({err}) and no system Python 3 was found."
        )),
        None => Err(
            "No usable Python 3 interpreter was found on this machine. Install Python 3 or set DEEPSEEK_PYTHON."
                .into(),
        ),
    }
}

fn read_staged_files(
    workspace_dir: &Path,
    staged: &[StagedFile],
) -> Result<Vec<PresentedFilePayload>, String> {
    let canonical_ws = std::fs::canonicalize(workspace_dir)
        .map_err(|e| format!("canonicalize workspace dir: {e}"))?;
    let mut files = Vec::with_capacity(staged.len().min(MAX_PRESENTED_FILES));
    for entry in staged.iter().take(MAX_PRESENTED_FILES) {
        let path = Path::new(&entry.staged_path);
        let canonical =
            std::fs::canonicalize(path).map_err(|e| format!("staged file {}: {e}", entry.name))?;
        if !canonical.starts_with(&canonical_ws) {
            return Err(format!(
                "staged file {} resolves outside the sandbox workspace",
                entry.name
            ));
        }
        let meta = std::fs::metadata(&canonical)
            .map_err(|e| format!("stat staged file {}: {e}", entry.name))?;
        if !meta.is_file() {
            return Err(format!("staged file {} is not a regular file", entry.name));
        }
        if meta.len() > MAX_PRESENTED_FILE_BYTES {
            return Err(format!(
                "staged file {} exceeds the 50 MB limit",
                entry.name
            ));
        }
        let bytes = std::fs::read(&canonical)
            .map_err(|e| format!("read staged file {}: {e}", entry.name))?;
        files.push(PresentedFilePayload {
            name: entry.name.clone(),
            mime_type: entry.mime_type.clone(),
            data_base64: BASE64.encode(bytes),
        });
    }
    Ok(files)
}

fn allocate_workspace_dir(manager: &PythonManager) -> PathBuf {
    let seq = manager.workspace_seq.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("deepseek-python-{}-{}", std::process::id(), seq))
}

fn allocate_uploads_dir(manager: &PythonManager) -> PathBuf {
    let seq = manager.workspace_seq.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "deepseek-python-uploads-{}-{}",
        std::process::id(),
        seq
    ))
}

fn ensure_session_uploads_dir(
    manager: &PythonManager,
    session_id: &Option<String>,
) -> Result<PathBuf, String> {
    let mut uploads_guard = manager
        .uploads
        .lock()
        .map_err(|_| "python uploads lock poisoned".to_string())?;
    let needs_reset = match (&*uploads_guard, session_id) {
        (Some(existing), Some(sid)) => existing.session_id.as_deref() != Some(sid.as_str()),
        _ => false,
    };
    if needs_reset {
        uploads_guard.take();
    }
    if let Some(existing) = uploads_guard.as_mut() {
        if existing.session_id.is_none() && session_id.is_some() {
            existing.session_id = session_id.clone();
        }
        return Ok(existing.dir.clone());
    }
    let dir = allocate_uploads_dir(manager);
    let created = SessionUploads::create(session_id.clone(), dir)?;
    let path = created.dir.clone();
    *uploads_guard = Some(created);
    Ok(path)
}

fn decode_header(request: &Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .filter(|v| !v.is_empty())
}

/// Stages a user-attached chat file into the session's read-only `uploads/` directory.
///
/// The body is raw file bytes; metadata arrives in `x-session-id`, `x-file-id`, and
/// `x-file-name` (percent-encoded). Returns the sanitized filename mounted inside `uploads/`.
#[tauri::command]
pub async fn python_stage_upload(
    webview: Webview,
    state: State<'_, PythonState>,
    request: Request<'_>,
) -> Result<String, String> {
    ensure_main_webview(&webview)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("python_stage_upload expects raw file bytes in the request body".into());
    };
    let bytes = bytes.clone();
    let session_id = decode_header(&request, "x-session-id");
    let file_id = decode_header(&request, "x-file-id")
        .ok_or_else(|| "python_stage_upload requires x-file-id header".to_string())?;
    let file_name = decode_header(&request, "x-file-name").unwrap_or_else(|| "file".to_string());
    let manager = Arc::clone(&state.manager);

    tauri::async_runtime::spawn_blocking(move || {
        let mut uploads_guard = manager
            .uploads
            .lock()
            .map_err(|_| "python uploads lock poisoned".to_string())?;
        let needs_reset = match (&*uploads_guard, &session_id) {
            (Some(existing), Some(sid)) => existing.session_id.as_deref() != Some(sid.as_str()),
            _ => false,
        };
        if needs_reset {
            uploads_guard.take();
        }
        if uploads_guard.is_none() {
            let dir = allocate_uploads_dir(&manager);
            *uploads_guard = Some(SessionUploads::create(session_id.clone(), dir)?);
        } else if let Some(existing) = uploads_guard.as_mut()
            && existing.session_id.is_none()
            && session_id.is_some()
        {
            existing.session_id = session_id.clone();
        }
        uploads_guard
            .as_mut()
            .expect("session uploads initialized")
            .stage(&file_id, &file_name, &bytes)
    })
    .await
    .map_err(|e| format!("python stage upload panicked: {e}"))?
}

#[tauri::command]
pub async fn python_run(
    app: AppHandle,
    webview: Webview,
    state: State<'_, PythonState>,
    code: String,
    session_id: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<PythonRunResponse, String> {
    ensure_main_webview(&webview)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let manager = Arc::clone(&state.manager);
    let app_data_dir = app.path().app_data_dir().ok();

    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = manager
            .worker
            .lock()
            .map_err(|_| "python worker lock poisoned".to_string())?;

        // Isolate sessions: switch resets the previous session's kernel and workspace.
        let needs_switch = match (&*guard, &session_id) {
            (Some(active), Some(sid)) => active.session_id.as_deref() != Some(sid.as_str()),
            _ => false,
        };
        if needs_switch {
            guard.take();
        }

        if guard.is_none() {
            let has_env_override = std::env::var("DEEPSEEK_PYTHON")
                .ok()
                .is_some_and(|v| !v.trim().is_empty());
            let needs_install = !has_env_override
                && app_data_dir
                    .as_deref()
                    .is_some_and(|dir| !is_managed_venv_ready(dir));
            let _ = app.emit(
                PHASE_EVENT,
                if needs_install {
                    "installing"
                } else {
                    "starting"
                },
            );
            let runtime = resolve_python_runtime(app_data_dir.as_deref())?;
            if needs_install {
                let _ = app.emit(PHASE_EVENT, "starting");
            }
            let workspace_dir = allocate_workspace_dir(&manager);
            let uploads_dir = ensure_session_uploads_dir(&manager, &session_id)?;
            let mut config = SandboxConfig::new(runtime.executable, workspace_dir.clone());
            config.read_only_paths = runtime.read_only_paths;
            config.uploads_dir = Some(uploads_dir);
            let worker = SandboxedWorker::spawn(config)?;
            let canonical_ws = worker.workspace_dir().to_path_buf();
            *guard = Some(ActiveWorker {
                session_id: session_id.clone(),
                worker,
                workspace_dir: canonical_ws,
            });
        } else if let Some(active) = guard.as_mut()
            && active.session_id.is_none()
            && session_id.is_some()
        {
            active.session_id = session_id.clone();
        }

        let _ = app.emit(PHASE_EVENT, "running");

        let seq = manager.run_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let pgid = guard.as_ref().map(|a| a.worker.pgid()).unwrap_or(0);
        manager.active_pgid.store(pgid, Ordering::SeqCst);

        let result = {
            let active = guard.as_mut().expect("worker initialized");
            active.worker.run_cell(&code, timeout)
        };

        // Clear active_pgid only if we are still the current run.
        if manager.run_seq.load(Ordering::SeqCst) == seq {
            manager.active_pgid.store(0, Ordering::SeqCst);
        }

        match result {
            Ok(outcome) => {
                let workspace_dir = guard
                    .as_ref()
                    .map(|a| a.workspace_dir.clone())
                    .unwrap_or_default();
                let files = read_staged_files(&workspace_dir, &outcome.files)?;
                Ok(PythonRunResponse {
                    stdout: outcome.stdout,
                    result: outcome.result,
                    error: outcome.error,
                    interrupted: outcome.interrupted,
                    restarted: false,
                    images: outcome.images,
                    dropped: outcome.dropped,
                    files,
                })
            }
            Err(err) => {
                // Worker timed out, crashed, or was SIGKILL'd: drop & clean up workspace.
                guard.take();
                Ok(PythonRunResponse {
                    stdout: String::new(),
                    result: None,
                    error: Some(err),
                    interrupted: false,
                    restarted: true,
                    images: Vec::new(),
                    dropped: 0,
                    files: Vec::new(),
                })
            }
        }
    })
    .await
    .map_err(|e| format!("python task panicked: {e}"))?
}

#[tauri::command]
pub async fn python_interrupt(
    webview: Webview,
    state: State<'_, PythonState>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let manager = Arc::clone(&state.manager);
    let pgid = manager.active_pgid.load(Ordering::SeqCst);
    let seq = manager.run_seq.load(Ordering::SeqCst);
    if pgid <= 0 {
        return Ok(());
    }

    #[cfg(unix)]
    unsafe {
        libc::kill(-pgid, libc::SIGINT);
    }

    // If the cell is stuck in a C extension that ignores SIGINT, escalate to SIGKILL.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(INTERRUPT_ESCALATION_MS));
        if manager.run_seq.load(Ordering::SeqCst) == seq
            && manager.active_pgid.load(Ordering::SeqCst) == pgid
        {
            #[cfg(unix)]
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn python_reset(webview: Webview, state: State<'_, PythonState>) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let manager = Arc::clone(&state.manager);

    // Unblock any running cell immediately before taking the worker mutex.
    let pgid = manager.active_pgid.swap(0, Ordering::SeqCst);
    if pgid > 0 {
        #[cfg(unix)]
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut guard) = manager.worker.lock() {
            guard.take();
        }
        if let Ok(mut uploads) = manager.uploads.lock() {
            uploads.take();
        }
    })
    .await
    .map_err(|e| format!("python reset panicked: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn python_runtime_status(
    app: AppHandle,
    webview: Webview,
) -> Result<ManagedPythonStatus, String> {
    ensure_main_webview(&webview)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || managed_python_status(&dir))
        .await
        .map_err(|e| format!("python runtime status panicked: {e}"))
}

#[tauri::command]
pub async fn python_runtime_reset(
    app: AppHandle,
    webview: Webview,
    state: State<'_, PythonState>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let manager = Arc::clone(&state.manager);

    let pgid = manager.active_pgid.swap(0, Ordering::SeqCst);
    if pgid > 0 {
        #[cfg(unix)]
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut guard) = manager.worker.lock() {
            guard.take();
        }
        reset_managed_python(&dir)
    })
    .await
    .map_err(|e| format!("python runtime reset panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_python_runtime_finds_interpreter() {
        let resolved = resolve_python_runtime(None).expect("python3 should resolve");
        assert!(resolved.executable.is_file());
        assert!(!resolved.read_only_paths.is_empty());
    }

    #[test]
    fn sanitize_and_dedupe_upload_names() {
        assert_eq!(sanitize_upload_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_upload_name("a/b/c.csv"), "c.csv");
        assert_eq!(sanitize_upload_name(".."), "file");
        assert_eq!(sanitize_upload_name(".env"), "env");

        let mut used = HashSet::new();
        assert_eq!(dedupe_upload_name("data.csv", &mut used), "data.csv");
        assert_eq!(dedupe_upload_name("data.csv", &mut used), "data_2.csv");
        assert_eq!(dedupe_upload_name("data.csv", &mut used), "data_3.csv");
        assert_eq!(dedupe_upload_name("README", &mut used), "README");
        assert_eq!(dedupe_upload_name("README", &mut used), "README_2");
    }

    #[test]
    fn session_uploads_enforces_read_only_and_idempotency() {
        let dir =
            std::env::temp_dir().join(format!("deepseek-uploads-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let canonical_dir = {
            let mut uploads = SessionUploads::create(Some("s1".into()), dir.clone()).unwrap();
            let first = uploads
                .stage("id-1", "../report.csv", b"a,b\n1,2\n")
                .unwrap();
            assert_eq!(first, "report.csv");
            // Same file_id is idempotent and does not duplicate or double-count bytes.
            let again = uploads
                .stage("id-1", "../report.csv", b"a,b\n1,2\n")
                .unwrap();
            assert_eq!(again, "report.csv");
            assert_eq!(uploads.total_bytes, 8);

            // Different file_id with same filename gets deduplicated.
            let second = uploads.stage("id-2", "report.csv", b"x,y\n").unwrap();
            assert_eq!(second, "report_2.csv");
            assert_eq!(uploads.total_bytes, 12);

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let dir_mode = std::fs::metadata(&uploads.dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(dir_mode, 0o500);
                let file_mode = std::fs::metadata(uploads.dir.join("report.csv"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(file_mode, 0o400);
            }
            uploads.dir.clone()
        };
        // Drop removes the read-only directory cleanly.
        assert!(!canonical_dir.exists());
    }

    #[test]
    fn read_staged_files_rejects_escape_outside_workspace() {
        let base =
            std::env::temp_dir().join(format!("deepseek-staged-test-{}", std::process::id()));
        let ws = base.join("ws");
        let outside = base.join("outside.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(&outside, b"secret").unwrap();

        let staged = vec![StagedFile {
            name: "outside.txt".into(),
            mime_type: "text/plain".into(),
            staged_path: outside.to_string_lossy().into_owned(),
            size: 6,
        }];
        let err = read_staged_files(&ws, &staged).unwrap_err();
        assert!(err.contains("outside the sandbox workspace"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[ignore = "downloads managed python-build-standalone and scientific wheels"]
    fn managed_runtime_end_to_end_matplotlib_and_sandbox() {
        let app_data =
            std::env::temp_dir().join(format!("deepseek-py-e2e-appdata-{}", std::process::id()));
        let ws = std::env::temp_dir().join(format!("deepseek-py-e2e-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&app_data).unwrap();

        // Place a simulated API key in app_data_dir (parent of app_data_dir/python/).
        let api_key_file = app_data.join("api-key");
        std::fs::write(&api_key_file, "sk-must-not-be-readable").unwrap();
        let canonical_api_key = std::fs::canonicalize(&api_key_file).unwrap();

        let runtime = resolve_python_runtime(Some(&app_data))
            .expect("managed python runtime should provision and resolve");
        assert!(
            runtime
                .executable
                .starts_with(std::fs::canonicalize(&app_data).unwrap().join("python")),
            "expected managed python inside app_data/python, got {}",
            runtime.executable.display()
        );

        let mut cfg = SandboxConfig::new(runtime.executable, ws.clone());
        cfg.read_only_paths = runtime.read_only_paths;
        let mut worker =
            SandboxedWorker::spawn(cfg).expect("managed sandboxed worker should start");

        let code = format!(
            r#"
import numpy as np
import pandas as pd
import scipy.stats as stats
import matplotlib.pyplot as plt
from PIL import Image

df = pd.DataFrame({{'x': np.linspace(0, 10, 50), 'y': np.linspace(0, 10, 50) * 2.5 + 1.0}})
reg = stats.linregress(df['x'], df['y'])

fig, ax = plt.subplots(figsize=(5, 3))
ax.plot(df['x'], df['y'], label='linear')
ax.set_title('Sandbox Matplotlib Smoke Test')
ax.set_xlabel('x')
ax.set_ylabel('y')
ax.legend()

# Confirm app_data_dir/api-key is NOT readable even though app_data_dir/python/ is.
api_key_err = None
try:
    with open({api_key:?}, 'r') as f:
        f.read()
except OSError as e:
    api_key_err = type(e).__name__

(round(float(reg.slope), 4), api_key_err)
"#,
            api_key = canonical_api_key.to_string_lossy()
        );

        let outcome = worker
            .run_cell(&code, Duration::from_secs(60))
            .expect("matplotlib cell should run");
        assert_eq!(outcome.error, None, "cell error: {:?}", outcome.error);
        assert_eq!(
            outcome.result.as_deref(),
            Some("(2.5, 'PermissionError')"),
            "unexpected result: {:?}",
            outcome.result
        );
        assert_eq!(
            outcome.images.len(),
            1,
            "expected 1 auto-captured matplotlib figure"
        );
        assert!(outcome.images[0].starts_with("data:image/jpeg;base64,"));
        assert!(
            outcome.images[0].len() > 2000,
            "expected non-trivial rendered JPEG, got {} bytes",
            outcome.images[0].len()
        );

        drop(worker);
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
