//! Local two-tier webpage scraper for `web_scrape` on desktop.
//!
//! - **Tier 1 (fast HTTP path):** `reqwest` with `Accept: text/markdown, text/html;q=0.9, ...`.
//!   Sites supporting Markdown content negotiation return Markdown directly; HTML pages are
//!   cleaned with `dom_smoothie` (Mozilla Readability) and converted to Markdown via `htmd`.
//! - **Tier 2 (JS/SPA fallback):** When a 2xx HTML page yields a JavaScript app shell with almost
//!   no static text, renders it in a hidden, ephemeral `.incognito(true)` child WebView, extracts
//!   the visible DOM, and runs the same `dom_smoothie` + `htmd` pipeline.
//!
//! Security boundaries:
//! - Every command requires the `"main"` UI webview (`browser::ensure_main_webview`).
//! - Only `http://` and `https://` URLs are accepted.
//! - Private, loopback, link-local / cloud metadata (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`),
//!   unspecified, multicast, and reserved IPs are blocked both by URL host inspection and by
//!   `SafeDnsResolver` on every hop (including redirects), preventing DNS-rebinding SSRF.
//! - Offscreen WebViews always run incognito with popups and downloads denied and never honor the
//!   interactive browser's localhost toggle.
//! - HTTP 4xx/5xx responses return an error directly without escalating to a WebView.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dom_smoothie::{Config as ReadabilityConfig, Readability};
use htmd::HtmlToMarkdown;
use htmd::options::{BulletListMarker, CodeBlockStyle, HeadingStyle, Options as HtmdOptions};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::redirect;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl};
use tokio::sync::{Semaphore, oneshot};
use url::{Host, Url};

use crate::browser::{self, BROWSER_USER_AGENT, MAIN_WEBVIEW_LABEL, platform_eval_js};

const DEFAULT_TIMEOUT_MS: u64 = 45_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_REDIRECTS: usize = 10;
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_CONCURRENT_HTTP: usize = 6;
const MAX_CONCURRENT_WEBVIEWS: usize = 2;
const SPA_MIN_TEXT_CHARS: usize = 200;
const WEBVIEW_SETTLE_MAX_MS: u64 = 2_500;
const WEBVIEW_SETTLE_TICK_MS: u64 = 250;
const WEBVIEW_EVAL_TIMEOUT_MS: u64 = 5_000;
const SCRAPE_WEBVIEW_PREFIX: &str = "scrape-wv-";

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
const ACCEPT_HEADER: &str =
    "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, */*;q=0.1";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalScrapeResponse {
    pub url: String,
    pub title: Option<String>,
    pub markdown: String,
    pub source: &'static str,
}

pub struct ScraperState {
    client: reqwest::Client,
    http_slots: Arc<Semaphore>,
    webview_slots: Arc<Semaphore>,
    in_flight: Mutex<HashMap<String, oneshot::Sender<()>>>,
    next_webview_id: AtomicU64,
}

impl Default for ScraperState {
    fn default() -> Self {
        Self {
            client: build_http_client(true),
            http_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_HTTP)),
            webview_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_WEBVIEWS)),
            in_flight: Mutex::new(HashMap::new()),
            next_webview_id: AtomicU64::new(1),
        }
    }
}

/// Custom DNS resolver that refuses any hostname resolving to a non-global IP address.
///
/// Because `reqwest` connects directly to the `SocketAddr`s returned here, there is no
/// TOCTOU window between IP verification and TCP connection.
struct SafeDnsResolver;

impl Resolve for SafeDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = resolve_public_addrs(&host).await.map_err(
                |msg| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(io::Error::new(io::ErrorKind::PermissionDenied, msg))
                },
            )?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

async fn resolve_public_addrs(host: &str) -> Result<Vec<SocketAddr>, String> {
    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|e| format!("Failed to resolve host `{host}`: {e}"))?
        .collect();
    if resolved.is_empty() {
        return Err(format!("DNS lookup returned no addresses for `{host}`."));
    }
    for addr in &resolved {
        if is_forbidden_ip(addr.ip()) {
            return Err(
                "Blocked request to private, loopback, link-local, or reserved network address."
                    .into(),
            );
        }
    }
    Ok(resolved)
}

