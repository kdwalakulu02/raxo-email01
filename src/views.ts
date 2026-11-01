import { generateHtmlSnippet } from "./forms.js";

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (match) => {
    switch (match) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return match;
    }
  });
}

export function renderGeneratorPage(
  baseUrl: string,
  state?: { formId?: string; email?: string; error?: string },
): string {
  const formId = state?.formId || "";
  const email = state?.email ? escapeHtml(state.email) : "";
  const errorMsg = state?.error ? escapeHtml(state.error) : "";
  const snippet = formId ? generateHtmlSnippet(baseUrl, formId) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Raxo Email — Instant Form ID Generator</title>
  <meta name="description" content="Local-first, account-free form backend gateway. Enter your email, paste HTML once, and receive form submissions securely.">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-gradient: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);
      --accent-cyan: #06b6d4;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --code-bg: #030712;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--font);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem;
      flex: 1;
      width: 100%;
    }
    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 9999px;
      font-size: 0.825rem;
      font-weight: 600;
      color: #818cf8;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      line-height: 1.2;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.75rem;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 1.125rem;
      max-width: 620px;
      margin: 0 auto;
    }
    .steps-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    @media (max-width: 680px) {
      .steps-row { grid-template-columns: 1fr; }
      h1 { font-size: 2rem; }
    }
    .step-card {
      background: rgba(17, 24, 39, 0.7);
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      text-align: left;
    }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .step-title {
      font-weight: 600;
      font-size: 0.975rem;
      margin-bottom: 0.25rem;
    }
    .step-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 1rem;
      padding: 2rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
      margin-bottom: 2rem;
    }
    .form-group {
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      font-size: 0.925rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #e5e7eb;
    }
    .input-wrapper {
      display: flex;
      gap: 0.75rem;
    }
    @media (max-width: 540px) {
      .input-wrapper { flex-direction: column; }
    }
    input[type="email"] {
      flex: 1;
      padding: 0.875rem 1rem;
      background: #0b1120;
      border: 1px solid #374151;
      border-radius: 0.5rem;
      color: white;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input[type="email"]:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }
    button.btn-primary {
      padding: 0.875rem 1.75rem;
      background: var(--primary-gradient);
      color: white;
      font-weight: 600;
      font-size: 1rem;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.15s;
      white-space: nowrap;
    }
    button.btn-primary:hover {
      opacity: 0.95;
      transform: translateY(-1px);
    }
    button.btn-primary:active {
      transform: translateY(0);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.9rem;
      margin-bottom: 1.25rem;
    }
    .result-section {
      margin-top: 2rem;
      padding-top: 2rem;
      border-top: 1px solid var(--card-border);
    }
    .status-notice {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
      color: #fde68a;
      font-size: 0.925rem;
    }
    .status-icon {
      font-size: 1.25rem;
      line-height: 1;
    }
    .form-id-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .form-id-tag {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #38bdf8;
      background: #0f172a;
      padding: 0.35rem 0.75rem;
      border-radius: 0.375rem;
      border: 1px solid #1e293b;
    }
    .code-container {
      position: relative;
      background: var(--code-bg);
      border: 1px solid #1e293b;
      border-radius: 0.5rem;
      overflow: hidden;
      margin-bottom: 1rem;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      background: #0b1120;
      border-bottom: 1px solid #1e293b;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .copy-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      padding: 0.25rem 0.75rem;
      border-radius: 0.25rem;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .copy-btn:hover {
      background: #334155;
      color: white;
    }
    pre {
      padding: 1.25rem;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #e2e8f0;
      line-height: 1.5;
    }
    .privacy-notice {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-top: 1rem;
    }
    footer {
      text-align: center;
      padding: 2rem 1rem;
      color: #6b7280;
      font-size: 0.85rem;
      border-top: 1px solid #111827;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">Phase 1 Integration Gateway</div>
      <h1>Raxo Email</h1>
      <p class="subtitle">Turn any HTML form into an instant email submission endpoint. No account, no dashboard, zero tracking.</p>
    </header>

    <div class="steps-row">
      <div class="step-card">
        <div class="step-num">1</div>
        <div class="step-title">Enter Email</div>
        <div class="step-desc">Enter your receiving address to generate your private 192-bit Form ID.</div>
      </div>
      <div class="step-card">
        <div class="step-num">2</div>
        <div class="step-title">Embed HTML Once</div>
        <div class="step-desc">Paste the snippet into your website. Your email is never exposed publicly.</div>
      </div>
      <div class="step-card">
        <div class="step-num">3</div>
        <div class="step-title">Verify Ownership</div>
        <div class="step-desc">Click the single-use activation email link. Form submissions deliver immediately.</div>
      </div>
    </div>

    <div class="card">
      ${errorMsg ? `<div class="alert-error">${errorMsg}</div>` : ""}

      <form id="generator-form" action="/api/forms" method="POST">
        <div class="form-group">
          <label for="email-input">Where should submissions be sent?</label>
          <div class="input-wrapper">
            <input
              type="email"
              id="email-input"
              name="email"
              placeholder="developer@example.com"
              value="${email}"
              required
              autocomplete="email"
            >
            <button type="submit" id="submit-btn" class="btn-primary">Generate Form ID</button>
          </div>
        </div>
      </form>

      <div id="result-container" class="result-section" style="${formId ? "display: block;" : "display: none;"}">
        <div class="status-notice">
          <div class="status-icon">✉️</div>
          <div>
            <strong>Activation Email Sent!</strong>
            <p>We sent a single-use activation link to your email address. Click it once to activate delivery. Submissions sent while pending are held safely in your durable queue and will be delivered upon activation.</p>
          </div>
        </div>

        <div class="form-id-row">
          <label style="margin: 0;">Your Ready-to-Copy HTML Form:</label>
          <span class="form-id-tag" id="display-form-id">Form ID: ${formId}</span>
        </div>

        <div class="code-container">
          <div class="code-header">
            <span>HTML Form Snippet</span>
            <button type="button" class="copy-btn" id="copy-btn" onclick="copySnippet()">Copy HTML</button>
          </div>
          <pre id="snippet-code"><code>${escapeHtml(snippet)}</code></pre>
        </div>

        <p class="privacy-notice">
          🔒 <strong>Privacy Guarantee:</strong> Your receiving email address never appears in the HTML. Form IDs are public identifiers, not authentication tokens.
        </p>
      </div>
    </div>
  </div>

  <footer>
    <p>Raxo Email — Local-first durable form gateway with cryptographic integrity.</p>
  </footer>

  <script>
    function copySnippet() {
      const code = document.getElementById("snippet-code").innerText;
      navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById("copy-btn");
        const prevText = btn.innerText;
        btn.innerText = "✓ Copied!";
        btn.style.background = "#10b981";
        btn.style.color = "#ffffff";
        setTimeout(() => {
          btn.innerText = prevText;
          btn.style.background = "";
          btn.style.color = "";
        }, 2000);
      });
    }

    const form = document.getElementById("generator-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        const emailInput = document.getElementById("email-input");
        const submitBtn = document.getElementById("submit-btn");

        if (window.fetch) {
          e.preventDefault();
          submitBtn.disabled = true;
          submitBtn.innerText = "Generating...";

          try {
            const res = await fetch("/api/forms", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
              },
              body: JSON.stringify({ email: emailInput.value })
            });

            const data = await res.json();
            if (!res.ok) {
              alert(data.error?.message || "Failed to generate Form ID");
              submitBtn.disabled = false;
              submitBtn.innerText = "Generate Form ID";
              return;
            }

            document.getElementById("display-form-id").innerText = "Form ID: " + data.form_id;
            document.getElementById("snippet-code").innerHTML = "<code>" + data.html_snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code>";
            document.getElementById("result-container").style.display = "block";
            document.getElementById("result-container").scrollIntoView({ behavior: "smooth" });
          } catch (err) {
            alert("Network error: " + err.message);
          } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Generate Form ID";
          }
        }
      });
    }
  </script>
