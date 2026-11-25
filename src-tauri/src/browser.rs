//! Built-in side-panel browser managed as isolated child webviews inside the main window.
//!
//! Security boundaries:
//! - Every Tauri command validates that the caller is the `"main"` UI webview (`ensure_main_webview`).
//! - Browser tab webviews live in an isolated data store (`data_store_identifier` on macOS 14+,
//!   separate directory elsewhere), completely separate from `"main"`.
//! - Navigation allows only `http://`, `https://`, and `about:blank`, and blocks model-initiated
//!   requests to loopback, link-local, or RFC1918 private hosts unless explicitly enabled.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewUrl};
use url::Url;

pub const MAIN_WEBVIEW_LABEL: &str = "main";
const BROWSER_TAB_PREFIX: &str = "browser-tab-";
const MAX_OPEN_TABS: usize = 24;
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 15_000;
const MAX_EVAL_TIMEOUT_MS: u64 = 60_000;
const MIN_VIEWPORT_ZOOM: f64 = 0.25;
const MAX_VIEWPORT_ZOOM: f64 = 4.0;
/// Persistent isolated data store ID for the built-in browser (`WKWebsiteDataStore` on macOS 14+).
const BROWSER_DATA_STORE_ID: [u8; 16] = *b"ds-browser-v0001";

/// Default desktop browser User-Agent so sites serve full modern pages instead of
/// stripped-down embedded-webview fallbacks (bare WKWebView/WebKitGTK omit `Version/... Safari/...`).
#[cfg(target_os = "macos")]
pub(crate) const BROWSER_USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
);
#[cfg(target_os = "linux")]
pub(crate) const BROWSER_USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
);
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) const BROWSER_USER_AGENT: Option<&str> = None;