fn is_forbidden_ipv4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || o[0] == 0 // 0.0.0.0/8 ("this network")
        || (o[0] == 100 && (o[1] & 0b1100_0000) == 64) // 100.64.0.0/10 (CGNAT)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18.0.0/15 (benchmarking)
        || o[0] >= 240 // 240.0.0.0/4 (reserved)
}

fn is_forbidden_ipv6(v6: Ipv6Addr) -> bool {
    if let Some(mapped) = v6.to_ipv4_mapped() {
        return is_forbidden_ipv4(mapped);
    }
    let segs = v6.segments();
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || (segs[0] & 0xfe00) == 0xfc00 // fc00::/7 (ULA)
        || (segs[0] & 0xffc0) == 0xfe80 // fe80::/10 (link-local)
        || (segs[0] & 0xffc0) == 0xfec0 // fec0::/10 (deprecated site-local)
        || (segs[0] == 0x2001 && segs[1] == 0x0db8) // 2001:db8::/32 (documentation)
}

pub(crate) fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_ipv4(v4),
        IpAddr::V6(v6) => is_forbidden_ipv6(v6),
    }
}

fn is_forbidden_domain(domain: &str) -> bool {
    let lower = domain.trim_end_matches('.').to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower == "metadata.google.internal"
        || lower == "metadata"
}

pub(crate) fn validate_scrape_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    let url = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "Invalid URL: unsupported scheme `{other}:`. Only http:// and https:// URLs are supported."
            ));
        }
    }
    let Some(host) = url.host() else {
        return Err("Invalid URL: missing host.".into());
    };
    match host {
        Host::Ipv4(v4) if is_forbidden_ipv4(v4) => {
            return Err(
                "Blocked request to private, loopback, link-local, or reserved network address."
                    .into(),
            );
        }
        Host::Ipv6(v6) if is_forbidden_ipv6(v6) => {
            return Err(
                "Blocked request to private, loopback, link-local, or reserved network address."
                    .into(),
            );
        }
        Host::Domain(domain) if is_forbidden_domain(domain) => {
            return Err(
                "Blocked request to private, loopback, link-local, or reserved network address."
                    .into(),
            );
        }
        _ => {}
    }
    Ok(url)
}

fn build_http_client(enforce_ssrf: bool) -> reqwest::Client {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static(ACCEPT_HEADER));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));

    let redirect_policy = redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error(format!("Too many redirects (exceeded {MAX_REDIRECTS})."));
        }
        if enforce_ssrf && let Err(reason) = validate_scrape_url(attempt.url().as_str()) {
            return attempt.error(reason);
        }
        attempt.follow()
    });

    let mut builder = reqwest::Client::builder()
        .user_agent(BROWSER_USER_AGENT.unwrap_or(DEFAULT_USER_AGENT))
        .default_headers(headers)
        .redirect(redirect_policy)
        .connect_timeout(Duration::from_secs(15));

    if enforce_ssrf {
        builder = builder.dns_resolver(Arc::new(SafeDnsResolver));
    }

    builder
        .build()
        .expect("failed to build reqwest scraper client")
}

#[derive(Debug)]
struct Tier1Outcome {
    url: String,
    title: Option<String>,
    markdown: String,
    source: &'static str,
    should_try_webview: bool,
}

