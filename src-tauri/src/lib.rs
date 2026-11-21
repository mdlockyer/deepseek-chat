//! Native side of the DeepSeek desktop app.
//!
//! The web UI stays the same as the browser build; this crate replaces the few
//! browser features that do not work, or are not safe enough, inside a desktop
//! webview:
//!
//! - The DeepSeek API key is stored in the app's private data directory
//!   (`api-key` with `0600` permissions on Unix) instead of the webview's
//!   `localStorage`, with one-time migration from any readable legacy macOS
//!   Keychain entry.
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

mod browser;
mod preview;
mod python;
mod python_runtime;
mod python_sandbox;

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// Keychain service and account under which legacy API keys may be stored.
const KEYCHAIN_SERVICE: &str = "com.mlockyer.deepseekchat";
const API_KEY_ACCOUNT: &str = "deepseek-api-key";
const API_KEY_FILE_NAME: &str = "api-key";
const FIRECRAWL_API_KEY_FILE_NAME: &str = "firecrawl-api-key";
#[cfg(target_os = "macos")]
const SETTINGS_MENU_ID: &str = "open-settings";
#[cfg(target_os = "macos")]
const OPEN_SETTINGS_EVENT: &str = "open-settings";

fn api_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, API_KEY_ACCOUNT).map_err(|e| e.to_string())
}

fn key_file_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(name))
        .map_err(|e| e.to_string())
}

fn api_key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    key_file_path(app, API_KEY_FILE_NAME)
}

fn read_key_file(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents.trim().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_key_file(path: &Path, key: Option<&str>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let value = key.map(str::trim).unwrap_or("");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        file.write_all(value.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, value.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the stored API key, or `None` when none has been saved.
///
/// Reads from the app's private data directory first so ad-hoc signed dev and
/// release builds do not lose access across rebuilds due to macOS Keychain ACLs.
/// If no local file exists yet, migrates any readable legacy Keychain entry.
#[tauri::command]
async fn get_api_key(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Option<String>, String> {
    browser::ensure_main_webview(&webview)?;
    let path = api_key_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(stored) = read_key_file(&path)? {
            return Ok((!stored.is_empty()).then_some(stored));
        }
        let migrated = match api_key_entry()
            .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
        {
            Ok(key) => {
                let trimmed = key.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            Err(error) => {
                log::warn!("Skipping keychain API key lookup: {error}");
                None
            }
        };
        if let Some(ref key) = migrated
            && let Err(error) = write_key_file(&path, Some(key))
        {
            log::warn!("Failed to cache migrated API key: {error}");
        }
        Ok(migrated)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stores the API key; `None` or an empty string clears it.
#[tauri::command]
async fn set_api_key(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    key: Option<String>,
) -> Result<(), String> {
    browser::ensure_main_webview(&webview)?;
    let path = api_key_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cleaned = key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        write_key_file(&path, cleaned)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the stored Firecrawl API key, or `None` when none has been saved.
#[tauri::command]
async fn get_firecrawl_api_key(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Option<String>, String> {
    browser::ensure_main_webview(&webview)?;
    let path = key_file_path(&app, FIRECRAWL_API_KEY_FILE_NAME)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(read_key_file(&path)?.filter(|stored| !stored.is_empty()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stores the Firecrawl API key; `None` or an empty string clears it.
#[tauri::command]
async fn set_firecrawl_api_key(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    key: Option<String>,
) -> Result<(), String> {
    browser::ensure_main_webview(&webview)?;
    let path = key_file_path(&app, FIRECRAWL_API_KEY_FILE_NAME)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cleaned = key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        write_key_file(&path, cleaned)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shows a save dialog and writes the request body to the chosen path.
///
/// The body is the raw file bytes. The suggested file name arrives in the
/// `x-file-name` header, percent-encoded because header values must be ASCII.
/// Returns `false` when the user cancels the dialog.
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: Request<'_>,
) -> Result<bool, String> {
    browser::ensure_main_webview(&webview)?;
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

#[cfg(target_os = "macos")]
fn build_macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.into_iter().next() {
        let settings_item = MenuItem::with_id(
            app,
            SETTINGS_MENU_ID,
            "Settings...",
            true,
            Some("CmdOrCtrl+,"),
        )?;
        let separator = PredefinedMenuItem::separator(app)?;
        app_submenu.insert_items(&[&settings_item, &separator], 2)?;
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(browser::BrowserState::default())
        .manage(preview::PreviewState::default())
        .manage(python::PythonState::default())
        .register_uri_scheme_protocol("ds-preview", preview::handle_protocol)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            get_firecrawl_api_key,
            set_firecrawl_api_key,
            save_file,
            browser::browser_set_options,
            browser::browser_create_tab,
            browser::browser_close_tab,
            browser::browser_set_active_tab,
            browser::browser_set_bounds,
            browser::browser_set_zoom,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_history,
            browser::browser_get_state,
            browser::browser_eval_js,
            browser::browser_take_snapshot,
            browser::browser_clear_data,
            browser::browser_open_devtools,
            preview::preview_set_content,
            preview::preview_set_bounds,
            preview::preview_set_visible,
            preview::preview_reload,
            preview::preview_take_snapshot,
            preview::preview_open_devtools,
            python::python_run,
            python::python_interrupt,
            python::python_reset,
            python::python_stage_upload,
            python::python_runtime_status,
            python::python_runtime_reset
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_macos_menu).on_menu_event(|app, event| {
        if event.id() == SETTINGS_MENU_ID {
            let _ = app.emit(OPEN_SETTINGS_EVENT, ());
        }
    });

    builder
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
        .expect("error while running the DeepSeek app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("deepseek-chat-test-{}", std::process::id()));
        let path = dir.join(API_KEY_FILE_NAME);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(read_key_file(&path).unwrap(), None);

        write_key_file(&path, Some("  sk-test-123  ")).unwrap();
        assert_eq!(
            read_key_file(&path).unwrap().as_deref(),
            Some("sk-test-123")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        write_key_file(&path, None).unwrap();
        assert_eq!(read_key_file(&path).unwrap().as_deref(), Some(""));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
