use crate::accept::{accept_submission, Receipt};
use crate::captcha::{verify_captcha, CaptchaOptions, TURNSTILE_ENDPOINT};
use crate::config::{AppConfig, FormConfig, FormField, FormFieldType};
use crate::errors::{AppError, Result};
use crate::forms::{
    create_dynamic_form, deactivate_dynamic_form, generate_html_snippet, get_dynamic_form_by_public_id,
    resend_verification, verify_dynamic_form,
};
use crate::input::{parse_submission, ParsedInput};
use crate::ratelimit::{
    compute_ip_hash, consume_deactivation_rate_limit, consume_global_rate_limit, consume_rate_limit,
    consume_recipient_registration_rate_limit, consume_registration_rate_limit,
};
use crate::repo::get_worker_heartbeat;
use crate::sentinel::Sentinel;
use crate::smtp::{send_system_message, SmtpConfig, SubmitResult};
use crate::storage::Storage;
use crate::views::{
    render_error_page, render_generator_page, render_receipt_page, render_test_page, render_verification_page,
    GeneratorState, VerificationResult,
};
use axum::body::{to_bytes, Body, BodyDataStream};
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const MAX_AGGREGATE_MULTIPART_BYTES: u64 = 11_534_336;
const MAX_URLENCODED_BYTES: usize = 1_048_576;
const MAX_IN_FLIGHT: usize = 2;

pub struct AppState {
    pub config: AppConfig,
    pub pool: PgPool,
    pub storage: Storage,
    pub sentinel: Sentinel,
    pub smtp: SmtpConfig,
    in_flight: AtomicUsize,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(config: AppConfig, pool: PgPool, storage: Storage, sentinel: Sentinel) -> Shared {
        let smtp = SmtpConfig::from_app(&config);
        Arc::new(Self { config, pool, storage, sentinel, smtp, in_flight: AtomicUsize::new(0) })
    }
}

struct InFlight(Shared);
impl InFlight {
    fn acquire(s: &Shared) -> Result<Self> {
        let prev = s.in_flight.fetch_add(1, Ordering::SeqCst);
        if prev >= MAX_IN_FLIGHT {
            s.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(AppError::new(
                "service_unavailable",
                503,
                "In-flight upload capacity full, please try again shortly",
            ));
        }
        Ok(Self(s.clone()))
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Carries the error through the response so the error middleware can render it
/// as JSON or HTML depending on the request's Accept header.
#[derive(Clone)]
struct ErrorMarker(AppError);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        r.extensions_mut().insert(ErrorMarker(self));
        r
    }
}

fn json_resp(status: u16, v: Value) -> Response {
    let mut r = Response::new(Body::from(v.to_string()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    r
}

fn html_resp(status: u16, html: String) -> Response {
    let mut r = Response::new(Body::from(html));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    r
}

fn redirect_303(to: &str) -> Response {
    Redirect::to(to).into_response()
}

async fn error_middleware(req: Request, next: Next) -> Response {
    let accept = req.headers().get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let resp = next.run(req).await;
    let Some(ErrorMarker(err)) = resp.extensions().get::<ErrorMarker>().cloned() else {
        return resp;
    };
    let request_id = Uuid::new_v4().to_string();
    if err.status >= 500 {
        tracing::error!(code = err.code, request_id = %request_id, "request failed");
    }
    let mut out = if accept.contains("text/html") && !accept.contains("application/json") {
        html_resp(err.status, render_error_page(err.status, err.code, &err.message))
    } else {
        json_resp(err.status, err.body(Some(&request_id)))
    };
    if err.status == 413 {
        out.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
    out
}

/// Request body parked outside the handler. Whatever a handler leaves unread when it rejects a
/// request (rate limit, 403, 404, 415, validation failure mid-upload...) is drained afterwards so
/// the client reliably receives the JSON error instead of a reset connection (EPIPE).
#[derive(Clone, Default)]
struct BodySlot(Arc<std::sync::Mutex<Option<BodyDataStream>>>);

impl BodySlot {
    fn stream(&self) -> Tracked {
        let inner = self.0.lock().ok().and_then(|mut g| g.take());
        Tracked { inner, slot: self.clone() }
    }
    fn body(&self) -> Body {
        Body::from_stream(self.stream())
    }
}

/// Hands the remaining (unread) body back to the slot when the consumer is dropped.
struct Tracked {
    inner: Option<BodyDataStream>,
    slot: BodySlot,
}

impl futures_util::Stream for Tracked {
    type Item = std::result::Result<axum::body::Bytes, axum::Error>;
    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        match self.inner.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_next(cx),
            None => std::task::Poll::Ready(None),
        }
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some(s) = self.inner.take() {
            if let Ok(mut g) = self.slot.0.lock() {
                *g = Some(s);
            }
        }
    }
}

async fn park_body(mut req: Request, next: Next) -> Response {
    let slot = BodySlot::default();
    if let Ok(mut g) = slot.0.lock() {
        *g = Some(std::mem::replace(req.body_mut(), Body::empty()).into_data_stream());
    }
    req.extensions_mut().insert(slot.clone());
    let resp = next.run(req).await;
    let unread = slot.0.lock().ok().and_then(|mut g| g.take());
    let too_large = resp.extensions().get::<ErrorMarker>().is_some_and(|m| m.0.status == 413);
    if let (Some(mut stream), false) = (unread, too_large) {
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            let mut seen = 0usize;
            while let Some(Ok(chunk)) = futures_util::StreamExt::next(&mut stream).await {
                seen += chunk.len();
                if seen > 2 * 1024 * 1024 {
                    break;
                }
            }
        })
        .await;
    }
    resp
}