fn content_type_essence(header: Option<&str>) -> String {
    header
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn extract_markdown_heading_title(markdown: &str) -> Option<String> {
    for line in markdown.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().trim_end_matches('#').trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

fn collapse_blank_lines(input: &str) -> String {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(normalized.len());
    let mut blank_run = 0usize;
    for line in normalized.lines() {
        let trimmed_end = line.trim_end();
        if trimmed_end.is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !out.is_empty() {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(trimmed_end);
        }
    }
    out.trim().to_string()
}

fn decode_basic_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

fn extract_html_title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start_tag = lower.find("<title")?;
    let after_open = html[start_tag..].find('>')? + start_tag + 1;
    let close = lower[after_open..].find("</title>")? + after_open;
    let raw = html[after_open..close].trim();
    let decoded = decode_basic_entities(raw);
    let collapsed: String = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    (!collapsed.is_empty()).then_some(collapsed)
}

fn non_whitespace_len(text: &str) -> usize {
    text.chars().filter(|c| !c.is_whitespace()).count()
}

fn build_htmd(strip_layout_chrome: bool) -> HtmlToMarkdown {
    let mut skip = vec!["script", "style", "noscript", "svg", "iframe", "template"];
    if strip_layout_chrome {
        skip.extend(["head", "nav", "footer", "aside"]);
    }
    HtmlToMarkdown::builder()
        .skip_tags(skip)
        .options(HtmdOptions {
            heading_style: HeadingStyle::Atx,
            bullet_list_marker: BulletListMarker::Dash,
            code_block_style: CodeBlockStyle::Fenced,
            ..Default::default()
        })
        .build()
}

pub(crate) fn extract_html_to_markdown(html: &str, base_url: &str) -> (Option<String>, String) {
    let cfg = ReadabilityConfig::default();

    let mut readability_title: Option<String> = None;
    let mut readability_md = String::new();

    if let Ok(mut readability) = Readability::new(html, Some(base_url), Some(cfg))
        && let Ok(article) = readability.parse()
    {
        let t = article.title.trim();
        if !t.is_empty() {
            readability_title = Some(t.to_string());
        }
        let converter = build_htmd(false);
        if let Ok(converted) = converter.convert(article.content.as_ref()) {
            readability_md = collapse_blank_lines(&converted);
        }
    }

    if non_whitespace_len(&readability_md) >= SPA_MIN_TEXT_CHARS {
        let title = readability_title.or_else(|| extract_html_title_tag(html));
        return (title, readability_md);
    }

    // Fallback for non-article pages (tables, doc indexes, directory listings) where Readability
    // may discard structural markup: convert directly with layout chrome stripped.
    let fallback_converter = build_htmd(true);
    let fallback_md = fallback_converter
        .convert(html)
        .map(|s| collapse_blank_lines(&s))
        .unwrap_or_default();

    let title = readability_title.or_else(|| extract_html_title_tag(html));
    if non_whitespace_len(&fallback_md) > non_whitespace_len(&readability_md) {
        (title, fallback_md)
    } else {
        (title, readability_md)
    }
}

pub(crate) fn looks_like_spa_shell(raw_html: &str, extracted_markdown: &str) -> bool {
    if non_whitespace_len(extracted_markdown) >= SPA_MIN_TEXT_CHARS {
        return false;
    }
    let lower = raw_html.to_ascii_lowercase();
    if !lower.contains("<script") {
        return false;
    }
    const SPA_MARKERS: &[&str] = &[
        "id=\"__next\"",
        "id='__next'",
        "id=\"__nuxt\"",
        "id='__nuxt'",
        "id=\"root\"",
        "id='root'",
        "id=\"app\"",
        "id='app'",
        "data-reactroot",
        "ng-version=",
        "window.__initial_state__",
        "enable javascript",
        "requires javascript",
        "javascript is disabled",
        "javascript to run this app",
    ];
    if SPA_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return true;
    }
    // Also escalate when the static page has essentially no readable text (< 40 non-ws chars)
    // yet loads external scripts.
    non_whitespace_len(extracted_markdown) < 40 && lower.contains("<script")
}

