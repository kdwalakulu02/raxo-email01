use crate::config::FormConfig;
use crate::errors::{AppError, Result};
use crate::sentinel::WithheldCategory;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use std::collections::BTreeMap;

pub struct NotificationAttachment {
    pub filename: String,
    pub content: Vec<u8>,
}

/// An attachment that is NOT delivered. Only its name and category are carried here;
/// its content never reaches the MIME builder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithheldAttachment {
    pub filename: String,
    pub category: WithheldCategory,
}

pub struct NotificationPayload<'a> {
    pub submission_id: String,
    pub created_at: DateTime<Utc>,
    pub fields: &'a BTreeMap<String, Option<String>>,
    pub message_id: String,
    pub withheld: &'a [WithheldAttachment],
    /// Adds a text/html alternative when a withheld-attachment notice is present.
    pub notice_html: bool,
}

pub fn escape_html(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

/// Makes an untrusted filename safe to show: no control characters (incl. CR/LF),
/// no bidi/zero-width controls that can disguise an extension, bounded length.
pub fn display_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return "(unnamed file)".into();
    }
    if cleaned.chars().count() > 120 {
        let mut s: String = cleaned.chars().take(119).collect();
        s.push('…');
        return s;
    }
    cleaned.to_string()
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        "attachment was"
    } else {
        "attachments were"
    }
}

struct Notice {
    flagged: Vec<String>,
    not_inspected: Vec<String>,
}

impl Notice {
    fn new(withheld: &[WithheldAttachment]) -> Option<Self> {
        if withheld.is_empty() {
            return None;
        }
        let pick = |c: WithheldCategory| {
            withheld.iter().filter(|w| w.category == c).map(|w| display_filename(&w.filename)).collect::<Vec<_>>()
        };
        Some(Self { flagged: pick(WithheldCategory::Flagged), not_inspected: pick(WithheldCategory::NotInspected) })
    }

    fn total(&self) -> usize {
        self.flagged.len() + self.not_inspected.len()
    }

    fn headline(&self) -> String {
        format!("SECURITY NOTICE: {} {} withheld", self.total(), plural(self.total()))
    }

    fn intro(&self) -> String {
        let n = self.total();
        let subject = if n == 1 { "1 attachment was".to_string() } else { format!("{n} attachments were") };
        format!("For your protection, {subject} not delivered with this message. The message itself and any other attachments are unchanged.")
    }

    const FLAGGED_LABEL: &'static str = "Flagged by the security scanner as potentially unsafe";
    const NOT_INSPECTED_LABEL: &'static str =
        "Could not be inspected, so withheld as a precaution (this does not mean the file is malicious)";
    const ADVICE: &'static str =
        "If you were expecting these files, please contact the sender through another trusted channel or ask your administrator to review them.";

    fn text(&self) -> Vec<String> {
        let mut l = vec![self.headline(), self.intro(), String::new()];
        for (label, names) in [(Self::FLAGGED_LABEL, &self.flagged), (Self::NOT_INSPECTED_LABEL, &self.not_inspected)] {
            if names.is_empty() {
                continue;
            }
            l.push(format!("{} ({}):", label, names.len()));
            for n in names {
                l.push(format!("  - {n}"));
            }
            l.push(String::new());
        }
        l.push(Self::ADVICE.into());
        l
    }

    fn html(&self) -> String {
        let mut h = format!(
            "<div style=\"border:1px solid #d9a441;background:#fff8e6;padding:12px 16px;margin:0 0 16px\"><p style=\"margin:0 0 8px\"><strong>{}</strong></p><p style=\"margin:0 0 8px\">{}</p>",
            escape_html(&self.headline()),
            escape_html(&self.intro())
        );
        for (label, names) in [(Self::FLAGGED_LABEL, &self.flagged), (Self::NOT_INSPECTED_LABEL, &self.not_inspected)] {
            if names.is_empty() {
                continue;
            }
            h.push_str(&format!("<p style=\"margin:8px 0 4px\">{} ({}):</p><ul style=\"margin:0\">", escape_html(label), names.len()));
            for n in names {
                h.push_str(&format!("<li>{}</li>", escape_html(n)));
            }
            h.push_str("</ul>");
        }
        h.push_str(&format!("<p style=\"margin:8px 0 0\">{}</p></div>", escape_html(Self::ADVICE)));
        h
    }
}

