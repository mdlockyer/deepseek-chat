//! OS-native sandboxed CPython REPL worker for macOS (Seatbelt) and Linux
//! (Landlock LSM + seccomp-bpf + setrlimit).
//!
//! Each session owns a single persistent sandboxed Python process communicating
//! over dedicated control pipes (FD 3 for requests, FD 4 for responses) so raw
//! stdout/stderr never corrupt the JSON-line RPC stream.

use std::collections::BTreeSet;
use std::fs::{File, Permissions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const WORKER_SCRIPT: &str = include_str!("python_worker.py");
const REQ_FD: i32 = 3;
const RESP_FD: i32 = 4;

#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// Canonical path to the CPython executable.
    pub python_executable: PathBuf,
    /// Additional read-only paths (e.g. Python prefix, venv, shared libs, read-only uploads).
    pub read_only_paths: Vec<PathBuf>,
    /// Per-session scratch workspace directory (read-write, `0700`).
    pub workspace_dir: PathBuf,
    /// Optional per-session read-only uploads directory, symlinked as `workspace_dir/uploads`.
    pub uploads_dir: Option<PathBuf>,
    /// Maximum single file size writable inside the sandbox (`RLIMIT_FSIZE`).
    pub max_file_size_bytes: u64,
    /// Maximum number of open file descriptors (`RLIMIT_NOFILE`).
    pub max_open_files: u64,
    /// Maximum resident set size (RSS) in bytes before the watchdog terminates the worker (`0` disables).
    pub max_rss_bytes: u64,
    /// Startup handshake timeout.
    pub startup_timeout: Duration,
}