async fn read_body_capped(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed reading response body: {e}"))?
    {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            let remaining = MAX_BODY_BYTES.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

async fn fetch_and_extract_http(
    client: &reqwest::Client,
    url: &Url,
    timeout: Duration,
) -> Result<Tier1Outcome, String> {
    let response = tokio::time::timeout(timeout, client.get(url.as_str()).send())
        .await
        .map_err(|_| format!("Request timed out after {:.1} s.", timeout.as_secs_f64()))?
        .map_err(|e| format!("Failed to fetch URL: {e}"))?;

    let final_url = response.url().to_string();
    let status = response.status();
    let content_type = content_type_essence(
        response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    );

    if status.as_u16() >= 400 {
        let reason = status.canonical_reason().unwrap_or("");
        let detail = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(format!("Page returned HTTP {}{detail}.", status.as_u16()));
    }

    // Reject binary formats that cannot be extracted as readable text.
    if !content_type.is_empty()
        && !content_type.starts_with("text/")
        && !matches!(
            content_type.as_str(),
            "application/xhtml+xml"
                | "application/json"
                | "application/xml"
                | "application/rss+xml"
                | "application/atom+xml"
                | "application/ld+json"
        )
    {
        return Err(format!(
            "Unsupported content type `{content_type}` (local scraping supports HTML, Markdown, plain text, JSON, and XML)."
        ));
    }

    let bytes = tokio::time::timeout(timeout, read_body_capped(response))
        .await
        .map_err(|_| {
            format!(
                "Reading page timed out after {:.1} s.",
                timeout.as_secs_f64()
            )
        })??;
    let body = String::from_utf8_lossy(&bytes).into_owned();

    if content_type == "text/markdown" || content_type == "text/x-markdown" {
        let markdown = collapse_blank_lines(&body);
        let title = extract_markdown_heading_title(&markdown);
        return Ok(Tier1Outcome {
            url: final_url,
            title,
            markdown,
            source: "markdown-negotiated",
            should_try_webview: false,
        });
    }

    if content_type == "text/plain"
        || content_type == "application/json"
        || content_type == "application/ld+json"
        || content_type == "application/xml"
        || content_type == "text/xml"
        || content_type == "application/rss+xml"
        || content_type == "application/atom+xml"
    {
        let text = collapse_blank_lines(&body);
        let markdown = if content_type.contains("json") {
            format!("```json\n{text}\n```")
        } else {
            text
        };
        return Ok(Tier1Outcome {
            url: final_url,
            title: None,
            markdown,
            source: "http",
            should_try_webview: false,
        });
    }

    let url_for_parse = final_url.clone();
    let html_for_parse = body.clone();
    let (title, markdown) = tauri::async_runtime::spawn_blocking(move || {
        extract_html_to_markdown(&html_for_parse, &url_for_parse)
    })
    .await
    .map_err(|e| format!("HTML extraction task failed: {e}"))?;

    let should_try_webview = looks_like_spa_shell(&body, &markdown);

    Ok(Tier1Outcome {
        url: final_url,
        title,
        markdown,
        source: "http",
        should_try_webview,
    })
}

struct ScraperWebviewGuard {
    webview: Option<Webview>,
}

impl ScraperWebviewGuard {
    fn new(webview: Webview) -> Self {
        Self {
            webview: Some(webview),
        }
    }

    fn webview(&self) -> &Webview {
        self.webview.as_ref().expect("guard webview present")
    }
}

impl Drop for ScraperWebviewGuard {
    fn drop(&mut self) {
        if let Some(wv) = self.webview.take() {
            let _ = wv.close();
        }
    }
}

#[derive(Debug, Deserialize)]
struct WebviewProbe {
    #[serde(rename = "readyState")]
    ready_state: String,
    #[serde(rename = "textLen")]
    text_len: usize,
}

#[derive(Debug, Deserialize)]
struct WebviewCapture {
    url: String,
    title: String,
    html: String,
}

const PROBE_JS: &str = r#"
const text = document.body && document.body.innerText ? document.body.innerText.trim() : '';
return JSON.stringify({ readyState: document.readyState || '', textLen: text.length });
"#;

const CAPTURE_DOM_JS: &str = r#"
const root = document.documentElement;
if (!root) {
  return JSON.stringify({ url: location.href || '', title: document.title || '', html: '' });
}
const hiddenSet = new Set();
const liveNodes = root.querySelectorAll('*');
for (let i = 0; i < liveNodes.length; i++) {
  const el = liveNodes[i];
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
    hiddenSet.add(i);
    continue;
  }
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) {
    hiddenSet.add(i);
    continue;
  }
  try {
    const cs = window.getComputedStyle(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
      hiddenSet.add(i);
    }
  } catch (_) {}
}
const clone = root.cloneNode(true);
const cloneNodes = clone.querySelectorAll('*');
const toRemove = [];
hiddenSet.forEach((idx) => {
  if (idx < cloneNodes.length) toRemove.push(cloneNodes[idx]);
});
for (const node of toRemove) {
  node.remove();
}
return JSON.stringify({
  url: location.href || '',
  title: document.title || '',
  html: clone.outerHTML || '',
});
"#;