fn b64_lines(data: &[u8]) -> String {
    let enc = base64::engine::general_purpose::STANDARD.encode(data);
    let mut out = String::with_capacity(enc.len() + enc.len() / 76 * 2 + 2);
    for chunk in enc.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push_str("\r\n");
    }
    out
}

/// RFC 2047 encoded-word(s) for non-ASCII header text; ASCII passes through unchanged.
pub fn encode_header_text(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let mut words = vec![];
    let mut cur = String::new();
    for c in s.chars() {
        if cur.len() + c.len_utf8() > 36 {
            words.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
        .iter()
        .map(|w| format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(w.as_bytes())))
        .collect::<Vec<_>>()
        .join("\r\n ")
}

fn text_part(body: &str, content_type: &str) -> String {
    let crlf = body.replace("\r\n", "\n").replace('\n', "\r\n");
    let plain_ok = crlf.is_ascii() && crlf.split("\r\n").all(|l| l.len() <= 900);
    if plain_ok {
        format!("Content-Type: {content_type}; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n{crlf}\r\n")
    } else {
        format!(
            "Content-Type: {content_type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
            b64_lines(crlf.as_bytes())
        )
    }
}

fn boundary(prefix: &str) -> String {
    let mut b = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("----{prefix}_{}", hex::encode(b))
}

fn filename_param(name: &str) -> String {
    if name.is_ascii() {
        let esc: String = name.chars().filter(|c| *c != '"' && *c != '\\').collect();
        format!("filename=\"{esc}\"")
    } else {
        let mut enc = String::new();
        for b in name.bytes() {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                enc.push(b as char);
            } else {
                enc.push_str(&format!("%{b:02X}"));
            }
        }
        format!("filename*=UTF-8''{enc}")
    }
}

