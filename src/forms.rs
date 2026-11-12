use crate::config::email_regex;
use crate::errors::{AppError, Result};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct RegisteredForm {
    pub id: Uuid,
    pub public_id: String,
    pub recipient_email: String,
    pub status: String,
    pub verification_token_hash: Option<String>,
    pub verification_expires_at: Option<DateTime<Utc>>,
    pub management_token_hash: String,
    pub resend_count: i32,
    pub last_verification_sent_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub verified_at: Option<DateTime<Utc>>,
    pub deactivated_at: Option<DateTime<Utc>>,
}

const COLS: &str = "id, public_id, recipient_email, status, verification_token_hash, verification_expires_at,
    management_token_hash, resend_count, last_verification_sent_at, created_at, verified_at, deactivated_at";

pub fn compute_token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_form_id() -> String {
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b64url(&b)
}

pub fn generate_token() -> (String, String) {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let t = b64url(&b);
    let h = compute_token_hash(&t);
    (t, h)
}

pub fn validate_recipient_email(raw: Option<&str>) -> Result<String> {
    let raw = raw.ok_or_else(|| AppError::bad_request("Recipient email is required"))?;
    let email = raw.trim();
    if email.is_empty() {
        return Err(AppError::bad_request("Recipient email cannot be empty"));
    }
    if email.len() > 254 {
        return Err(AppError::bad_request("Recipient email exceeds maximum length of 254 characters"));
    }
    if email.contains('\r') || email.contains('\n') {
        return Err(AppError::bad_request("Recipient email contains forbidden control characters"));
    }
    if !email_regex().is_match(email) {
        return Err(AppError::bad_request("Invalid recipient email format"));
    }
    Ok(email.to_lowercase())
}

pub struct CreateFormResult {
    pub form: RegisteredForm,
    pub form_id: String,
    pub verification_token: String,
    pub management_token: String,
}

pub async fn create_dynamic_form(pool: &PgPool, raw_email: Option<&str>) -> Result<CreateFormResult> {
    let email = validate_recipient_email(raw_email)?;
    for attempt in 0..3 {
        let form_id = generate_form_id();
        let (vtok, vhash) = generate_token();
        let (mtok, mhash) = generate_token();
        let expires = Utc::now() + Duration::hours(24);
        let res = sqlx::query_as::<_, RegisteredForm>(&format!(
            "INSERT INTO registered_forms (id, public_id, recipient_email, status, verification_token_hash,
               verification_expires_at, management_token_hash, resend_count, last_verification_sent_at, created_at)
             VALUES ($1, $2, $3, 'pending_verification', $4, $5, $6, 0, now(), now()) RETURNING {COLS}"
        ))
        .bind(Uuid::new_v4())
        .bind(&form_id)
        .bind(&email)
        .bind(&vhash)
        .bind(expires)
        .bind(&mhash)
        .fetch_one(pool)
        .await;
        match res {
            Ok(form) => {
                return Ok(CreateFormResult { form, form_id, verification_token: vtok, management_token: mtok })
            }
            Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("23505") && attempt < 2 => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::new("service_unavailable", 500, "Failed to generate unique Form ID after maximum retries"))
}

pub async fn get_dynamic_form_by_public_id(pool: &PgPool, public_id: &str) -> Result<Option<RegisteredForm>> {
    Ok(sqlx::query_as::<_, RegisteredForm>(&format!("SELECT {COLS} FROM registered_forms WHERE public_id = $1"))
        .bind(public_id)
        .fetch_optional(pool)
        .await?)
}

pub struct VerifyResult {
    pub form: RegisteredForm,
    pub promoted: u64,
}