async fn render_in_hidden_webview(
    app: &AppHandle,
    state: &ScraperState,
    url: &Url,
    timeout: Duration,
) -> Result<LocalScrapeResponse, String> {
    let deadline = Instant::now() + timeout;
    let _permit = tokio::time::timeout(timeout, state.webview_slots.acquire())
        .await
        .map_err(|_| "Timed out waiting for offscreen render slot.".to_string())?
        .map_err(|_| "Scraper webview semaphore closed.".to_string())?;

    // Re-verify DNS before spawning WebView so private hosts cannot be loaded via DNS rebinding.
    if let Some(Host::Domain(domain)) = url.host() {
        resolve_public_addrs(domain).await?;
    }

    let window = app
        .get_window(MAIN_WEBVIEW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;

    let id = state.next_webview_id.fetch_add(1, Ordering::Relaxed);
    let label = format!("{SCRAPE_WEBVIEW_PREFIX}{id}");

    let (load_tx, load_rx) = oneshot::channel::<()>();
    let load_tx_slot = Arc::new(Mutex::new(Some(load_tx)));

    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .incognito(true)
        .disable_drag_drop_handler()
        .focused(false);

    if let Some(ua) = BROWSER_USER_AGENT {
        builder = builder.user_agent(ua);
    }

    builder = builder
        .on_navigation(|target_url| validate_scrape_url(target_url.as_str()).is_ok())
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_wv, _event| false)
        .on_page_load(move |_wv, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && let Some(tx) = load_tx_slot.lock().ok().and_then(|mut g| g.take())
            {
                let _ = tx.send(());
            }
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(-2000.0, -2000.0),
            LogicalSize::new(1280.0, 900.0),
        )
        .map_err(|e| format!("Failed to create offscreen scrape webview: {e}"))?;
    let _ = webview.hide();
    let guard = ScraperWebviewGuard::new(webview);

    // Wait for initial load finish, bounded by remaining timeout.
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("Timed out loading page in offscreen renderer.".into());
    }
    let _ = tokio::time::timeout(remaining, load_rx).await;

    // Brief Rust-driven settle loop so client-side JS frameworks hydrate before capture.
    let settle_deadline = std::cmp::min(
        deadline,
        Instant::now() + Duration::from_millis(WEBVIEW_SETTLE_MAX_MS),
    );
    let mut prev_len: Option<usize> = None;
    while Instant::now() < settle_deadline {
        let eval_limit = std::cmp::min(
            Duration::from_millis(WEBVIEW_EVAL_TIMEOUT_MS),
            deadline.saturating_duration_since(Instant::now()),
        );
        if eval_limit.is_zero() {
            break;
        }
        if let Ok(raw) =
            platform_eval_js(guard.webview(), PROBE_JS.to_string(), true, eval_limit).await
            && let Ok(probe) = serde_json::from_str::<WebviewProbe>(&raw)
        {
            if probe.ready_state == "complete"
                && probe.text_len >= SPA_MIN_TEXT_CHARS
                && prev_len == Some(probe.text_len)
            {
                break;
            }
            prev_len = Some(probe.text_len);
        }
        let sleep_for = std::cmp::min(
            Duration::from_millis(WEBVIEW_SETTLE_TICK_MS),
            settle_deadline.saturating_duration_since(Instant::now()),
        );
        if sleep_for.is_zero() {
            break;
        }
        tokio::time::sleep(sleep_for).await;
    }

    let eval_limit = std::cmp::min(
        Duration::from_millis(WEBVIEW_EVAL_TIMEOUT_MS),
        deadline.saturating_duration_since(Instant::now()),
    );
    if eval_limit.is_zero() {
        return Err("Timed out extracting rendered page content.".into());
    }

    let raw_capture = platform_eval_js(
        guard.webview(),
        CAPTURE_DOM_JS.to_string(),
        true,
        eval_limit,
    )
    .await?;
    // Destroy the offscreen webview immediately now that DOM HTML is captured.
    drop(guard);

    let capture: WebviewCapture = serde_json::from_str(&raw_capture)
        .map_err(|e| format!("Failed to parse rendered DOM payload: {e}"))?;
    let final_url = if validate_scrape_url(&capture.url).is_ok() {
        capture.url
    } else {
        url.to_string()
    };

    let url_for_parse = final_url.clone();
    let html = capture.html;
    let (extracted_title, markdown) = tauri::async_runtime::spawn_blocking(move || {
        extract_html_to_markdown(&html, &url_for_parse)
    })
    .await
    .map_err(|e| format!("Rendered HTML extraction failed: {e}"))?;

    let title = extracted_title.or_else(|| {
        let trimmed = capture.title.trim();
        (!trimmed.is_empty()).then_some(trimmed.to_string())
    });

    Ok(LocalScrapeResponse {
        url: final_url,
        title,
        markdown,
        source: "webview",
    })
}

struct InFlightRegistration<'a> {
    state: &'a ScraperState,
    request_id: String,
}

impl Drop for InFlightRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.in_flight.lock() {
            map.remove(&self.request_id);
        }
    }
}

