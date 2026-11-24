//! Local two-tier webpage & PDF scraper for `web_scrape` on desktop.
//!
//! - **Tier 1 (fast HTTP path):** `reqwest` with `Accept: text/markdown, text/html;q=0.9, ...`,
//!   per-host (2) + global (6) concurrency limits, 1 automatic retry on transient 502/503/504 or
//!   transport errors, charset decoding (`encoding_rs`), pure-Rust PDF extraction (`pdf_oxide`),
//!   and HTML extraction (`dom_smoothie` + `htmd` with noise/data-URI stripping).
//! - **Tier 2 (JS/SPA fallback):** When a 2xx HTML page yields a JavaScript app shell with almost
//!   no static article text, renders it in a hidden, ephemeral `.incognito(true)` child WebView
//!   pinned to the already DNS-verified host, extracts the visible DOM, and runs the same
//!   `dom_smoothie` + `htmd` pipeline.
//!
//! Security boundaries:
//! - Every command requires the `"main"` UI webview (`browser::ensure_main_webview`).
//! - Only `http://` and `https://` URLs are accepted.
//! - Private, loopback, link-local / cloud metadata (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`),
//!   unspecified, multicast, and reserved IPs are blocked both by URL host inspection and by
//!   `SafeDnsResolver` on every hop (including redirects), preventing DNS-rebinding SSRF.
//! - Offscreen WebViews always run incognito with popups and downloads denied, pin navigations to
//!   the Tier 1 DNS-verified host (with `www.` equivalence), and never honor the interactive
//!   browser's localhost toggle.
//! - HTTP 4xx/5xx responses return an error directly without escalating to a WebView.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dom_smoothie::{Config as ReadabilityConfig, Readability};
use encoding_rs::Encoding;
use htmd::element_handler::{HandlerResult, Handlers};
use htmd::options::{BulletListMarker, CodeBlockStyle, HeadingStyle, Options as HtmdOptions};
use htmd::{Element, HtmlToMarkdown};
use pdf_oxide::PdfDocument;
use pdf_oxide::converters::ConversionOptions;
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
const MAX_PDF_BYTES: usize = 15 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 40;
const MAX_PDF_EXTRACTED_CHARS: usize = 60_000;
const MAX_CONCURRENT_HTTP: usize = 6;
const MAX_CONCURRENT_PER_HOST: usize = 2;
const MAX_TRACKED_HOSTS: usize = 64;
const MAX_CONCURRENT_WEBVIEWS: usize = 2;
const TRANSIENT_RETRY_DELAY_MS: u64 = 450;
const SPA_MIN_TEXT_CHARS: usize = 200;
const WEBVIEW_SETTLE_MAX_MS: u64 = 2_500;
const WEBVIEW_SETTLE_TICK_MS: u64 = 250;
const WEBVIEW_EVAL_TIMEOUT_MS: u64 = 5_000;
const SCRAPE_WEBVIEW_PREFIX: &str = "scrape-wv-";

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
const ACCEPT_HEADER: &str = "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, application/pdf;q=0.7, text/plain;q=0.6, */*;q=0.1";

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
    host_slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    webview_slots: Arc<Semaphore>,
    in_flight: Mutex<HashMap<String, oneshot::Sender<()>>>,
    next_webview_id: AtomicU64,
}

impl Default for ScraperState {
    fn default() -> Self {
        Self {
            client: build_http_client(true),
            http_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_HTTP)),
            host_slots: Mutex::new(HashMap::new()),
            webview_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_WEBVIEWS)),
            in_flight: Mutex::new(HashMap::new()),
            next_webview_id: AtomicU64::new(1),
        }
    }
}

impl ScraperState {
    fn host_semaphore(&self, host_key: &str) -> Result<Arc<Semaphore>, String> {
        let mut map = self
            .host_slots
            .lock()
            .map_err(|_| "Scraper host-slot lock poisoned".to_string())?;
        if let Some(sem) = map.get(host_key) {
            return Ok(Arc::clone(sem));
        }
        if map.len() >= MAX_TRACKED_HOSTS {
            map.retain(|_, sem| sem.available_permits() < MAX_CONCURRENT_PER_HOST);
        }
        let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_PER_HOST));
        map.insert(host_key.to_string(), Arc::clone(&sem));
        Ok(sem)
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

