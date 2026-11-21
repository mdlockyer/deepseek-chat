//! Managed CPython runtime provisioning for desktop builds.
//!
//! Downloads a SHA-256-verified `python-build-standalone` archive into
//! `app_data_dir()/python/standalone/`, creates a dedicated venv in
//! `app_data_dir()/python/venv/`, and installs the base scientific packages.
//!
//! Provisioning runs on the host (outside the REPL sandbox). Once provisioned,
//! the sandboxed worker only gets read-only access to `app_data_dir()/python/`
//! (never the parent `app_data_dir()` where API keys are stored) and zero
//! network access.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const MANAGED_PYTHON_VERSION: &str = "3.13.18+20261110";
pub const BASE_PACKAGES: &[&str] = &["numpy", "pandas", "matplotlib", "pillow", "scipy"];

const READY_MARKER_NAME: &str = ".deepseek-ready";
const DOWNLOAD_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Copy)]
pub struct RuntimeSpec {
    pub url: &'static str,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPythonStatus {
    pub ready: bool,
    pub version: String,
    pub venv_python: Option<String>,
    pub packages: Vec<String>,
}

pub fn current_runtime_spec() -> Option<RuntimeSpec> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some(RuntimeSpec {
            url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz",
            sha256: "7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540",
        })
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some(RuntimeSpec {
            url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-x86_64-apple-darwin-install_only_stripped.tar.gz",
            sha256: "d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b",
        })
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some(RuntimeSpec {
            url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
            sha256: "f2d2199eb25880e07863b391cf7124e7ffa1338b0d65600dfcec117c4223a7fb",
        })
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Some(RuntimeSpec {
            url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
            sha256: "55c00325f7c1fddf325dfc621aabdfbbac4dc54adda224af88ec411dc12db239",
        })
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        None
    }
}

fn python_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("python")
}

fn standalone_dir(app_data_dir: &Path) -> PathBuf {
    python_root(app_data_dir).join("standalone")
}

fn standalone_python(app_data_dir: &Path) -> PathBuf {
    standalone_dir(app_data_dir)
        .join("python")
        .join("bin")
        .join("python3")
}

fn venv_dir(app_data_dir: &Path) -> PathBuf {
    python_root(app_data_dir).join("venv")
}

pub fn venv_python_path(app_data_dir: &Path) -> PathBuf {
    venv_dir(app_data_dir).join("bin").join("python3")
}

fn expected_marker() -> String {
    format!("{MANAGED_PYTHON_VERSION}\n{}\n", BASE_PACKAGES.join(","))
}

pub fn is_managed_venv_ready(app_data_dir: &Path) -> bool {
    let py = venv_python_path(app_data_dir);
    if !py.is_file() {
        return false;
    }
    let marker_path = venv_dir(app_data_dir).join(READY_MARKER_NAME);
    fs::read_to_string(marker_path)
        .map(|content| content == expected_marker())
        .unwrap_or(false)
}

pub fn managed_python_status(app_data_dir: &Path) -> ManagedPythonStatus {
    let ready = is_managed_venv_ready(app_data_dir);
    let venv_python = ready.then(|| {
        venv_python_path(app_data_dir)
            .to_string_lossy()
            .into_owned()
    });
    ManagedPythonStatus {
        ready,
        version: MANAGED_PYTHON_VERSION.to_string(),
        venv_python,
        packages: BASE_PACKAGES.iter().map(|s| (*s).to_string()).collect(),
    }
}

/// Ensures the managed standalone CPython and base scientific venv exist and are ready.
pub fn ensure_managed_python(app_data_dir: &Path) -> Result<PathBuf, String> {
    if is_managed_venv_ready(app_data_dir) {
        return Ok(venv_python_path(app_data_dir));
    }

    let root = python_root(app_data_dir);
    fs::create_dir_all(&root).map_err(|e| format!("create managed python dir: {e}"))?;

    let base_py = ensure_standalone_python(app_data_dir)?;
    create_and_populate_venv(app_data_dir, &base_py)?;
    Ok(venv_python_path(app_data_dir))
}

/// Removes the managed Python runtime and venv so they will be freshly provisioned on next use.
pub fn reset_managed_python(app_data_dir: &Path) -> Result<(), String> {
    let root = python_root(app_data_dir);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("remove managed python dir: {e}"))?;
    }
    Ok(())
}