async fn scrape_pipeline(
    app: &AppHandle,
    state: &ScraperState,
    url: Url,
    timeout: Duration,
) -> Result<LocalScrapeResponse, String> {
    let deadline = Instant::now() + timeout;
    let tier1 = {
        let _http_permit = tokio::time::timeout(timeout, state.http_slots.acquire())
            .await
            .map_err(|_| format!("Request timed out after {:.1} s.", timeout.as_secs_f64()))?
            .map_err(|_| "Scraper HTTP semaphore closed.".to_string())?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        fetch_and_extract_http(&state.client, &url, remaining).await?
    };

    if tier1.should_try_webview {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining >= Duration::from_secs(2)
            && let Ok(final_parsed) = validate_scrape_url(&tier1.url)
            && let Ok(rendered) =
                render_in_hidden_webview(app, state, &final_parsed, remaining).await
            && non_whitespace_len(&rendered.markdown) > non_whitespace_len(&tier1.markdown)
        {
            return Ok(rendered);
        }
    }

    Ok(LocalScrapeResponse {
        url: tier1.url,
        title: tier1.title,
        markdown: tier1.markdown,
        source: tier1.source,
    })
}

/// Fetches a public `http(s)://` webpage locally and extracts its main content as Markdown.
#[tauri::command]
pub async fn web_scrape_local(
    app: AppHandle,
    webview: Webview,
    state: State<'_, ScraperState>,
    request_id: String,
    url: String,
    timeout_ms: Option<u64>,
) -> Result<LocalScrapeResponse, String> {
    browser::ensure_main_webview(&webview)?;
    let parsed_url = validate_scrape_url(&url)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut map = state
            .in_flight
            .lock()
            .map_err(|_| "Scraper state lock poisoned".to_string())?;
        map.insert(request_id.clone(), cancel_tx);
    }
    let _registration = InFlightRegistration {
        state: &state,
        request_id,
    };

    tokio::select! {
        biased;
        _ = cancel_rx => Err("Aborted by user.".into()),
        result = scrape_pipeline(&app, &state, parsed_url, timeout) => result,
    }
}