</body>
</html>`;
}

export function renderVerificationPage(result: {
  success: boolean;
  message: string;
  promotedCount?: number;
  isPrefetch?: boolean;
  token?: string;
}): string {
  const isSuccess = result.success;
  const isPrefetch = result.isPrefetch;
  const escapedMessage = escapeHtml(result.message);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Raxo Email — ${isPrefetch ? "Confirm Email Verification" : isSuccess ? "Email Ownership Verified" : "Verification Failed"}</title>
  <style>
    body {
      background-color: #090d16;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1.5rem;
    }
    .card {
      background: #111827;
      border: 1px solid #1f293d;
      border-radius: 1rem;
      padding: 2.5rem;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: ${isPrefetch ? "#38bdf8" : isSuccess ? "#10b981" : "#ef4444"};
    }
    p {
      color: #9ca3af;
      font-size: 1rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    .highlight-box {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      font-size: 0.9rem;
      color: #6ee7b7;
      margin-bottom: 1.5rem;
    }
    .btn {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: #4f46e5;
      color: white;
      text-decoration: none;
      border-radius: 0.5rem;
      font-weight: 600;
      font-size: 0.95rem;
      border: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover { background: #4338ca; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isPrefetch ? "🔒" : isSuccess ? "🎉" : "⚠️"}</div>
    <h1>${isPrefetch ? "Confirm Email Verification" : isSuccess ? "Email Verified Successfully!" : "Verification Failed"}</h1>
    <p>${escapedMessage}</p>
    ${
      isSuccess && (result.promotedCount ?? 0) > 0
        ? `<div class="highlight-box">📦 ${result.promotedCount} held submission(s) have been unlocked and queued for delivery.</div>`
        : ""
    }
    ${
      isPrefetch && result.token
        ? `<form method="POST" action="/verify">
             <input type="hidden" name="token" value="${escapeHtml(result.token)}" />
             <button type="submit" class="btn">Confirm & Activate Form</button>
           </form>`
        : `<a href="/" class="btn">Return to Home</a>`
    }
  </div>
</body>
</html>`;
}

