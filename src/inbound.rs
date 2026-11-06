//! Groundwork for future inbound email support (not wired into any route yet).
//!
//! Two rules: (1) the original message is preserved byte-for-byte, read-only and
//! hash-verified before anything is stripped from it; (2) a cryptographically signed
//! message is never modified in place, because any edit invalidates the signature and
//! would make a forged-looking or silently "unverifiable" message.

use crate::errors::{AppError, Result};
use crate::storage::sha256_hex;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureKind {
    None,
    /// multipart/signed (S/MIME detached or PGP/MIME)
    MultipartSigned,
    /// application/pkcs7-mime or x-pkcs7-mime (opaque S/MIME, signed or enveloped)
    Pkcs7Opaque,
    /// Inline PGP clear-signed body
    PgpInline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteAction {
    /// Safe to remove parts and add a notice.
    ModifyInPlace,
    /// Preserve the original untouched and deliver a separate, unsigned wrapper message.
    PreserveAndWrap,
}

fn top_level_headers(raw: &[u8]) -> String {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n"))
        .unwrap_or(raw.len().min(16 * 1024));
    String::from_utf8_lossy(&raw[..end.min(64 * 1024)]).replace("\r\n", "\n").replace("\n ", " ").replace("\n\t", " ")
}

pub fn detect_signature(raw: &[u8]) -> SignatureKind {
    let headers = top_level_headers(raw).to_ascii_lowercase();
    let ctype = headers
        .lines()
        .find_map(|l| l.strip_prefix("content-type:"))
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if ctype.starts_with("multipart/signed") {
        return SignatureKind::MultipartSigned;
    }
    if ctype.starts_with("application/pkcs7-mime") || ctype.starts_with("application/x-pkcs7-mime") {
        return SignatureKind::Pkcs7Opaque;
    }
    let body = String::from_utf8_lossy(&raw[..raw.len().min(256 * 1024)]);
    if body.contains("-----BEGIN PGP SIGNED MESSAGE-----") {
        return SignatureKind::PgpInline;
    }
    SignatureKind::None
}

pub fn plan_rewrite(raw: &[u8]) -> RewriteAction {
    match detect_signature(raw) {
        SignatureKind::None => RewriteAction::ModifyInPlace,
        _ => RewriteAction::PreserveAndWrap,
    }
}

/// Write-once, private store for original inbound messages.
pub struct OriginalStore {
    dir: PathBuf,
}

impl OriginalStore {
    pub fn new(dir: &Path) -> Result<Self> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        Ok(Self { dir: dir.to_path_buf() })
    }

    /// Stores `raw` under its SHA-256 (content-addressed, 0400, never overwritten).
    pub fn preserve(&self, raw: &[u8]) -> Result<String> {
        let sha = sha256_hex(raw);
        let path = self.dir.join(&sha);
        match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o400).open(&path) {
            Ok(mut f) => {
                f.write_all(raw)?;
                f.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        Ok(sha)
    }

    pub fn read_verified(&self, sha: &str) -> Result<Vec<u8>> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::not_found("Original message not found"));
        }
        let data = std::fs::read(self.dir.join(sha)).map_err(|_| AppError::not_found("Original message not found"))?;
        if sha256_hex(&data) != sha {
            return Err(AppError::new("integrity_error", 500, "Preserved original failed integrity verification"));
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_signed_kinds() {
        assert_eq!(
            detect_signature(b"From: a@b.c\r\nContent-Type: multipart/signed;\r\n boundary=x; protocol=\"application/pgp-signature\"\r\n\r\nbody"),
            SignatureKind::MultipartSigned
        );
        assert_eq!(
            detect_signature(b"Content-Type: application/pkcs7-mime; smime-type=signed-data\r\n\r\nxx"),
            SignatureKind::Pkcs7Opaque
        );
        assert_eq!(
            detect_signature(b"Content-Type: text/plain\r\n\r\n-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n"),
            SignatureKind::PgpInline
        );
        assert_eq!(detect_signature(b"Content-Type: text/plain\r\n\r\nhello"), SignatureKind::None);
    }

    #[test]
    fn signed_messages_are_never_modified_in_place() {
        assert_eq!(plan_rewrite(b"Content-Type: multipart/signed; boundary=x\r\n\r\n"), RewriteAction::PreserveAndWrap);
        assert_eq!(plan_rewrite(b"Content-Type: multipart/mixed; boundary=x\r\n\r\n"), RewriteAction::ModifyInPlace);
    }

    #[test]
    fn originals_are_preserved_readonly_and_verified() {
        let d = tempfile::tempdir().unwrap();
        let s = OriginalStore::new(&d.path().join("originals")).unwrap();
        let sha = s.preserve(b"raw message").unwrap();
        assert_eq!(s.preserve(b"raw message").unwrap(), sha);
        assert_eq!(s.read_verified(&sha).unwrap(), b"raw message");
        let mode = std::fs::metadata(d.path().join("originals").join(&sha)).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.permissions().mode() & 0o777, 0o400);
        assert!(s.read_verified("../etc/passwd").is_err());
    }
}