impl SandboxConfig {
    pub fn new(python_executable: PathBuf, workspace_dir: PathBuf) -> Self {
        Self {
            python_executable,
            read_only_paths: Vec::new(),
            workspace_dir,
            uploads_dir: None,
            max_file_size_bytes: 100 * 1024 * 1024,
            max_open_files: 256,
            max_rss_bytes: 2 * 1024 * 1024 * 1024,
            startup_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub name: String,
    pub mime_type: String,
    pub staged_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CellOutcome {
    pub stdout: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub interrupted: bool,
    pub images: Vec<String>,
    pub dropped: u64,
    pub files: Vec<StagedFile>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WorkerMessage {
    Ready {
        #[allow(dead_code)]
        pid: u32,
    },
    Result {
        id: u64,
        stdout: String,
        result: Option<String>,
        error: Option<String>,
        interrupted: bool,
        images: Vec<String>,
        dropped: u64,
        files: Vec<StagedFile>,
    },
}

#[derive(Debug, Serialize)]
struct CellRequest<'a> {
    id: u64,
    code: &'a str,
}

/// Persistent sandboxed Python worker process.
pub struct SandboxedWorker {
    child: Child,
    pgid: i32,
    req_writer: File,
    resp_rx: mpsc::Receiver<Result<String, String>>,
    next_id: u64,
    workspace_dir: PathBuf,
    max_rss_bytes: u64,
}

impl SandboxedWorker {
    /// Spawns a new sandboxed Python worker and waits for its ready handshake.
    pub fn spawn(config: SandboxConfig) -> Result<Self, String> {
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = &config;
            return Err("Sandboxed Python worker is only supported on macOS and Linux".into());
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::io::FromRawFd;
            use std::os::unix::process::CommandExt;

            // Ensure workspace directory exists with 0700 permissions.
            std::fs::create_dir_all(&config.workspace_dir)
                .map_err(|e| format!("create workspace dir: {e}"))?;
            std::fs::set_permissions(&config.workspace_dir, Permissions::from_mode(0o700))
                .map_err(|e| format!("chmod workspace dir: {e}"))?;

            let workspace_dir = std::fs::canonicalize(&config.workspace_dir)
                .map_err(|e| format!("canonicalize workspace dir: {e}"))?;
            // Preserve the symlink filename (e.g. `venv/bin/python3`) so CPython finds
            // `pyvenv.cfg` and activates the venv, while also resolving the canonical target
            // binary for Seatbelt's `process-exec` and read-only allowlists.
            let launch_exe = canonicalize_preserving_leaf(&config.python_executable)
                .map_err(|e| format!("resolve python executable parent: {e}"))?;
            let real_exe = std::fs::canonicalize(&config.python_executable)
                .map_err(|e| format!("canonicalize python executable: {e}"))?;
            let exe_chain = collect_symlink_chain(&launch_exe, &real_exe);

            let mut ro_paths = BTreeSet::new();
            for exe in &exe_chain {
                if let Some(bin_dir) = exe.parent() {
                    ro_paths.insert(bin_dir.to_path_buf());
                    if let Some(prefix_dir) = bin_dir.parent() {
                        ro_paths.insert(prefix_dir.to_path_buf());
                    }
                }
            }
            for path in &config.read_only_paths {
                if let Ok(canon) = std::fs::canonicalize(path) {
                    ro_paths.insert(canon);
                }
            }

            // If a read-only uploads directory is configured, mount it in `ro_paths`
            // and expose it inside the workspace via an `uploads` symlink.
            if let Some(ref uploads) = config.uploads_dir {
                std::fs::create_dir_all(uploads).map_err(|e| format!("create uploads dir: {e}"))?;
                let canon_uploads = std::fs::canonicalize(uploads)
                    .map_err(|e| format!("canonicalize uploads dir: {e}"))?;
                ro_paths.insert(canon_uploads.clone());
                let link_path = workspace_dir.join("uploads");
                let _ = std::fs::remove_file(&link_path);
                std::os::unix::fs::symlink(&canon_uploads, &link_path)
                    .map_err(|e| format!("symlink workspace uploads dir: {e}"))?;
            }

            let ro_list: Vec<PathBuf> = ro_paths.into_iter().collect();

            // Create dedicated control pipes (parent->child requests, child->parent responses).
            let (req_read_fd, req_write_fd) = create_pipe()?;
            let (resp_read_fd, resp_write_fd) = create_pipe()?;

            #[cfg(target_os = "linux")]
            let linux_sandbox = linux::PreparedSandbox::prepare(&ro_list, &workspace_dir)?;

            #[cfg(target_os = "macos")]
            let mut cmd = {
                let profile = macos::build_seatbelt_profile(&exe_chain, &ro_list, &workspace_dir);
                let mut c = Command::new("/usr/bin/sandbox-exec");
                c.arg("-p").arg(profile).arg(&launch_exe).args([
                    "-s",
                    "-B",
                    "-u",
                    "-c",
                    WORKER_SCRIPT,
                ]);
                c
            };

            #[cfg(target_os = "linux")]
            let mut cmd = {
                let mut c = Command::new(&launch_exe);
                c.args(["-s", "-B", "-u", "-c", WORKER_SCRIPT]);
                c
            };

            cmd.current_dir(&workspace_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear()
                .env("HOME", &workspace_dir)
                .env("TMPDIR", &workspace_dir)
                .env("MPLCONFIGDIR", &workspace_dir)
                .env("MPLBACKEND", "Agg")
                .env("PYTHONNOUSERSITE", "1")
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .env("PYTHONUNBUFFERED", "1")
                .env("OPENBLAS_NUM_THREADS", "2")
                .env("OMP_NUM_THREADS", "2")
                .env("LANG", "C.UTF-8")
                .env("LC_ALL", "C.UTF-8")
                .env("PATH", "/usr/bin:/bin");

            let max_fsize = config.max_file_size_bytes;
            let max_nofile = config.max_open_files;

            // SAFETY: pre_exec only invokes async-signal-safe syscalls (setpgid, setrlimit,
            // dup2, close, fcntl, prctl, syscall) with no heap allocations or locks.
            unsafe {
                cmd.pre_exec(move || {
                    // Own process group so signals/kills reach the entire subtree.
                    if libc::setpgid(0, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }

                    // Apply resource limits.
                    set_rlimit(libc::RLIMIT_FSIZE, max_fsize)?;
                    set_rlimit(libc::RLIMIT_NOFILE, max_nofile)?;

                    // Wire req_read_fd -> FD 3 and resp_write_fd -> FD 4 without FD_CLOEXEC.
                    install_control_fds(req_read_fd, resp_write_fd)?;

                    // Close parent ends if they are still open in child.
                    if req_write_fd != REQ_FD && req_write_fd != RESP_FD {
                        libc::close(req_write_fd);
                    }
                    if resp_read_fd != REQ_FD && resp_read_fd != RESP_FD {
                        libc::close(resp_read_fd);
                    }

                    #[cfg(target_os = "linux")]
                    {
                        linux_sandbox.apply_in_child()?;
                    }

                    Ok(())
                });
            }

            let spawn_result = cmd.spawn();

            // Close child ends in parent regardless of spawn outcome.
            unsafe {
                libc::close(req_read_fd);
                libc::close(resp_write_fd);
            }

            let mut child = match spawn_result {
                Ok(child) => child,
                Err(err) => {
                    unsafe {
                        libc::close(req_write_fd);
                        libc::close(resp_read_fd);
                    }
                    return Err(format!("spawn sandboxed python worker: {err}"));
                }
            };

            let pgid = child.id() as i32;
            let req_writer = unsafe { File::from_raw_fd(req_write_fd) };
            let resp_reader = unsafe { File::from_raw_fd(resp_read_fd) };

            // Drain OS stderr in background so we can surface startup diagnostics if it dies.
            let stderr_rx = spawn_stderr_collector(child.stderr.take());
            // Drain OS stdout in background so C-level writes never block the pipe.
            if let Some(stdout) = child.stdout.take() {
                thread::spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    let mut sink = String::new();
                    while reader.read_line(&mut sink).unwrap_or(0) > 0 {
                        sink.clear();
                    }
                });
            }

            let (resp_tx, resp_rx) = mpsc::channel();
            thread::spawn(move || {
                let mut reader = BufReader::new(resp_reader);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            if resp_tx.send(Ok(line.clone())).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = resp_tx.send(Err(e.to_string()));
                            break;
                        }
                    }
                }
            });

            let mut worker = Self {
                child,
                pgid,
                req_writer,
                resp_rx,
                next_id: 1,
                workspace_dir,
                max_rss_bytes: config.max_rss_bytes,
            };

