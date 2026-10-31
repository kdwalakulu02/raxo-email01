# Running Raxo Email on a Contabo VPS

This document provides a comprehensive, step-by-step operational guide for running **Raxo Email Forms Core** in production on a **Contabo Cloud VPS** under the **`btctoons.com`** domain.

---

## 1. Production Architecture Overview

The production stack runs on a single Contabo VPS using Docker Compose with strict network isolation. Only ports 80 and 443 are exposed to the public Internet through Caddy.

```
                  [ Public Internet ]
                           │
                 HTTPS:443 │ HTTP:80
                           ▼
                  ┌─────────────────┐
                  │   Caddy v2      │ (TLS termination, Let's Encrypt,
                  │  Reverse Proxy  │  forms.btctoons.com)
                  └────────┬────────┘
                           │ internal network: raxo_internal
         ┌─────────────────┼──────────────────┐
         │                 │                  │
         ▼                 ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │   Raxo API   │  │ Raxo Worker  │  │  PostgreSQL  │
  │ (Fastify:3000│  │ (Advisory    │  │   v16 DB     │
  │  Gateway)    │  │  Queue/SMTP) │  │ (Port 5432)   │
  └──────┬───────┘  └──────┬───────┘  └──────────────┘
         │                 │
         ▼                 ▼
  ┌──────────────┐  ┌──────────────┐
  │   ClamAV     │  │ Postal SMTP  │
  │ Antivirus    │  │ (mail.btc-   │
  │ (Port 3310)  │  │  toons.com)  │
  └──────────────┘  └──────────────┘
```

| Service         | Container Name  | Internal Port | Internet Exposed  | Role                                                |
| :-------------- | :-------------- | :------------ | :---------------- | :-------------------------------------------------- |
| **Caddy**       | `raxo_caddy`    | 80, 443       | **Yes (80, 443)** | Public TLS reverse proxy for `forms.btctoons.com`   |
| **API Gateway** | `raxo_api`      | 3000          | **No**            | Form intake, rate limiting, and spam filtering      |
| **Worker**      | `raxo_worker`   | —             | **No**            | Advisory-locked queue claim and SMTP submission     |
| **PostgreSQL**  | `raxo_postgres` | 5432          | **No**            | Transactional queue and submission metadata storage |
| **ClamAV**      | `raxo_clamav`   | 3310          | **No**            | Antivirus scanning for uploaded PDF attachments     |

---

## 2. Prerequisites & Server Setup

### 2.1 VPS Specifications

- **Provider**: Contabo Cloud VPS (Cloud VPS 1 or higher)
- **OS**: Ubuntu 22.04 LTS or Ubuntu 24.04 LTS (x86_64)
- **Static Public IPv4**: Assigned by Contabo

### 2.2 Install Base Packages & Docker Engine

Connect to your VPS via SSH as `root` or an administrative user with `sudo`:

```bash
# Update base system packages
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw fail2ban jq openssl

# Install official Docker Engine and Docker Compose v2 plugin
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Log out and log back in or apply group changes
newgrp docker
```

Verify Docker installation:

```bash
docker --version
docker compose version
```

### 2.3 Configure Host Firewall (UFW)

Strictly restrict incoming network traffic. Only SSH, HTTP, and HTTPS must accept connections from the outside:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP (Let Encrypt ACME)'
sudo ufw allow 443/tcp comment 'HTTPS (Web Forms Gateway)'
sudo ufw --force enable
sudo ufw status verbose
```

---

## 3. Contabo Mail & DNS Prerequisites

### 3.1 Unblock Outbound Port 25 on Contabo

Contabo VPS instances block outbound TCP port 25 by default to prevent abuse. Submit a support ticket in the [Contabo Customer Control Panel (CCP)](https://my.contabo.com) before launching outbound mail:

```text
Subject: Request to unblock outbound port 25 for transactional email server

Hello Contabo Support Team,

I have provisioned VPS [YOUR_VPS_ID / IP] to run our self-hosted transactional email infrastructure (Postal SMTP) for our service domain btctoons.com.

Please remove the outbound port 25 restriction on this VPS.
I confirm that:
1. We enforce strict double-opt-in / email verification for all form endpoints.
2. We have configured Forward-Confirmed Reverse DNS (FCrDNS), SPF, DKIM, and DMARC.
3. We maintain automated bounce suppression and do not send bulk marketing.

Thank you.
```

### 3.2 Configure Reverse DNS (PTR Record)

In Contabo CCP under **VPS Control** -> **Manage** -> **Reverse DNS**:

- Set the PTR target for your VPS IPv4 to: `mail.btctoons.com`
- Verify locally:
  ```bash
  dig +short -x [YOUR_CONTABO_VPS_IP]
  # Expected output: mail.btctoons.com.
  ```

### 3.3 Configure Authoritative DNS Zone for `btctoons.com`

Publish the following records in your DNS provider (Cloudflare, Namecheap, etc.):

```dns
# Web Gateway and SMTP endpoints
forms.btctoons.com.    IN A     [CONTABO_VPS_IP]
mail.btctoons.com.     IN A     [CONTABO_VPS_IP]

# Inbound bounce MX route
bounces.btctoons.com.  IN MX 10 mail.btctoons.com.

# SPF Authorization
notify.btctoons.com.   IN TXT   "v=spf1 ip4:[CONTABO_VPS_IP] -all"

