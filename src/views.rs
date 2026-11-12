use crate::forms::{generate_attachment_snippet, generate_html_snippet};
use crate::web::INDEX_TEMPLATE;

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

const ASSET_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Single-pass `{{KEY}}` substitution, so substituted values can never introduce new placeholders.
fn render_template(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 2048);
    let mut rest = template;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find("}}").and_then(|j| vars.iter().find(|(k, _)| *k == &after[..j]).map(|(_, v)| (j, v))) {
            Some((j, v)) => {
                out.push_str(v);
                rest = &after[j + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn page(title: &str, body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/styles.css?v={ASSET_VERSION}">
</head>
<body>
<div class="site">
  <header class="header"><nav class="nav" aria-label="Main navigation"><a class="brand" href="/"><img class="brand-logo" src="/assets/logo.svg" alt="" width="28" height="28"> Raxo Forms</a></nav></header>
  <main class="simple-main">{body}</main>
  <footer><a class="brand" href="/"><img class="brand-logo" src="/assets/logo.svg" alt="" width="24" height="24"> Raxo Forms</a><small>Raxo Forms · forms.raxo.email</small></footer>
</div>
</body>
</html>"#,
        title = escape_html(title)
    )
}

pub struct GeneratorState<'a> {
    pub form_id: Option<&'a str>,
    pub email: Option<&'a str>,
    pub management_token: Option<&'a str>,
    pub error: Option<&'a str>,
}

const EXAMPLE_FORM_ID: &str = "YOUR_FORM_ID";

pub fn render_generator_page(base_url: &str, state: Option<GeneratorState>) -> String {
    let form_id = state.as_ref().and_then(|s| s.form_id).unwrap_or("");
    let email = state.as_ref().and_then(|s| s.email).map(escape_html).unwrap_or_default();
    let management_token = state.as_ref().and_then(|s| s.management_token).map(escape_html).unwrap_or_default();
    let error = state.as_ref().and_then(|s| s.error).map(escape_html).unwrap_or_default();
    let created = !form_id.is_empty();
    let snippet_id = if created { form_id } else { EXAMPLE_FORM_ID };
    let base = base_url.trim_end_matches('/');
    let action_url = if created { escape_html(&format!("{base}/f/{form_id}")) } else { String::new() };
    let snippet = escape_html(&generate_html_snippet(base_url, snippet_id));
    let attachment_snippet = escape_html(&generate_attachment_snippet(base_url, snippet_id));
    let form_id = escape_html(form_id);
    let embed_status = if created {
        "Your form code is ready. It will start delivering after you click the activation link."
    } else {
        "Example code. Generate a Form ID above and this code is filled in for you."
    };
    let hidden = |h: bool| if h { " hidden" } else { "" };
    render_template(
        INDEX_TEMPLATE,
        &[
            ("V", ASSET_VERSION),
            ("ERROR", &error),
            ("ERROR_HIDDEN", hidden(error.is_empty())),
            ("EMAIL", &email),
            ("RESULT_HIDDEN", hidden(!created)),
            ("FORM_ID", &form_id),
            ("ACTION_URL", &action_url),
            ("MANAGEMENT_TOKEN", &management_token),
            ("EMBED_STATUS", embed_status),
            ("SNIPPET", &snippet),
            ("ATTACHMENT_SNIPPET", &attachment_snippet),
        ],
    )
}

pub struct VerificationResult<'a> {
    pub success: bool,
    pub message: &'a str,
    pub promoted_count: i64,
    pub is_prefetch: bool,
    pub token: Option<&'a str>,
}

pub fn render_verification_page(r: &VerificationResult) -> String {
    let (title, heading, icon) = if r.is_prefetch {
        ("Confirm Email Verification", "Confirm Email Verification", "🔒")
    } else if r.success {
        ("Email Ownership Verified", "Email Verified Successfully!", "🎉")
    } else {
        ("Verification Failed", "Verification Failed", "⚠️")
    };
    let promoted = if r.success && r.promoted_count > 0 {
        format!(
            "<div class=\"notice\">📦 {} held submission(s) have been unlocked and queued for delivery.</div>",
            r.promoted_count
        )
    } else {
        String::new()
    };
    let action = match (r.is_prefetch, r.token) {
        (true, Some(t)) => format!(
            "<form method=\"POST\" action=\"/verify\"><input type=\"hidden\" name=\"token\" value=\"{}\" /><button type=\"submit\" class=\"button primary\">Confirm &amp; Activate Form</button></form>",
            escape_html(t)
        ),
        _ => "<a href=\"/\" class=\"button primary\">Return to Home</a>".to_string(),
    };
    let body = format!(
        "<div class=\"simple-card\"><div class=\"icon\">{icon}</div><h1>{heading}</h1><p>{}</p>{promoted}{action}</div>",
        escape_html(r.message)
    );
    page(&format!("Raxo Forms — {title}"), &body)
}

