use crate::errors::{AppError, Result};
use std::time::Duration;

pub struct CaptchaOptions<'a> {
    pub secret: Option<&'a str>,
    pub demo_mode: bool,
    pub allowed_hostnames: Vec<String>,
    pub endpoint: &'a str,
    pub timeout: Duration,
}

pub const TURNSTILE_ENDPOINT: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

pub async fn verify_captcha(token: Option<&str>, remote_ip: &str, o: &CaptchaOptions<'_>) -> Result<bool> {
    if o.demo_mode {
        match token {
            None => return Ok(true),
            Some("demo_valid_token") | Some("test_token") => return Ok(true),
            _ => {}
        }
    }
    let Some(token) = token.filter(|t| !t.trim().is_empty()) else { return Ok(false) };
    let Some(secret) = o.secret else {
        if o.demo_mode {
            return Ok(true);
        }
        return Err(AppError::unavailable("CAPTCHA verification is not configured"));
    };
    let client = match reqwest::Client::builder().timeout(o.timeout).build() {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    let mut form = vec![("secret", secret.to_string()), ("response", token.trim().to_string())];
    if !remote_ip.is_empty() {
        form.push(("remoteip", remote_ip.to_string()));
    }
    // Fail closed on any network error, timeout or malformed reply.
    let Ok(res) = client.post(o.endpoint).form(&form).send().await else { return Ok(false) };
    if !res.status().is_success() {
        return Ok(false);
    }
    let Ok(body) = res.json::<serde_json::Value>().await else { return Ok(false) };
    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(false);
    }
    if body.get("action").and_then(|v| v.as_str()) != Some("submit_form") {
        return Ok(false);
    }
    if !o.allowed_hostnames.is_empty() {
        let Some(h) = body.get("hostname").and_then(|v| v.as_str()) else { return Ok(false) };
        let h = h.trim().to_lowercase();
        if !o.allowed_hostnames.iter().any(|a| a.trim().to_lowercase() == h) {
            return Ok(false);
        }
    }
    Ok(true)
}