fn ensure_standalone_python(app_data_dir: &Path) -> Result<PathBuf, String> {
    let py = standalone_python(app_data_dir);
    if py.is_file() {
        return Ok(py);
    }

    let spec = current_runtime_spec().ok_or_else(|| {
        "No managed python-build-standalone archive is configured for this platform".to_string()
    })?;

    let tmp_dir = python_root(app_data_dir).join(".tmp");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("create temp dir: {e}"))?;

    let archive_path = tmp_dir.join("cpython.tar.gz");
    let download_res = download_and_verify(spec.url, spec.sha256, &archive_path);
    if let Err(err) = download_res {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(err);
    }

    let staging_dir = tmp_dir.join("extract");
    fs::create_dir_all(&staging_dir).map_err(|e| format!("create extract dir: {e}"))?;

    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(&archive_path)
        .arg("-C")
        .arg(&staging_dir)
        .status()
        .map_err(|e| format!("run tar to extract standalone python: {e}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "tar failed to extract standalone python (status: {status})"
        ));
    }

    let target_dir = standalone_dir(app_data_dir);
    if target_dir.exists() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    fs::rename(&staging_dir, &target_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&tmp_dir);
        format!("move extracted standalone python into place: {e}")
    })?;
    let _ = fs::remove_dir_all(&tmp_dir);

    if !py.is_file() {
        return Err(format!(
            "extracted standalone python is missing expected binary at {}",
            py.display()
        ));
    }
    Ok(py)
}

fn download_and_verify(url: &str, expected_sha256: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("download standalone python: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download standalone python failed: HTTP {}",
            response.status()
        ));
    }

    let mut file =
        File::create(dest).map_err(|e| format!("create archive file {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = response
            .read(&mut buf)
            .map_err(|e| format!("read standalone python stream: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| format!("write archive file: {e}"))?;
    }
    file.flush()
        .map_err(|e| format!("flush archive file: {e}"))?;

    let actual_hex = format!("{:x}", hasher.finalize());
    verify_sha256_hex(&actual_hex, expected_sha256)
}

fn verify_sha256_hex(actual: &str, expected: &str) -> Result<(), String> {
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "standalone python SHA-256 mismatch: expected {expected}, got {actual}"
        ))
    }
}

fn create_and_populate_venv(app_data_dir: &Path, base_py: &Path) -> Result<(), String> {
    let venv = venv_dir(app_data_dir);
    let output = Command::new(base_py)
        .args(["-m", "venv", "--clear"])
        .arg(&venv)
        .output()
        .map_err(|e| format!("create python venv: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("create python venv failed: {}", stderr.trim()));
    }

    let venv_py = venv_python_path(app_data_dir);

    // Prefer `uv pip install` when available on the host (much faster); otherwise use venv pip.
    let installed_with_uv = Command::new("uv")
        .args(["pip", "install", "--python"])
        .arg(&venv_py)
        .args(BASE_PACKAGES)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);

    if !installed_with_uv {
        let pip_out = Command::new(&venv_py)
            .args([
                "-m",
                "pip",
                "install",
                "--no-input",
                "--disable-pip-version-check",
                "--quiet",
            ])
            .args(BASE_PACKAGES)
            .output()
            .map_err(|e| format!("run pip install in managed venv: {e}"))?;
        if !pip_out.status.success() {
            let stderr = String::from_utf8_lossy(&pip_out.stderr);
            return Err(format!(
                "pip install failed in managed venv: {}",
                stderr.trim()
            ));
        }
    }

    let marker_path = venv.join(READY_MARKER_NAME);
    fs::write(&marker_path, expected_marker())
        .map_err(|e| format!("write managed python ready marker: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_sha256_accepts_matching_and_rejects_mismatch() {
        let digest = "7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540";
        assert!(verify_sha256_hex(digest, digest).is_ok());
        assert!(verify_sha256_hex(&digest.to_uppercase(), digest).is_ok());
        assert!(verify_sha256_hex("0000", digest).is_err());
    }

    #[test]
    fn marker_validation_detects_incomplete_venv() {
        let base =
            std::env::temp_dir().join(format!("deepseek-py-runtime-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        assert!(!is_managed_venv_ready(&base));

        let bin_dir = venv_dir(&base).join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(bin_dir.join("python3"), b"stub").unwrap();
        // Missing marker -> still not ready.
        assert!(!is_managed_venv_ready(&base));

        // Wrong marker -> not ready.
        fs::write(venv_dir(&base).join(READY_MARKER_NAME), "old-version\n").unwrap();
        assert!(!is_managed_venv_ready(&base));

        // Expected marker -> ready.
        fs::write(venv_dir(&base).join(READY_MARKER_NAME), expected_marker()).unwrap();
        assert!(is_managed_venv_ready(&base));

        reset_managed_python(&base).unwrap();
        assert!(!is_managed_venv_ready(&base));
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn current_platform_has_pinned_spec() {
        let spec = current_runtime_spec().expect("spec should exist on macOS/Linux");
        assert!(
            spec.url
                .starts_with("https://github.com/astral-sh/python-build-standalone/")
        );
        assert_eq!(spec.sha256.len(), 64);
    }
}
