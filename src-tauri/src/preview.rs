//! Isolated child webview for previewing HTML and PDF files inside the main window.
//!
//! Security boundaries:
//! - Served via the custom `ds-preview` URI scheme exclusively to `"file-preview"`.
//! - `"file-preview"` is NOT `"main"` and has no Tauri IPC capabilities.
//! - Uses a separate ephemeral/isolated data store from both `"main"` and `"browser-tab-*"`.
//! - Navigation inside `"file-preview"` is restricted to `ds-preview` and `about:blank`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::ipc::{InvokeBody, Request};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, UriSchemeContext, Webview, WebviewUrl,
};
use url::Url;

use crate::browser::{
    BrowserBounds, BrowserSnapshotResult, MAIN_WEBVIEW_LABEL, ensure_main_webview,
    platform_take_snapshot, sanitize_zoom,
};

pub const PREVIEW_WEBVIEW_LABEL: &str = "file-preview";
const PREVIEW_SCHEME: &str = "ds-preview";
/// Separate isolated data store ID so file previews never share cookies/storage with BrowserPanel.
const PREVIEW_DATA_STORE_ID: [u8; 16] = *b"ds-preview-v0001";

const HTML_SANDBOX_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data: blob:; img-src * data: blob:; font-src https: data:; media-src * data: blob:; connect-src https: data: blob:; worker-src blob:; frame-src 'none'; object-src 'none';";

pub struct PreviewState {
    bytes: Mutex<Vec<u8>>,
    mime_type: Mutex<String>,
    nonce: AtomicU64,
    bounds: Mutex<Option<BrowserBounds>>,
    zoom: Mutex<f64>,
    visible: AtomicBool,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            bytes: Mutex::new(Vec::new()),
            mime_type: Mutex::new("text/html; charset=utf-8".to_string()),
            nonce: AtomicU64::new(0),
            bounds: Mutex::new(None),
            zoom: Mutex::new(1.0),
            visible: AtomicBool::new(false),
        }
    }
}

fn preview_url(nonce: u64, is_pdf: bool) -> Url {
    let ext = if is_pdf { "pdf" } else { "html" };
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let raw = format!("http://{PREVIEW_SCHEME}.localhost/{nonce}.{ext}");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let raw = format!("{PREVIEW_SCHEME}://localhost/{nonce}.{ext}");
    Url::parse(&raw).expect("valid preview URL")
}

fn is_allowed_preview_navigation(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() == PREVIEW_SCHEME {
        return true;
    }
    #[cfg(any(target_os = "windows", target_os = "android"))]
    if (url.scheme() == "http" || url.scheme() == "https")
        && url.host_str() == Some("ds-preview.localhost")
    {
        return true;
    }
    false
}

pub fn handle_protocol<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    _request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if ctx.webview_label() != PREVIEW_WEBVIEW_LABEL {
        return tauri::http::Response::builder()
            .status(403)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(b"Forbidden".to_vec())
            .expect("valid forbidden response");
    }

    let state = ctx.app_handle().state::<PreviewState>();
    let bytes = state
        .bytes
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let mime = state
        .mime_type
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| "text/html; charset=utf-8".to_string());

    let mut builder = tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime.as_str())
        .header("Cache-Control", "no-store");

    if mime.starts_with("text/html") {
        builder = builder.header("Content-Security-Policy", HTML_SANDBOX_CSP);
    }

    builder.body(bytes).expect("valid preview response")
}

fn ensure_preview_webview(
    app: &AppHandle,
    state: &PreviewState,
    url: Url,
    bounds: BrowserBounds,
    visible: bool,
    zoom: f64,
) -> Result<Webview, String> {
    if let Some(existing) = app.get_webview(PREVIEW_WEBVIEW_LABEL) {
        return Ok(existing);
    }

    let window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let sanitized = bounds.sanitized();

    let mut builder = WebviewBuilder::new(PREVIEW_WEBVIEW_LABEL, WebviewUrl::CustomProtocol(url))
        .disable_drag_drop_handler()
        .focused(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(PREVIEW_DATA_STORE_ID);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            builder = builder.data_directory(dir.join("preview-profile"));
        }
    }

    builder = builder
        .on_navigation(|target_url| is_allowed_preview_navigation(target_url))
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_wv, event| {
            let _ = matches!(event, DownloadEvent::Requested { .. });
            false
        });

    let created = window
        .add_child(
            builder,
            LogicalPosition::new(sanitized.x, sanitized.y),
            LogicalSize::new(sanitized.width, sanitized.height),
        )
        .map_err(|e| format!("Failed to create preview webview: {e}"))?;

    let clamped_zoom = sanitize_zoom(zoom);
    if (clamped_zoom - 1.0).abs() > f64::EPSILON {
        let _ = created.set_zoom(clamped_zoom);
    }
    if !visible {
        let _ = created.hide();
    }
    let _ = state;
    Ok(created)
}