# DKIM Key (generated inside Postal web console)
postal._domainkey.notify.btctoons.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."

# DMARC Policy
_dmarc.notify.btctoons.com. IN TXT "v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; pct=100; rua=mailto:dmarc-reports@btctoons.com"
```

---

## 4. Deploying the Repository to the VPS

### 4.1 Clone Repository

Create the application directory at `/opt/raxo`:

```bash
sudo mkdir -p /opt/raxo
sudo chown $USER:$USER /opt/raxo
cd /opt/raxo

# Clone via HTTPS with token or SSH deploy key
git clone https://github.com/kdwalakulu02/raxo-email01.git .
```

### 4.2 Configure Production Environment File (`.env.production`)

Create the runtime environment configuration:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Generate two cryptographically strong random secrets:

```bash
# Secret for hashing IP addresses in rate limit buckets
openssl rand -hex 32

# Secret for PostgreSQL database password
openssl rand -hex 32
```

Edit `.env.production` (`nano .env.production`) and set:

1. `IP_HASH_SECRET` to the generated 64-character hex string.
2. `POSTGRES_PASSWORD` to the generated 64-character database password.
3. Update `DATABASE_URL` with that same password:
   ```ini
   DATABASE_URL=postgresql://raxo_user:YOUR_GENERATED_PASSWORD@postgres:5432/raxo_production
   ```
4. Set your Postal SMTP credentials:
   ```ini
   SMTP_HOST=mail.btctoons.com
   SMTP_PORT=587
   SMTP_TLS_MODE=starttls_required
   SMTP_USERNAME=YOUR_POSTAL_SMTP_USER
   SMTP_PASSWORD=YOUR_POSTAL_SMTP_PASSWORD
   MESSAGE_ID_DOMAIN=notify.btctoons.com
   OUTBOUND_ENABLED=true
   ```

### 4.3 Configure Form Definitions (`config/forms.json`)

If you are using static forms alongside dynamic forms:

```bash
mkdir -p config
cp config/forms.example.json config/forms.json
chmod 600 config/forms.json
```

Customize form recipient addresses, origins, and file upload limits as needed.

---

## 5. Starting the Stack

Build the container images and launch the services in background mode:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Automatic Migration Execution

The `api` container runs database migrations automatically (`node dist/src/migrate.js`) before starting the Fastify web server. It creates all tables, schemas, and security hardening triggers idempotently.

---

## 6. Verification & Health Monitoring

Run these verification commands on the VPS:

### 6.1 Check Container Status

```bash
docker compose -f docker-compose.prod.yml ps
```

All five containers (`raxo_caddy`, `raxo_api`, `raxo_worker`, `raxo_postgres`, `raxo_clamav`) should display state `running` or `healthy`.

### 6.2 Inspect Service Logs

```bash
# Check API startup and migration log
docker compose -f docker-compose.prod.yml logs --tail=50 api

# Check worker queue loop and advisory lock acquisition
docker compose -f docker-compose.prod.yml logs --tail=50 worker

# Check Caddy TLS certificate issuance
docker compose -f docker-compose.prod.yml logs --tail=50 caddy
```

### 6.3 Check Internal Readiness & Liveness

```bash
# Internal health check from inside the network
docker compose -f docker-compose.prod.yml exec api curl -s -i http://127.0.0.1:3000/health/live
docker compose -f docker-compose.prod.yml exec api curl -s -i http://127.0.0.1:3000/health/ready
```

Both endpoints should return `HTTP/1.1 200 OK` with JSON `{"status":"ok"}`.

### 6.4 Test Public HTTPS Endpoint

From your local workstation or the VPS:

```bash
curl -i https://forms.btctoons.com/
```

Should return `HTTP/2 200` with the public Raxo Email welcome view.

---

## 7. Operator CLI Commands

To execute administrative tasks without installing Node.js or pnpm on the host VPS, run the CLI inside the running `api` container:

```bash
# Alias for convenience
alias raxo-cli="docker compose -f /opt/raxo/docker-compose.prod.yml exec api node dist/src/cli.js"

# List recent submissions
raxo-cli list

# View details of a specific submission
raxo-cli show <SUBMISSION_ID>

# Export submission data and attachments to an isolated host directory
raxo-cli export <SUBMISSION_ID> /app/storage/export-test
```

---

## 8. Updates, Backups, and Maintenance

### 8.1 Deploying Code Updates

To deploy updates from the main branch without downtime:

```bash
cd /opt/raxo

# Pull latest commits
git pull origin main

# Rebuild containers and apply changes cleanly
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

# Verify stack health
docker compose -f docker-compose.prod.yml exec api curl -f http://127.0.0.1:3000/health/ready
```

### 8.2 Automated Backups

Set up automated daily backups following [docs/BACKUP_AND_RESTORE.md](file:///workspace/projects/008-raxocode/06-raxo-email/docs/BACKUP_AND_RESTORE.md).

Install the backup script into `/usr/local/bin/raxo-backup.sh` and register it in `crontab`:

```cron
30 2 * * * /usr/local/bin/raxo-backup.sh >> /var/log/raxo-backup.log 2>&1
```

### 8.3 Emergency Rollback

If an update encounters issues:

```bash
cd /opt/raxo
git log --oneline -n 5
git checkout <PREVIOUS_COMMIT_SHA>
docker compose -f docker-compose.prod.yml up -d --build
```
