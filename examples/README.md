# Example Forms

These examples demonstrate standard browser form submission with `multipart/form-data` and PDF file retention.

## Files

- `job-application.html`: Job application form demonstrating required text, email, optional URL, message, and multiple PDF attachments.
- `contact.html`: General contact form with required fields and optional PDF attachment.

## Local Usage

When `DEMO_MODE=true` is set, these forms are served directly by the gateway:

- `http://127.0.0.1:3000/demo/job-application`
- `http://127.0.0.1:3000/demo/contact`

In production, these `/demo/*` routes return `404 Not Found`.

## Retries & Deduplication

Both forms include a lightweight JavaScript client submission ID generator (`_submission_id`). If the user retries a submission with an identical ID within 24 hours, the gateway returns the original receipt without sending duplicate emails. Plain HTML without JavaScript operates normally without client deduplication guarantees.