#[tauri::command]
pub async fn preview_set_content(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, PreviewState>,
    request: Request<'_>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("preview_set_content expects raw bytes".into());
    };
    let raw_mime = request
        .headers()
        .get("x-mime-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html");
    let is_pdf = raw_mime.eq_ignore_ascii_case("application/pdf");
    let mime = if is_pdf {
        "application/pdf".to_string()
    } else if raw_mime.to_ascii_lowercase().starts_with("text/html") {
        "text/html; charset=utf-8".to_string()
    } else {
        return Err(format!("Unsupported preview webview MIME type: {raw_mime}"));
    };

    {
        let mut content = state
            .bytes
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        *content = bytes.clone();
    }
    {
        let mut mime_guard = state
            .mime_type
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        *mime_guard = mime;
    }

    let nonce = state.nonce.fetch_add(1, Ordering::Relaxed) + 1;
    let url = preview_url(nonce, is_pdf);
    let bounds = state
        .bounds
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .unwrap_or(BrowserBounds {
            x: 640.0,
            y: 96.0,
            width: 540.0,
            height: 700.0,
        });
    let visible = state.visible.load(Ordering::Relaxed);
    let zoom = *state
        .zoom
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;

    if let Some(existing) = app.get_webview(PREVIEW_WEBVIEW_LABEL) {
        existing
            .navigate(url)
            .map_err(|e| format!("Failed to load preview content: {e}"))?;
        let _ = existing.set_bounds(bounds.to_rect());
        let _ = existing.set_zoom(sanitize_zoom(zoom));
        if visible {
            let _ = existing.show();
        } else {
            let _ = existing.hide();
        }
    } else {
        ensure_preview_webview(&app, &state, url, bounds, visible, zoom)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_set_bounds(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, PreviewState>,
    bounds: BrowserBounds,
    zoom: Option<f64>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let sanitized = bounds.sanitized();
    {
        let mut b = state
            .bounds
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        *b = Some(sanitized);
    }
    if let Some(next_zoom) = zoom {
        let mut z = state
            .zoom
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        *z = sanitize_zoom(next_zoom);
    }
    if let Some(wv) = app.get_webview(PREVIEW_WEBVIEW_LABEL) {
        if let Some(next_zoom) = zoom {
            let _ = wv.set_zoom(sanitize_zoom(next_zoom));
        }
        wv.set_bounds(sanitized.to_rect())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_set_visible(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, PreviewState>,
    visible: bool,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    state.visible.store(visible, Ordering::Relaxed);
    if let Some(wv) = app.get_webview(PREVIEW_WEBVIEW_LABEL) {
        if visible {
            if let Ok(guard) = state.bounds.lock()
                && let Some(b) = *guard
            {
                let _ = wv.set_bounds(b.to_rect());
            }
            if let Ok(z) = state.zoom.lock() {
                let _ = wv.set_zoom(sanitize_zoom(*z));
            }
            wv.show().map_err(|e| e.to_string())?;
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_reload(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, PreviewState>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let is_pdf = state
        .mime_type
        .lock()
        .map(|m| m.starts_with("application/pdf"))
        .unwrap_or(false);
    let nonce = state.nonce.fetch_add(1, Ordering::Relaxed) + 1;
    let url = preview_url(nonce, is_pdf);
    if let Some(wv) = app.get_webview(PREVIEW_WEBVIEW_LABEL) {
        wv.navigate(url)
            .map_err(|e| format!("Failed to reload preview: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_take_snapshot(
    app: AppHandle,
    webview: Webview,
    max_width: Option<f64>,
) -> Result<BrowserSnapshotResult, String> {
    ensure_main_webview(&webview)?;
    let wv = app
        .get_webview(PREVIEW_WEBVIEW_LABEL)
        .ok_or_else(|| "Preview webview is not created".to_string())?;
    platform_take_snapshot(&wv, max_width.unwrap_or(1280.0)).await
}

#[tauri::command]
pub async fn preview_open_devtools(app: AppHandle, webview: Webview) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    #[cfg(debug_assertions)]
    {
        let wv = app
            .get_webview(PREVIEW_WEBVIEW_LABEL)
            .ok_or_else(|| "Preview webview is not created".to_string())?;
        wv.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Err("DevTools is only available in debug builds.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_preview_navigation_to_isolated_scheme_and_blank() {
        assert!(is_allowed_preview_navigation(
            &Url::parse("ds-preview://localhost/1.html").unwrap()
        ));
        assert!(is_allowed_preview_navigation(
            &Url::parse("about:blank").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("https://example.com").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("http://127.0.0.1:8090").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("file:///etc/passwd").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("tauri://localhost").unwrap()
        ));
        assert!(!is_allowed_preview_navigation(
            &Url::parse("javascript:alert(1)").unwrap()
        ));
    }

    #[test]
    fn formats_platform_preview_urls() {
        let html_url = preview_url(7, false);
        let pdf_url = preview_url(9, true);
        assert!(is_allowed_preview_navigation(&html_url));
        assert!(is_allowed_preview_navigation(&pdf_url));
        assert!(html_url.as_str().ends_with("/7.html"));
        assert!(pdf_url.as_str().ends_with("/9.pdf"));
    }
}
