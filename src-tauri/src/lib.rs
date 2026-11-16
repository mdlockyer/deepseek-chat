//! Native side of the DeepSeek Chat desktop app.
//!
//! The web UI stays the same as the browser build; this crate replaces the few
//! browser features that do not work, or are not safe enough, inside a desktop
//! webview:
//!
//! - The DeepSeek API key lives in the OS credential store (the macOS
//!   Keychain) instead of the webview's localStorage.
//! - Files the Python tool offers for download are saved through a native save
//!   dialog. WKWebView ignores `<a download>` links to `blob:` URLs
//!   (WebKit bug 216918), so the browser path does nothing there. The page never
//!   gets general file-system access: this one command shows the dialog and
//!   writes the bytes to the path the user picked.
//! - API requests go out through `tauri-plugin-http` (reqwest) instead of the
//!   webview's fetch, so CORS does not apply to the app's `tauri://` origin. The
//!   capability file allows only `https://api.deepseek.com/*`.
//! - Links that would open a new browser window (`target="_blank"`) open in the
//!   default browser through `tauri-plugin-opener`; the webview ignores them.

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

/// Keychain service and account under which the API key is stored.
const KEYCHAIN_SERVICE: &str = "com.mlockyer.deepseekchat";
const API_KEY_ACCOUNT: &str = "deepseek-api-key";

fn api_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, API_KEY_ACCOUNT).map_err(|e| e.to_string())
}

/// Returns the stored API key, or `None` when none has been saved.
#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    match api_key_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Stores the API key; `None` or an empty string deletes it.
#[tauri::command]
fn set_api_key(key: Option<String>) -> Result<(), String> {
    let entry = api_key_entry()?;
    match key.filter(|key| !key.is_empty()) {
        Some(key) => entry.set_password(&key).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

/// Shows a save dialog and writes the request body to the chosen path.
///
/// The body is the raw file bytes. The suggested file name arrives in the
/// `x-file-name` header, percent-encoded because header values must be ASCII.
/// Returns `false` when the user cancels the dialog.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file expects the file bytes as a raw request body".into());
    };
    let bytes = bytes.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "download".to_string());

    // The dialog call blocks until the user answers, so keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name(&name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            save_file
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the DeepSeek Chat app");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a dummy key through the real OS credential store, then deletes it.
    /// Ignored by default because it touches the user's Keychain entry; run with
    /// `cargo test -- --ignored keychain` only when no real key is stored.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        assert_eq!(
            get_api_key().unwrap(),
            None,
            "a real key is stored; not overwriting it"
        );
        set_api_key(Some("sk-test-roundtrip".into())).unwrap();
        assert_eq!(get_api_key().unwrap().as_deref(), Some("sk-test-roundtrip"));
        set_api_key(Some(String::new())).unwrap();
        assert_eq!(get_api_key().unwrap(), None);
        set_api_key(None).unwrap();
    }
}