/// Ensures a command was invoked strictly from the trusted `"main"` UI webview.
pub fn ensure_main_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() != MAIN_WEBVIEW_LABEL {
        return Err("Unauthorized webview caller".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    pub(crate) fn sanitized(self) -> Self {
        Self {
            x: self.x.max(0.0),
            y: self.y.max(0.0),
            width: self.width.max(1.0),
            height: self.height.max(1.0),
        }
    }

    pub(crate) fn to_rect(self) -> Rect {
        let b = self.sanitized();
        Rect {
            position: LogicalPosition::new(b.x, b.y).into(),
            size: LogicalSize::new(b.width, b.height).into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabStateEvent {
    pub tab_id: String,
    pub url: String,
    pub title: Option<String>,
    pub is_loading: Option<bool>,
    pub can_go_back: Option<bool>,
    pub can_go_forward: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewTabEvent {
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBlockedEvent {
    pub tab_id: String,
    pub url: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateResult {
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Debug, Clone)]
struct TabMeta {
    label: String,
    zoom: f64,
    allow_private_nav: bool,
}

fn default_zoom() -> f64 {
    1.0
}

pub fn sanitize_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() {
        return 1.0;
    }
    zoom.clamp(MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTabOptions {
    pub tab_id: String,
    pub url: String,
    pub bounds: BrowserBounds,
    pub visible: bool,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    #[serde(default)]
    pub initiator: Option<String>,
}

pub struct BrowserState {
    tabs: Mutex<HashMap<String, TabMeta>>,
    active_tab_id: Mutex<Option<String>>,
    bounds: Mutex<Option<BrowserBounds>>,
    visible: AtomicBool,
    allow_localhost: AtomicBool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            tabs: Mutex::new(HashMap::new()),
            active_tab_id: Mutex::new(None),
            bounds: Mutex::new(None),
            visible: AtomicBool::new(false),
            allow_localhost: AtomicBool::new(false),
        }
    }
}

impl BrowserState {
    fn tab_label(&self, tab_id: &str) -> Result<String, String> {
        let tabs = self
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        tabs.get(tab_id)
            .map(|meta| meta.label.clone())
            .ok_or_else(|| format!("Unknown browser tab: {tab_id}"))
    }

    fn tab_zoom(&self, tab_id: &str) -> Option<f64> {
        self.tabs
            .lock()
            .ok()
            .and_then(|tabs| tabs.get(tab_id).map(|meta| meta.zoom))
    }

    fn set_tab_zoom(&self, tab_id: &str, zoom: f64) -> Result<(), String> {
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        let meta = tabs
            .get_mut(tab_id)
            .ok_or_else(|| format!("Unknown browser tab: {tab_id}"))?;
        meta.zoom = zoom;
        Ok(())
    }

    fn tab_allows_private_nav(&self, tab_id: &str, default_val: bool) -> bool {
        self.tabs
            .lock()
            .ok()
            .and_then(|tabs| tabs.get(tab_id).map(|meta| meta.allow_private_nav))
            .unwrap_or(default_val)
    }

    fn set_tab_allows_private_nav(&self, tab_id: &str, allow: bool) {
        if let Ok(mut tabs) = self.tabs.lock()
            && let Some(meta) = tabs.get_mut(tab_id)
        {
            meta.allow_private_nav = allow;
        }
    }
}

fn is_valid_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn normalize_ip_host(host: &str) -> String {
    let trimmed = host.trim_matches(['[', ']']);
    let without_zone = trimmed.split('%').next().unwrap_or(trimmed);
    without_zone.to_ascii_lowercase()
}

fn is_link_local_v4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 169 && o[1] == 254
}

fn is_private_or_loopback_v4(v4: std::net::Ipv4Addr) -> bool {
    v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
}

fn is_link_local_or_metadata(host: &str) -> bool {
    let normalized = normalize_ip_host(host);
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_link_local_v4(v4),
            IpAddr::V6(v6) => {
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return is_link_local_v4(mapped);
                }
                (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

fn is_private_or_loopback_host(host: &str) -> bool {
    let lower = normalize_ip_host(host);
    if lower == "localhost" || lower.ends_with(".localhost") || lower == "0.0.0.0" || lower == "::"
    {
        return true;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_private_or_loopback_v4(v4),
            IpAddr::V6(v6) => {
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return is_private_or_loopback_v4(mapped);
                }
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

/// Validates a target URL before loading it into the browser webview.
pub fn validate_browser_url(
    raw: &str,
    allow_blank: bool,
    is_model_initiator: bool,
    allow_localhost: bool,
) -> Result<Url, String> {
    let trimmed = raw.trim();
    if allow_blank && trimmed == "about:blank" {
        return Url::parse("about:blank").map_err(|e| e.to_string());
    }
    let url = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "Unsupported URL scheme `{other}:`. Only http:// and https:// are allowed."
            ));
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL must contain a host".to_string())?;
    if is_link_local_or_metadata(host) {
        return Err("Access to link-local or cloud metadata addresses is blocked.".into());
    }
    if is_model_initiator && !allow_localhost && is_private_or_loopback_host(host) {
        return Err(
            "Model navigation to localhost/private network addresses is disabled. Enable it in Settings or navigate manually."
                .into(),
        );
    }
    Ok(url)
}

fn is_allowed_navigation(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "http" | "https" => !url.host_str().is_some_and(is_link_local_or_metadata),
        _ => false,
    }
}

fn is_allowed_navigation_for_tab(
    url: &Url,
    allow_localhost: bool,
    tab_allows_private: bool,
) -> bool {
    if !is_allowed_navigation(url) {
        return false;
    }
    if !allow_localhost
        && !tab_allows_private
        && url.host_str().is_some_and(is_private_or_loopback_host)
    {
        return false;
    }
    true
}

fn ensure_model_access_allowed(url: &Url, allow_localhost: bool) -> Result<(), String> {
    if url.host_str().is_some_and(is_link_local_or_metadata) {
        return Err("Access to link-local or cloud metadata addresses is blocked.".into());
    }
    if !allow_localhost && url.host_str().is_some_and(is_private_or_loopback_host) {
        return Err(
            "Model access to localhost/private network addresses is disabled. Enable it in Settings."
                .into(),
        );
    }
    Ok(())
}

fn get_tab_webview(app: &AppHandle, state: &BrowserState, tab_id: &str) -> Result<Webview, String> {
    let label = state.tab_label(tab_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("Browser webview `{label}` is no longer attached"))
}

struct SpawnTabConfig {
    tab_id: String,
    url: Url,
    bounds: BrowserBounds,
    visible: bool,
    zoom: f64,
    allow_private_nav: bool,
}

fn spawn_tab_webview(
    app: &AppHandle,
    state: &BrowserState,
    cfg: SpawnTabConfig,
) -> Result<Webview, String> {
    let SpawnTabConfig {
        tab_id,
        url,
        bounds,
        visible,
        zoom,
        allow_private_nav,
    } = cfg;
    let tab_id = tab_id.as_str();
    {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        if tabs.contains_key(tab_id) {
            return Err(format!("Browser tab `{tab_id}` already exists"));
        }
        if tabs.len() >= MAX_OPEN_TABS {
            return Err(format!(
                "Maximum of {MAX_OPEN_TABS} open browser tabs reached."
            ));
        }
    }

    let window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let label = format!("{BROWSER_TAB_PREFIX}{tab_id}");
    let sanitized = bounds.sanitized();

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .disable_drag_drop_handler()
        .focused(false);

    if let Some(ua) = BROWSER_USER_AGENT {
        builder = builder.user_agent(ua);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(BROWSER_DATA_STORE_ID);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            builder = builder.data_directory(dir.join("browser-profile"));
        }
    }

    let app_nav = app.clone();
    let tab_nav = tab_id.to_string();
    builder = builder.on_navigation(move |target_url| {
        let nav_state = app_nav.state::<BrowserState>();
        let allow_localhost = nav_state.allow_localhost.load(Ordering::Relaxed);
        let tab_allows_private = nav_state.tab_allows_private_nav(&tab_nav, allow_private_nav);
        if is_allowed_navigation_for_tab(target_url, allow_localhost, tab_allows_private) {
            return true;
        }
        let _ = app_nav.emit_to(
            MAIN_WEBVIEW_LABEL,
            "browser://navigation-blocked",
            BrowserBlockedEvent {
                tab_id: tab_nav.clone(),
                url: target_url.to_string(),
                reason: "Blocked unsupported or restricted URL".into(),
            },
        );
        false
    });

    let app_title = app.clone();
    let tab_title = tab_id.to_string();
    builder = builder.on_document_title_changed(move |_wv, title| {
        let _ = app_title.emit_to(
            MAIN_WEBVIEW_LABEL,
            "browser://state",
            BrowserTabStateEvent {
                tab_id: tab_title.clone(),
                url: String::new(),
                title: Some(title),
                is_loading: None,
                can_go_back: None,
                can_go_forward: None,
            },
        );
    });

    let app_load = app.clone();
    let tab_load = tab_id.to_string();
    builder = builder.on_page_load(move |wv, payload| {
        if let Some(saved_zoom) = app_load.state::<BrowserState>().tab_zoom(&tab_load)
            && (saved_zoom - 1.0).abs() > f64::EPSILON
        {
            let _ = wv.set_zoom(saved_zoom);
        }
        let (can_go_back, can_go_forward) = platform_history_flags(&wv);
        let is_loading = matches!(payload.event(), PageLoadEvent::Started);
        let _ = app_load.emit_to(
            MAIN_WEBVIEW_LABEL,
            "browser://state",
            BrowserTabStateEvent {
                tab_id: tab_load.clone(),
                url: payload.url().to_string(),
                title: None,
                is_loading: Some(is_loading),
                can_go_back: Some(can_go_back),
                can_go_forward: Some(can_go_forward),
            },
        );
    });

    let app_popup = app.clone();
    let tab_popup = tab_id.to_string();
    builder = builder.on_new_window(move |target_url, _features| {
        let popup_state = app_popup.state::<BrowserState>();
        let allow_localhost = popup_state.allow_localhost.load(Ordering::Relaxed);
        let tab_allows_private = popup_state.tab_allows_private_nav(&tab_popup, allow_private_nav);
        if is_allowed_navigation_for_tab(&target_url, allow_localhost, tab_allows_private)
            && target_url.as_str() != "about:blank"
        {
            let _ = app_popup.emit_to(
                MAIN_WEBVIEW_LABEL,
                "browser://new-tab-requested",
                BrowserNewTabEvent {
                    tab_id: tab_popup.clone(),
                    url: target_url.to_string(),
                },
            );
        }
        NewWindowResponse::Deny
    });

    let app_dl = app.clone();
    let tab_dl = tab_id.to_string();
    builder = builder.on_download(move |_wv, event| {
        if let DownloadEvent::Requested { url, .. } = event {
            let _ = app_dl.emit_to(
                MAIN_WEBVIEW_LABEL,
                "browser://download-blocked",
                BrowserBlockedEvent {
                    tab_id: tab_dl.clone(),
                    url: url.to_string(),
                    reason: "Downloads inside the built-in browser are disabled for safety".into(),
                },
            );
        }
        false
    });

    let created = window
        .add_child(
            builder,
            LogicalPosition::new(sanitized.x, sanitized.y),
            LogicalSize::new(sanitized.width, sanitized.height),
        )
        .map_err(|e| format!("Failed to create browser webview: {e}"))?;

    let zoom = sanitize_zoom(zoom);
    if (zoom - 1.0).abs() > f64::EPSILON {
        let _ = created.set_zoom(zoom);
    }

    if !visible {
        let _ = created.hide();
    }

    {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        tabs.insert(
            tab_id.to_string(),
            TabMeta {
                label,
                zoom,
                allow_private_nav,
            },
        );
    }

    Ok(created)
}

#[cfg(target_os = "macos")]
fn platform_history_flags(webview: &Webview) -> (bool, bool) {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let res = webview.with_webview(move |platform| unsafe {
        let wk: &objc2_web_kit::WKWebView = &*platform.inner().cast();
        let _ = tx.send((wk.canGoBack(), wk.canGoForward()));
    });
    if res.is_err() {
        return (false, false);
    }
    rx.recv().unwrap_or((false, false))
}

#[cfg(not(target_os = "macos"))]
fn platform_history_flags(_webview: &Webview) -> (bool, bool) {
    (false, false)
}

#[cfg(target_os = "macos")]
fn platform_history_action(webview: &Webview, action: &str) -> Result<(), String> {
    let action = action.to_string();
    webview
        .with_webview(move |platform| unsafe {
            let wk: &objc2_web_kit::WKWebView = &*platform.inner().cast();
            match action.as_str() {
                "back" => {
                    wk.goBack();
                }
                "forward" => {
                    wk.goForward();
                }
                "reload" => {
                    wk.reload();
                }
                "stop" => {
                    wk.stopLoading();
                }
                _ => {}
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn platform_history_action(webview: &Webview, action: &str) -> Result<(), String> {
    match action {
        "back" => webview.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => webview.reload().map_err(|e| e.to_string()),
        "stop" => webview.eval("window.stop()").map_err(|e| e.to_string()),
        _ => Err(format!("Unknown history action: {action}")),
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn platform_eval_js(
    webview: &Webview,
    script: String,
    isolated_world: bool,
    timeout: Duration,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        MainThreadMarker, NSError, NSJSONSerialization, NSJSONWritingOptions, NSString,
        NSUTF8StringEncoding,
    };
    use objc2_web_kit::{WKContentWorld, WKWebView};
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let tx_slot = Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |platform| unsafe {
            let wk: &WKWebView = &*platform.inner().cast();
            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(tx) = tx_slot.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(Err("Not running on macOS main thread".into()));
                }
                return;
            };
            let world = if isolated_world {
                WKContentWorld::defaultClientWorld(mtm)
            } else {
                WKContentWorld::pageWorld(mtm)
            };
            let body = NSString::from_str(&script);
            let tx_cb = Arc::clone(&tx_slot);
            let handler = RcBlock::new(move |val: *mut AnyObject, err: *mut NSError| {
                let Some(tx) = tx_cb.lock().ok().and_then(|mut g| g.take()) else {
                    return;
                };
                if !err.is_null() {
                    let msg = (*err).localizedDescription().to_string();
                    let _ = tx.send(Err(msg));
                    return;
                }
                if let Some(obj) = NonNull::new(val) {
                    if let Some(s) = obj.as_ref().downcast_ref::<NSString>() {
                        let _ = tx.send(Ok(s.to_string()));
                        return;
                    }
                    if let Ok(json_data) = NSJSONSerialization::dataWithJSONObject_options_error(
                        obj.as_ref(),
                        NSJSONWritingOptions::FragmentsAllowed,
                    ) {
                        let json_str = NSString::initWithData_encoding(
                            objc2::AnyThread::alloc(),
                            &json_data,
                            NSUTF8StringEncoding,
                        );
                        if let Some(s) = json_str {
                            let _ = tx.send(Ok(s.to_string()));
                            return;
                        }
                    }
                    let _ = tx.send(Ok("null".into()));
                    return;
                }
                let _ = tx.send(Ok("null".into()));
            });
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &body,
                None,
                None,
                &world,
                Some(&handler),
            );
        })
        .map_err(|e| e.to_string())?;

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Browser script execution channel closed".into()),
        Err(_) => Err("Browser script execution timed out".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn platform_eval_js(
    webview: &Webview,
    script: String,
    _isolated_world: bool,
    timeout: Duration,
) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<String>();
    let tx_slot = Arc::new(Mutex::new(Some(tx)));
    let wrapped = format!("(function() {{ {script} }})()");
    webview
        .eval_with_callback(&wrapped, move |out| {
            if let Some(tx) = tx_slot.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(out);
            }
        })
        .map_err(|e| e.to_string())?;

    let raw = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| "Browser script execution timed out".to_string())?
        .map_err(|_| "Browser script execution channel closed".to_string())?;

    if raw.is_empty() {
        return Ok("null".into());
    }
    if let Ok(unwrapped) = serde_json::from_str::<String>(&raw) {
        return Ok(unwrapped);
    }
    Ok(raw)
}

#[cfg(target_os = "macos")]
pub(crate) async fn platform_take_snapshot(
    webview: &Webview,
    max_width: f64,
) -> Result<BrowserSnapshotResult, String> {
    use base64::Engine;
    use block2::RcBlock;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor,
    };
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Result<BrowserSnapshotResult, String>>();
    let tx_slot = Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |platform| unsafe {
            let wk: &WKWebView = &*platform.inner().cast();
            let Some(mtm) = MainThreadMarker::new() else {
                if let Some(tx) = tx_slot.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(Err("Not running on macOS main thread".into()));
                }
                return;
            };
            let frame_width = wk.frame().size.width;
            let cfg = WKSnapshotConfiguration::new(mtm);
            cfg.setAfterScreenUpdates(true);
            if max_width > 0.0 && frame_width > max_width {
                let target = NSNumber::numberWithDouble(max_width);
                cfg.setSnapshotWidth(Some(&target));
            }
            let tx_cb = Arc::clone(&tx_slot);
            let handler = RcBlock::new(move |image: *mut NSImage, err: *mut NSError| {
                let Some(tx) = tx_cb.lock().ok().and_then(|mut g| g.take()) else {
                    return;
                };
                if !err.is_null() {
                    let _ = tx.send(Err((*err).localizedDescription().to_string()));
                    return;
                }
                if image.is_null() {
                    let _ = tx.send(Err("Snapshot returned null image".into()));
                    return;
                }
                let ns_image = &*image;
                let size = ns_image.size();
                let Some(tiff) = ns_image.TIFFRepresentation() else {
                    let _ = tx.send(Err("Failed to encode snapshot TIFF".into()));
                    return;
                };
                let Some(bitmap) = NSBitmapImageRep::imageRepWithData(&tiff) else {
                    let _ = tx.send(Err("Failed to build NSBitmapImageRep".into()));
                    return;
                };
                let quality = NSNumber::numberWithDouble(0.76);
                let quality_obj: &objc2::runtime::AnyObject =
                    &*(quality.as_ref() as *const NSNumber as *const objc2::runtime::AnyObject);
                let props = NSDictionary::from_slices(&[NSImageCompressionFactor], &[quality_obj]);
                let Some(jpeg_data) =
                    bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props)
                else {
                    let _ = tx.send(Err("Failed to encode snapshot JPEG".into()));
                    return;
                };
                let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg_data.to_vec());
                let _ = tx.send(Ok(BrowserSnapshotResult {
                    data_url: format!("data:image/jpeg;base64,{encoded}"),
                    width: size.width.max(1.0).round() as u32,
                    height: size.height.max(1.0).round() as u32,
                }));
            });
            wk.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &handler);
        })
        .map_err(|e| e.to_string())?;

    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Browser snapshot channel closed".into()),
        Err(_) => Err("Browser snapshot timed out".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn platform_take_snapshot(
    _webview: &Webview,
    _max_width: f64,
) -> Result<BrowserSnapshotResult, String> {
    Err("Native viewport snapshot is currently implemented on macOS only.".into())
}

#[tauri::command]
pub async fn browser_set_options(
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    allow_localhost: bool,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    state
        .allow_localhost
        .store(allow_localhost, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn browser_create_tab(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    options: CreateTabOptions,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let CreateTabOptions {
        tab_id,
        url,
        bounds,
        visible,
        zoom,
        initiator,
    } = options;
    if !is_valid_tab_id(&tab_id) {
        return Err("Invalid browser tab id".into());
    }
    let is_model = initiator.as_deref() == Some("model");
    let allow_localhost = state.allow_localhost.load(Ordering::Relaxed);
    let parsed = validate_browser_url(&url, true, is_model, allow_localhost)?;
    let allow_private_nav = !is_model && parsed.host_str().is_some_and(is_private_or_loopback_host);
    {
        let mut b = state
            .bounds
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        *b = Some(bounds.sanitized());
    }
    state.visible.store(visible, Ordering::Relaxed);
    let created = spawn_tab_webview(
        &app,
        &state,
        SpawnTabConfig {
            tab_id: tab_id.clone(),
            url: parsed,
            bounds,
            visible,
            zoom,
            allow_private_nav,
        },
    )?;
    if visible {
        let prev_id = {
            let mut active = state
                .active_tab_id
                .lock()
                .map_err(|_| "Browser state lock poisoned".to_string())?;
            active.replace(tab_id)
        };
        if let Some(prev) = prev_id
            && let Ok(prev_wv) = get_tab_webview(&app, &state, &prev)
        {
            let _ = prev_wv.hide();
        }
        let _ = created.set_bounds(bounds.to_rect());
        let _ = created.show();
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_close_tab(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let meta = {
        let mut tabs = state
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        tabs.remove(&tab_id)
    };
    {
        let mut active = state
            .active_tab_id
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        if active.as_deref() == Some(&tab_id) {
            *active = None;
        }
    }
    if let Some(meta) = meta
        && let Some(wv) = app.get_webview(&meta.label)
    {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_active_tab(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: Option<String>,
    bounds: Option<BrowserBounds>,
    visible: bool,
    zoom: Option<f64>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let effective_bounds = {
        let mut b = state
            .bounds
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        if let Some(next) = bounds {
            *b = Some(next.sanitized());
        }
        *b
    };
    if let (Some(id), Some(next_zoom)) = (tab_id.as_deref(), zoom) {
        let _ = state.set_tab_zoom(id, sanitize_zoom(next_zoom));
    }
    state.visible.store(visible, Ordering::Relaxed);

    let all_labels: Vec<(String, String, f64)> = {
        let tabs = state
            .tabs
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        tabs.iter()
            .map(|(id, meta)| (id.clone(), meta.label.clone(), meta.zoom))
            .collect()
    };

    {
        let mut active = state
            .active_tab_id
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        *active = tab_id.clone();
    }

    for (id, label, tab_zoom) in all_labels {
        let Some(wv) = app.get_webview(&label) else {
            continue;
        };
        if tab_id.as_deref() == Some(id.as_str()) {
            if let Some(b) = effective_bounds {
                let _ = wv.set_bounds(b.to_rect());
            }
            let _ = wv.set_zoom(tab_zoom);
            if visible {
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        } else {
            let _ = wv.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    bounds: BrowserBounds,
    zoom: Option<f64>,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let sanitized = bounds.sanitized();
    {
        let mut b = state
            .bounds
            .lock()
            .map_err(|_| "Browser state lock poisoned".to_string())?;
        *b = Some(sanitized);
    }
    let active_id = state
        .active_tab_id
        .lock()
        .map_err(|_| "Browser state lock poisoned".to_string())?
        .clone();
    if let Some(id) = active_id {
        if let Some(next_zoom) = zoom {
            let _ = state.set_tab_zoom(&id, sanitize_zoom(next_zoom));
        }
        if let Ok(wv) = get_tab_webview(&app, &state, &id) {
            wv.set_bounds(sanitized.to_rect())
                .map_err(|e| e.to_string())?;
            if let Some(next_zoom) = zoom {
                let _ = wv.set_zoom(sanitize_zoom(next_zoom));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_zoom(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    zoom: f64,
) -> Result<f64, String> {
    ensure_main_webview(&webview)?;
    let sanitized = sanitize_zoom(zoom);
    state.set_tab_zoom(&tab_id, sanitized)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    tab_wv.set_zoom(sanitized).map_err(|e| e.to_string())?;
    Ok(sanitized)
}

#[tauri::command]
pub async fn browser_set_visible(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    visible: bool,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    state.visible.store(visible, Ordering::Relaxed);
    let active_id = state
        .active_tab_id
        .lock()
        .map_err(|_| "Browser state lock poisoned".to_string())?
        .clone();
    if let Some(id) = active_id
        && let Ok(wv) = get_tab_webview(&app, &state, &id)
    {
        if visible {
            if let Ok(guard) = state.bounds.lock()
                && let Some(b) = *guard
            {
                let _ = wv.set_bounds(b.to_rect());
            }
            if let Some(zoom) = state.tab_zoom(&id) {
                let _ = wv.set_zoom(zoom);
            }
            wv.show().map_err(|e| e.to_string())?;
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
    initiator: Option<String>,
) -> Result<String, String> {
    ensure_main_webview(&webview)?;
    let is_model = initiator.as_deref() == Some("model");
    let allow_localhost = state.allow_localhost.load(Ordering::Relaxed);
    let parsed = validate_browser_url(&url, false, is_model, allow_localhost)?;
    let allow_private_nav = !is_model && parsed.host_str().is_some_and(is_private_or_loopback_host);
    state.set_tab_allows_private_nav(&tab_id, allow_private_nav);
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    tab_wv
        .navigate(parsed.clone())
        .map_err(|e| format!("Failed to navigate: {e}"))?;
    Ok(parsed.to_string())
}

#[tauri::command]
pub async fn browser_history(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    action: String,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    platform_history_action(&tab_wv, &action)
}

#[tauri::command]
pub async fn browser_get_state(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserStateResult, String> {
    ensure_main_webview(&webview)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    let url = tab_wv.url().map(|u| u.to_string()).unwrap_or_default();
    let (can_go_back, can_go_forward) = platform_history_flags(&tab_wv);
    Ok(BrowserStateResult {
        url,
        can_go_back,
        can_go_forward,
    })
}

#[tauri::command]
pub async fn browser_eval_js(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    script: String,
    isolated_world: bool,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    ensure_main_webview(&webview)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    let allow_localhost = state.allow_localhost.load(Ordering::Relaxed);
    if let Ok(current_url) = tab_wv.url() {
        ensure_model_access_allowed(&current_url, allow_localhost)?;
    }
    let ms = timeout_ms
        .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
        .clamp(500, MAX_EVAL_TIMEOUT_MS);
    platform_eval_js(&tab_wv, script, isolated_world, Duration::from_millis(ms)).await
}

#[tauri::command]
pub async fn browser_take_snapshot(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    max_width: Option<f64>,
) -> Result<BrowserSnapshotResult, String> {
    ensure_main_webview(&webview)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    platform_take_snapshot(&tab_wv, max_width.unwrap_or(1280.0)).await
}

#[tauri::command]
pub async fn browser_clear_data(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
    tab_wv.clear_all_browsing_data().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_open_devtools(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    ensure_main_webview(&webview)?;
    #[cfg(debug_assertions)]
    {
        let tab_wv = get_tab_webview(&app, &state, &tab_id)?;
        tab_wv.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, state, tab_id);
        Err("DevTools is only available in debug builds.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_schemes_and_private_hosts() {
        assert!(validate_browser_url("https://example.com/a", false, true, false).is_ok());
        assert!(validate_browser_url("about:blank", true, true, false).is_ok());
        assert!(validate_browser_url("about:blank", false, true, false).is_err());
        assert!(validate_browser_url("file:///etc/passwd", true, false, true).is_err());
        assert!(validate_browser_url("tauri://localhost", true, false, true).is_err());
        assert!(validate_browser_url("javascript:alert(1)", true, false, true).is_err());
        // Link-local metadata is always blocked (IPv4, bracketed IPv6, IPv4-mapped IPv6)
        assert!(validate_browser_url("http://169.254.169.254/latest", false, false, true).is_err());
        assert!(validate_browser_url("http://[fe80::1]/", false, false, true).is_err());
        assert!(
            validate_browser_url("http://[::ffff:169.254.169.254]/latest", false, false, true)
                .is_err()
        );
        assert!(!is_allowed_navigation(
            &Url::parse("http://[fe80::1]/").unwrap()
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://[::ffff:169.254.169.254]/latest").unwrap()
        ));
        // Model-initiated loopback/private is blocked unless allow_localhost=true
        assert!(validate_browser_url("http://127.0.0.1:8080", false, true, false).is_err());
        assert!(
            validate_browser_url("http://[::ffff:127.0.0.1]:8080/", false, true, false).is_err()
        );
        assert!(validate_browser_url("http://[::ffff:10.0.0.1]/", false, true, false).is_err());
        assert!(validate_browser_url("http://localhost:3000", false, true, false).is_err());
        assert!(validate_browser_url("http://localhost:3000", false, true, true).is_ok());
        // User-initiated localhost is allowed
        assert!(validate_browser_url("http://localhost:3000", false, false, false).is_ok());

        // Redirects to private/loopback are blocked unless allow_localhost or user-initiated private tab
        let local_url = Url::parse("http://127.0.0.1:8080/secret").unwrap();
        assert!(!is_allowed_navigation_for_tab(&local_url, false, false));
        assert!(is_allowed_navigation_for_tab(&local_url, false, true));
        assert!(is_allowed_navigation_for_tab(&local_url, true, false));

        // Model script/snapshot access to private/loopback pages requires allow_localhost
        assert!(ensure_model_access_allowed(&local_url, false).is_err());
        assert!(ensure_model_access_allowed(&local_url, true).is_ok());
        assert!(
            ensure_model_access_allowed(&Url::parse("https://example.com").unwrap(), false).is_ok()
        );
    }

    #[test]
    fn sets_safari_user_agent_on_apple_and_linux_webkits() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let ua = BROWSER_USER_AGENT.expect("expected user agent on macOS/Linux");
            assert!(ua.contains("Version/"));
            assert!(ua.contains("Safari/"));
        }
    }

    #[test]
    fn clamps_zoom_to_safe_bounds() {
        assert_eq!(sanitize_zoom(1.0), 1.0);
        assert_eq!(sanitize_zoom(0.42), 0.42);
        assert_eq!(sanitize_zoom(0.1), 0.25);
        assert_eq!(sanitize_zoom(-2.0), 0.25);
        assert_eq!(sanitize_zoom(10.0), 4.0);
        assert_eq!(sanitize_zoom(f64::NAN), 1.0);
    }
}
