# Postal SMTP Engine: Contabo VPS Deployment & Deliverability Guide

## 1. Production Architecture & Hostnames

The production email architecture for domain `btctoons.com` separates the web application, mail transport, envelope sender, and bounce receiver:

| Hostname                   | Role                                            | Destination IP / Service                     |
| :------------------------- | :---------------------------------------------- | :------------------------------------------- |
| **`forms.btctoons.com`**   | Raxo Forms Public Gateway                       | Contabo VPS IPv4 (Caddy Reverse Proxy)       |
| **`mail.btctoons.com`**    | Self-Hosted Postal SMTP Server                  | Contabo VPS IPv4 (Postal SMTP ports 25, 587) |
| **`notify.btctoons.com`**  | Sender Domain (`From: ...@notify.btctoons.com`) | Authorized via SPF, DKIM, and DMARC          |
| **`bounces.btctoons.com`** | Envelope Return-Path / Bounce Domain            | MX 10 `mail.btctoons.com`                    |

---

## 2. Contabo VPS Port 25 Outbound Unblock Requirement

> [!CAUTION]
> **Mandatory Contabo Prerequisite:**  
> By default, Contabo blocks outbound TCP port 25 on all new VPS instances to prevent spam abuse.  
> Before Postal can transmit outbound email to external mail servers (Gmail, Outlook, Yahoo), you must submit a support request to Contabo:
>
> **Contabo Support Ticket Template:**
>
> ```text
> Subject: Request to unblock outbound port 25 for transactional email server
>
> Hello Contabo Support Team,
>
> I have provisioned VPS [VPS_ID / IP] to run our self-hosted transactional email infrastructure (Postal SMTP) for our service domain btctoons.com.
>
> Please remove the outbound port 25 restriction on this VPS.
> I confirm that:
> 1. We enforce strict double-opt-in / email verification for all form endpoints.
> 2. We have configured Forward-Confirmed Reverse DNS (FCrDNS), SPF, DKIM, and DMARC.
> 3. We maintain automated bounce suppression and do not send bulk marketing.
>
> Thank you.
> ```

---

## 3. Reverse DNS (PTR Record) Setup in Contabo

External mail servers (especially Gmail and Microsoft SmartScreen) instantly reject email if the connecting IP does not have Forward-Confirmed Reverse DNS (FCrDNS).

1. Log in to the **Contabo Customer Control Panel (CCP)**: `https://my.contabo.com`
2. Navigate to **Reverse DNS Management** (or **VPS Control** -> **Manage** -> **Reverse DNS**).
3. Set the PTR record for your VPS IP:
   - **IP**: `[YOUR_CONTABO_VPS_IP]`
   - **PTR Target**: `mail.btctoons.com`
4. Confirm resolution:
   ```bash
   dig +short -x [YOUR_CONTABO_VPS_IP]
   # Must return: mail.btctoons.com.
   ```

---

## 4. Postal SMTP Engine Installation

Postal runs via its official Docker distribution and uses MariaDB and RabbitMQ.

### 4.1 Install Postal CLI & Dependencies

```bash
# Install git and ruby (required for postal CLI helper)
sudo apt install -y git ruby-full

# Install Postal CLI
sudo gem install postal-cli

# Run Postal automated installation
sudo postal install --host mail.btctoons.com
```

### 4.2 Start Postal Services

Postal orchestrates its own containers for web management, SMTP server, worker, and MariaDB:

```bash
sudo postal start
sudo postal status
```

Access the Postal web admin at `https://mail.btctoons.com` to configure your first organization and mail server.

---

## 5. DNS Records Matrix for `btctoons.com`

Publish the following DNS records in your domain DNS zone (Cloudflare / Registrar):

### 5.1 Host & Routing Records

```dns
# A records
forms.btctoons.com.    IN A     [CONTABO_VPS_IP]
mail.btctoons.com.     IN A     [CONTABO_VPS_IP]

# Bounce MX record (routes return-path bounces to Postal)
bounces.btctoons.com.  IN MX 10 mail.btctoons.com.
```

### 5.2 SPF (Sender Policy Framework)

Authorize only Postal sending IP to send on behalf of `notify.btctoons.com`:

```dns
notify.btctoons.com.   IN TXT   "v=spf1 ip4:[CONTABO_VPS_IP] -all"
```

### 5.3 DKIM (DomainKeys Identified Mail)

Generate a 2048-bit key in Postal Web Admin under **Mail Server Settings** -> **DKIM Keys**:

```dns
postal._domainkey.notify.btctoons.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
```

### 5.4 DMARC Record

Enforce alignment and reporting:

```dns
_dmarc.notify.btctoons.com. IN TXT "v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; pct=100; rua=mailto:dmarc-reports@btctoons.com"
```

---

## 6. Configuring Raxo Email to Use Postal

In your Raxo Email production environment (`.env.production`), connect to Postal via authenticated SMTP over TLS:

```ini
SMTP_HOST=mail.btctoons.com
SMTP_PORT=587
SMTP_TLS_MODE=starttls_required
SMTP_USERNAME=[POSTAL_CREDENTIAL_USERNAME]
SMTP_PASSWORD=[POSTAL_CREDENTIAL_PASSWORD]
SMTP_MAX_MESSAGE_BYTES=20971520
MESSAGE_ID_DOMAIN=notify.btctoons.com
OUTBOUND_ENABLED=true
```

---

## 7. Deliverability Verification & Sender Reputation Monitoring

Once the Contabo VPS port 25 is unblocked and Postal is live:

1. **Verify DKIM / SPF via Check-Auth**:
   - Send a test form submission to `check-auth@verifier.port25.com` or `mail-tester.com`.
   - Confirm score is 10/10 with SPF `pass`, DKIM `pass`, and DMARC `pass`.

2. **Gmail & Outlook Inbox Placement Test**:
   - Submit a test message to an external `@gmail.com` and `@outlook.com` mailbox.
   - Confirm receipt in **Primary Inbox**.
   - Inspect raw headers in Gmail ("Show original") to verify:
     - `SPF: PASS with IP [CONTABO_VPS_IP]`
     - `DKIM: PASS with domain notify.btctoons.com`
     - `DMARC: PASS`

3. **Reputation Dashboards**:
   - Register domain `notify.btctoons.com` with **Google Postmaster Tools**: `https://postmaster.google.com`
   - Register sending IP with **Microsoft SNDS (Smart Network Data Services)**: `https://sendersupport.olc.protection.outlook.com/snds/`
   - Check IP reputation on **Spamhaus Zen**: `https://check.spamhaus.org`
