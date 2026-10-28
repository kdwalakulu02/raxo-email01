# Security policy

This repository currently contains a specification. No software release is supported yet.

If GitHub private vulnerability reporting is enabled, use it for vulnerabilities. Otherwise use a contact actually listed on the maintainer's GitHub profile. Do not invent or assume a security mailbox. Do not post private files or credentials in issues.

Implementation requirements:

- Fixed server-configured form recipients and senders.
- Production CAPTCHA, exact origin filter, throttles and request limits.
- Database and file retention before notification.
- Quarantined files; scanner failures block notification/export.
- No public record-reading or file-download routes.
- No visitor-selected URLs, headers, mail destinations or storage paths.
- Private configuration, uploads, generated MIME and logs outside git.
- Uncertain SMTP outcomes are not automatically retried.

Baseline security is part of the public component. It is not reserved for a private edition. Passing antivirus tests is not a claim that every uploaded file is safe.
