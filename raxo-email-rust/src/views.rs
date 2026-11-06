use crate::forms::generate_html_snippet;

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

const STYLE: &str = r#"<style>
:root{--bg:#090d16;--card:#111827;--border:#1f293d;--text:#f3f4f6;--muted:#9ca3af;--primary:#4f46e5;--ok:#10b981;--danger:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.6;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem 1rem}
.container{max-width:860px;width:100%}
.card{background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:2rem;margin-bottom:1.5rem;text-align:center}
.card.left{text-align:left}
h1{font-size:2rem;margin-bottom:.75rem}
p{color:var(--muted);margin-bottom:1rem}
label{display:block;margin-bottom:.35rem;text-align:left;color:var(--muted)}
input,textarea{width:100%;padding:.6rem;border-radius:.4rem;border:1px solid var(--border);background:#030712;color:var(--text);margin-bottom:1rem}
.btn,button{display:inline-block;background:var(--primary);color:#fff;border:0;border-radius:.4rem;padding:.6rem 1.2rem;cursor:pointer;text-decoration:none;font-size:1rem}
pre{background:#030712;border:1px solid var(--border);padding:1rem;overflow:auto;text-align:left;border-radius:.4rem;color:#d1d5db}
.alert-error{background:rgba(239,68,68,.1);border:1px solid var(--danger);color:#fca5a5;padding:.75rem;border-radius:.4rem;margin-bottom:1rem}
.notice,.highlight-box{background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);padding:.75rem;border-radius:.4rem;margin:1rem 0}
.receipt-id{font-family:monospace;background:#030712;padding:.5rem;border-radius:.4rem;margin-bottom:1rem}
.icon{font-size:3rem;margin-bottom:1rem}
footer{color:var(--muted);margin-top:2rem;font-size:.85rem}
</style>"#;

fn page(title: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>{title}</title>\n  {STYLE}\n</head>\n<body>\n{body}\n</body>\n</html>"
    )
}

pub struct GeneratorState<'a> {
    pub form_id: Option<&'a str>,
    pub email: Option<&'a str>,
    pub error: Option<&'a str>,
}

pub fn render_generator_page(base_url: &str, state: Option<GeneratorState>) -> String {
    let form_id = state.as_ref().and_then(|s| s.form_id).unwrap_or("");
    let email = state.as_ref().and_then(|s| s.email).map(escape_html).unwrap_or_default();
    let error = state.as_ref().and_then(|s| s.error).map(escape_html).unwrap_or_default();
    let snippet = if form_id.is_empty() { String::new() } else { generate_html_snippet(base_url, form_id) };
    let err_html = if error.is_empty() { String::new() } else { format!("<div class=\"alert-error\">{error}</div>") };
    let display = if form_id.is_empty() { "none" } else { "block" };
    let body = format!(
        r#"<div class="container">
  <header class="card"><h1>Raxo Email</h1>
  <p class="subtitle">Turn any HTML form into an instant email submission endpoint. No account, no dashboard, zero tracking.</p></header>
  <div class="card left">
    {err_html}
    <form id="generator-form" action="/api/forms" method="POST">
      <label for="email-input">Where should submissions be sent?</label>
      <input type="email" id="email-input" name="email" placeholder="developer@example.com" value="{email}" required autocomplete="email">
      <button type="submit" id="submit-btn" class="btn-primary">Generate Form ID</button>
    </form>
    <div id="result-container" style="display:{display};margin-top:1.5rem">
      <div class="notice"><strong>Activation Email Sent!</strong> We sent a single-use activation link to your email address. Click it once to activate delivery. Submissions sent while pending are held safely in your durable queue and will be delivered upon activation.</div>
      <p><span id="display-form-id">Form ID: {form_id}</span></p>
      <pre id="snippet-code"><code>{snippet_esc}</code></pre>
      <p class="privacy-notice">Privacy Guarantee: Your receiving email address never appears in the HTML. Form IDs are public identifiers, not authentication tokens.</p>
    </div>
  </div>
  <footer><p>Raxo Email — Local-first durable form gateway with cryptographic integrity.</p></footer>
</div>
<script>
const form=document.getElementById("generator-form");
form.addEventListener("submit",async(e)=>{{
  e.preventDefault();
  const btn=document.getElementById("submit-btn");
  btn.disabled=true;btn.innerText="Generating...";
  try{{
    const res=await fetch("/api/forms",{{method:"POST",headers:{{"Content-Type":"application/json","Accept":"application/json"}},body:JSON.stringify({{email:document.getElementById("email-input").value}})}});
    const data=await res.json();
    if(!res.ok){{alert((data.error&&data.error.message)||"Failed to generate Form ID");return;}}
    document.getElementById("display-form-id").innerText="Form ID: "+data.form_id;
    const code=document.createElement("code");code.textContent=data.html_snippet;
    const pre=document.getElementById("snippet-code");pre.replaceChildren(code);
    document.getElementById("result-container").style.display="block";
  }}catch(err){{alert("Network error: "+err.message);}}
  finally{{btn.disabled=false;btn.innerText="Generate Form ID";}}
}});
</script>"#,
        form_id = escape_html(form_id),
        snippet_esc = escape_html(&snippet),
    );
    page("Raxo Email — Instant Form ID Generator", &body)
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
        format!("<div class=\"highlight-box\">📦 {} held submission(s) have been unlocked and queued for delivery.</div>", r.promoted_count)
    } else {
        String::new()
    };
    let action = match (r.is_prefetch, r.token) {
        (true, Some(t)) => format!(
            "<form method=\"POST\" action=\"/verify\"><input type=\"hidden\" name=\"token\" value=\"{}\" /><button type=\"submit\" class=\"btn\">Confirm &amp; Activate Form</button></form>",
            escape_html(t)
        ),
        _ => "<a href=\"/\" class=\"btn\">Return to Home</a>".to_string(),
    };
    let body = format!(
        "<div class=\"card\"><div class=\"icon\">{icon}</div><h1>{heading}</h1><p>{}</p>{promoted}{action}</div>",
        escape_html(r.message)
    );
    page(&format!("Raxo Email — {title}"), &body)
}

pub fn render_receipt_page(submission_id: Option<&str>, is_held: bool) -> String {
    let id = submission_id.map(escape_html).unwrap_or_else(|| "received".into());
    let held = if is_held {
        "<div class=\"notice\">ℹ️ The form recipient is currently activating email delivery. Your submission is safely held and will deliver as soon as activation completes.</div>"
    } else {
        ""
    };
    let body = format!(
        "<div class=\"card\"><div class=\"icon\">✓</div><h1>Submission Received &amp; Queued</h1><p>Your submission has been durably received and queued for processing.</p><div class=\"receipt-id\">ID: {id}</div>{held}</div>"
    );
    page("Submission Received & Queued — Raxo Email", &body)
}

pub fn render_test_page(base_url: &str, form_id: &str, site_key: &str) -> String {
    let (b, f, k) = (escape_html(base_url), escape_html(form_id), escape_html(site_key));
    let body = format!(
        r#"<div class="container"><div class="card left">
<h1>Live Operator Test Form</h1>
<p>Test form for verifying Raxo Email gateway acceptance, attachment storage, and RaxoSentinel scanning.</p>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="test-form" action="{b}/forms/{f}" method="POST" enctype="multipart/form-data">
<input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">
<label for="full_name">Your Name</label><input type="text" id="full_name" name="full_name" required value="Test User">
<label for="email">Your Email Address</label><input type="email" id="email" name="email" required value="test@example.com">
<label for="message">Message</label><textarea id="message" name="message" rows="3" required>Raxo Email — verification</textarea>
<label for="attachments">Upload PDF Document (Optional)</label><input type="file" id="attachments" name="attachments" accept="application/pdf">
<div class="cf-turnstile" data-sitekey="{k}" data-action="submit_form" data-theme="dark"></div>
<button type="submit" id="submit-btn">Submit Test Entry →</button>
</form>
<div id="success-view" style="display:none"><p>Receipt ID:</p><div class="receipt-id" id="receipt-id"></div>
<p>Your submission and attached PDF have been durably received and queued for antivirus scanning and dispatch.</p></div>
</div></div>
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
    page("Raxo Email — Live Operator Test Form", &body)
}

pub fn render_error_page(status: u16, code: &str, message: &str) -> String {
    let body = format!(
        "<div class=\"card\"><div class=\"icon\">⚠️</div><h1>Error {status}</h1><p>{}</p><p><code>{}</code></p><a href=\"/\" class=\"btn\">Return to Home</a></div>",
        escape_html(message),
        escape_html(code)
    );
    page(&format!("Error {status} — Raxo Email"), &body)
}
