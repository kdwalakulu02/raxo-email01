# Demo Verification Results

Execution timestamp: `2026-10-26T00:56:55Z`
Command: `pnpm run demo:verify`

## Environment

- OS: Linux x86_64
- Node.js: v22.23.3
- pnpm: 12.6.0
- DEMO_MODE: `true`
- PostgreSQL: `127.0.0.1:55432` (`raxo_email_demo`)
- Mailpit: `127.0.0.1:1025` (SMTP), `127.0.0.1:8025` (HTTP API)
- ClamAV: `127.0.0.1:3310` (`clamd`)

## Test Scenario

1. Verified loopback host constraints and `DEMO_MODE=true`.
2. Created a synthetic valid PDF fixture (`alex_example_cv.pdf`, 616 bytes).
3. Started HTTP gateway and single background worker process with advisory lock `726901`.
4. Submitted multipart `job-application` form with synthetic applicant details and PDF attachment via HTTP POST to `http://127.0.0.1:3000/forms/job-application`.
5. Gateway accepted submission and returned `202 Accepted` with receipt UUID `2f304f70-2362-47ee-b6d6-6c32f8039c74`.
6. Resubmitted identical payload with the same client submission ID (`2d2f6506-58ae-4dd1-938f-45b4dce1517f`). Gateway returned original receipt `2f304f70-2362-47ee-b6d6-6c32f8039c74` (idempotent deduplication).
7. Worker scanned attachment with live ClamAV, built MIME, and handed notification to local Mailpit SMTP.
8. Polled Mailpit API and captured message `4sQBhL6EF3rH9Rw4rwMJ5O`.
9. Exported attachment from private clean storage using the operator CLI (`attachments export`).
10. Compared SHA-256 digests across original buffer, Mailpit MIME parsed attachment, and CLI-exported file.

## Checksum Verification

- Original PDF SHA-256: `9cf4f2fe9f4d555528b4a9013fe37dcf230c917c5ebbd9e73953687a9be08e2c`
- Mailpit MIME Attachment SHA-256: `9cf4f2fe9f4d555528b4a9013fe37dcf230c917c5ebbd9e73953687a9be08e2c`
- Operator CLI Export SHA-256: `9cf4f2fe9f4d555528b4a9013fe37dcf230c917c5ebbd9e73953687a9be08e2c`
- All 3 Checksums Match: **YES**

## Notification Status

- Final Database State: `submitted`
- Delivery Claim: None (SMTP acceptance recorded as `submitted`; no remote mailbox delivery claim)