fn normalized_host_for_compare(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// Returns true iff `candidate` is a valid public http(s) URL on the same host (ignoring `www.`)
/// as `expected`. Used to pin Tier 2 offscreen WebView navigations to the Tier 1 DNS-verified host.
pub(crate) fn is_same_scrape_host(expected: &Url, candidate: &Url) -> bool {
    if validate_scrape_url(candidate.as_str()).is_err() {
        return false;
    }
    match (
        normalized_host_for_compare(expected),
        normalized_host_for_compare(candidate),
    ) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
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
    article_non_ws_len: usize,
    source: &'static str,
    should_try_webview: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExtractedHtml {
    pub title: Option<String>,
    pub markdown: String,
    pub article_non_ws_len: usize,
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

fn extract_charset_param(header: &str) -> Option<String> {
    for part in header.split(';').skip(1) {
        let trimmed = part.trim();
        let Some((key, val)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("charset") {
            let cleaned = val.trim().trim_matches(['"', '\'']).trim();
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

fn sniff_html_meta_charset(bytes: &[u8]) -> Option<String> {
    let prefix = &bytes[..bytes.len().min(4096)];
    let head = String::from_utf8_lossy(prefix);
    let lower = head.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("<meta") {
        let start = cursor + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let tag = &head[start..start + end_rel + 1];
        let tag_lower = &lower[start..start + end_rel + 1];
        if let Some(pos) = tag_lower.find("charset") {
            let after = &tag[pos + "charset".len()..];
            let after_eq = after.trim_start().strip_prefix('=');
            if let Some(val_part) = after_eq {
                let val_trimmed = val_part.trim_start();
                let label = if let Some(rest) = val_trimmed.strip_prefix('"') {
                    rest.split('"').next().unwrap_or("")
                } else if let Some(rest) = val_trimmed.strip_prefix('\'') {
                    rest.split('\'').next().unwrap_or("")
                } else {
                    val_trimmed
                        .split(|c: char| {
                            c.is_ascii_whitespace() || c == ';' || c == '>' || c == '/'
                        })
                        .next()
                        .unwrap_or("")
                };
                let cleaned = label.trim();
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }
        cursor = start + end_rel + 1;
    }
    None
}

pub(crate) fn decode_text_bytes(
    bytes: &[u8],
    content_type_header: Option<&str>,
    is_html: bool,
) -> String {
    if let Some(header) = content_type_header
        && let Some(label) = extract_charset_param(header)
        && let Some(enc) = Encoding::for_label(label.as_bytes())
    {
        let (decoded, _, _) = enc.decode(bytes);
        return decoded.into_owned();
    }
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (decoded, _, _) = enc.decode(&bytes[bom_len..]);
        return decoded.into_owned();
    }
    if is_html
        && let Some(label) = sniff_html_meta_charset(bytes)
        && let Some(enc) = Encoding::for_label(label.as_bytes())
    {
        let (decoded, _, _) = enc.decode(bytes);
        return decoded.into_owned();
    }
    let (decoded, _, _) = encoding_rs::UTF_8.decode(bytes);
    decoded.into_owned()
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

fn attr_value(element: &Element, name: &str) -> Option<String> {
    element
        .attrs
        .iter()
        .find(|attr| attr.name.local.as_ref().eq_ignore_ascii_case(name))
        .map(|attr| attr.value.to_string())
}

fn is_inline_noise_img_src(src: &str) -> bool {
    let lower = src.trim().to_ascii_lowercase();
    lower.is_empty() || lower.starts_with("data:") || lower.starts_with("blob:")
}

fn clean_img_handler(_handlers: &dyn Handlers, element: Element) -> Option<HandlerResult> {
    let src = attr_value(&element, "src").unwrap_or_default();
    if is_inline_noise_img_src(&src) {
        return Some(String::new().into());
    }
    let alt = attr_value(&element, "alt")
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if alt.is_empty() {
        return Some(String::new().into());
    }
    let escaped_src = src.trim().replace('(', "\\(").replace(')', "\\)");
    let dest = if escaped_src.contains(' ') {
        format!("<{escaped_src}>")
    } else {
        escaped_src
    };
    Some(format!("![{alt}]({dest})").into())
}

fn is_permalink_noise(text: &str, aria_label: Option<&str>) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    if matches!(trimmed, "#" | "¶" | "§" | "🔗") {
        return true;
    }
    if let Some(label) = aria_label {
        let lower = label.to_ascii_lowercase();
        if (lower.contains("permalink")
            || lower.contains("direct link")
            || lower.contains("anchor"))
            && trimmed.chars().count() <= 3
        {
            return true;
        }
    }
    false
}

fn clean_anchor_handler(handlers: &dyn Handlers, element: Element) -> Option<HandlerResult> {
    let href = attr_value(&element, "href");
    let aria_label = attr_value(&element, "aria-label");
    let content = handlers.walk_children(element.node).content;
    let trimmed = content.trim();

    if is_permalink_noise(trimmed, aria_label.as_deref()) {
        return Some(String::new().into());
    }

    let Some(raw_href) = href.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) else {
        return Some(content.into());
    };
    let lower_href = raw_href.to_ascii_lowercase();
    if lower_href.starts_with("javascript:") || lower_href.starts_with('#') {
        return Some(trimmed.to_string().into());
    }

    let escaped_href = raw_href.replace('(', "\\(").replace(')', "\\)");
    let dest = if escaped_href.contains(' ') {
        format!("<{escaped_href}>")
    } else {
        escaped_href
    };
    Some(format!("[{trimmed}]({dest})").into())
}

fn build_htmd(strip_layout_chrome: bool) -> HtmlToMarkdown {
    let mut skip = vec!["script", "style", "noscript", "svg", "iframe", "template"];
    if strip_layout_chrome {
        skip.extend(["head", "nav", "footer", "aside"]);
    }
    HtmlToMarkdown::builder()
        .skip_tags(skip)
        .add_handler(vec!["img"], clean_img_handler)
        .add_handler(vec!["a"], clean_anchor_handler)
        .options(HtmdOptions {
            heading_style: HeadingStyle::Atx,
            bullet_list_marker: BulletListMarker::Dash,
            code_block_style: CodeBlockStyle::Fenced,
            ..Default::default()
        })
        .build()
}

pub(crate) fn extract_html_to_markdown(html: &str, base_url: &str) -> ExtractedHtml {
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

    let article_non_ws_len = non_whitespace_len(&readability_md);
    if article_non_ws_len >= SPA_MIN_TEXT_CHARS {
        let title = readability_title.or_else(|| extract_html_title_tag(html));
        return ExtractedHtml {
            title,
            markdown: readability_md,
            article_non_ws_len,
        };
    }

    // Fallback for non-article pages (tables, doc indexes, directory listings) where Readability
    // may discard structural markup: convert directly with layout chrome stripped.
    let fallback_converter = build_htmd(true);
    let fallback_md = fallback_converter
        .convert(html)
        .map(|s| collapse_blank_lines(&s))
        .unwrap_or_default();

    let title = readability_title.or_else(|| extract_html_title_tag(html));
    let markdown = if non_whitespace_len(&fallback_md) > article_non_ws_len {
        fallback_md
    } else {
        readability_md
    };
    ExtractedHtml {
        title,
        markdown,
        article_non_ws_len,
    }
}

pub(crate) fn looks_like_spa_shell(raw_html: &str, extracted: &ExtractedHtml) -> bool {
    if extracted.article_non_ws_len >= SPA_MIN_TEXT_CHARS {
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
    // yet loads scripts.
    non_whitespace_len(&extracted.markdown) < 40
}

pub(crate) fn extract_pdf_to_markdown(bytes: Vec<u8>) -> Result<(Option<String>, String), String> {
    let doc =
        PdfDocument::from_bytes(bytes).map_err(|e| format!("Failed to parse PDF document: {e}"))?;
    let total_pages = doc
        .page_count()
        .map_err(|e| format!("Failed reading PDF page count: {e}"))?;
    let limit = total_pages.min(MAX_PDF_PAGES);
    let options = ConversionOptions::default();

    let mut parts: Vec<String> = Vec::new();
    let mut extracted_chars = 0usize;
    for page_idx in 0..limit {
        let page_chunk = doc
            .to_markdown(page_idx, &options)
            .ok()
            .map(|s| collapse_blank_lines(&s))
            .filter(|s| non_whitespace_len(s) > 0)
            .or_else(|| {
                doc.extract_text(page_idx)
                    .ok()
                    .map(|s| collapse_blank_lines(&s))
                    .filter(|s| non_whitespace_len(s) > 0)
            });
        if let Some(chunk) = page_chunk {
            extracted_chars += chunk.len();
            parts.push(chunk);
            if extracted_chars >= MAX_PDF_EXTRACTED_CHARS {
                break;
            }
        }
    }

    let markdown = collapse_blank_lines(&parts.join("\n\n"));
    if non_whitespace_len(&markdown) == 0 {
        return Err("PDF contains no selectable text (likely scanned images).".into());
    }
    let title = extract_markdown_heading_title(&markdown);
    Ok((title, markdown))
}

async fn read_body_capped(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed reading response body: {e}"))?
    {
        if buf.len() + chunk.len() > max_bytes {
            let remaining = max_bytes.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

fn is_transient_http_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
}

fn is_transient_reqwest_error(error: &reqwest::Error) -> bool {
    if error.is_redirect() || error.is_builder() {
        return false;
    }
    // Never retry SSRF blocks surfaced through SafeDnsResolver.
    let msg = error.to_string().to_ascii_lowercase();
    if msg.contains("blocked request") || msg.contains("permission denied") {
        return false;
    }
    error.is_connect() || error.is_timeout() || error.is_request()
}

async fn send_with_transient_retry(
    client: &reqwest::Client,
    url: &Url,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    let deadline = Instant::now() + timeout;
    for attempt in 0..=1 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Request timed out after {:.1} s.",
                timeout.as_secs_f64()
            ));
        }
        match tokio::time::timeout(remaining, client.get(url.as_str()).send()).await {
            Ok(Ok(response)) => {
                if attempt == 0 && is_transient_http_status(response.status()) {
                    let retry_wait = Duration::from_millis(TRANSIENT_RETRY_DELAY_MS);
                    if deadline.saturating_duration_since(Instant::now()) > retry_wait {
                        tokio::time::sleep(retry_wait).await;
                        continue;
                    }
                }
                return Ok(response);
            }
            Ok(Err(error)) => {
                if attempt == 0 && is_transient_reqwest_error(&error) {
                    let retry_wait = Duration::from_millis(TRANSIENT_RETRY_DELAY_MS);
                    if deadline.saturating_duration_since(Instant::now()) > retry_wait {
                        tokio::time::sleep(retry_wait).await;
                        continue;
                    }
                }
                return Err(format!("Failed to fetch URL: {error}"));
            }
            Err(_) => {
                return Err(format!(
                    "Request timed out after {:.1} s.",
                    timeout.as_secs_f64()
                ));
            }
        }
    }
    unreachable!("loop always returns on attempt 1")
}

async fn fetch_and_extract_http(
    client: &reqwest::Client,
    url: &Url,
    timeout: Duration,
) -> Result<Tier1Outcome, String> {
    let deadline = Instant::now() + timeout;
    let response = send_with_transient_retry(client, url, timeout).await?;

    let final_url = response.url().to_string();
    let status = response.status();
    let raw_content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);
    let content_type = content_type_essence(raw_content_type.as_deref());

    if status.as_u16() >= 400 {
        let reason = status.canonical_reason().unwrap_or("");
        let detail = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(format!("Page returned HTTP {}{detail}.", status.as_u16()));
    }

    let path_is_pdf = response.url().path().to_ascii_lowercase().ends_with(".pdf");
    let maybe_pdf = content_type == "application/pdf"
        || ((content_type.is_empty() || content_type == "application/octet-stream") && path_is_pdf);

    // Reject binary formats that cannot be extracted as readable text.
    if !maybe_pdf
        && !content_type.is_empty()
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
            "Unsupported content type `{content_type}` (local scraping supports HTML, Markdown, plain text, JSON, XML, and text-based PDFs)."
        ));
    }

    let max_bytes = if maybe_pdf {
        MAX_PDF_BYTES
    } else {
        MAX_BODY_BYTES
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let bytes = tokio::time::timeout(remaining, read_body_capped(response, max_bytes))
        .await
        .map_err(|_| {
            format!(
                "Reading page timed out after {:.1} s.",
                timeout.as_secs_f64()
            )
        })??;

    let is_pdf = content_type == "application/pdf" || bytes.starts_with(b"%PDF-");
    if is_pdf {
        let (title, markdown) =
            tauri::async_runtime::spawn_blocking(move || extract_pdf_to_markdown(bytes))
                .await
                .map_err(|e| format!("PDF extraction task failed: {e}"))??;
        let len = non_whitespace_len(&markdown);
        return Ok(Tier1Outcome {
            url: final_url,
            title,
            markdown,
            article_non_ws_len: len,
            source: "pdf",
            should_try_webview: false,
        });
    }

    if maybe_pdf {
        return Err(format!(
            "Unsupported content type `{content_type}` (response is not a valid PDF document)."
        ));
    }

    let is_html = content_type.is_empty()
        || content_type == "text/html"
        || content_type == "application/xhtml+xml";
    let body = decode_text_bytes(&bytes, raw_content_type.as_deref(), is_html);

    if content_type == "text/markdown" || content_type == "text/x-markdown" {
        let markdown = collapse_blank_lines(&body);
        let title = extract_markdown_heading_title(&markdown);
        let len = non_whitespace_len(&markdown);
        return Ok(Tier1Outcome {
            url: final_url,
            title,
            markdown,
            article_non_ws_len: len,
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
        let len = non_whitespace_len(&markdown);
        return Ok(Tier1Outcome {
            url: final_url,
            title: None,
            markdown,
            article_non_ws_len: len,
            source: "http",
            should_try_webview: false,
        });
    }

    let url_for_parse = final_url.clone();
    let html_for_parse = body.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || {
        extract_html_to_markdown(&html_for_parse, &url_for_parse)
    })
    .await
    .map_err(|e| format!("HTML extraction task failed: {e}"))?;

    let should_try_webview = looks_like_spa_shell(&body, &extracted);

    Ok(Tier1Outcome {
        url: final_url,
        title: extracted.title,
        markdown: extracted.markdown,
        article_non_ws_len: extracted.article_non_ws_len,
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

struct Tier2Outcome {
    response: LocalScrapeResponse,
    article_non_ws_len: usize,
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
) -> Result<Tier2Outcome, String> {
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

    // Pin Tier 2 navigations to the Tier 1 DNS-verified host (with `www.` equivalence) so a page
    // cannot redirect to an unverified external domain that DNS-rebinds to a private IP.
    let expected_url = url.clone();
    builder = builder
        .on_navigation(move |target_url| is_same_scrape_host(&expected_url, target_url))
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
    let extracted = tauri::async_runtime::spawn_blocking(move || {
        extract_html_to_markdown(&html, &url_for_parse)
    })
    .await
    .map_err(|e| format!("Rendered HTML extraction failed: {e}"))?;

    let title = extracted.title.or_else(|| {
        let trimmed = capture.title.trim();
        (!trimmed.is_empty()).then_some(trimmed.to_string())
    });

    Ok(Tier2Outcome {
        response: LocalScrapeResponse {
            url: final_url,
            title,
            markdown: extracted.markdown,
            source: "webview",
        },
        article_non_ws_len: extracted.article_non_ws_len,
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

async fn acquire_host_and_http_permits<'a>(
    state: &'a ScraperState,
    url: &Url,
    deadline: Instant,
    timeout: Duration,
) -> Result<
    (
        tokio::sync::OwnedSemaphorePermit,
        tokio::sync::SemaphorePermit<'a>,
    ),
    String,
> {
    let host_key = normalized_host_for_compare(url).unwrap_or_default();
    let host_sem = state.host_semaphore(&host_key)?;

    let remaining = deadline.saturating_duration_since(Instant::now());
    let host_permit = tokio::time::timeout(remaining, host_sem.acquire_owned())
        .await
        .map_err(|_| format!("Request timed out after {:.1} s.", timeout.as_secs_f64()))?
        .map_err(|_| "Scraper per-host semaphore closed.".to_string())?;

    let remaining = deadline.saturating_duration_since(Instant::now());
    let http_permit = tokio::time::timeout(remaining, state.http_slots.acquire())
        .await
        .map_err(|_| format!("Request timed out after {:.1} s.", timeout.as_secs_f64()))?
        .map_err(|_| "Scraper HTTP semaphore closed.".to_string())?;

    Ok((host_permit, http_permit))
}

async fn scrape_pipeline(
    app: &AppHandle,
    state: &ScraperState,
    url: Url,
    timeout: Duration,
) -> Result<LocalScrapeResponse, String> {
    let deadline = Instant::now() + timeout;
    let tier1 = {
        let (_host_permit, _http_permit) =
            acquire_host_and_http_permits(state, &url, deadline, timeout).await?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        fetch_and_extract_http(&state.client, &url, remaining).await?
    };

    if tier1.should_try_webview {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining >= Duration::from_secs(2)
            && let Ok(final_parsed) = validate_scrape_url(&tier1.url)
            && let Ok(rendered) =
                render_in_hidden_webview(app, state, &final_parsed, remaining).await
            && (rendered.article_non_ws_len > tier1.article_non_ws_len
                || non_whitespace_len(&rendered.response.markdown)
                    > non_whitespace_len(&tier1.markdown))
        {
            return Ok(rendered.response);
        }
    }

    Ok(LocalScrapeResponse {
        url: tier1.url,
        title: tier1.title,
        markdown: tier1.markdown,
        source: tier1.source,
    })
}

/// Fetches a public `http(s)://` webpage or text-based PDF locally and extracts Markdown.
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
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Builds a minimal valid single-page PDF 1.4 in memory with optional text line.
    fn build_minimal_pdf(text: Option<&str>) -> Vec<u8> {
        let content_stream = match text {
            Some(line) => format!("BT /F1 18 Tf 72 720 Td ({line}) Tj ET"),
            None => String::new(),
        };
        let objects = [
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_string(),
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_string(),
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n".to_string(),
            "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_string(),
            format!(
                "5 0 obj\n<< /Length {} >>\nstream\n{}\nendstream\nendobj\n",
                content_stream.len(),
                content_stream
            ),
        ];

        let mut buf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for obj in &objects {
            offsets.push(buf.len());
            buf.extend_from_slice(obj.as_bytes());
        }
        let xref_offset = buf.len();
        buf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for off in offsets {
            buf.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        buf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        buf
    }

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
    fn same_scrape_host_allows_www_equivalence_and_blocks_cross_host_or_private() {
        let base = Url::parse("https://example.com/docs/intro").unwrap();
        assert!(is_same_scrape_host(
            &base,
            &Url::parse("https://www.example.com/docs/next").unwrap()
        ));
        assert!(is_same_scrape_host(
            &base,
            &Url::parse("https://EXAMPLE.COM/other").unwrap()
        ));
        assert!(!is_same_scrape_host(
            &base,
            &Url::parse("https://evil.example/phish").unwrap()
        ));
        assert!(!is_same_scrape_host(
            &base,
            &Url::parse("http://127.0.0.1:8090/").unwrap()
        ));
    }

    #[test]
    fn decode_text_bytes_handles_gbk_header_meta_charset_and_shift_jis() {
        let chinese = "<html><head><title>深度研究测试</title></head><body><p>本地抓取支持中文编码。</p></body></html>";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(chinese);
        let decoded_header = decode_text_bytes(&gbk_bytes, Some("text/html; charset=gbk"), true);
        assert_eq!(decoded_header, chinese);

        let with_meta =
            "<html><head><meta charset=\"gbk\"></head><body><p>中文网页内容</p></body></html>";
        let (meta_gbk_bytes, _, _) = encoding_rs::GBK.encode(with_meta);
        let decoded_meta = decode_text_bytes(&meta_gbk_bytes, Some("text/html"), true);
        assert_eq!(decoded_meta, with_meta);

        let japanese = "日本語のページ内容";
        let (sjis_bytes, _, _) = encoding_rs::SHIFT_JIS.encode(japanese);
        let decoded_sjis =
            decode_text_bytes(&sjis_bytes, Some("text/plain; charset=shift_jis"), false);
        assert_eq!(decoded_sjis, japanese);
    }

    #[test]
    fn extract_html_to_markdown_strips_chrome_data_images_and_permalink_noise() {
        let html = r##"<!doctype html>
<html>
<head><title>Rust Async Guide</title></head>
<body>
  <nav><a href="/home">Home</a><a href="/pricing">Pricing</a></nav>
  <main>
    <article>
      <h1>Rust Async Guide <a href="#guide" aria-label="Permalink">¶</a></h1>
      <p>Tokio provides a multi-threaded runtime for asynchronous Rust applications with cooperative scheduling and low-overhead tasks.</p>
      <p><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="inline svg"> <img src="https://docs.example.com/arch.png" alt="Architecture diagram"></p>
      <p>Read the <a href="/docs/tasks">task documentation</a> or <a href="javascript:void(0)">copy command</a> and ignore <a href="/icon"></a>.</p>
      <h2>Example <a href="#example">#</a></h2>
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
</html>"##;

        let extracted = extract_html_to_markdown(html, "https://docs.example.com/guide");
        assert_eq!(extracted.title.as_deref(), Some("Rust Async Guide"));
        assert!(
            extracted.markdown.contains("multi-threaded runtime"),
            "md={}",
            extracted.markdown
        );
        assert!(
            extracted
                .markdown
                .contains("![Architecture diagram](https://docs.example.com/arch.png)"),
            "md={}",
            extracted.markdown
        );
        assert!(
            !extracted.markdown.contains("data:image/svg+xml"),
            "md={}",
            extracted.markdown
        );
        assert!(
            !extracted.markdown.contains("¶"),
            "md={}",
            extracted.markdown
        );
        assert!(
            !extracted.markdown.contains("javascript:"),
            "md={}",
            extracted.markdown
        );
        assert!(
            extracted.markdown.contains("copy command"),
            "md={}",
            extracted.markdown
        );
        assert!(
            extracted.markdown.contains("async fn greet()"),
            "md={}",
            extracted.markdown
        );
        assert!(
            !extracted.markdown.contains("window.__tracking"),
            "md={}",
            extracted.markdown
        );
        assert!(
            !extracted.markdown.contains("Copyright 2026 Example Corp"),
            "md={}",
            extracted.markdown
        );
    }

    #[test]
    fn spa_shell_heuristic_detects_partially_ssrd_spas_by_article_length() {
        let next_shell = r#"<html><body><header>Navigation link one Navigation link two Navigation link three Navigation link four Cookie consent banner text with lots of boilerplate words so raw body length exceeds 200 characters easily even though main content is empty</header><div id="__next"></div><script src="/app.js"></script></body></html>"#;
        let extracted = extract_html_to_markdown(next_shell, "https://spa.example/");
        assert!(
            looks_like_spa_shell(next_shell, &extracted),
            "expected partially-SSR'd SPA shell to escalate (article_len={}, md={})",
            extracted.article_non_ws_len,
            extracted.markdown
        );

        let static_short = r#"<html><body><h1>Hello</h1><p>Short static notice.</p></body></html>"#;
        let static_extracted = extract_html_to_markdown(static_short, "https://static.example/");
        assert!(!looks_like_spa_shell(static_short, &static_extracted));

        let rich = ExtractedHtml {
            title: Some("Doc".into()),
            markdown: "word ".repeat(60),
            article_non_ws_len: 240,
        };
        assert!(!looks_like_spa_shell(next_shell, &rich));
    }

    #[test]
    fn extract_pdf_to_markdown_extracts_text_and_errors_on_blank_pdf() {
        let pdf_bytes = build_minimal_pdf(Some("Hello local PDF extractor from Rust"));
        let (_title, md) = extract_pdf_to_markdown(pdf_bytes).unwrap();
        assert!(
            md.contains("Hello local PDF extractor from Rust"),
            "expected extracted PDF text, got: {md}"
        );

        let blank_pdf = build_minimal_pdf(None);
        let err = extract_pdf_to_markdown(blank_pdf).unwrap_err();
        assert!(err.contains("no selectable text"), "err={err}");
    }

    async fn spawn_mock_server(
        handler: impl Fn(String) -> Vec<u8> + Send + Sync + 'static,
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
                    let _ = stream.write_all(&resp).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn tier1_http_handles_markdown_redirects_pdf_transient_retry_and_4xx() {
        let pdf_payload = Arc::new(build_minimal_pdf(Some("Attention Is All You Need")));
        let flaky_hits = Arc::new(AtomicUsize::new(0));
        let forbidden_hits = Arc::new(AtomicUsize::new(0));
        let flaky_clone = Arc::clone(&flaky_hits);
        let forbidden_clone = Arc::clone(&forbidden_hits);
        let pdf_clone = Arc::clone(&pdf_payload);

        let (addr, _server) = spawn_mock_server(move |req| {
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
                    .into_bytes()
                }
                "/redirect" => b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                "/final" => {
                    let body = "<html><head><title>Final Page</title></head><body><article><h1>Final Page</h1><p>This is a full paragraph of real article content after following a redirect cleanly so readability extracts it properly without escalating to a browser.</p><p>Second paragraph adds enough text for a realistic document body.</p></article></body></html>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .into_bytes()
                }
                "/paper.pdf" => {
                    let mut resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        pdf_clone.len()
                    )
                    .into_bytes();
                    resp.extend_from_slice(&pdf_clone);
                    resp
                }
                "/flaky" => {
                    let hit = flaky_clone.fetch_add(1, Ordering::SeqCst);
                    if hit == 0 {
                        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy".to_vec()
                    } else {
                        let body = "Recovered after transient 503.";
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .into_bytes()
                    }
                }
                "/binary" => b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\x89PNG".to_vec(),
                _ => {
                    forbidden_clone.fetch_add(1, Ordering::SeqCst);
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden".to_vec()
                }
            }
        })
        .await;

        let client = build_http_client(false);
        let timeout = Duration::from_secs(5);

        let md_url = Url::parse(&format!("http://{addr}/md")).unwrap();
        let md = fetch_and_extract_http(&client, &md_url, timeout)
            .await
            .unwrap();
        assert_eq!(md.source, "markdown-negotiated");
        assert_eq!(md.title.as_deref(), Some("Negotiated Doc"));

        let redir_url = Url::parse(&format!("http://{addr}/redirect")).unwrap();
        let redir = fetch_and_extract_http(&client, &redir_url, timeout)
            .await
            .unwrap();
        assert_eq!(redir.url, format!("http://{addr}/final"));
        assert_eq!(redir.title.as_deref(), Some("Final Page"));
        assert!(!redir.should_try_webview);

        let pdf_url = Url::parse(&format!("http://{addr}/paper.pdf")).unwrap();
        let pdf = fetch_and_extract_http(&client, &pdf_url, timeout)
            .await
            .unwrap();
        assert_eq!(pdf.source, "pdf");
        assert!(pdf.markdown.contains("Attention Is All You Need"));

        let flaky_url = Url::parse(&format!("http://{addr}/flaky")).unwrap();
        let recovered = fetch_and_extract_http(&client, &flaky_url, timeout)
            .await
            .unwrap();
        assert_eq!(recovered.markdown, "Recovered after transient 503.");
        assert_eq!(flaky_hits.load(Ordering::SeqCst), 2);

        let bin_url = Url::parse(&format!("http://{addr}/binary")).unwrap();
        let bin_err = fetch_and_extract_http(&client, &bin_url, timeout)
            .await
            .unwrap_err();
        assert!(bin_err.contains("image/png"), "err={bin_err}");

        let err_url = Url::parse(&format!("http://{addr}/blocked")).unwrap();
        let http_err = fetch_and_extract_http(&client, &err_url, timeout)
            .await
            .unwrap_err();
        assert!(http_err.contains("HTTP 403"), "err={http_err}");
        assert_eq!(
            forbidden_hits.load(Ordering::SeqCst),
            1,
            "403 must not retry"
        );
    }

    #[tokio::test]
    async fn per_host_semaphore_caps_concurrent_scrapes_per_host_at_two() {
        let state = Arc::new(ScraperState::default());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let url = Url::parse("https://docs.example.com/page").unwrap();

        let mut handles = Vec::new();
        for _ in 0..6 {
            let state = Arc::clone(&state);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            let url = url.clone();
            handles.push(tokio::spawn(async move {
                let deadline = Instant::now() + Duration::from_secs(5);
                let _permits =
                    acquire_host_and_http_permits(&state, &url, deadline, Duration::from_secs(5))
                        .await
                        .unwrap();
                let cur = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), MAX_CONCURRENT_PER_HOST);
    }
}
