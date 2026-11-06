use crate::config::{email_regex, FormConfig, FormFieldType};
use crate::errors::{AppError, Result};
use crate::storage::Storage;
use bytes::Bytes;
use futures_util::Stream;
use futures_util::StreamExt;
use multer::{Constraints, Multipart, SizeLimit};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const MAX_AGGREGATE_MULTIPART_BYTES: u64 = 11_534_336;
const MAX_PARTS: usize = 30;
const MAX_FIELDS: usize = 50;
const MAX_FILES: usize = 5;
const MAX_FILE_BYTES: u64 = 10_485_760;
const MAX_FIELD_BYTES: usize = 65_536;

#[derive(Debug, Clone)]
pub struct StagedAttachment {
    pub id: Uuid,
    pub storage_key: String,
    pub original_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ParsedInput {
    pub submission_id: Uuid,
    pub client_submission_id: Option<Uuid>,
    pub fields: BTreeMap<String, Option<String>>,
    pub is_honeypot: bool,
    pub captcha_token: Option<String>,
    pub attachments: Vec<StagedAttachment>,
}

fn uuid_v4_regex() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").unwrap()
    })
}

pub fn normalize_text(raw: &str, max_code_points: usize, max_bytes: usize) -> Result<Option<String>> {
    let nfc: String = raw.nfc().collect();
    let t = nfc.trim().replace("\r\n", "\n").replace('\r', "\n");
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > max_code_points {
        return Err(AppError::invalid_form(format!(
            "Text value exceeds maximum allowed {max_code_points} code points"
        )));
    }
    if t.len() > max_bytes {
        return Err(AppError::invalid_form(format!("Text UTF-8 bytes exceed maximum allowed {max_bytes} bytes")));
    }
    Ok(Some(t))
}

pub fn sanitize_filename(raw: &str) -> String {
    if raw.is_empty() {
        return "attachment.pdf".into();
    }
    let mut base: String = raw.chars().map(|c| if c == '/' || c == '\\' { '_' } else { c }).collect();
    // collapse runs of two or more dots (path traversal)
    let mut out = String::with_capacity(base.len());
    let mut dots = 0;
    for c in base.chars().chain(std::iter::once('\0')) {
        if c == '.' {
            dots += 1;
            continue;
        }
        if dots == 1 {
            out.push('.');
        } else if dots >= 2 {
            out.push('_');
        }
        dots = 0;
        if c != '\0' {
            out.push(c);
        }
    }
    base = out;
    let base: String = base.chars().filter(|c| !matches!(*c as u32, 0..=0x1f | 0x7f..=0x9f)).collect();
    let mut base = base.trim().to_string();
    if base.to_lowercase().ends_with(".pdf") {
        let n = base.chars().count() - 4;
        base = base.chars().take(n).collect::<String>() + ".pdf";
    } else {
        base.push_str(".pdf");
    }
    if base.chars().count() > 120 {
        base = base.chars().take(116).collect::<String>() + ".pdf";
    }
    if base.is_empty() {
        "attachment.pdf".into()
    } else {
        base
    }
}

pub fn normalize_email(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err(AppError::invalid_form("Email is required"));
    }
    if raw.contains(['\r', '\n', '<', '>']) {
        return Err(AppError::invalid_form("Header injection characters detected in email"));
    }
    let t = raw.trim();
    let at = t.rfind('@');
    match at {
        Some(i) if i > 0 && i < t.len() - 1 => {
            let combined = format!("{}@{}", &t[..i], t[i + 1..].to_lowercase());
            if !email_regex().is_match(&combined) {
                return Err(AppError::invalid_form("Invalid email format"));
            }
            Ok(combined)
        }
        _ => Err(AppError::invalid_form("Invalid email address")),
    }
}

pub fn normalize_url(raw: &str, max_len: usize) -> Result<String> {
    let Some(n) = normalize_text(raw, max_len, MAX_FIELD_BYTES)? else { return Ok(String::new()) };
    match url::Url::parse(&n) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => Ok(u.to_string()),
        Ok(_) => Err(AppError::invalid_form("URL must use http or https scheme")),
        Err(_) => Err(AppError::invalid_form("Invalid URL format")),
    }
}