export function renderReceiptPage(submissionId: string | null, isHeld = false): string {
  const escapedId = submissionId ? escapeHtml(submissionId) : "received";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Submission Received — Raxo Email</title>
  <style>
    body {
      background-color: #090d16;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1.5rem;
    }
    .card {
      background: #111827;
      border: 1px solid #1f293d;
      border-radius: 1rem;
      padding: 2.5rem;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.75rem; color: #10b981; }
    p { color: #9ca3af; font-size: 1rem; line-height: 1.5; margin-bottom: 1.25rem; }
    .receipt-id {
      font-family: ui-monospace, monospace;
      font-size: 0.9rem;
      background: #030712;
      border: 1px solid #1e293b;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      color: #38bdf8;
      display: inline-block;
      margin-bottom: 1.5rem;
    }
    .notice {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.25);
      border-radius: 0.5rem;
      padding: 0.75rem;
      color: #fde68a;
      font-size: 0.85rem;
      margin-bottom: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Thank You!</h1>
    <p>Your submission has been received and securely retained.</p>
    <div class="receipt-id">ID: ${escapedId}</div>
    ${
      isHeld
        ? `<div class="notice">ℹ️ The form recipient is currently activating email delivery. Your submission is safely held and will deliver as soon as activation completes.</div>`
        : ""
    }
  </div>
</body>
</html>`;
}

export function renderTestPage(
  baseUrl: string,
  formId: string = "vps-delivery-test",
  siteKey: string = "0x4AAAAAAAxxxxxxxxxxxxxx",
): string {
  const escapedBase = escapeHtml(baseUrl);
  const escapedFormId = escapeHtml(formId);
  const escapedSiteKey = escapeHtml(siteKey);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Raxo Email — Live Operator Test Form</title>
  <meta name="description" content="Test form for verifying Raxo Email gateway acceptance, attachment storage, and ClamAV scanning.">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --success: #10b981;
      --accent: #38bdf8;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--font);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .container {
      width: 100%;
      max-width: 580px;
    }
    .header {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1.4rem;
      font-weight: 800;
      color: #fff;
      margin-bottom: 0.5rem;
    }
    .logo span { color: var(--accent); }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: var(--success);
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 1rem;
      padding: 2rem;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .card h2 {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .card p.subtitle {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-bottom: 1.5rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 600;
      color: #e5e7eb;
      margin-bottom: 0.35rem;
    }
    .help-text {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    input[type="text"],
    input[type="email"],
    textarea {
      width: 100%;
      background: #030712;
      border: 1px solid #374151;
      border-radius: 0.5rem;
      padding: 0.65rem 0.85rem;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus,
    input[type="email"]:focus,
    textarea:focus {
      border-color: var(--primary);
    }
    input[type="file"] {
      width: 100%;
      background: #030712;
      border: 1px dashed #374151;
      border-radius: 0.5rem;
      padding: 0.65rem;
      color: var(--text-muted);
      font-size: 0.85rem;
      cursor: pointer;
    }
    button[type="submit"] {
      width: 100%;
      background: var(--primary);
      color: #fff;
      font-weight: 600;
      font-size: 1rem;
      border: none;
      border-radius: 0.5rem;
      padding: 0.85rem;
      cursor: pointer;
      transition: background 0.2s;
      margin-top: 0.5rem;
    }
    button[type="submit"]:hover {
      background: var(--primary-hover);
    }
    .status-box {
      margin-top: 1.5rem;
      padding: 1rem;
      background: #030712;
      border: 1px solid var(--card-border);
      border-radius: 0.5rem;
      font-size: 0.8rem;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.35rem;
    }
    .status-row:last-child { margin-bottom: 0; }
    .status-val { font-family: ui-monospace, monospace; color: var(--accent); }
    .footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .footer a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">⚡ Raxo<span>Email</span></div>
      <div><span class="badge">● Stack Operational</span></div>
    </div>

    <div class="card">
      <h2>Live Operator Test Form</h2>
      <p class="subtitle">Submit a test enquiry with an optional PDF attachment to verify end-to-end receipt, ClamAV antivirus scanning, and database persistence.</p>

      <form action="${escapedBase}/forms/${escapedFormId}" method="POST" enctype="multipart/form-data">
        <input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">

        <div class="form-group">
          <label for="full_name">Your Name</label>
          <input type="text" id="full_name" name="full_name" required placeholder="Kumudu UOG" value="Kumudu UOG">
        </div>

        <div class="form-group">
          <label for="email">Your Email Address</label>
          <input type="email" id="email" name="email" required placeholder="kumudu.uog@gmail.com" value="kumudu.uog@gmail.com">
          <div class="help-text">Authorized recipient configured in config/forms.json.</div>
        </div>

        <div class="form-group">
          <label for="message">Message</label>
          <textarea id="message" name="message" rows="3" required placeholder="Write a test message...">Hello from Contabo VPS live operator test form!</textarea>
        </div>

        <div class="form-group">
          <label for="attachments">Upload PDF Document (Optional)</label>
          <input type="file" id="attachments" name="attachments" accept="application/pdf">
          <div class="help-text">Max 10 MB. Scanned automatically by live ClamAV daemon.</div>
        </div>

        <div class="form-group" style="margin-top: 1rem; display: flex; justify-content: center;">
          <div class="cf-turnstile" data-sitekey="${escapedSiteKey}" data-action="submit_form" data-theme="dark"></div>
        </div>

        <button type="submit">Submit Test Entry →</button>
      </form>

      <div class="status-box">
        <div class="status-row">
          <span>Active Test Form ID:</span>
          <span class="status-val">${escapedFormId}</span>
        </div>
        <div class="status-row">
          <span>Target Endpoint:</span>
          <span class="status-val">POST /forms/${escapedFormId}</span>
        </div>
        <div class="status-row">
          <span>Recipient:</span>
          <span class="status-val">kumudu.uog@gmail.com</span>
        </div>
        <div class="status-row">
          <span>Outbound SMTP:</span>
          <span class="status-val" style="color: #10b981;">Active (STARTTLS port 587)</span>
        </div>
        <div class="status-row">
          <span>ClamAV Scanner:</span>
          <span class="status-val" style="color: #10b981;">Online (v1.5.4)</span>
        </div>
      </div>
    </div>

    <div class="footer">
      Raxo Email Forms Core v0.1.0-alpha • <a href="${escapedBase}/">Generate New Form ID</a>
    </div>
  </div>
</body>
</html>`;
}

