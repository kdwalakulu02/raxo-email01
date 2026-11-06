# Postal SMTP Engine: Production Verification & Deliverability Guide

## 1. Executive Summary & Deliverability Distinction

| Environment                        | Purpose                                  | Verification Scope                                                                                            | Current Status                                               |
| :--------------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------- |
| **Local Development (Mailpit)**    | Loopback & automated integration testing | Transport protocol correctness, MIME formatting, RFC 5322 headers, attachment serialization                   | **VERIFIED** (Automated tests pass with code 0)              |
| **Self-Hosted Postal SMTP Engine** | Production outbound message submission   | IP reputation, rDNS, SPF/DKIM/DMARC alignment, TLS cipher negotiation, mailbox deliverability (Gmail/Outlook) | **DEPLOYMENT DEPENDENCY** (Pending live server provisioning) |

> [!IMPORTANT]
> Local Mailpit handoff tests prove software protocol correctness; they **do not** prove Internet deliverability. Do not claim production SMTP readiness until the end-to-end live testing matrix below has passed against commercial mailbox providers.

---

## 2. Infrastructure & DNS Specification

### 2.1 Sending IP and Reverse DNS (PTR)

To prevent immediate reputation rejection by Spamhaus, Gmail, and Microsoft SmartScreen:

- **Dedicated Outbound IPv4**: Must not be shared with noisy tenants or web traffic.
- **PTR Record**: Must match the Fully Qualified Domain Name (FQDN) of the Postal outbound mail server:
  ```dns
  # Example PTR lookup
  203.0.113.25.in-addr.arpa. IN PTR mail.example.com.
  ```
- **Forward Confirmed Reverse DNS (FCrDNS)**: Forward resolution of `mail.example.com` MUST resolve back to `203.0.113.25`.

### 2.2 SPF (Sender Policy Framework)

Authorize the Postal sending IP for your organizational domain:

```dns
# TXT record on root domain (example.com)
v=spf1 ip4:203.0.113.25 -all
```

_(Use strict `-all` fail policy once IP is verified, rather than softfail `~all`)._

### 2.3 DKIM (DomainKeys Identified Mail)

Generate a 2048-bit RSA key pair within Postal.

```dns
# TXT record on postal._domainkey.example.com
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
```

- Message headers signed: `From`, `To`, `Subject`, `Date`, `Message-ID`, `Reply-To`, `MIME-Version`, `Content-Type`.
- Canonicalization: `relaxed/relaxed`.

### 2.4 DMARC (Domain-based Message Authentication, Reporting, and Conformance)

Publish a DMARC policy requiring alignment of RFC 5322 `From` domain with SPF and DKIM:

```dns
# TXT record on _dmarc.example.com
v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; pct=100; rua=mailto:dmarc-reports@example.com
```

### 2.5 MX and Inbound Routing for Bounces

Postal requires a dedicated bounce domain (e.g., `psrp.example.com` or `bounces.example.com`):

```dns
# MX record for bounce handling
bounces.example.com. IN MX 10 mail.example.com.
```

---

## 3. Postal Configuration & Security Matrix

### 3.1 Network & Authentication Parameters

Configure the Raxo Email production environment (`.env`):

```ini
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_TLS_MODE=starttls_required
SMTP_USERNAME=raxo_production_sender
SMTP_PASSWORD=[STRONG_GENERATED_CREDENTIAL]
MESSAGE_ID_DOMAIN=notifications.example.com
OUTBOUND_ENABLED=true
```

### 3.2 Transport Security (TLS)

- **Minimum Protocol**: TLS 1.2; TLS 1.3 preferred.
- **Cipher Suites**: Reject export/null/DES ciphers. Require forward secrecy (ECDHE).
- **Certificate**: Trusted authority certificate (Let's Encrypt / Commercial CA) matching `mail.example.com`. No self-signed or expired certificates in production.

---

## 4. Operational Handling: Queuing, Retries, and Bounces

### 4.1 Bounded Retries & Exponential Backoff

Raxo Email maintains an internal durable queue with transaction-safe retries:

1. **Initial Send**: Immediate upon submission acceptance.
2. **First Retry**: 1 minute (`retry_wait`).
3. **Second Retry**: 5 minutes.
4. **Third Retry**: 15 minutes.
5. **Fourth Retry**: 60 minutes.
6. **Terminal State**: After 5 failed attempts (attempt_count = 5), notification transitions permanently to `failed`.
7. **Post-DATA Ambiguity**: Any network disconnect or socket timeout during or after the SMTP `DATA` phase transitions to `unknown` and is **never** automatically resubmitted to prevent duplicate delivery.

### 4.2 Bounce & Rejection Handling

1. **Synchronous Rejections (5xx)**:
   - Postal rejects message during SMTP session (e.g., `550 User unknown`).
   - Raxo records failure outcome with receipt `smtp_550` and marks notification `failed`.
2. **Asynchronous Bounces (NDRs)**:
   - Downstream mailbox provider accepts message, then sends an NDR to the Envelope `MAIL FROM` bounce address.
   - Postal's incoming bounce processor parses the VERP (Variable Envelope Return Path) token.
   - Postal webhooks or bounce logs flag the recipient address as suppressed.

---

## 5. End-to-End Production Verification Checklist

Run this checklist once the self-hosted Postal server is online before promoting Raxo Email to public traffic:

### Step 1: DNS & Authentication Verification

- [ ] Verify FCrDNS: `dig +short -x <SENDING_IP>` returns Postal FQDN.
- [ ] Verify Forward DNS: `dig +short <FQDN>` returns `<SENDING_IP>`.
- [ ] Verify SPF: `dig +short TXT <ORGANIZATIONAL_DOMAIN>` contains `ip4:<SENDING_IP>`.
- [ ] Verify DKIM: `dig +short TXT postal._domainkey.<DOMAIN>` returns valid 2048-bit key.
- [ ] Verify DMARC: `dig +short TXT _dmarc.<DOMAIN>` returns valid policy.

### Step 2: TLS & Port Connectivity

- [ ] Test STARTTLS:
  ```bash
  openssl s_client -starttls smtp -connect mail.example.com:587 -tls1_2
  ```
- [ ] Confirm certificate subject matches `mail.example.com`.
- [ ] Confirm certificate expiration is > 30 days away.

### Step 3: Test Deliverability to Gmail

- [ ] Trigger test submission to a clean `@gmail.com` address.
- [ ] Inspect Gmail raw headers ("Show original"):
  - **SPF**: `PASS with IP <SENDING_IP>`
  - **DKIM**: `PASS with domain <DOMAIN>`
  - **DMARC**: `PASS`
- [ ] Confirm email landed in **Primary Inbox** (not Spam or Promotions).

### Step 4: Test Deliverability to Outlook / Office 365

- [ ] Trigger test submission to a clean `@outlook.com` or corporate Microsoft 365 address.
- [ ] Inspect Outlook raw headers:
  - `Authentication-Results: ... dkim=pass ... spf=pass ... dmarc=pass`
  - `X-Forefront-Antispam-Report: ... SFV:NSPM` (Not Spam)
- [ ] Confirm message landed in **Inbox** (not Junk Email).

---

## 6. Outstanding Deployment Dependencies

1. **Self-Hosted Postal Server Provisioning**: Server instance with static public IP and reverse DNS authority.
2. **Domain DNS Authorization**: Delegation of SPF, DKIM selector, DMARC, and MX records.
3. **Warm-up Schedule**: Initial sending rate must be throttled (< 100 emails/day) and ramped gradually over 14 days to establish sender reputation.
