use crate::errors::{AppError, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

pub const RESERVED_FIELD_NAMES: &[&str] = &[
    "attachments",
    "_captcha_token",
    "_honey",
    "_submission_id",
    "_to",
    "_cc",
    "_from",
    "_next",
    "_subject",
    "_webhook",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormFieldType {
    Text,
    Email,
    Url,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormField {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: FormFieldType,
    pub required: bool,
    pub max_length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormConfig {
    pub id: String,
    pub enabled: bool,
    pub from: String,
    pub recipient: String,
    pub subject_prefix: String,
    pub reply_to_field: Option<String>,
    pub success_url: Option<String>,
    pub allowed_origins: Vec<String>,
    pub fields: Vec<FormField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpTlsMode {
    PlainLocal,
    Implicit,
    StarttlsRequired,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub node_env: String,
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub forms_config_path: PathBuf,
    pub storage_dir: PathBuf,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_tls_mode: SmtpTlsMode,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub smtp_max_message_bytes: u64,
    pub message_id_domain: String,
    pub captcha_secret: Option<String>,
    pub demo_mode: bool,
    pub ip_hash_secret: String,
    pub outbound_enabled: bool,
    pub trusted_proxy_cidrs: Vec<String>,
    pub sentinel_socket: PathBuf,
    pub sentinel_timeout_ms: u64,
    pub sentinel_max_size: u64,
    pub attachment_policy: AttachmentPolicy,
    pub attachment_scan_retries: i32,
    pub attachment_notice_html: bool,
    pub forms: BTreeMap<String, FormConfig>,
}

/// `Withhold`: each attachment is judged independently; unsafe or uninspectable ones are
/// withheld and the rest of the message is delivered with a notice.
/// `BlockMessage`: legacy behaviour; one unsafe attachment blocks the whole message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPolicy {
    Withhold,
    BlockMessage,
}

pub fn email_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$",
        )
        .unwrap()
    })
}

fn form_id_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap())
}
fn field_name_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9_]{1,40}$").unwrap())
}

fn is_http_url(s: &str) -> bool {
    url::Url::parse(s).map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false)
}