fn map_multer(e: multer::Error) -> AppError {
    use multer::Error::*;
    match e {
        FieldSizeExceeded { .. } | StreamSizeExceeded { .. } => AppError::too_large(),
        IncompleteStream | IncompleteHeaders | IncompleteFieldData { .. } | StreamReadFailed(_) => {
            AppError::bad_request("Client aborted upload request")
        }
        _ => AppError::bad_request("Invalid request syntax."),
    }
}

struct Cleanup<'a> {
    storage: &'a Storage,
    keys: Vec<String>,
}
impl Cleanup<'_> {
    fn all(&mut self) {
        for k in self.keys.drain(..) {
            let _ = self.storage.delete(&k, None);
        }
    }
}

/// Streams a multipart body, staging PDF parts to quarantine while hashing, and validates fields.
/// Every rejection removes anything staged so far.
pub async fn parse_submission<S, E>(
    body: S,
    boundary: String,
    form: &FormConfig,
    storage: &Storage,
) -> Result<ParsedInput>
where
    S: Stream<Item = std::result::Result<Bytes, E>> + Send + 'static,
    E: Into<Box<dyn std::error::Error + Send + Sync>> + 'static,
{
    let mut cleanup = Cleanup { storage, keys: vec![] };
    let r = parse_inner(body, boundary, form, storage, &mut cleanup).await;
    if r.is_err() {
        cleanup.all();
    }
    r
}

