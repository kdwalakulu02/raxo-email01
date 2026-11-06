# Raxo Email — Developer Integration Kit

> Simple, private, FormSubmit-style form backend for modern websites. No accounts, no dashboards, zero tracker scripts.

Embed an HTML form into any static website or web app, and receive form submissions directly in your email inbox.

> [!NOTE]
> **Implementation & Deployment Status:**  
> This integration kit specifies the client interface for Raxo Email gateways. The backend engine and API contracts are fully implemented and verified via automated integration suites. Live production availability depends on the operator deploying their instance and establishing production SMTP delivery.

---

## Quick Start (3 Steps)

### Step 1: Generate your Form ID

Visit your Raxo Email gateway (e.g. `https://forms.yourdomain.com`) and enter your receiving email address.
You will immediately receive a unique 192-bit Form ID:

```
dGVzdC1mb3JtLWlkLTE5MmJpdHMxMjM0
```

### Step 2: Paste the HTML Form into your Website

Paste the following HTML into your site **only once**:

```html
<form action="https://forms.yourdomain.com/f/YOUR_FORM_ID" method="POST">
  <!-- Required form fields -->
  <label for="name">Name</label>
  <input type="text" id="name" name="name" required placeholder="Alex Smith" />

  <label for="email">Email</label>
  <input type="email" id="email" name="email" required placeholder="alex@example.com" />

  <label for="message">Message</label>
  <textarea id="message" name="message" rows="4" required placeholder="Your message..."></textarea>

  <!-- Optional honeypot spam prevention (hidden from users) -->
  <input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off" />

  <button type="submit">Send</button>
</form>
```

### Step 3: Click the Email Activation Link

Check your email inbox for an activation message from Raxo Email. Click the activation link **once**.

- You do **not** need to edit or re-paste your HTML after activation.
- Any submissions submitted while pending activation are stored safely and delivered immediately once activated.

---

## Special Features

| Field                | Description                                                                      | Example                                                                     |
| :------------------- | :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| `_next`              | Redirect users to a custom "Thank You" page upon successful submission           | `<input type="hidden" name="_next" value="https://mysite.com/thanks.html">` |
| `_subject`           | Customize the email subject line in your inbox                                   | `<input type="hidden" name="_subject" value="New Website Inquiry">`         |
| `_replyto` / `email` | Sets the email `Reply-To` header so hitting Reply directly replies to the sender | `<input type="email" name="email" required>`                                |
| `_honey`             | Invisible honeypot field. Silent rejection of spam bots without error            | `<input type="text" name="_honey" style="display:none">`                    |
| `_submission_id`     | Client UUID v4 for idempotent duplicate submission prevention                    | `<input type="hidden" name="_submission_id" value="[UUID]">`                |

---

## File Uploads (PDF Attachments)

To allow visitors to attach PDF documents (e.g., job applications, resumes, proposals):

```html
<form
  action="https://forms.yourdomain.com/f/YOUR_FORM_ID"
  method="POST"
  enctype="multipart/form-data"
>
  <input type="text" name="name" required placeholder="Your Name" />
  <input type="email" name="email" required placeholder="Your Email" />
  <input type="file" name="attachments" accept="application/pdf" required />
  <button type="submit">Submit Application</button>
</form>
```

_Note: All uploaded files are automatically scanned by ClamAV antivirus before transmission._

---

## JavaScript / AJAX Submissions

For single-page applications (React, Vue, Svelte) or AJAX forms without page reloads, pass `Accept: application/json`:

```javascript
const response = await fetch("https://forms.yourdomain.com/f/YOUR_FORM_ID", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    name: "Alex Smith",
    email: "alex@example.com",
    message: "Hello from my client app!",
  }),
});

const data = await response.json();
if (response.ok) {
  console.log("Submission accepted, receipt ID:", data.submission_id);
}
```

---

## Integration Examples

- [Minimal Form](examples/basic-form.html) — Simple vanilla HTML form.
- [Styled Form](examples/styled-form.html) — Modern, accessible, responsive form with dark-mode styling.
- [AJAX Integration](examples/ajax-form.html) — Seamless JavaScript submission with loading and success states.
- [API Reference](docs/API_REFERENCE.md) — Detailed request/response specifications and error codes.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