fn has_crlf(s: &str) -> bool {
    s.contains('\r') || s.contains('\n')
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormsFile {
    version: u32,
    forms: Vec<FormConfig>,
}

fn validate_form(i: usize, f: &FormConfig, issues: &mut Vec<String>) {
    let p = |s: &str| format!("forms.{i}.{s}");
    if !form_id_regex().is_match(&f.id) {
        issues.push(format!("{}: Form ID must match ^[a-z0-9][a-z0-9-]{{0,39}}$", p("id")));
    }
    for (key, val, label) in
        [("from", &f.from, "Invalid sender email"), ("recipient", &f.recipient, "Invalid recipient email")]
    {
        if val.contains('<') || val.contains('>') || has_crlf(val) || !email_regex().is_match(val) {
            issues.push(format!("{}: {label}", p(key)));
        }
    }
    let plen = f.subject_prefix.chars().count();
    if !(1..=120).contains(&plen) {
        issues.push(format!("{}: Subject prefix must be 1-120 characters", p("subject_prefix")));
    }
    if has_crlf(&f.subject_prefix) {
        issues.push(format!("{}: Subject prefix cannot contain CRLF", p("subject_prefix")));
    }
    if let Some(u) = &f.success_url {
        if !is_http_url(u) {
            issues.push(format!("{}: Invalid success_url", p("success_url")));
        }
    }
    for (j, o) in f.allowed_origins.iter().enumerate() {
        if !is_http_url(o) {
            issues.push(format!("{}: Invalid allowed_origin", p(&format!("allowed_origins.{j}"))));
        }
    }
    if f.fields.len() > 20 {
        issues.push(format!("{}: At most 20 configured fields per form", p("fields")));
    }
    let mut names = HashSet::new();
    let mut emails = HashSet::new();
    for (j, fl) in f.fields.iter().enumerate() {
        let fp = |s: &str| format!("forms.{i}.fields.{j}.{s}");
        if !field_name_regex().is_match(&fl.name) {
            issues.push(format!("{}: Field name must be 1-40 alphanumeric/underscore chars", fp("name")));
        } else if RESERVED_FIELD_NAMES.contains(&fl.name.as_str()) || fl.name.starts_with('_') {
            issues.push(format!("{}: Field name is reserved", fp("name")));
        }
        if fl.max_length < 1 || fl.max_length > 4000 {
            issues.push(format!("{}: max_length must be between 1 and 4000", fp("max_length")));
        }
        if !names.insert(fl.name.clone()) {
            issues.push(format!("{}: Duplicate field name: {}", fp("name"), fl.name));
        }
        if fl.kind == FormFieldType::Email {
            emails.insert(fl.name.clone());
        }
    }
    if let Some(r) = &f.reply_to_field {
        if !emails.contains(r) {
            issues.push(format!(
                "forms.{i}.reply_to_field: reply_to_field '{r}' must reference an existing email field"
            ));
        }
    }
}

pub fn parse_forms_config(raw: &str) -> Result<BTreeMap<String, FormConfig>> {
    let file: FormsFile = match serde_json::from_str::<serde_json::Value>(raw) {
        Err(_) => return Err(AppError::bad_request("Invalid forms.json syntax")),
        Ok(v) => serde_json::from_value(v).map_err(|e| {
            AppError::invalid_form(format!("Forms configuration invalid: {e}"))
        })?,
    };
    let mut issues = Vec::new();
    if file.version != 1 {
        issues.push("version: Invalid literal value, expected 1".to_string());
    }
    let mut ids = HashSet::new();
    for (i, f) in file.forms.iter().enumerate() {
        validate_form(i, f, &mut issues);
        if !ids.insert(f.id.clone()) {
            issues.push(format!("forms.{i}.id: Duplicate form id: {}", f.id));
        }
    }
    if !issues.is_empty() {
        return Err(AppError::invalid_form(format!("Forms configuration invalid: {}", issues.join("; "))));
    }
    Ok(file.forms.into_iter().map(|f| (f.id.clone(), f)).collect())
}

fn is_loopback_smtp(h: &str) -> bool {
    matches!(h, "127.0.0.1" | "::1" | "localhost" | "mailpit")
}

pub fn load_config(env: &HashMap<String, String>, custom_forms_path: Option<&str>) -> Result<AppConfig> {
    let get = |k: &str| env.get(k).map(String::as_str);
    let node_env = get("NODE_ENV").unwrap_or("development").to_string();
    let is_prod = node_env == "production";
    let host = get("HOST").unwrap_or("127.0.0.1").to_string();
    let port: u16 = get("PORT")
        .unwrap_or("3000")
        .parse()
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(|| AppError::config("bad_request", format!("Invalid PORT: {}", get("PORT").unwrap_or(""))))?;
    let database_url = get("DATABASE_URL")
        .ok_or_else(|| AppError::config("bad_request", "DATABASE_URL is required"))?
        .to_string();

    let forms_path_s = custom_forms_path.or(get("FORMS_CONFIG_PATH")).unwrap_or("config/forms.json");
    let forms_path = std::env::current_dir().unwrap_or_default().join(forms_path_s);
    let content = std::fs::read_to_string(&forms_path).map_err(|_| {
        AppError::config("bad_request", format!("Forms config file not found: {}", forms_path.display()))
    })?;
    let forms = parse_forms_config(&content)?;

    let storage_dir = std::env::current_dir().unwrap_or_default().join(get("STORAGE_DIR").unwrap_or("./data"));

    let smtp_host = get("SMTP_HOST").unwrap_or("127.0.0.1").to_string();
    let smtp_port: u16 = get("SMTP_PORT").unwrap_or("1025").parse().unwrap_or(1025);
    let smtp_tls_mode = match get("SMTP_TLS_MODE").unwrap_or("plain_local") {
        "plain_local" => SmtpTlsMode::PlainLocal,
        "implicit" => SmtpTlsMode::Implicit,
        "starttls_required" => SmtpTlsMode::StarttlsRequired,
        other => return Err(AppError::config("bad_request", format!("Invalid SMTP_TLS_MODE: {other}"))),
    };
    let smtp_username = get("SMTP_USERNAME").map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let smtp_password = get("SMTP_PASSWORD").filter(|s| !s.is_empty()).map(String::from);
    let smtp_max_message_bytes: u64 = get("SMTP_MAX_MESSAGE_BYTES").unwrap_or("20971520").parse().unwrap_or(20_971_520);
    let message_id_domain = get("MESSAGE_ID_DOMAIN").unwrap_or("notifications.example.test").to_string();
    let captcha_secret = get("CAPTCHA_SECRET").map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let demo_mode = get("DEMO_MODE") == Some("true");
    let ip_hash_secret = get("IP_HASH_SECRET").unwrap_or("").to_string();
    let outbound_enabled = get("OUTBOUND_ENABLED") != Some("false");
    let trusted_proxy_cidrs: Vec<String> = get("TRUSTED_PROXY_CIDRS")
        .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();

    let sentinel_socket = PathBuf::from(get("SENTINEL_SOCKET").unwrap_or("/run/raxosentinel/scan.sock"));
    let sentinel_timeout_ms: u64 = match get("SENTINEL_TIMEOUT_MS") {
        None => 15_000,
        Some(s) => s
            .parse()
            .ok()
            .filter(|v| (1000..=60000).contains(v))
            .ok_or_else(|| AppError::config("bad_request", format!("Invalid SENTINEL_TIMEOUT_MS: {s}")))?,
    };
    let sentinel_max_size: u64 = get("SENTINEL_MAX_SIZE").unwrap_or("52428800").parse().unwrap_or(52_428_800);

    let attachment_policy = match get("ATTACHMENT_POLICY").map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("withhold") => AttachmentPolicy::Withhold,
        Some("block_message") => AttachmentPolicy::BlockMessage,
        Some(other) => {
            return Err(AppError::config(
                "bad_request",
                format!("Invalid ATTACHMENT_POLICY: {other} (expected withhold or block_message)"),
            ))
        }
    };
    let attachment_scan_retries: i32 = match get("ATTACHMENT_SCAN_RETRIES") {
        None => 0,
        Some(s) => s
            .parse()
            .ok()
            .filter(|v| (0..=4).contains(v))
            .ok_or_else(|| AppError::config("bad_request", format!("Invalid ATTACHMENT_SCAN_RETRIES: {s}")))?,
    };
    let attachment_notice_html = match get("ATTACHMENT_NOTICE_HTML") {
        None | Some("true") => true,
        Some("false") => false,
        Some(s) => return Err(AppError::config("bad_request", format!("Invalid ATTACHMENT_NOTICE_HTML: {s}"))),
    };

    if demo_mode {
        if is_prod {
            return Err(AppError::config("forbidden", "DEMO_MODE=true is forbidden in production"));
        }
        if host != "127.0.0.1" && host != "::1" {
            return Err(AppError::config(
                "forbidden",
                format!("DEMO_MODE=true requires loopback HOST (127.0.0.1 or ::1), got: {host}"),
            ));
        }
        if !is_loopback_smtp(&smtp_host) {
            return Err(AppError::config(
                "forbidden",
                format!("DEMO_MODE=true requires loopback SMTP host, got: {smtp_host}"),
            ));
        }
        if smtp_username.is_some() || smtp_password.is_some() {
            return Err(AppError::config("forbidden", "DEMO_MODE=true forbids SMTP credentials"));
        }
    }

    if is_prod {
        if smtp_tls_mode == SmtpTlsMode::PlainLocal {
            return Err(AppError::config("forbidden", "Production rejects plain_local SMTP_TLS_MODE"));
        }
        if ip_hash_secret.trim().is_empty() {
            return Err(AppError::config("forbidden", "Production requires non-empty IP_HASH_SECRET"));
        }
        if captcha_secret.is_none() {
            return Err(AppError::config("forbidden", "Production requires CAPTCHA_SECRET"));
        }
        for (id, f) in &forms {
            if let Some(s) = &f.success_url {
                if url::Url::parse(s).map(|u| u.scheme() != "https").unwrap_or(true) {
                    return Err(AppError::config(
                        "forbidden",
                        format!("Production requires HTTPS success_url in form {id}"),
                    ));
                }
            }
            for o in &f.allowed_origins {
                if o == "*" {
                    return Err(AppError::config(
                        "forbidden",
                        format!("Production forbids wildcard origin in form {id}"),
                    ));
                }
                if url::Url::parse(o).map(|u| u.scheme() != "https").unwrap_or(true) {
                    return Err(AppError::config(
                        "forbidden",
                        format!("Production requires HTTPS allowed_origins in form {id}"),
                    ));
                }
            }
        }
    }

    Ok(AppConfig {
        node_env,
        host,
        port,
        database_url,
        forms_config_path: forms_path,
        storage_dir,
        smtp_host,
        smtp_port,
        smtp_tls_mode,
        smtp_username,
        smtp_password,
        smtp_max_message_bytes,
        message_id_domain,
        captcha_secret,
        demo_mode,
        ip_hash_secret,
        outbound_enabled,
        trusted_proxy_cidrs,
        sentinel_socket,
        sentinel_timeout_ms,
        sentinel_max_size,
        attachment_policy,
        attachment_scan_retries,
        attachment_notice_html,
        forms,
    })
}

pub fn load_config_from_env() -> Result<AppConfig> {
    let env: HashMap<String, String> = std::env::vars().collect();
    load_config(&env, None)
}