async fn parse_inner<S, E>(
    body: S,
    boundary: String,
    form: &FormConfig,
    storage: &Storage,
    cleanup: &mut Cleanup<'_>,
) -> Result<ParsedInput>
where
    S: Stream<Item = std::result::Result<Bytes, E>> + Send + 'static,
    E: Into<Box<dyn std::error::Error + Send + Sync>> + 'static,
{
    let constraints = Constraints::new()
        .size_limit(SizeLimit::new().whole_stream(MAX_AGGREGATE_MULTIPART_BYTES).per_field(MAX_FILE_BYTES));
    let mut mp = Multipart::with_constraints(body, boundary, constraints);

    let allowed: HashSet<&str> = form.fields.iter().map(|f| f.name.as_str()).collect();
    let mut raw_fields: BTreeMap<String, String> = BTreeMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut attachments: Vec<StagedAttachment> = vec![];
    let mut client_submission_id = None;
    let mut captcha_token = None;
    let mut honeypot = false;
    let mut parts = 0usize;
    let mut text_fields = 0usize;
    let mut combined_file_bytes = 0u64;

    while let Some(mut field) = mp.next_field().await.map_err(map_multer)? {
        parts += 1;
        if parts > MAX_PARTS {
            return Err(AppError::invalid_form("Exceeded maximum allowed 30 multipart parts"));
        }
        let name = field.name().unwrap_or("").to_string();

        if field.file_name().is_some() {
            if !allowed.is_empty() && name != "attachments" {
                return Err(AppError::invalid_form(format!("Unexpected file field name: {name}")));
            }
            if attachments.len() >= MAX_FILES {
                return Err(AppError::new("file_too_large", 413, format!("Exceeded maximum {MAX_FILES} attachments")));
            }
            let sanitized = sanitize_filename(field.file_name().filter(|s| !s.is_empty()).unwrap_or("attachment.pdf"));
            let mime_ok = field.content_type().map(|m| m.essence_str() == "application/pdf").unwrap_or(false);
            if !mime_ok {
                return Err(AppError::new("invalid_pdf", 422, "Only application/pdf MIME type is allowed"));
            }

            let mut writer = storage.begin_stage(MAX_FILE_BYTES).await?;
            let mut header: Vec<u8> = Vec::with_capacity(5);
            let mut header_checked = false;
            let res: Result<()> = async {
                while let Some(chunk) = field.chunk().await.map_err(map_multer)? {
                    combined_file_bytes += chunk.len() as u64;
                    if combined_file_bytes > MAX_FILE_BYTES {
                        return Err(AppError::new("file_too_large", 413, "Combined file bytes exceed 10MB limit"));
                    }
                    if !header_checked {
                        header.extend_from_slice(&chunk);
                        if header.len() >= 5 {
                            if &header[..5] != b"%PDF-" {
                                return Err(AppError::new(
                                    "invalid_pdf",
                                    422,
                                    "File content is not a valid PDF (%PDF- header missing)",
                                ));
                            }
                            header_checked = true;
                        }
                    }
                    writer.write(&chunk).await?;
                }
                if !header_checked {
                    return Err(AppError::new("invalid_pdf", 422, "Empty or truncated PDF file"));
                }
                Ok(())
            }
            .await;
            match res {
                Ok(()) => {
                    let staged = writer.finish().await?;
                    cleanup.keys.push(staged.key.clone());
                    attachments.push(StagedAttachment {
                        id: Uuid::new_v4(),
                        storage_key: staged.key,
                        original_name: sanitized,
                        size_bytes: staged.size_bytes,
                        sha256: staged.sha256,
                    });
                }
                Err(e) => {
                    writer.abort().await;
                    return Err(e);
                }
            }
            continue;
        }

        text_fields += 1;
        if text_fields > MAX_FIELDS {
            return Err(AppError::invalid_form("Multipart form fields exceeded allowed limits."));
        }
        let mut buf: Vec<u8> = vec![];
        while let Some(chunk) = field.chunk().await.map_err(map_multer)? {
            buf.extend_from_slice(&chunk);
            if buf.len() > MAX_FIELD_BYTES {
                return Err(AppError::invalid_form(format!(
                    "Text UTF-8 bytes exceed maximum allowed {MAX_FIELD_BYTES} bytes"
                )));
            }
        }
        let value = String::from_utf8_lossy(&buf).into_owned();

        match name.as_str() {
            "_submission_id" => {
                if !seen.insert(name.clone()) {
                    return Err(AppError::invalid_form("Duplicate _submission_id field"));
                }
                let t = value.trim();
                if !t.is_empty() {
                    if !uuid_v4_regex().is_match(t) {
                        return Err(AppError::invalid_form("Invalid _submission_id: must be a valid UUID v4"));
                    }
                    client_submission_id = Uuid::parse_str(t).ok();
                }
            }
            "_captcha_token" | "cf-turnstile-response" => {
                if seen.contains("_captcha_token") || seen.contains("cf-turnstile-response") {
                    return Err(AppError::invalid_form(format!("Duplicate {name} field")));
                }
                seen.insert(name.clone());
                let t = value.trim();
                captcha_token = if t.is_empty() { None } else { Some(t.to_string()) };
            }
            "_honey" => {
                if !seen.insert(name.clone()) {
                    return Err(AppError::invalid_form("Duplicate _honey field"));
                }
                if !value.trim().is_empty() {
                    honeypot = true;
                }
            }
            _ => {
                if !allowed.is_empty() && !allowed.contains(name.as_str()) {
                    return Err(AppError::invalid_form(format!("Unknown or disallowed field: {name}")));
                }
                if !seen.insert(name.clone()) {
                    return Err(AppError::invalid_form(format!("Duplicate field name: {name}")));
                }
                raw_fields.insert(name, value);
            }
        }
    }

    if honeypot {
        cleanup.all();
        return Ok(ParsedInput {
            submission_id: Uuid::new_v4(),
            client_submission_id,
            fields: BTreeMap::new(),
            is_honeypot: true,
            captcha_token,
            attachments: vec![],
        });
    }

    let mut fields = BTreeMap::new();
    if !form.fields.is_empty() {
        for f in &form.fields {
            let raw = raw_fields.get(&f.name);
            let blank = raw.map(|v| v.trim().is_empty()).unwrap_or(true);
            if f.required && blank {
                return Err(AppError::invalid_form(format!("Required field missing: {}", f.name)));
            }
            if blank {
                fields.insert(f.name.clone(), None);
                continue;
            }
            let raw = raw.unwrap();
            let v = match f.kind {
                FormFieldType::Email => Some(normalize_email(raw)?),
                FormFieldType::Url => Some(normalize_url(raw, f.max_length as usize)?),
                FormFieldType::Text => normalize_text(raw, f.max_length as usize, MAX_FIELD_BYTES)?,
            };
            fields.insert(f.name.clone(), v);
        }
    } else {
        for (k, v) in &raw_fields {
            fields.insert(k.clone(), normalize_text(v, 4000, MAX_FIELD_BYTES)?);
        }
    }

    Ok(ParsedInput {
        submission_id: Uuid::new_v4(),
        client_submission_id,
        fields,
        is_honeypot: false,
        captcha_token,
        attachments: std::mem::take(&mut attachments),
    })
}

/// Drop-in helper for callers that need a boxed stream from an axum body.
pub fn body_stream(
    body: axum::body::Body,
) -> impl Stream<Item = std::result::Result<Bytes, axum::Error>> + Send + 'static {
    body.into_data_stream().map(|r| r)
}
