//! DKIM (RFC 6376) signing of outbound messages at send time.
//!
//! Signing uses `mail-auth` (rsa-sha256, relaxed/relaxed). The stored MIME is never
//! modified; a `DKIM-Signature` header is prepended to a copy right before transmission,
//! so every retry carries a fresh signature over the same stored bytes.

use base64::Engine;
use mail_auth::crypto::{RsaKey, Sha256};
use mail_auth::dkim::{Canonicalization, DkimSigner};
use mail_auth::headers::HeaderWriter;
use mail_auth::signer::Ready;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1::DecodeRsaPublicKey;
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use std::path::Path;
use tokio_rustls::rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

/// Headers covered by the signature. `From` is listed twice to over-sign it; listed
/// headers absent from a message (e.g. `Cc`, `Reply-To`) are signed as empty, which
/// prevents them from being added in transit.
pub const SIGNED_HEADERS: &[&str] =
    &["From", "From", "To", "Cc", "Subject", "Date", "Message-ID", "Reply-To", "MIME-Version", "Content-Type"];

pub struct Dkim {
    domain: String,
    selector: String,
    signer: DkimSigner<RsaKey<Sha256>, Ready>,
    public_key: RsaPublicKey,
}

impl std::fmt::Debug for Dkim {
    // Never print key material.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dkim").field("domain", &self.domain).field("selector", &self.selector).finish_non_exhaustive()
    }
}

fn valid_label_seq(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
}

/// Parses a PEM RSA private key (PKCS#8 `PRIVATE KEY` or PKCS#1 `RSA PRIVATE KEY`).
/// Error messages never include key material.
pub fn parse_private_key_pem(pem: &str) -> Result<RsaPrivateKey, String> {
    let key = if pem.contains("-----BEGIN PRIVATE KEY-----") {
        RsaPrivateKey::from_pkcs8_pem(pem).map_err(|_| "not a valid PKCS#8 RSA private key".to_string())?
    } else if pem.contains("-----BEGIN RSA PRIVATE KEY-----") {
        RsaPrivateKey::from_pkcs1_pem(pem).map_err(|_| "not a valid PKCS#1 RSA private key".to_string())?
    } else {
        return Err("expected a PEM 'PRIVATE KEY' (PKCS#8) or 'RSA PRIVATE KEY' (PKCS#1) block".into());
    };
    key.validate().map_err(|_| "RSA private key failed consistency check".to_string())?;
    let bits = key.size() * 8;
    if bits < 1024 {
        return Err(format!("RSA key is {bits} bits; at least 1024 required (2048 recommended)"));
    }
    Ok(key)
}

/// Validates and normalizes a signing domain and selector.
pub fn normalize_names(domain: &str, selector: &str) -> Result<(String, String), String> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let selector = selector.trim().to_string();
    if !valid_label_seq(&domain) || !domain.contains('.') {
        return Err(format!("invalid DKIM domain: {domain}"));
    }
    if !valid_label_seq(&selector) {
        return Err(format!("invalid DKIM selector: {selector}"));
    }
    Ok((domain, selector))
}

impl Dkim {
    pub fn from_private_key(domain: &str, selector: &str, key: RsaPrivateKey) -> Result<Self, String> {
        let (domain, selector) = normalize_names(domain, selector)?;
        if key.size() * 8 < 2048 {
            tracing::warn!(bits = key.size() * 8, "DKIM key shorter than 2048 bits");
        }
        let public_key = RsaPublicKey::from(&key);
        let der = key.to_pkcs8_der().map_err(|_| "could not encode RSA key".to_string())?;
        let rsa_key = RsaKey::<Sha256>::from_key_der(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der.as_bytes())))
            .map_err(|_| "DKIM signer rejected the RSA key".to_string())?;
        let signer = DkimSigner::from_key(rsa_key)
            .domain(domain.clone())
            .selector(selector.clone())
            .headers(SIGNED_HEADERS.iter().copied())
            .header_canonicalization(Canonicalization::Relaxed)
            .body_canonicalization(Canonicalization::Relaxed);
        let d = Self { domain, selector, signer, public_key };
        // A trial signature proves the key is usable before we accept any traffic.
        d.sign(b"From: a@example.com\r\nSubject: t\r\n\r\nt\r\n").map_err(|_| "trial DKIM signature failed")?;
        Ok(d)
    }

    pub fn load(domain: &str, selector: &str, path: &Path) -> Result<Self, String> {
        let pem = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read DKIM_PRIVATE_KEY_PATH {}: {}", path.display(), e.kind()))?;
        let key = parse_private_key_pem(&pem).map_err(|e| format!("DKIM_PRIVATE_KEY_PATH {}: {e}", path.display()))?;
        Self::from_private_key(domain, selector, key)
    }

    pub fn domain(&self) -> &str {
        &self.domain
    }

    pub fn selector(&self) -> &str {
        &self.selector
    }

    /// `selector._domainkey.domain`
    pub fn dns_name(&self) -> String {
        format!("{}._domainkey.{}", self.selector, self.domain)
    }

    pub fn public_key(&self) -> &RsaPublicKey {
        &self.public_key
    }

    /// TXT record value (`v=DKIM1; k=rsa; p=<SubjectPublicKeyInfo base64>`).
    pub fn dns_value(&self) -> String {
        dns_txt_value(&self.public_key)
    }

    /// Returns `DKIM-Signature: ...\r\n` followed by the unchanged message bytes.
    pub fn sign(&self, raw: &[u8]) -> Result<Vec<u8>, String> {
        let sig = self.signer.sign(raw).map_err(|e| format!("dkim_sign_failed: {e}"))?;
        let header = sig.to_header();
        let mut out = Vec::with_capacity(header.len() + raw.len());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(raw);
        Ok(out)
    }

    /// Relaxed alignment (DMARC): the author domain equals the signing domain or is a
    /// subdomain of it.
    pub fn aligned_with(&self, from_domain: &str) -> bool {
        domain_aligned(from_domain, &self.domain)
    }
}

