use serde_json::json;
use std::fmt;

/// Application error carrying a stable machine code, an HTTP status and a
/// message that is safe to show to clients (mirrors the Node `AppError`).
#[derive(Debug, Clone)]
pub struct AppError {
    pub code: &'static str,
    pub status: u16,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, status: u16, message: impl Into<String>) -> Self {
        Self { code, status, message: message.into() }
    }
    pub fn bad_request(m: impl Into<String>) -> Self {
        Self::new("bad_request", 400, m)
    }
    pub fn invalid_form(m: impl Into<String>) -> Self {
        Self::new("invalid_form_data", 422, m)
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new("not_found", 404, m)
    }
    pub fn forbidden(m: impl Into<String>) -> Self {
        Self::new("forbidden", 403, m)
    }
    pub fn rate_limited(m: impl Into<String>) -> Self {
        Self::new("rate_limited", 429, m)
    }
    pub fn unavailable(m: impl Into<String>) -> Self {
        Self::new("service_unavailable", 503, m)
    }
    pub fn too_large() -> Self {
        Self::new("file_too_large", 413, "File or multipart upload exceeded allowed size limits.")
    }
    pub fn internal() -> Self {
        Self::new("internal_error", 500, "An internal server error occurred.")
    }
    /// Configuration errors (startup) use the same shape as Node.
    pub fn config(code: &'static str, m: impl Into<String>) -> Self {
        Self::new(code, 500, m)
    }

    pub fn body(&self, request_id: Option<&str>) -> serde_json::Value {
        let mut e = json!({"code": self.code, "message": self.message});
        if let Some(r) = request_id {
            e["request_id"] = json!(r);
        }
        json!({ "error": e })
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        AppError::unavailable("Service temporarily unavailable.")
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        tracing::error!(error = %e, "io error");
        AppError::internal()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