pub async fn verify_dynamic_form(pool: &PgPool, token: &str) -> Result<VerifyResult> {
    if token.trim().is_empty() {
        return Err(AppError::bad_request("Verification token is required"));
    }
    let hash = compute_token_hash(token.trim());
    let mut tx = pool.begin().await?;
    let form = sqlx::query_as::<_, RegisteredForm>(&format!(
        "SELECT {COLS} FROM registered_forms WHERE verification_token_hash = $1 FOR UPDATE"
    ))
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Invalid or already used verification token"))?;
    if form.status == "deactivated" {
        return Err(AppError::forbidden("This form has been deactivated"));
    }
    if form.verification_expires_at.map(|e| e < Utc::now()).unwrap_or(false) {
        return Err(AppError::bad_request("Verification token has expired. Please request a new verification email."));
    }
    let updated = sqlx::query_as::<_, RegisteredForm>(&format!(
        "UPDATE registered_forms SET status = 'active', verified_at = now(), verification_token_hash = NULL,
           verification_expires_at = NULL WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(form.id)
    .fetch_one(&mut *tx)
    .await?;
    let promoted = sqlx::query(
        "UPDATE notifications SET state = 'queued', next_attempt_at = now(), updated_at = now()
         FROM submissions s WHERE notifications.submission_id = s.id AND s.form_id = $1
           AND notifications.state = 'held_unverified'",
    )
    .bind(&form.public_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(VerifyResult { form: updated, promoted })
}

pub async fn deactivate_dynamic_form(pool: &PgPool, public_id: &str, token: Option<&str>) -> Result<()> {
    let token = token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AppError::bad_request("Management token is required for deactivation"))?;
    let hash = compute_token_hash(token);
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, management_token_hash FROM registered_forms WHERE public_id = $1 FOR UPDATE")
            .bind(public_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (id, expected) = row.ok_or_else(|| AppError::not_found("Form not found"))?;
    let ok = expected.len() == hash.len() && bool::from(expected.as_bytes().ct_eq(hash.as_bytes()));
    if !ok {
        return Err(AppError::forbidden("Invalid management token"));
    }
    sqlx::query("UPDATE registered_forms SET status = 'deactivated', deactivated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE notifications SET state = 'cancelled', updated_at = now()
         FROM submissions s WHERE notifications.submission_id = s.id AND s.form_id = $1
           AND notifications.state IN ('queued', 'retry_wait', 'held_unverified')",
    )
    .bind(public_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn resend_verification(pool: &PgPool, public_id: &str) -> Result<(RegisteredForm, String)> {
    let mut tx = pool.begin().await?;
    let form = sqlx::query_as::<_, RegisteredForm>(&format!(
        "SELECT {COLS} FROM registered_forms WHERE public_id = $1 FOR UPDATE"
    ))
    .bind(public_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Form not found"))?;
    if form.status == "active" {
        return Err(AppError::bad_request("Form is already verified and active"));
    }
    if form.status == "deactivated" {
        return Err(AppError::forbidden("Form has been deactivated"));
    }
    let since = (Utc::now() - form.last_verification_sent_at).num_milliseconds();
    if since < 60_000 {
        return Err(AppError::rate_limited(format!(
            "Please wait at least 60 seconds before requesting another verification email ({}s remaining)",
            ((60_000 - since) as f64 / 1000.0).ceil() as i64
        )));
    }
    if form.resend_count >= 5 {
        return Err(AppError::rate_limited("Maximum verification resend limit reached for this form"));
    }
    let (tok, hash) = generate_token();
    let updated = sqlx::query_as::<_, RegisteredForm>(&format!(
        "UPDATE registered_forms SET verification_token_hash = $1, verification_expires_at = $2,
           resend_count = resend_count + 1, last_verification_sent_at = now() WHERE id = $3 RETURNING {COLS}"
    ))
    .bind(&hash)
    .bind(Utc::now() + Duration::hours(24))
    .bind(form.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((updated, tok))
}

pub fn generate_html_snippet(base_url: &str, form_id: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!(
        r#"<form action="{base}/f/{form_id}" method="POST">
  <!-- Recipient fields -->
  <label for="name">Your Name</label>
  <input type="text" id="name" name="name" required placeholder="Alex Smith">

  <label for="email">Your Email</label>
  <input type="email" id="email" name="email" required placeholder="alex@example.com">

  <label for="message">Message</label>
  <textarea id="message" name="message" rows="4" required placeholder="Hello..."></textarea>

  <!-- Spam prevention: honeypot field (hidden from real users) -->
  <input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">

  <!-- Optional custom redirect URL after submission -->
  <!-- <input type="hidden" name="_next" value="https://example.com/thanks"> -->

  <button type="submit">Send Message</button>
</form>"#
    )
}
