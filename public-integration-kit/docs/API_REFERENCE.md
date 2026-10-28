# Raxo Email — Public API Reference

## 1. Submission Endpoint: `POST /f/:formId`

Accepts public form submissions from ordinary HTML forms, single-page web applications, and multipart file uploads.

### Supported Content Types

- `application/x-www-form-urlencoded` (default browser form encoding)
- `multipart/form-data` (required when uploading files)
- `application/json` (REST / AJAX submissions)

---

## 2. Request Parameters & Special Fields

Any standard form fields (e.g. `name`, `email`, `message`, `phone`, `company`) are accepted, sanitized, and formatted into the notification email sent to the owner.

In addition, the following control fields are supported:

| Field Name       | Type           | Description                                                                                                     |
| :--------------- | :------------- | :-------------------------------------------------------------------------------------------------------------- |
| `_next`          | String (URL)   | Redirect URL after submission. If provided, the endpoint returns an HTTP 303 redirect.                          |
| `_honey`         | String         | Anti-spam honeypot. Real users leave this blank. If filled by a bot, the submission is silently discarded.      |
| `_replyto`       | String (Email) | Overrides the email `Reply-To` header. If omitted, field named `email` is used as Reply-To automatically.       |
| `_subject`       | String         | Overrides the notification subject line prefix in the owner's inbox.                                            |
| `_submission_id` | UUID v4        | Client-generated idempotency key. Duplicate submissions with identical keys and fields return original receipt. |
| `attachments`    | File (PDF)     | PDF attachment up to 10 MB. Scanned by ClamAV antivirus before transmission.                                    |

---

## 3. Response Formats

### JSON Response (when `Accept: application/json` is sent)

**HTTP 202 Accepted**:

```json
{
  "submission_id": "925cabb7-fcff-4687-8214-026711d83f0d",
  "status": "received"
}
```

### HTML Response (default browser submissions)

- If `_next` is provided: **HTTP 303 See Other** redirecting to the provided URL.
- If `_next` is not provided: **HTTP 202 Accepted** with a clean, branded "Submission Received" receipt page.

---

## 4. Error Codes & Troubleshooting

| Status Code | Error Code             | Meaning & Solution                                                                    |
| :---------- | :--------------------- | :------------------------------------------------------------------------------------ |
| `400`       | `bad_request`          | Malformed parameters, forbidden control characters, or too many fields (> 50).        |
| `403`       | `forbidden`            | The requested form has been deactivated by its owner.                                 |
| `404`       | `not_found`            | The Form ID does not exist. Check that the Form ID in your `action` URL is correct.   |
| `409`       | `idempotency_conflict` | Conflicting submission payload submitted under an existing `_submission_id`.          |
| `413`       | `file_too_large`       | Uploaded file exceeds 10 MB or aggregate multipart request exceeds 11 MB.             |
| `422`       | `invalid_pdf`          | Uploaded file was not a valid PDF or failed antivirus security inspection.            |
| `429`       | `rate_limited`         | Submission rate limit exceeded (5 requests/minute per IP, 100 requests/day per form). |
| `503`       | `service_unavailable`  | Server is temporarily operating at maximum concurrent capacity. Retry shortly.        |

---

## 5. Account-Free Deactivation: `POST /f/:formId/deactivate`

If you ever wish to retire a form, you can deactivate it without an account using the private `management_token` provided during form registration:

```bash
curl -X POST https://forms.yourdomain.com/f/YOUR_FORM_ID/deactivate \
  -H "Content-Type: application/json" \
  -d '{"management_token": "YOUR_PRIVATE_MANAGEMENT_TOKEN"}'
```

**Response (HTTP 200)**:

```json
{
  "status": "deactivated",
  "form_id": "YOUR_FORM_ID",
  "message": "Form has been successfully deactivated."
}
```

Once deactivated, subsequent submissions to `POST /f/:formId` will immediately return `403 Forbidden`.