            // Wait for ready handshake.
            match worker.resp_rx.recv_timeout(config.startup_timeout) {
                Ok(Ok(line)) => {
                    let msg: WorkerMessage = serde_json::from_str(&line)
                        .map_err(|e| format!("invalid worker handshake: {e} ({line})"))?;
                    match msg {
                        WorkerMessage::Ready { .. } => Ok(worker),
                        other => Err(format!("unexpected handshake message: {other:?}")),
                    }
                }
                Ok(Err(err)) => {
                    worker.kill();
                    Err(format!("worker pipe read error during startup: {err}"))
                }
                Err(_) => {
                    worker.kill();
                    let stderr_text = stderr_rx
                        .recv_timeout(Duration::from_millis(200))
                        .unwrap_or_default();
                    Err(format!(
                        "python worker failed to start within {}s{}",
                        config.startup_timeout.as_secs(),
                        if stderr_text.trim().is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr_text.trim())
                        }
                    ))
                }
            }
        }
    }

    pub fn pgid(&self) -> i32 {
        self.pgid
    }

    #[allow(dead_code)]
    pub fn workspace_dir(&self) -> &Path {
        &self.workspace_dir
    }

    /// Sends `SIGINT` to the worker's process group so Python raises `KeyboardInterrupt`
    /// without discarding persistent REPL variables.
    #[allow(dead_code)]
    pub fn interrupt(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGINT);
        }
    }

    /// Executes a cell in the persistent `__main__` namespace with a wall-clock timeout.
    pub fn run_cell(&mut self, code: &str, timeout: Duration) -> Result<CellOutcome, String> {
        let id = self.next_id;
        self.next_id += 1;

        let req = CellRequest { id, code };
        let mut payload =
            serde_json::to_string(&req).map_err(|e| format!("serialize cell request: {e}"))?;
        payload.push('\n');

        self.req_writer
            .write_all(payload.as_bytes())
            .and_then(|_| self.req_writer.flush())
            .map_err(|e| format!("write to python worker: {e}"))?;

        let deadline = Instant::now() + timeout;
        let poll_interval = Duration::from_millis(100);
        loop {
            if self.max_rss_bytes > 0
                && let Some(rss) = read_process_rss_bytes(self.child.id())
                && rss > self.max_rss_bytes
            {
                self.kill();
                return Err(format!(
                    "cell exceeded memory limit ({} MB), so the kernel was restarted",
                    self.max_rss_bytes / (1024 * 1024)
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.kill();
                return Err(format!("cell timed out after {}s", timeout.as_secs()));
            }
            match self.resp_rx.recv_timeout(remaining.min(poll_interval)) {
                Ok(Ok(line)) => {
                    let msg: WorkerMessage = serde_json::from_str(&line)
                        .map_err(|e| format!("decode worker reply: {e}"))?;
                    match msg {
                        WorkerMessage::Result {
                            id: reply_id,
                            stdout,
                            result,
                            error,
                            interrupted,
                            images,
                            dropped,
                            files,
                        } if reply_id == id => {
                            return Ok(CellOutcome {
                                stdout,
                                result,
                                error,
                                interrupted,
                                images,
                                dropped,
                                files,
                            });
                        }
                        _ => continue,
                    }
                }
                Ok(Err(err)) => {
                    self.kill();
                    return Err(format!("python worker pipe error: {err}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.kill();
                    return Err("python worker exited unexpectedly".into());
                }
            }
        }
    }

    /// Terminates the worker process group immediately.
    pub fn kill(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SandboxedWorker {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn canonicalize_preserving_leaf(path: &Path) -> std::io::Result<PathBuf> {
    let Some(parent) = path.parent() else {
        return std::fs::canonicalize(path);
    };
    let Some(file_name) = path.file_name() else {
        return std::fs::canonicalize(path);
    };
    let canon_parent = if parent.as_os_str().is_empty() {
        std::env::current_dir()?
    } else {
        std::fs::canonicalize(parent)?
    };
    Ok(canon_parent.join(file_name))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn collect_symlink_chain(launch_exe: &Path, real_exe: &Path) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut current = launch_exe.to_path_buf();
    for _ in 0..16 {
        if !seen.insert(current.clone()) {
            break;
        }
        match std::fs::read_link(&current) {
            Ok(target) => {
                let next = if target.is_absolute() {
                    target
                } else {
                    current
                        .parent()
                        .unwrap_or_else(|| Path::new("/"))
                        .join(target)
                };
                current = canonicalize_preserving_leaf(&next).unwrap_or(next);
            }
            Err(_) => break,
        }
    }
    seen.insert(real_exe.to_path_buf());
    seen.into_iter().collect()
}

#[cfg(target_os = "macos")]
fn read_process_rss_bytes(pid: u32) -> Option<u64> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKINFO,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    };
    if ret == size {
        Some(info.pti_resident_size)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn read_process_rss_bytes(pid: u32) -> Option<u64> {
    let content = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let resident_pages: u64 = content.split_whitespace().nth(1)?.parse().ok()?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return None;
    }
    Some(resident_pages.saturating_mul(page_size as u64))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_process_rss_bytes(_pid: u32) -> Option<u64> {
    None
}

#[cfg(unix)]
fn create_pipe() -> Result<(i32, i32), String> {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(format!("pipe(): {}", std::io::Error::last_os_error()));
    }
    for fd in fds {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    Ok((fds[0], fds[1]))
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(all(target_os = "linux", target_env = "gnu"))))]
type RlimitResource = libc::c_int;

#[cfg(unix)]
unsafe fn set_rlimit(resource: RlimitResource, limit: u64) -> std::io::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let capped = if current.rlim_max == libc::RLIM_INFINITY {
        limit as libc::rlim_t
    } else {
        (limit as libc::rlim_t).min(current.rlim_max)
    };
    let next = libc::rlimit {
        rlim_cur: capped,
        rlim_max: capped,
    };
    if unsafe { libc::setrlimit(resource, &next) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
unsafe fn install_control_fds(req_read: i32, resp_write: i32) -> std::io::Result<()> {
    // Handle any overlap if req_read or resp_write already happens to be 3 or 4.
    let mut r = req_read;
    let mut w = resp_write;
    if r == RESP_FD {
        let duped = unsafe { libc::dup(r) };
        if duped < 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe { libc::close(r) };
        r = duped;
    }
    if w == REQ_FD {
        let duped = unsafe { libc::dup(w) };
        if duped < 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe { libc::close(w) };
        w = duped;
    }

    if r != REQ_FD {
        if unsafe { libc::dup2(r, REQ_FD) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe { libc::close(r) };
    }
    if w != RESP_FD {
        if unsafe { libc::dup2(w, RESP_FD) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe { libc::close(w) };
    }

    // Clear FD_CLOEXEC on FD 3 and FD 4 so they survive exec into sandbox-exec / python3.
    if unsafe { libc::fcntl(REQ_FD, libc::F_SETFD, 0) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(RESP_FD, libc::F_SETFD, 0) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn spawn_stderr_collector(stderr: Option<std::process::ChildStderr>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut collected = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                if collected.len() < 8192 {
                    collected.push_str(&line);
                }
                line.clear();
            }
        }
        let _ = tx.send(collected);
    });
    rx
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    fn sbpl_escape(path: &Path) -> String {
        let raw = path.to_string_lossy();
        raw.replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn collect_ancestors(paths: &[&Path]) -> BTreeSet<PathBuf> {
        let mut ancestors = BTreeSet::new();
        ancestors.insert(PathBuf::from("/"));
        for path in paths {
            let mut cur = path.parent();
            while let Some(dir) = cur {
                ancestors.insert(dir.to_path_buf());
                cur = dir.parent();
            }
        }
        ancestors
    }

    /// Builds a deny-by-default macOS Seatbelt profile for CPython.
    pub fn build_seatbelt_profile(
        exe_chain: &[PathBuf],
        read_only_paths: &[PathBuf],
        workspace_dir: &Path,
    ) -> String {
        let mut all_paths: Vec<&Path> = vec![workspace_dir];
        for p in exe_chain {
            all_paths.push(p.as_path());
        }
        for p in read_only_paths {
            all_paths.push(p.as_path());
        }
        let ancestors = collect_ancestors(&all_paths);

        let mut profile = String::new();
        profile.push_str("(version 1)\n");
        profile.push_str("(deny default)\n");

        // Allow executing only the pinned Python interpreter symlink chain; deny fork/subprocesses.
        for exe in exe_chain {
            profile.push_str(&format!(
                "(allow process-exec (literal \"{}\"))\n",
                sbpl_escape(exe)
            ));
        }
        profile.push_str("(deny process-fork)\n");
        profile.push_str("(allow signal (target self))\n");
        profile.push_str("(allow sysctl-read)\n");
        profile.push_str("(allow file-map-executable)\n");

        // Allow UNIX domain sockets only (needed by asyncio self-pipe); deny all IP/network.
        profile.push_str("(deny network*)\n");
        profile.push_str("(allow system-socket (socket-domain AF_UNIX))\n");

        // Allow stat() only on ancestor directories required to traverse to allowed paths.
        // Plus literal "/" (opened by dyld/CoreFoundation on macOS startup) and the standard
        // root symlinks ("/var", "/tmp", "/etc") so venv symlinks pointing through /var resolve.
        profile.push_str("(allow file-read* (literal \"/\"))\n");
        for link in ["/var", "/tmp", "/etc"] {
            profile.push_str(&format!(
                "(allow file-read-metadata (literal \"{link}\"))\n"
            ));
        }
        for anc in &ancestors {
            profile.push_str(&format!(
                "(allow file-read-metadata (literal \"{}\"))\n",
                sbpl_escape(anc)
            ));
        }

        // Minimal read-only OS runtime & shared library paths.
        const SYSTEM_RO_SUBPATHS: &[&str] = &[
            "/usr/lib",
            "/usr/share",
            "/System/Library",
            "/System/Cryptexes",
            "/System/Volumes/Preboot/Cryptexes",
            "/Library/Frameworks",
            "/Library/Preferences/Logging",
            "/private/var/db/timezone",
        ];
        let sys_ancestors = collect_ancestors(
            &SYSTEM_RO_SUBPATHS
                .iter()
                .map(Path::new)
                .collect::<Vec<&Path>>(),
        );
        for anc in &sys_ancestors {
            if !ancestors.contains(anc) {
                profile.push_str(&format!(
                    "(allow file-read-metadata (literal \"{}\"))\n",
                    sbpl_escape(anc)
                ));
            }
        }
        for p in SYSTEM_RO_SUBPATHS {
            profile.push_str(&format!("(allow file-read* (subpath \"{p}\"))\n"));
        }

        const SYSTEM_RO_LITERALS: &[&str] = &[
            "/private/etc/localtime",
            "/etc/localtime",
            "/dev/null",
            "/dev/zero",
            "/dev/urandom",
            "/dev/random",
            "/dev/dtracehelper",
        ];
        for p in SYSTEM_RO_LITERALS {
            profile.push_str(&format!("(allow file-read* (literal \"{p}\"))\n"));
        }
        profile.push_str("(allow file-write-data (literal \"/dev/null\"))\n");

        // Read-only allowlist for the Python installation and any mounted read-only dirs.
        for p in read_only_paths {
            let escaped = sbpl_escape(p);
            if p.is_dir() {
                profile.push_str(&format!("(allow file-read* (subpath \"{escaped}\"))\n"));
            } else {
                profile.push_str(&format!("(allow file-read* (literal \"{escaped}\"))\n"));
            }
        }
        for exe in exe_chain {
            profile.push_str(&format!(
                "(allow file-read* (literal \"{}\"))\n",
                sbpl_escape(exe)
            ));
        }

        // Read-write allowlist strictly scoped to the per-session workspace directory.
        let ws = sbpl_escape(workspace_dir);
        profile.push_str(&format!(
            "(allow file-read* file-write* (subpath \"{ws}\"))\n"
        ));

        profile
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const SYS_IO_URING_SETUP: libc::c_long = 425;
    const AF_VSOCK_LINUX: u32 = 40;

    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1 << 0;
    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

    const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
    const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
    const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
    const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
    const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
    const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
    const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
    const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
    const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
    const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
    const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
    const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
    const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
    const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
    const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;

    const LANDLOCK_ACCESS_NET_BIND_TCP: u64 = 1 << 0;
    const LANDLOCK_ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;

    #[repr(C)]
    struct LandlockRulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
    }

    #[repr(C, packed)]
    struct LandlockPathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    #[repr(C)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }

    pub struct PreparedSandbox {
        landlock_fd: Option<i32>,
        seccomp_filter: Vec<SockFilter>,
    }

    impl PreparedSandbox {
        pub fn prepare(ro_paths: &[PathBuf], workspace_dir: &Path) -> Result<Self, String> {
            let landlock_fd = prepare_landlock(ro_paths, workspace_dir)?;
            let seccomp_filter = build_seccomp_filter()?;
            Ok(Self {
                landlock_fd,
                seccomp_filter,
            })
        }

        /// Async-signal-safe application inside `pre_exec`.
        pub unsafe fn apply_in_child(&self) -> std::io::Result<()> {
            if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if let Some(fd) = self.landlock_fd {
                let rc = unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, fd, 0u32) };
                unsafe {
                    libc::close(fd);
                }
                if rc != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let prog = SockFprog {
                len: self.seccomp_filter.len() as u16,
                filter: self.seccomp_filter.as_ptr(),
            };
            if unsafe {
                libc::prctl(
                    libc::PR_SET_SECCOMP,
                    libc::SECCOMP_MODE_FILTER,
                    &prog as *const SockFprog,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for PreparedSandbox {
        fn drop(&mut self) {
            if let Some(fd) = self.landlock_fd.take() {
                unsafe {
                    libc::close(fd);
                }
            }
        }
    }

    fn prepare_landlock(ro_paths: &[PathBuf], workspace_dir: &Path) -> Result<Option<i32>, String> {
        let abi = unsafe {
            libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                std::ptr::null::<LandlockRulesetAttr>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };
        if abi < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("Landlock unavailable on this kernel: {err}"));
        }

        let mut handled_fs = LANDLOCK_ACCESS_FS_EXECUTE
            | LANDLOCK_ACCESS_FS_WRITE_FILE
            | LANDLOCK_ACCESS_FS_READ_FILE
            | LANDLOCK_ACCESS_FS_READ_DIR
            | LANDLOCK_ACCESS_FS_REMOVE_DIR
            | LANDLOCK_ACCESS_FS_REMOVE_FILE
            | LANDLOCK_ACCESS_FS_MAKE_CHAR
            | LANDLOCK_ACCESS_FS_MAKE_DIR
            | LANDLOCK_ACCESS_FS_MAKE_REG
            | LANDLOCK_ACCESS_FS_MAKE_SOCK
            | LANDLOCK_ACCESS_FS_MAKE_FIFO
            | LANDLOCK_ACCESS_FS_MAKE_BLOCK
            | LANDLOCK_ACCESS_FS_MAKE_SYM;
        if abi >= 2 {
            handled_fs |= LANDLOCK_ACCESS_FS_REFER;
        }
        if abi >= 3 {
            handled_fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
        }

        let handled_net = if abi >= 4 {
            LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP
        } else {
            0
        };

        let attr = LandlockRulesetAttr {
            handled_access_fs: handled_fs,
            handled_access_net: handled_net,
        };
        let attr_size = if abi >= 4 {
            std::mem::size_of::<LandlockRulesetAttr>()
        } else {
            std::mem::size_of::<u64>()
        };

        let ruleset_fd = unsafe {
            libc::syscall(
                SYS_LANDLOCK_CREATE_RULESET,
                &attr as *const LandlockRulesetAttr,
                attr_size,
                0u32,
            )
        } as i32;
        if ruleset_fd < 0 {
            return Err(format!(
                "landlock_create_ruleset failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let file_ro_flags =
            (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE) & handled_fs;
        let dir_ro_flags = (LANDLOCK_ACCESS_FS_READ_FILE
            | LANDLOCK_ACCESS_FS_READ_DIR
            | LANDLOCK_ACCESS_FS_EXECUTE)
            & handled_fs;
        let dir_rw_flags = handled_fs
            & !(LANDLOCK_ACCESS_FS_MAKE_CHAR
                | LANDLOCK_ACCESS_FS_MAKE_BLOCK
                | LANDLOCK_ACCESS_FS_MAKE_SOCK
                | LANDLOCK_ACCESS_FS_MAKE_FIFO);
        let dev_null_flags = (LANDLOCK_ACCESS_FS_READ_FILE
            | LANDLOCK_ACCESS_FS_WRITE_FILE
            | LANDLOCK_ACCESS_FS_TRUNCATE)
            & handled_fs;

        let system_ro = [
            "/usr",
            "/lib",
            "/lib64",
            "/etc/ld.so.cache",
            "/etc/ld.so.conf",
            "/etc/ld.so.conf.d",
            "/etc/localtime",
            "/etc/ssl",
            "/proc/self",
            "/dev/urandom",
            "/dev/random",
            "/dev/zero",
        ];
        for p in system_ro {
            let path = Path::new(p);
            if path.exists() {
                let flags = if path.is_dir() {
                    dir_ro_flags
                } else {
                    file_ro_flags
                };
                let _ = add_path_rule(ruleset_fd, path, flags);
            }
        }
        let _ = add_path_rule(ruleset_fd, Path::new("/dev/null"), dev_null_flags);

        for p in ro_paths {
            if p.exists() {
                let flags = if p.is_dir() {
                    dir_ro_flags
                } else {
                    file_ro_flags
                };
                add_path_rule(ruleset_fd, p, flags)?;
            }
        }

        add_path_rule(ruleset_fd, workspace_dir, dir_rw_flags)?;

        Ok(Some(ruleset_fd))
    }

    fn add_path_rule(ruleset_fd: i32, path: &Path, allowed_access: u64) -> Result<(), String> {
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|e| format!("invalid path {}: {e}", path.display()))?;
        let parent_fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if parent_fd < 0 {
            return Err(format!(
                "open O_PATH {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        let rule = LandlockPathBeneathAttr {
            allowed_access,
            parent_fd,
        };
        let rc = unsafe {
            libc::syscall(
                SYS_LANDLOCK_ADD_RULE,
                ruleset_fd,
                LANDLOCK_RULE_PATH_BENEATH,
                &rule as *const LandlockPathBeneathAttr,
                0u32,
            )
        };
        unsafe { libc::close(parent_fd) };
        if rc != 0 {
            return Err(format!(
                "landlock_add_rule {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;

    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

    // Offsets into struct seccomp_data: nr=0, arch=4, instruction_pointer=8, args[0]=16.
    const OFFSET_NR: u32 = 0;
    const OFFSET_ARCH: u32 = 4;
    const OFFSET_ARG0: u32 = 16;

    #[cfg(target_arch = "x86_64")]
    const EXPECTED_AUDIT_ARCH: u32 = 0xC000_003E;
    #[cfg(target_arch = "aarch64")]
    const EXPECTED_AUDIT_ARCH: u32 = 0xC000_00B7;

    fn stmt(code: u16, k: u32) -> SockFilter {
        SockFilter {
            code,
            jt: 0,
            jf: 0,
            k,
        }
    }

    fn jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
        SockFilter { code, jt, jf, k }
    }

    fn build_seccomp_filter() -> Result<Vec<SockFilter>, String> {
        let deny_eperm = SECCOMP_RET_ERRNO | (libc::EPERM as u32 & 0xffff);
        let mut f = Vec::new();

        // 1. Validate syscall architecture (blocks 32-bit compat bypass).
        f.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFFSET_ARCH));
        f.push(jump(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_AUDIT_ARCH, 1, 0));
        f.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

        // 2. Load syscall number.
        f.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFFSET_NR));

        // 3. Deny dangerous syscalls unconditionally with EPERM.
        let denied_syscalls: &[libc::c_long] = &[
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_bpf,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_chroot,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_kexec_load,
            libc::SYS_userfaultfd,
            SYS_IO_URING_SETUP,
        ];
        for &nr in denied_syscalls {
            f.push(jump(BPF_JMP | BPF_JEQ | BPF_K, nr as u32, 0, 1));
            f.push(stmt(BPF_RET | BPF_K, deny_eperm));
        }

        // 4. For socket(domain, ...), deny IP/netlink/packet/vsock domains while allowing AF_UNIX.
        let blocked_domains: &[u32] = &[
            libc::AF_INET as u32,
            libc::AF_INET6 as u32,
            libc::AF_NETLINK as u32,
            libc::AF_PACKET as u32,
            AF_VSOCK_LINUX,
        ];
        // If nr != SYS_socket, skip the domain checks and jump straight to ALLOW.
        let skip_socket = (1 + blocked_domains.len() * 2) as u8;
        f.push(jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            libc::SYS_socket as u32,
            0,
            skip_socket,
        ));
        f.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFFSET_ARG0));
        for &domain in blocked_domains {
            f.push(jump(BPF_JMP | BPF_JEQ | BPF_K, domain, 0, 1));
            f.push(stmt(BPF_RET | BPF_K, deny_eperm));
        }

        // 5. Default allow.
        f.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn resolve_test_python() -> (PathBuf, Vec<PathBuf>) {
        // Query python3 directly so shims (like pyenv) resolve to the real interpreter & prefixes.
        let output = Command::new("python3")
            .args([
                "-c",
                "import sys, os; print(os.path.realpath(sys.executable)); print(os.path.realpath(sys.prefix)); print(os.path.realpath(sys.base_prefix))",
            ])
            .output()
            .expect("python3 must be available to run sandbox tests");
        assert!(output.status.success(), "failed to inspect python3");
        let text = String::from_utf8(output.stdout).unwrap();
        let mut lines = text.lines();
        let exe = PathBuf::from(lines.next().unwrap().trim());
        let mut ro = Vec::new();
        for line in lines {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                ro.push(PathBuf::from(trimmed));
            }
        }
        // On macOS with Homebrew/pyenv Python, dynamically linked libs (e.g. libffi/openssl)
        // may live under /opt/homebrew/opt or /usr/local/opt.
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
        (exe, ro)
    }

    fn temp_workspace(tag: &str) -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "deepseek-py-sandbox-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn spawn_test_worker(tag: &str) -> (SandboxedWorker, PathBuf) {
        let (exe, ro) = resolve_test_python();
        let ws = temp_workspace(tag);
        let mut cfg = SandboxConfig::new(exe, ws.clone());
        cfg.read_only_paths = ro;
        let worker = SandboxedWorker::spawn(cfg).expect("sandboxed worker should start");
        (worker, ws)
    }

    #[test]
    fn persistent_repl_and_top_level_await() {
        let (mut worker, ws) = spawn_test_worker("repl");

        let r1 = worker
            .run_cell("x = 21\nprint('hello')\nx * 2", Duration::from_secs(10))
            .unwrap();
        assert_eq!(r1.error, None);
        assert_eq!(r1.stdout, "hello\n");
        assert_eq!(r1.result.as_deref(), Some("42"));

        // State persists across calls, including `_` and top-level await.
        let r2 = worker
            .run_cell(
                "import asyncio\nawait asyncio.sleep(0.01)\nx + _",
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(r2.error, None);
        assert_eq!(r2.result.as_deref(), Some("63"));

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn blocks_reading_secret_files_and_writing_outside_workspace() {
        let (mut worker, ws) = spawn_test_worker("fs-deny");

        // Create a secret file outside the workspace (simulating app_data_dir()/api-key).
        let outside_dir = temp_workspace("outside-secret");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let secret_file = outside_dir.join("api-key");
        std::fs::write(&secret_file, "sk-super-secret-value").unwrap();
        let canonical_secret = std::fs::canonicalize(&secret_file).unwrap();
        let escape_target = outside_dir.join("escaped.txt");

        let code = format!(
            r#"
import os
secret = {secret:?}
escape = {escape:?}
read_err = None
try:
    with open(secret, 'r') as f:
        f.read()
except OSError as e:
    read_err = type(e).__name__

write_err = None
try:
    with open(escape, 'w') as f:
        f.write('pwned')
except OSError as e:
    write_err = type(e).__name__

# Writing inside workspace must succeed.
with open('local.txt', 'w') as f:
    f.write('ok')
with open('local.txt', 'r') as f:
    local_val = f.read()

(read_err, write_err, local_val)
"#,
            secret = canonical_secret.to_string_lossy(),
            escape = escape_target.to_string_lossy(),
        );

        let r = worker.run_cell(&code, Duration::from_secs(10)).unwrap();
        assert_eq!(r.error, None, "unexpected error: {:?}", r.error);
        assert_eq!(
            r.result.as_deref(),
            Some("('PermissionError', 'PermissionError', 'ok')")
        );
        assert!(!escape_target.exists());

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
        let _ = std::fs::remove_dir_all(outside_dir);
    }

    #[test]
    fn blocks_network_access_loopback_and_external() {
        let (mut worker, ws) = spawn_test_worker("net-deny");

        let code = r#"
import socket
errs = []
for host, port in [('127.0.0.1', 80), ('1.1.1.1', 443)]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect((host, port))
        s.close()
        errs.append('CONNECTED')
    except OSError as e:
        errs.append(type(e).__name__)
errs
"#;
        let r = worker.run_cell(code, Duration::from_secs(10)).unwrap();
        assert_eq!(r.error, None);
        assert_eq!(
            r.result.as_deref(),
            Some("['PermissionError', 'PermissionError']")
        );

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn sigint_interrupts_loop_without_losing_repl_state() {
        let (mut worker, ws) = spawn_test_worker("sigint");

        let r1 = worker
            .run_cell("keep_me = 'alive'", Duration::from_secs(10))
            .unwrap();
        assert_eq!(r1.error, None);

        // Schedule SIGINT from another thread while the worker is stuck in a tight loop.
        let pgid = worker.pgid;
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            unsafe {
                libc::kill(-pgid, libc::SIGINT);
            }
        });

        let r2 = worker
            .run_cell("while True:\n    pass", Duration::from_secs(5))
            .unwrap();
        handle.join().unwrap();
        assert!(r2.interrupted, "expected interrupted=true, got {r2:?}");
        assert!(
            r2.error
                .as_deref()
                .unwrap_or("")
                .contains("KeyboardInterrupt")
        );

        // Verify variables survived the interrupt!
        let r3 = worker.run_cell("keep_me", Duration::from_secs(10)).unwrap();
        assert_eq!(r3.error, None);
        assert_eq!(r3.result.as_deref(), Some("'alive'"));

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn present_file_stages_bytes_in_workspace() {
        let (mut worker, ws) = spawn_test_worker("present-file");

        let r = worker
            .run_cell(
                "with open('report.csv', 'w') as f:\n    f.write('a,b\\n1,2\\n')\npresent_file('report.csv')",
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(r.error, None);
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.files[0].name, "report.csv");
        assert_eq!(r.files[0].mime_type, "text/csv");
        let bytes = std::fs::read(&r.files[0].staged_path).unwrap();
        assert_eq!(bytes, b"a,b\n1,2\n");

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn scientific_packages_work_inside_sandbox_when_installed() {
        let (mut worker, ws) = spawn_test_worker("sci");

        let code = r#"
results = {}
try:
    import numpy as np
    a = np.arange(10, dtype=np.float64)
    results['numpy'] = float(a.sum())
except ImportError:
    results['numpy'] = 'not_installed'

try:
    from PIL import Image
    img = Image.new('RGB', (32, 32), color=(255, 0, 0))
    show(img)
    results['pil'] = 'ok'
except ImportError:
    results['pil'] = 'not_installed'

results
"#;
        let r = worker.run_cell(code, Duration::from_secs(15)).unwrap();
        assert_eq!(r.error, None, "error: {:?}", r.error);
        let text = r.result.as_deref().unwrap_or("");
        assert!(text.contains("'numpy': 45.0") || text.contains("'numpy': 'not_installed'"));
        if text.contains("'pil': 'ok'") {
            assert_eq!(r.images.len(), 1);
            assert!(r.images[0].starts_with("data:image/jpeg;base64,"));
        }

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_blocks_subprocess_spawning() {
        let (mut worker, ws) = spawn_test_worker("no-fork");

        let code = r#"
import subprocess
try:
    subprocess.run(['/bin/echo', 'hi'], check=True)
    res = 'SPAWNED'
except OSError as e:
    res = type(e).__name__
res
"#;
        let r = worker.run_cell(code, Duration::from_secs(10)).unwrap();
        assert_eq!(r.error, None);
        assert_eq!(r.result.as_deref(), Some("'PermissionError'"));

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn uploads_dir_is_read_only_and_supports_live_additions() {
        let (exe, ro) = resolve_test_python();
        let ws = temp_workspace("uploads-ws");
        let uploads = temp_workspace("uploads-ro");
        std::fs::create_dir_all(&uploads).unwrap();
        std::fs::write(uploads.join("sales.csv"), b"a,b\n1,2\n").unwrap();

        let mut cfg = SandboxConfig::new(exe, ws.clone());
        cfg.read_only_paths = ro;
        cfg.uploads_dir = Some(uploads.clone());
        let mut worker = SandboxedWorker::spawn(cfg).expect("worker with uploads should start");

        let r1 = worker
            .run_cell(
                r#"
import os
seen = sorted(os.listdir('uploads'))
content = open('uploads/sales.csv').read()
errs = []
for fn in (
    lambda: open('uploads/sales.csv', 'a').write('x'),
    lambda: open('uploads/new.txt', 'w').write('x'),
    lambda: os.remove('uploads/sales.csv'),
):
    try:
        fn()
        errs.append('WRITTEN')
    except OSError as e:
        errs.append(type(e).__name__)
state_var = 99
(seen, content, errs)
"#,
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(r1.error, None, "unexpected error: {:?}", r1.error);
        assert_eq!(
            r1.result.as_deref(),
            Some(
                "(['sales.csv'], 'a,b\\n1,2\\n', ['PermissionError', 'PermissionError', 'PermissionError'])"
            )
        );

        // Add a second file mid-session without restarting the worker.
        std::fs::write(uploads.join("extra.txt"), b"mid-session").unwrap();
        let r2 = worker
            .run_cell(
                "(state_var, open('uploads/extra.txt').read())",
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(r2.error, None, "unexpected error: {:?}", r2.error);
        assert_eq!(r2.result.as_deref(), Some("(99, 'mid-session')"));

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
        let _ = std::fs::remove_dir_all(uploads);
    }

    #[test]
    fn rss_watchdog_terminates_memory_hog() {
        let (exe, ro) = resolve_test_python();
        let ws = temp_workspace("rss-limit");
        let mut cfg = SandboxConfig::new(exe, ws.clone());
        cfg.read_only_paths = ro;
        cfg.max_rss_bytes = 96 * 1024 * 1024;
        let mut worker = SandboxedWorker::spawn(cfg).expect("worker should start");

        // Allocate and touch > 96 MB of pages, then pause briefly so the 100ms watchdog catches it.
        let err = worker
            .run_cell(
                "import time\nbuf = bytearray(160 * 1024 * 1024)\nfor i in range(0, len(buf), 4096): buf[i] = 1\ntime.sleep(2)",
                Duration::from_secs(10),
            )
            .expect_err("memory hog should be killed by RSS watchdog");
        assert!(
            err.contains("exceeded memory limit"),
            "unexpected error: {err}"
        );

        drop(worker);
        let _ = std::fs::remove_dir_all(ws);
    }
}