async fn not_found() -> Response {
    AppError::not_found("Route not found").into_response()
}

pub fn build_router(state: Shared) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/", get(index))
        .route("/test", get(test_page))
        .route("/api/forms", post(register_form))
        .route("/verify", get(verify_get).post(verify_post))
        .route("/api/forms/{form_id}/resend", post(resend))
        .route("/f/{form_id}/deactivate", post(deactivate))
        .route("/api/forms/{form_id}/deactivate", post(deactivate))
        .route("/f/{form_id}", post(submit_public).layer(middleware::from_fn(park_body)))
        .route("/forms/{form_id}", post(submit_legacy).layer(middleware::from_fn(park_body)))
        .route("/demo/job-application", get(demo_job))
        .route("/demo/contact", get(demo_contact))
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
        .layer(middleware::from_fn(error_middleware))
        .with_state(state)
}

fn header_str<'a>(h: &'a HeaderMap, name: &str) -> &'a str {
    h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

fn base_url(h: &HeaderMap, cfg: &AppConfig) -> String {
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).map(String::from).unwrap_or_else(|| format!("{}:{}", cfg.host, cfg.port));
    let proto = h.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()).unwrap_or("http");
    format!("{proto}://{host}")
}

fn client_ip(addr: &SocketAddr) -> String {
    addr.ip().to_canonical().to_string()
}

fn ip_hash(cfg: &AppConfig, ip: &str) -> String {
    compute_ip_hash(&cfg.ip_hash_secret, &Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), ip)
}

// ---------- health ----------

async fn live() -> Response {
    json_resp(200, json!({"status":"ok"}))
}

async fn ready(State(s): State<Shared>) -> Response {
    match ready_check(&s).await {
        Ok(()) => json_resp(200, json!({"status":"ready"})),
        Err(reason) => json_resp(503, json!({"status":"not_ready","reason":reason})),
    }
}

async fn ready_check(s: &Shared) -> std::result::Result<(), String> {
    sqlx::query("SELECT 1").execute(&s.pool).await.map_err(|e| e.to_string())?;
    if !s.storage.is_writable() {
        return Err("storage is not writable".into());
    }
    let sentinel = s.sentinel.clone();
    let reachable = tokio::task::spawn_blocking(move || sentinel.socket_exists()).await.unwrap_or(false);
    if !reachable {
        return Err("raxosentinel socket unreachable".into());
    }
    match get_worker_heartbeat(&s.pool).await.map_err(|e| e.message)? {
        None => Err("no worker heartbeat".into()),
        Some(t) => {
            let age = (Utc::now() - t).num_milliseconds();
            if age > 60_000 {
                Err(format!("stale worker heartbeat ({}s ago)", (age as f64 / 1000.0).round() as i64))
            } else {
                Ok(())
            }
        }
    }
}

// ---------- pages ----------

async fn index(State(s): State<Shared>, headers: HeaderMap) -> Response {
    html_resp(200, render_generator_page(&base_url(&headers, &s.config), None))
}