/// Cancels an in-flight `web_scrape_local` request (and tears down any hidden WebView it owns).
#[tauri::command]
pub fn web_scrape_cancel(
    webview: Webview,
    state: State<'_, ScraperState>,
    request_id: String,
) -> Result<(), String> {
    browser::ensure_main_webview(&webview)?;
    if let Ok(mut map) = state.in_flight.lock()
        && let Some(tx) = map.remove(&request_id)
    {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn forbidden_ip_blocks_private_loopback_metadata_cgnat_and_allows_public() {
        let blocked = [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.5",
        ];
        for raw in blocked {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(is_forbidden_ip(ip), "expected {raw} to be blocked");
        }

        let allowed = [
            "93.184.216.34",
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:2800:220:1:248:1893:25c8:1946",
        ];
        for raw in allowed {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(!is_forbidden_ip(ip), "expected {raw} to be allowed");
        }
    }

    #[test]
    fn validate_scrape_url_rejects_non_http_and_private_hosts() {
        assert!(validate_scrape_url("https://example.com/docs").is_ok());
        assert!(validate_scrape_url("http://93.184.216.34/page").is_ok());

        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/a",
            "http://localhost:8090/",
            "http://sub.localhost/test",
            "http://127.0.0.1:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/internal",
            "http://[::1]/",
            "http://metadata.google.internal/computeMetadata/v1/",
        ] {
            assert!(
                validate_scrape_url(bad).is_err(),
                "expected `{bad}` to be rejected"
            );
        }
    }

    #[test]
    fn extract_html_to_markdown_strips_chrome_and_keeps_article_structure() {
        let html = r#"<!doctype html>
<html>
<head><title>Rust Async Guide</title></head>
<body>
  <nav><a href="/home">Home</a><a href="/pricing">Pricing</a></nav>
  <main>
    <article>
      <h1>Rust Async Guide</h1>
      <p>Tokio provides a multi-threaded runtime for asynchronous Rust applications with cooperative scheduling and low-overhead tasks.</p>
      <p>Read the <a href="/docs/tasks">task documentation</a> for full scheduling semantics and cancellation guarantees across channels.</p>
      <h2>Example</h2>
      <pre><code class="language-rust">async fn greet() -&gt; &amp;'static str { "hello" }</code></pre>
      <ul>
        <li>Zero-cost futures</li>
        <li>Structured concurrency</li>
      </ul>
    </article>
  </main>
  <footer>Copyright 2026 Example Corp</footer>
  <script>window.__tracking = true;</script>
</body>
</html>"#;

        let (title, md) = extract_html_to_markdown(html, "https://docs.example.com/guide");
        assert_eq!(title.as_deref(), Some("Rust Async Guide"));
        assert!(md.contains("multi-threaded runtime"), "md={md}");
        assert!(
            md.contains("https://docs.example.com/docs/tasks") || md.contains("/docs/tasks"),
            "md={md}"
        );
        assert!(md.contains("async fn greet()"), "md={md}");
        assert!(md.contains("Zero-cost futures"), "md={md}");
        assert!(!md.contains("window.__tracking"), "md={md}");
        assert!(!md.contains("Copyright 2026 Example Corp"), "md={md}");
    }

    #[test]
    fn spa_shell_heuristic_detects_empty_js_shells_and_skips_static_pages() {
        let next_shell =
            r#"<html><body><div id="__next"></div><script src="/app.js"></script></body></html>"#;
        assert!(looks_like_spa_shell(next_shell, ""));

        let static_short = r#"<html><body><h1>Hello</h1><p>Short static notice.</p></body></html>"#;
        assert!(!looks_like_spa_shell(
            static_short,
            "# Hello\n\nShort static notice."
        ));

        let rich_content = "word ".repeat(60);
        assert!(!looks_like_spa_shell(next_shell, &rich_content));
    }

    async fn spawn_mock_server(
        handler: impl Fn(String) -> String + Send + Sync + 'static,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let resp = handler(req);
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn tier1_http_handles_markdown_negotiation_redirects_html_and_errors() {
        let (addr, _server) = spawn_mock_server(|req| {
            let first_line = req.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");
            match path {
                "/md" => {
                    assert!(
                        req.to_ascii_lowercase().contains("accept: text/markdown"),
                        "expected Accept: text/markdown header in request: {req}"
                    );
                    let body = "# Negotiated Doc\n\nDirect markdown from edge.";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/markdown; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                }
                "/redirect" => {
                    "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                }
                "/final" => {
                    let body = "<html><head><title>Final Page</title></head><body><article><h1>Final Page</h1><p>This is a full paragraph of real article content after following a redirect cleanly so readability extracts it properly without escalating to a browser.</p><p>Second paragraph adds enough text for a realistic document body.</p></article></body></html>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                }
                "/pdf" => {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 4\r\nConnection: close\r\n\r\n%PDF"
                        .to_string()
                }
                _ => {
                    "HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden"
                        .to_string()
                }
            }
        })
        .await;

        // Test-only client with SSRF bypassed strictly for the local mock listener.
        let client = build_http_client(false);
        let timeout = Duration::from_secs(5);

        let md_url = Url::parse(&format!("http://{addr}/md")).unwrap();
        let md = fetch_and_extract_http(&client, &md_url, timeout)
            .await
            .unwrap();
        assert_eq!(md.source, "markdown-negotiated");
        assert_eq!(md.title.as_deref(), Some("Negotiated Doc"));
        assert!(md.markdown.contains("Direct markdown from edge."));
        assert!(!md.should_try_webview);

        let redir_url = Url::parse(&format!("http://{addr}/redirect")).unwrap();
        let redir = fetch_and_extract_http(&client, &redir_url, timeout)
            .await
            .unwrap();
        assert_eq!(redir.url, format!("http://{addr}/final"));
        assert_eq!(redir.title.as_deref(), Some("Final Page"));
        assert_eq!(redir.source, "http");
        assert!(redir.markdown.contains("following a redirect cleanly"));
        assert!(!redir.should_try_webview);

        let pdf_url = Url::parse(&format!("http://{addr}/pdf")).unwrap();
        let pdf_err = fetch_and_extract_http(&client, &pdf_url, timeout)
            .await
            .unwrap_err();
        assert!(pdf_err.contains("application/pdf"), "err={pdf_err}");

        let err_url = Url::parse(&format!("http://{addr}/blocked")).unwrap();
        let http_err = fetch_and_extract_http(&client, &err_url, timeout)
            .await
            .unwrap_err();
        assert!(http_err.contains("HTTP 403"), "err={http_err}");
    }
}