pub fn render_receipt_page(submission_id: Option<&str>, is_held: bool) -> String {
    let id = submission_id.map(escape_html).unwrap_or_else(|| "received".into());
    let held = if is_held {
        "<div class=\"notice\">ℹ️ The form recipient is currently activating email delivery. Your submission is safely held and will deliver as soon as activation completes.</div>"
    } else {
        ""
    };
    let body = format!(
        "<div class=\"simple-card\"><div class=\"icon\">✓</div><h1>Submission Received &amp; Queued</h1><p>Your submission has been durably received and queued for processing.</p><div class=\"receipt-id\">ID: {id}</div>{held}</div>"
    );
    page("Submission Received & Queued — Raxo Forms", &body)
}

pub fn render_test_page(base_url: &str, form_id: &str, site_key: &str) -> String {
    let (b, f, k) = (escape_html(base_url), escape_html(form_id), escape_html(site_key));
    let body = format!(
        r#"<div class="simple-card left">
<h1>Live Operator Test Form</h1>
<p>Test form for verifying Raxo Email gateway acceptance, attachment storage, and RaxoSentinel scanning.</p>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="test-form" action="{b}/forms/{f}" method="POST" enctype="multipart/form-data">
<input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">
<label for="full_name">Your Name</label><input type="text" id="full_name" name="full_name" required value="Test User">
<label for="email">Your Email Address</label><input type="email" id="email" name="email" required value="test@example.com">
<label for="message">Message</label><textarea id="message" name="message" rows="3" required>Raxo Email — verification</textarea>
<label for="attachments">Upload PDF Document (Optional)</label><input type="file" id="attachments" name="attachments" accept="application/pdf">
<div class="cf-turnstile" data-sitekey="{k}" data-action="submit_form" data-theme="light"></div>
<button type="submit" id="submit-btn" class="button primary">Submit Test Entry →</button>
</form>
<div id="success-view" style="display:none"><p>Receipt ID:</p><div class="receipt-id" id="receipt-id"></div>
<p>Your submission and attached PDF have been durably received and queued for antivirus scanning and dispatch.</p></div>
</div>
<script>
const tf=document.getElementById("test-form");
tf.addEventListener("submit",async(e)=>{{
  e.preventDefault();
  const res=await fetch(tf.action,{{method:"POST",headers:{{"Accept":"application/json"}},body:new FormData(tf)}});
  const data=await res.json().catch(()=>({{}}));
  if(res.ok){{tf.style.display="none";document.getElementById("success-view").style.display="block";document.getElementById("receipt-id").innerText=data.submission_id||"received";}}
  else{{alert((data.error&&data.error.message)||"Submission failed");}}
}});
</script>"#
    );
    page("Raxo Forms — Live Operator Test Form", &body)
}

pub fn render_error_page(status: u16, code: &str, message: &str) -> String {
    let body = format!(
        "<div class=\"simple-card\"><div class=\"icon\">⚠️</div><h1>Error {status}</h1><p>{}</p><p><code>{}</code></p><a href=\"/\" class=\"button primary\">Return to Home</a></div>",
        escape_html(message),
        escape_html(code)
    );
    page(&format!("Error {status} — Raxo Forms"), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_page_shows_example_snippet_before_registration() {
        let html = render_generator_page("https://forms.raxo.email", None);
        assert!(html.contains("https://forms.raxo.email/f/YOUR_FORM_ID"));
        assert!(html.contains(r#"id="result-container" class="result" hidden"#));
        assert!(html.contains(r#"id="generator-error" class="alert-error" role="alert" hidden"#));
        assert!(!html.contains("{{"));
    }

    #[test]
    fn generator_page_escapes_state_and_ignores_injected_placeholders() {
        let html = render_generator_page(
            "https://forms.raxo.email",
            Some(GeneratorState {
                form_id: Some("abc123"),
                email: Some("a{{SNIPPET}}\"<x>@example.com"),
                management_token: Some("<tok>"),
                error: None,
            }),
        );
        assert!(html.contains(r#"<code id="form-id">abc123</code>"#));
        assert!(html.contains("https://forms.raxo.email/f/abc123"));
        assert!(html.contains("&lt;tok&gt;"));
        assert!(html.contains("a{{SNIPPET}}&quot;&lt;x&gt;@example.com"));
        assert!(html.contains("enctype=&quot;multipart/form-data&quot;"));
        assert!(!html.contains("<tok>") && !html.contains("YOUR_FORM_ID"));
    }
}