async fn test_page(State(s): State<Shared>, headers: HeaderMap) -> Response {
    let site_key = std::env::var("CAPTCHA_SITEKEY").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    html_resp(
        200,
        render_test_page(&base_url(&headers, &s.config), "vps-delivery-test", site_key.as_deref().unwrap_or("0x4AAAAAAFvLUA97Ll30BfAu")),
    )
}

async fn demo_file(s: &Shared, name: &str) -> Response {
    if !s.config.demo_mode {
        return json_resp(404, json!({"error":{"code":"not_found","message":"Not found"}}));
    }
    let path = std::env::current_dir().unwrap_or_default().join("examples").join(name);
    match tokio::fs::read_to_string(path).await {
        Ok(h) => html_resp(200, h),
        Err(_) => json_resp(404, json!({"error":{"code":"not_found","message":"Demo file not found"}})),
    }
}
async fn demo_job(State(s): State<Shared>) -> Response {
    demo_file(&s, "job-application.html").await
}
async fn demo_contact(State(s): State<Shared>) -> Response {
    demo_file(&s, "contact.html").await
}

// ---------- body helpers ----------

fn content_type(h: &HeaderMap) -> String {
    header_str(h, "content-type").to_string()
}

fn is_json_ct(ct: &str) -> bool {
    ct.to_lowercase().contains("application/json")
}
fn is_form_ct(ct: &str) -> bool {
    ct.to_lowercase().contains("application/x-www-form-urlencoded")
}
fn is_multipart_ct(ct: &str) -> bool {
    ct.to_lowercase().contains("multipart/form-data")
}

async fn read_limited(body: Body, limit: usize) -> Result<Vec<u8>> {
    to_bytes(body, limit).await.map(|b| b.to_vec()).map_err(|_| AppError::too_large())
}