pub fn domain_aligned(from_domain: &str, dkim_domain: &str) -> bool {
    let f = from_domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let d = dkim_domain.trim().trim_end_matches('.').to_ascii_lowercase();
    !d.is_empty() && (f == d || f.ends_with(&format!(".{d}")))
}

pub fn dns_txt_value(public_key: &RsaPublicKey) -> String {
    let spki = public_key.to_public_key_der().expect("RSA public key encodes as SPKI");
    format!("v=DKIM1; k=rsa; p={}", base64::engine::general_purpose::STANDARD.encode(spki.as_bytes()))
}

/// Domain of the first address in the message's `From:` header.
pub fn header_from_domain(raw: &[u8]) -> Option<String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut value: Option<String> = None;
    for line in head.split("\r\n") {
        if let Some(v) = value.as_mut() {
            if line.starts_with([' ', '\t']) {
                v.push_str(line);
                continue;
            }
            break;
        }
        if line.len() > 5 && line[..5].eq_ignore_ascii_case("from:") {
            value = Some(line[5..].to_string());
        }
    }
    let v = value?;
    let addr = match (v.rfind('<'), v.rfind('>')) {
        (Some(a), Some(b)) if a < b => v[a + 1..b].to_string(),
        _ => v.trim().to_string(),
    };
    addr.rsplit_once('@').map(|(_, d)| d.trim().to_ascii_lowercase()).filter(|d| !d.is_empty())
}

/// Parses the `p=` tag of a DKIM TXT record (SPKI or bare PKCS#1 RSA public key).
pub fn parse_dns_public_key(record: &str) -> Result<RsaPublicKey, String> {
    let mut p = None;
    let mut k = "rsa".to_string();
    for tag in record.split(';') {
        let Some((name, val)) = tag.split_once('=') else { continue };
        let val: String = val.chars().filter(|c| !c.is_whitespace()).collect();
        match name.trim() {
            "p" => p = Some(val),
            "k" => k = val,
            _ => {}
        }
    }
    if !k.eq_ignore_ascii_case("rsa") {
        return Err(format!("record has k={k}, expected rsa"));
    }
    let p = p.ok_or("record has no p= tag")?;
    if p.is_empty() {
        return Err("record has an empty p= (key revoked)".into());
    }
    let der = base64::engine::general_purpose::STANDARD.decode(p).map_err(|_| "p= is not valid base64".to_string())?;
    RsaPublicKey::from_public_key_der(&der)
        .or_else(|_| RsaPublicKey::from_pkcs1_der(&der))
        .map_err(|_| "p= is not an RSA public key".to_string())
}

/// Generates a new RSA-2048 key, returned as PKCS#8 PEM (wiped on drop) plus its public key.
pub fn generate_rsa_2048() -> Result<(impl std::ops::Deref<Target = String>, RsaPublicKey), String> {
    let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).map_err(|e| format!("key generation failed: {e}"))?;
    let pem = key.to_pkcs8_pem(LineEnding::LF).map_err(|_| "could not encode key as PKCS#8".to_string())?;
    Ok((pem, RsaPublicKey::from(&key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_is_relaxed() {
        assert!(domain_aligned("btctoons.com", "btctoons.com"));
        assert!(domain_aligned("mail.btctoons.com", "btctoons.com"));
        assert!(domain_aligned("BTCtoons.COM.", "btctoons.com"));
        assert!(!domain_aligned("evilbtctoons.com", "btctoons.com"));
        assert!(!domain_aligned("btctoons.com", "mail.btctoons.com"));
    }

    #[test]
    fn extracts_header_from_domain() {
        let m = b"To: x@y.z\r\nFrom: \"Forms\"\r\n <forms@Example.ORG>\r\nSubject: s\r\n\r\nFrom: body@nope.test\r\n";
        assert_eq!(header_from_domain(m).as_deref(), Some("example.org"));
        assert_eq!(header_from_domain(b"From: a@b.test\r\n\r\n").as_deref(), Some("b.test"));
        assert_eq!(header_from_domain(b"Subject: x\r\n\r\n"), None);
    }

    #[test]
    fn rejects_garbage_keys_without_echoing_them() {
        let e =
            parse_private_key_pem("-----BEGIN PRIVATE KEY-----\nU0VDUkVU\n-----END PRIVATE KEY-----\n").unwrap_err();
        assert!(!e.contains("U0VDUkVU"));
        assert!(parse_private_key_pem("hello").is_err());
    }
}
