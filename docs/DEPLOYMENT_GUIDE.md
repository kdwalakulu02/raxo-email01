# Raxo Email — Production Deployment Guide

## 1. Target Infrastructure Overview

| Component            | Target Specification                       |
| :------------------- | :----------------------------------------- |
| **Hosting Provider** | Contabo Cloud VPS                          |
| **Operating System** | Ubuntu 22.04 LTS or 24.04 LTS x86_64       |
| **Domain**           | `btctoons.com`                             |
| **Subdomain**        | `forms.btctoons.com` (Web Gateway & API)   |
| **Orchestration**    | Docker Compose v2                          |
| **Reverse Proxy**    | Caddy v2 (Automated Let's Encrypt TLS)     |
| **Database**         | PostgreSQL 16 (Isolated container network) |
| **Antivirus**        | ClamAV Daemon (Isolated container network) |

---

## 2. Server Provisioning & Hardening

### 2.1 OS Packages and Docker Installation

Connect via SSH to your Contabo Ubuntu VPS:

```bash
# Update base system
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw fail2ban jq

# Install official Docker Engine & Docker Compose plugin
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### 2.2 UFW Firewall Configuration

Strictly lock down the VPS network perimeter. **Never expose PostgreSQL, ClamAV, or internal ports.**

```bash
# Allow SSH, HTTP, and HTTPS
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP (Let\'s Encrypt ACME)'
sudo ufw allow 443/tcp comment 'HTTPS'
sudo ufw enable
```

---

## 3. Restricted Deployment Authentication (No Personal Tokens)

To deploy securely from GitHub without exposing personal developer tokens on the VPS, use a **Dedicated Read-Only Deploy Key**:

### 3.1 Generate Deploy Key on VPS

```bash
ssh-keygen -t ed25519 -C "deploy@forms.btctoons.com" -f ~/.ssh/raxo_deploy_key -N ""
```

### 3.2 Add Deploy Key to GitHub Private Repository

1. Copy the public key:
   ```bash
   cat ~/.ssh/raxo_deploy_key.pub
   ```
2. Navigate to your private GitHub repository:  
   `https://github.com/kdwalakulu02/raxo-email01/settings/keys`
3. Click **Add deploy key**:
   - Title: `Contabo VPS (Read-Only)`
   - Key: Paste the copied `.pub` key
   - **Do NOT check** "Allow write access" (keep it read-only).
4. Configure SSH on the VPS (`~/.ssh/config`):
   ```ssh
   Host github.com
     IdentityFile ~/.ssh/raxo_deploy_key
     IdentitiesOnly yes
   ```

### 3.3 Clone the Repository

```bash
mkdir -p /opt/raxo && cd /opt/raxo
git clone git@github.com:kdwalakulu02/raxo-email01.git .
```

---

## 4. Production Configuration

### 4.1 Create Production Environment File

```bash
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Generate secure secrets:

```bash
# Generate IP_HASH_SECRET
openssl rand -hex 32

# Generate POSTGRES_PASSWORD
openssl rand -hex 32
```

Update `.env.production` with these generated values.

### 4.2 Verify DNS A Record

Ensure `forms.btctoons.com` resolves to your Contabo VPS public IPv4 address:

```bash
dig +short forms.btctoons.com
```

---

## 5. Launch Stack & Database Migrations

Start all containers in detached mode:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The `api` container automatically executes pending migrations (`node dist/src/migrate.js`) before starting the web server.

### 5.1 Verification Commands

```bash
# 1. Check all container statuses
docker compose -f docker-compose.prod.yml ps

# 2. Inspect migration and server logs
docker compose -f docker-compose.prod.yml logs api

# 3. Check worker advisory lock and heartbeat
docker compose -f docker-compose.prod.yml logs worker

# 4. Verify local readiness probe
docker compose -f docker-compose.prod.yml exec api curl -i http://127.0.0.1:3000/health/ready

# 5. Verify public HTTPS response
curl -i https://forms.btctoons.com
```

---

## 6. Updates & Rollback Procedure

### 6.1 Deploying an Update

```bash
cd /opt/raxo

# 1. Pull latest verified commits
git pull origin main

# 2. Rebuild images and restart containers
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

# 3. Check readiness
docker compose -f docker-compose.prod.yml exec api curl -f http://127.0.0.1:3000/health/ready
```

### 6.2 Rollback Procedure

If an update fails:

```bash
# 1. Check Git history and roll back to the previous stable commit SHA
git log --oneline -n 5
git checkout <PREVIOUS_STABLE_COMMIT_SHA>

# 2. Rebuild and restart
docker compose -f docker-compose.prod.yml up -d --build

# 3. If database restoration is required, follow docs/BACKUP_AND_RESTORE.md
```