/// Returns a flat string map for JSON-object or urlencoded bodies.
async fn read_simple_body(headers: &HeaderMap, body: Body) -> Result<HashMap<String, Value>> {
    let ct = content_type(headers);
    if ct.is_empty() {
        let b = read_limited(body, MAX_AGGREGATE_MULTIPART_BYTES as usize).await?;
        if b.is_empty() {
            return Ok(HashMap::new());
        }
        return Err(AppError::new("unsupported_type", 415, "Unsupported media type."));
    }
    if is_json_ct(&ct) {
        let b = read_limited(body, MAX_AGGREGATE_MULTIPART_BYTES as usize).await?;
        if b.is_empty() {
            return Ok(HashMap::new());
        }
        return match serde_json::from_slice::<Value>(&b) {
            Ok(Value::Object(m)) => Ok(m.into_iter().collect()),
            Ok(_) => Ok(HashMap::new()),
            Err(_) => Err(AppError::bad_request("Invalid request syntax.")),
        };
    }
    if is_form_ct(&ct) {
        let b = read_limited(body, MAX_URLENCODED_BYTES).await?;
        let mut m = HashMap::new();
        for (k, v) in url::form_urlencoded::parse(&b) {
            m.insert(k.into_owned(), Value::String(v.into_owned()));
        }
        return Ok(m);
    }
    Err(AppError::new("unsupported_type", 415, "Unsupported media type."))
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn str_field(m: &HashMap<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(|v| v.as_str()).map(String::from)
}

// ---------- registration ----------

fn system_smtp_failure(r: &SubmitResult) -> Option<String> {
    match r {
        SubmitResult::Submitted { .. } => None,
        SubmitResult::SafeRetry(c) | SubmitResult::Failed(c) | SubmitResult::Unknown(c) => Some(c.clone()),
    }
}

async fn register_form(
    State(s): State<Shared>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    let cfg = &s.config;
    consume_registration_rate_limit(&s.pool, &ip_hash(cfg, &client_ip(&addr)), Utc::now()).await?;
    let fields = read_simple_body(&headers, body).await?;
    let email = str_field(&fields, "email");
    if let Some(e) = email.as_deref().filter(|e| !e.is_empty()) {
        consume_recipient_registration_rate_limit(&s.pool, e, Utc::now()).await?;
    }
    let created = create_dynamic_form(&s.pool, email.as_deref()).await?;
    let base = base_url(&headers, cfg);
    let form_id = &created.form_id;
    let activation = format!("{base}/verify?token={}", created.verification_token);
    let subject = format!("Activate your Raxo Email form ({}...)", &form_id[..8.min(form_id.len())]);
    let text = format!(
        "Hello,\n\nYou requested a new Raxo Email form endpoint.\n\nForm ID: {form_id}\nAction URL: {base}/f/{form_id}\n\nTo activate submission delivery, click the link below:\n{activation}\n\nThis activation link expires in 24 hours. Submissions sent while pending are held safely in your queue.\n\nManagement Key: {}\n(Use this key if you ever want to deactivate this form without an account)\n",
        created.management_token
    );
    let html = format!(
        "<p>Hello,</p><p>You requested a new Raxo Email form endpoint.</p><p><strong>Form ID:</strong> <code>{form_id}</code><br><strong>Action URL:</strong> <code>{base}/f/{form_id}</code></p><p><a href=\"{activation}\" style=\"display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:5px;font-weight:bold;\">Activate Form</a></p><p>Or copy this activation link:<br><a href=\"{activation}\">{activation}</a></p><p><small>This activation link expires in 24 hours. Submissions sent before activation are held safely and delivered upon verification.<br>Management Key: <code>{}</code></small></p>",
        created.management_token
    );
    let r = send_system_message(
        &created.form.recipient_email,
        &subject,
        &text,
        &html,
        &s.smtp,
        &format!("notifications@{}", cfg.message_id_domain),
        &cfg.message_id_domain,
    )
    .await;
    if let Some(code) = system_smtp_failure(&r) {
        tracing::warn!(code, "could not dispatch activation email directly");
    }

    let accept = header_str(&headers, "accept");
    if !accept.contains("application/json") && accept.contains("text/html") {
        return Ok(html_resp(
            200,
            render_generator_page(&base, Some(GeneratorState { form_id: Some(form_id), email: Some(&created.form.recipient_email), error: None })),
        ));
    }
    Ok(json_resp(
        201,
        json!({
            "status": "pending_verification",
            "form_id": form_id,
            "action_url": format!("{base}/f/{form_id}"),
            "html_snippet": generate_html_snippet(&base, form_id),
            "management_token": created.management_token,
            "message": "Form created successfully. An activation link has been sent to your email address.",
        }),
    ))
}

// ---------- verification ----------

const VERIFIED_MSG: &str = "Your email ownership has been verified! Your form is now active and ready to deliver submissions.";

fn verification_html(status: u16, success: bool, message: &str, promoted: i64) -> Response {
    html_resp(
        status,
        render_verification_page(&VerificationResult { success, message, promoted_count: promoted, is_prefetch: false, token: None }),
    )
}

async fn verify_get(State(s): State<Shared>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let Some(token) = q.get("token").filter(|t| !t.is_empty()) else {
        return verification_html(400, false, "Missing verification token in query parameters.", 0);
    };
    let prefetch = header_str(&headers, "purpose") == "prefetch"
        || header_str(&headers, "sec-purpose") == "prefetch"
        || header_str(&headers, "x-purpose") == "preview"
        || header_str(&headers, "x-moz") == "prefetch";
    if prefetch {
        let mut r = html_resp(
            200,
            render_verification_page(&VerificationResult {
                success: false,
                message: "Link prefetch detected. To verify your email and activate your form, please click the confirmation button below.",
                promoted_count: 0,
                is_prefetch: true,
                token: Some(token.trim()),
            }),
        );
        r.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
        return r;
    }
    match verify_dynamic_form(&s.pool, token).await {
        Ok(res) => verification_html(200, true, VERIFIED_MSG, res.promoted as i64),
        Err(e) => verification_html(e.status, false, &e.message, 0),
    }
}

async fn verify_post(
    State(s): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response> {
    let fields = read_simple_body(&headers, body).await?;
    let token = str_field(&fields, "token").filter(|t| !t.is_empty()).or_else(|| q.get("token").cloned().filter(|t| !t.is_empty()));
    let Some(token) = token else {
        return Ok(verification_html(400, false, "Missing verification token.", 0));
    };
    let json_accept = header_str(&headers, "accept").contains("application/json");
    match verify_dynamic_form(&s.pool, &token).await {
        Ok(res) => {
            if json_accept {
                return Ok(json_resp(
                    200,
                    json!({"status":"verified","form_id":res.form.public_id,"promoted_notifications":res.promoted}),
                ));
            }
            Ok(verification_html(200, true, VERIFIED_MSG, res.promoted as i64))
        }
        Err(e) => {
            if json_accept {
                return Ok(json_resp(e.status, json!({"error":{"code":"verification_failed","message":e.message}})));
            }
            Ok(verification_html(e.status, false, &e.message, 0))
        }
    }
}

async fn resend(State(s): State<Shared>, Path(form_id): Path<String>, headers: HeaderMap) -> Result<Response> {
    let (form, token) = resend_verification(&s.pool, &form_id).await?;
    let base = base_url(&headers, &s.config);
    let activation = format!("{base}/verify?token={token}");
    let subject = format!("Activate your Raxo Email form ({}...)", &form_id[..8.min(form_id.len())]);
    let text = format!("Hello,\n\nHere is your new activation link for Form ID {form_id}:\n{activation}\n\nThis activation link expires in 24 hours.\n");
    let html = format!("<p>Hello,</p><p>Here is your new activation link for Form ID <code>{form_id}</code>:</p><p><a href=\"{activation}\">Activate Form</a></p>");
    let r = send_system_message(
        &form.recipient_email,
        &subject,
        &text,
        &html,
        &s.smtp,
        &format!("notifications@{}", s.config.message_id_domain),
        &s.config.message_id_domain,
    )
    .await;
    if system_smtp_failure(&r).is_some() {
        return Err(AppError::internal());
    }
    Ok(json_resp(200, json!({"status":"ok","message":"A new activation email has been sent."})))
}

async fn deactivate(State(s): State<Shared>, Path(form_id): Path<String>, headers: HeaderMap, body: Body) -> Result<Response> {
    consume_deactivation_rate_limit(&s.pool, &form_id, Utc::now()).await?;
    let fields = read_simple_body(&headers, body).await?;
    let token = str_field(&fields, "management_token")
        .filter(|t| !t.is_empty())
        .or_else(|| headers.get("x-management-token").and_then(|v| v.to_str().ok()).map(String::from));
    deactivate_dynamic_form(&s.pool, &form_id, token.as_deref()).await?;
    let accept = header_str(&headers, "accept");
    if accept.contains("text/html") && !accept.contains("application/json") {
        return Ok(verification_html(
            200,
            true,
            &format!("Form {form_id} has been successfully deactivated. No further submissions will be accepted."),
            0,
        ));
    }
    Ok(json_resp(200, json!({"status":"deactivated","form_id":form_id,"message":"Form has been successfully deactivated."})))
}

// ---------- submissions ----------

pub fn validate_next_url(next: &str, origin: Option<&str>, referer: Option<&str>, allowed_origins: &[String]) -> Option<String> {
    let t = next.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("//") || t.starts_with("\\\\") || t.starts_with("/\\") {
        return None;
    }
    if t.starts_with('/') {
        return Some(t.to_string());
    }
    let parsed = Url::parse(t).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    if !allowed_origins.is_empty() {
        let ok = allowed_origins
            .iter()
            .any(|ao| Url::parse(ao).map(|u| u.origin().ascii_serialization() == parsed.origin().ascii_serialization()).unwrap_or(false));
        return ok.then(|| parsed.to_string());
    }
    let source = origin.filter(|s| !s.is_empty()).or(referer.filter(|s| !s.is_empty()));
    if let Some(src) = source {
        let sh = Url::parse(src).ok()?;
        let sh = sh.host_str()?.to_string();
        let ph = parsed.host_str()?;
        if ph == sh || ph.ends_with(&format!(".{sh}")) {
            return Some(parsed.to_string());
        }
        return None;
    }
    Some(parsed.to_string())
}

fn sanitize_subject(raw: &str) -> String {
    let clean: String = raw.replace(['\r', '\n'], " ");
    let clean: String = clean.trim().chars().take(150).collect();
    if clean.is_empty() {
        "New Form Submission".into()
    } else {
        clean
    }
}

fn opt_header(h: &HeaderMap, n: &str) -> Option<String> {
    h.get(n).and_then(|v| v.to_str().ok()).map(String::from)
}

fn multipart_boundary(ct: &str) -> Option<String> {
    multer::parse_boundary(ct).ok()
}

fn check_multipart_length(headers: &HeaderMap) -> Result<()> {
    if let Some(n) = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
        if n > MAX_AGGREGATE_MULTIPART_BYTES {
            return Err(AppError::new(
                "file_too_large",
                413,
                format!("Request body exceeds multipart aggregate limit of {MAX_AGGREGATE_MULTIPART_BYTES} bytes"),
            ));
        }
    }
    Ok(())
}

fn receipt_response(receipt: &Receipt) -> Response {
    json_resp(202, serde_json::to_value(receipt).unwrap())
}

async fn submit_public(
    State(s): State<Shared>,
    Path(form_id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Result<Response> {
    let (parts, _) = req.into_parts();
    let slot = parts.extensions.get::<BodySlot>().cloned().unwrap_or_default();
    let headers = parts.headers;
    let ct = content_type(&headers);
    if is_multipart_ct(&ct) {
        check_multipart_length(&headers)?;
    }
    let _guard = InFlight::acquire(&s)?;
    let cfg = &s.config;

    let mut initial_state = "queued";
    let mut form: FormConfig;
    if let Some(dynf) = get_dynamic_form_by_public_id(&s.pool, &form_id).await? {
        if dynf.status == "deactivated" {
            return Err(AppError::forbidden("This form has been deactivated"));
        }
        if dynf.status == "pending_verification" {
            initial_state = "held_unverified";
        }
        form = FormConfig {
            id: dynf.public_id.clone(),
            enabled: true,
            from: format!("notifications@{}", cfg.message_id_domain),
            recipient: dynf.recipient_email.clone(),
            subject_prefix: "New Form Submission".into(),
            reply_to_field: None,
            success_url: None,
            allowed_origins: vec![],
            fields: vec![],
        };
    } else {
        let st = cfg.forms.get(&form_id).ok_or_else(|| AppError::not_found(format!("Form not found: {form_id}")))?;
        if !st.enabled {
            return Err(AppError::forbidden(format!("Form is disabled: {form_id}")));
        }
        form = st.clone();
    }

    consume_global_rate_limit(&s.pool, Utc::now(), 1000).await?;
    consume_rate_limit(&s.pool, &form.id, &ip_hash(cfg, &client_ip(&addr)), Utc::now(), 5, 100).await?;

    let parsed: ParsedInput = if is_multipart_ct(&ct) {
        let boundary = multipart_boundary(&ct).ok_or_else(|| AppError::bad_request("Invalid request syntax."))?;
        parse_submission(slot.stream(), boundary, &form, &s.storage).await?
    } else {
        let raw = read_simple_body(&headers, slot.body()).await?;
        if raw.len() > 50 {
            return Err(AppError::bad_request("Too many form fields (maximum 50)"));
        }
        let mut fields: BTreeMap<String, Option<String>> = BTreeMap::new();
        for (k, v) in &raw {
            let sv = value_to_string(v);
            if sv.len() > 65536 {
                return Err(AppError::bad_request(format!("Field \"{k}\" exceeds 64 KB limit")));
            }
            fields.insert(k.clone(), Some(sv));
        }
        let get = |k: &str| fields.get(k).and_then(|v| v.clone()).unwrap_or_default();
        let honey = !get("_honey").trim().is_empty() || !get("_gotcha").trim().is_empty() || !get("website").trim().is_empty();
        let client_id = {
            let c = get("_submission_id");
            if c.is_empty() {
                None
            } else {
                Some(Uuid::parse_str(c.trim()).map_err(|_| AppError::invalid_form("Invalid _submission_id: must be a valid UUID v4"))?)
            }
        };
        ParsedInput {
            submission_id: Uuid::new_v4(),
            client_submission_id: client_id,
            fields,
            is_honeypot: honey,
            captcha_token: None,
            attachments: vec![],
        }
    };

    let origin = opt_header(&headers, "origin");
    let referer = opt_header(&headers, "referer");
    let field = |k: &str| parsed.fields.get(k).and_then(|v| v.clone()).filter(|v| !v.is_empty());

    if parsed.is_honeypot {
        if let Some(n) = field("_next") {
            if let Some(v) = validate_next_url(&n, origin.as_deref(), referer.as_deref(), &form.allowed_origins) {
                return Ok(redirect_303(&v));
            }
        }
        return Ok(json_resp(202, json!({"submission_id":null,"status":"received"})));
    }

    if let Some(sub) = field("_subject") {
        form.subject_prefix = sanitize_subject(&sub);
    }
    if field("_replyto").is_some() {
        form.reply_to_field = Some("_replyto".into());
    } else if field("email").is_some() {
        form.reply_to_field = Some("email".into());
    }
    if let Some(n) = field("_next") {
        if let Some(v) = validate_next_url(&n, origin.as_deref(), referer.as_deref(), &form.allowed_origins) {
            form.success_url = Some(v);
        }
    }
    if form.fields.is_empty() {
        form.fields = parsed
            .fields
            .keys()
            .filter(|k| !k.starts_with('_'))
            .map(|k| FormField { name: k.clone(), kind: FormFieldType::Text, required: false, max_length: 5000 })
            .collect();
    }

    let receipt = accept_submission(&parsed, &form, &s.pool, &s.storage, &cfg.message_id_domain, initial_state).await?;

    if let Some(u) = &form.success_url {
        return Ok(redirect_303(u));
    }
    let accept = header_str(&headers, "accept");
    if accept.contains("application/json") || !accept.contains("text/html") {
        return Ok(receipt_response(&receipt));
    }
    let id = receipt.submission_id.map(|u| u.to_string());
    Ok(html_resp(202, render_receipt_page(id.as_deref(), initial_state == "held_unverified")))
}

async fn submit_legacy(
    State(s): State<Shared>,
    Path(form_id): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Result<Response> {
    let (parts, _) = req.into_parts();
    let slot = parts.extensions.get::<BodySlot>().cloned().unwrap_or_default();
    let headers = parts.headers;
    let _guard = InFlight::acquire(&s)?;
    let cfg = &s.config;
    let ct = content_type(&headers);
    if !is_multipart_ct(&ct) {
        return Err(AppError::new("unsupported_type", 415, "Only multipart/form-data is accepted"));
    }
    check_multipart_length(&headers)?;
    let form = cfg.forms.get(&form_id).ok_or_else(|| AppError::not_found(format!("Form not found: {form_id}")))?;
    if !form.enabled {
        return Err(AppError::forbidden(format!("Form is disabled: {form_id}")));
    }
    let origin = opt_header(&headers, "origin");
    if cfg.node_env == "production" {
        let Some(o) = &origin else { return Err(AppError::forbidden("Missing Origin header in production")) };
        if !form.allowed_origins.contains(o) {
            return Err(AppError::forbidden(format!("Origin {o} is not allowed")));
        }
    } else if let Some(o) = &origin {
        if !form.allowed_origins.contains(o) {
            return Err(AppError::forbidden(format!("Origin {o} is not allowed")));
        }
    }
    let ip = client_ip(&addr);
    consume_rate_limit(&s.pool, &form.id, &ip_hash(cfg, &ip), Utc::now(), 5, 100).await?;

    let boundary = multipart_boundary(&ct).ok_or_else(|| AppError::bad_request("Invalid request syntax."))?;
    let parsed = parse_submission(slot.stream(), boundary, form, &s.storage).await?;

    if !parsed.is_honeypot {
        let hosts: Vec<String> = form
            .allowed_origins
            .iter()
            .map(|o| Url::parse(o).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_else(|| o.to_lowercase()))
            .collect();
        let valid = verify_captcha(
            parsed.captcha_token.as_deref(),
            &ip,
            &CaptchaOptions {
                secret: cfg.captcha_secret.as_deref(),
                demo_mode: cfg.demo_mode,
                allowed_hostnames: hosts,
                endpoint: TURNSTILE_ENDPOINT,
                timeout: Duration::from_secs(5),
            },
        )
        .await;
        let ok = match valid {
            Ok(v) => v,
            Err(e) => {
                for a in &parsed.attachments {
                    let _ = s.storage.delete(&a.storage_key, None);
                }
                return Err(e);
            }
        };
        if !ok {
            for a in &parsed.attachments {
                let _ = s.storage.delete(&a.storage_key, None);
            }
            return Err(AppError::new("captcha_failed", 422, "CAPTCHA verification failed"));
        }
    }

    let receipt = accept_submission(&parsed, form, &s.pool, &s.storage, &cfg.message_id_domain, "queued").await?;
    let accept = header_str(&headers, "accept");
    if accept.contains("application/json") || !accept.contains("text/html") {
        return Ok(receipt_response(&receipt));
    }
    if let Some(u) = &form.success_url {
        return Ok(redirect_303(u));
    }
    let id = receipt.submission_id.map(|u| u.to_string()).unwrap_or_else(|| "received".into());
    Ok(html_resp(
        202,
        format!("<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>Submission Received</title></head>\n<body>\n  <h1>Submission Received</h1>\n  <p>Status: received</p>\n  <p>Submission ID: <code>{id}</code></p>\n</body>\n</html>"),
    ))
}