fn header_clean(s: &str) -> String {
    s.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

fn render_html(
    snapshot: &FormConfig,
    payload: &NotificationPayload<'_>,
    attachments: &[NotificationAttachment],
    notice: &Notice,
) -> String {
    let mut h = String::from(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a\"><h2 style=\"margin:0 0 12px\">Raxo Email Submission Notification</h2>",
    );
    h.push_str(&notice.html());
    h.push_str(&format!(
        "<p style=\"margin:0 0 12px\">Receipt ID: {}<br>Received (UTC): {}<br>Form ID: {}</p><h3 style=\"margin:0 0 6px\">Submission Fields</h3><table style=\"border-collapse:collapse\">",
        escape_html(&payload.submission_id),
        payload.created_at.format("%Y-%m-%dT%H:%M:%S%.3fZ"),
        escape_html(&snapshot.id)
    ));
    for f in &snapshot.fields {
        let v = payload.fields.get(&f.name).and_then(|v| v.clone()).unwrap_or_else(|| "(none)".into());
        h.push_str(&format!(
            "<tr><td style=\"padding:2px 12px 2px 0;vertical-align:top\"><strong>{}</strong></td><td style=\"white-space:pre-wrap\">{}</td></tr>",
            escape_html(&f.name),
            escape_html(&v)
        ));
    }
    h.push_str(&format!("</table><p style=\"margin:12px 0 4px\">Retained attachments: {}</p>", attachments.len()));
    if !attachments.is_empty() {
        h.push_str("<ul style=\"margin:0\">");
        for a in attachments {
            h.push_str(&format!("<li>{} ({} bytes)</li>", escape_html(&display_filename(&a.filename)), a.content.len()));
        }
        h.push_str("</ul>");
    }
    h.push_str("</body></html>");
    h
}

pub fn build_notification(
    snapshot: &FormConfig,
    payload: &NotificationPayload<'_>,
    attachments: &[NotificationAttachment],
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let notice = Notice::new(payload.withheld);
    let rule = "----------------------------------------";
    let mut lines: Vec<String> = vec!["Raxo Email Submission Notification".into(), rule.into()];
    if let Some(n) = &notice {
        lines.extend(n.text());
        lines.push(rule.into());
    }
    lines.extend([
        format!("Receipt ID:     {}", payload.submission_id),
        format!("Received (UTC): {}", payload.created_at.format("%Y-%m-%dT%H:%M:%S%.3fZ")),
        format!("Form ID:        {}", snapshot.id),
        String::new(),
        "Submission Fields:".into(),
    ]);
    for f in &snapshot.fields {
        let v = payload.fields.get(&f.name).and_then(|v| v.clone()).unwrap_or_else(|| "(none)".into());
        lines.push(format!("  {}: {}", f.name, v));
    }
    lines.push(String::new());
    lines.push("----------------------------------------".into());
    lines.push(format!("Retained attachments: {}", attachments.len()));
    for a in attachments {
        lines.push(format!("  - {} ({} bytes)", a.filename, a.content.len()));
    }
    let body = lines.join("\r\n");

    let reply_to = snapshot
        .reply_to_field
        .as_ref()
        .and_then(|f| payload.fields.get(f).cloned().flatten())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let mut m = String::new();
    m.push_str(&format!("Message-ID: {}\r\n", header_clean(&payload.message_id)));
    m.push_str(&format!("Date: {}\r\n", payload.created_at.to_rfc2822()));
    m.push_str(&format!("From: {}\r\n", header_clean(&snapshot.from)));
    m.push_str(&format!("To: {}\r\n", header_clean(&snapshot.recipient)));
    if let Some(r) = reply_to {
        m.push_str(&format!("Reply-To: {}\r\n", header_clean(&r)));
    }
    m.push_str(&format!(
        "Subject: {}\r\n",
        encode_header_text(&header_clean(&format!("{} — {}", snapshot.subject_prefix, payload.submission_id)))
    ));
    m.push_str("MIME-Version: 1.0\r\n");
    if let Some(n) = &notice {
        m.push_str(&format!("X-Raxo-Attachments-Withheld: {}\r\n", n.total()));
    }

    // With a notice, the human-readable body becomes text/plain + escaped text/html alternatives.
    let body_part = || -> String {
        match (&notice, payload.notice_html) {
            (Some(n), true) => {
                let b = boundary("alt");
                let html = render_html(snapshot, payload, attachments, n);
                let part = format!(
                    "Content-Type: multipart/alternative; boundary=\"{b}\"\r\n\r\n--{b}\r\n{}--{b}\r\n{}--{b}--\r\n",
                    text_part(&body, "text/plain"),
                    text_part(&html, "text/html")
                );
                part
            }
            _ => text_part(&body, "text/plain"),
        }
    };

    if attachments.is_empty() {
        m.push_str(&body_part());
    } else {
        let b = boundary("raxo");
        m.push_str(&format!("Content-Type: multipart/mixed; boundary=\"{b}\"\r\n\r\n"));
        let part = body_part();
        m.push_str(&format!("--{b}\r\n{part}"));
        for a in attachments {
            let fp = filename_param(&a.filename);
            m.push_str(&format!(
                "--{b}\r\nContent-Type: application/pdf; {fp}\r\nContent-Disposition: attachment; {fp}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
                b64_lines(&a.content)
            ));
        }
        m.push_str(&format!("--{b}--\r\n"));
    }
    let bytes = m.into_bytes();
    if bytes.len() > max_bytes {
        return Err(AppError::new(
            "mime_too_large",
            413,
            format!(
                "Final notification MIME size ({} bytes) exceeds maximum limit ({} bytes)",
                bytes.len(),
                max_bytes
            ),
        ));
    }
    Ok(bytes)
}

pub fn build_system_message(from: &str, to: &str, subject: &str, text: &str, html: &str, message_id: &str) -> Vec<u8> {
    let b = boundary("alt");
    let mut m = String::new();
    m.push_str(&format!("Message-ID: {}\r\n", header_clean(message_id)));
    m.push_str(&format!("Date: {}\r\n", Utc::now().to_rfc2822()));
    m.push_str(&format!("From: {}\r\nTo: {}\r\n", header_clean(from), header_clean(to)));
    m.push_str(&format!("Subject: {}\r\nMIME-Version: 1.0\r\n", encode_header_text(&header_clean(subject))));
    m.push_str(&format!("Content-Type: multipart/alternative; boundary=\"{b}\"\r\n\r\n"));
    m.push_str(&format!("--{b}\r\n{}", text_part(text, "text/plain")));
    m.push_str(&format!("--{b}\r\n{}", text_part(html, "text/html")));
    m.push_str(&format!("--{b}--\r\n"));
    m.into_bytes()
}
