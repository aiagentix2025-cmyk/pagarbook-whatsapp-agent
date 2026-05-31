# VPS Architecture & System Solution Design Document

This document serves as the **Single Source of Truth** for the production server infrastructure, databases, networking, and security configurations hosted on your VPS.

---

## 🖥️ System Overview

- **Host Public IP:** `76.13.250.173`
- **Host OS:** Ubuntu Linux
- **Management Layer:** Coolify v4 (Beta 463)
- **SSL Edge Proxy:** Traefik v3.6 (`coolify-proxy`)
- **Host Web Server:** Nginx (listening locally on port `8090` for `ai-agentix.com`)
- **Process Manager:** PM2 (running `ai-agentix-backend` on Node.js v20)

---

## 🌐 Network & Routing Architecture

All external traffic enters through Traefik (`coolify-proxy`), which handles Let's Encrypt SSL/TLS termination and routes traffic to internal Docker networks or host-level loopback interfaces.

```mermaid
graph TD
    User([External User]) -->|HTTPS: 443| Traefik[Traefik Edge Proxy: coolify-proxy]
    
    subgraph Docker Networks
        Traefik -->|Internal DNS| PagarbookBot[Pagarbook Bot Container:3000]
        Traefik -->|Internal DNS| KanbanCRM[Kanban CRM Container:5000]
        Traefik -->|Internal DNS| NocoDB[NocoDB Container:8080]
        Traefik -->|Internal DNS| PocketBase[PocketBase Container:8080]
        
        PagarbookBot -->|Internal DNS| PostgresDB[Postgres Container:5432]
        KanbanCRM -->|Internal DNS| PostgresDB
        NocoDB -->|Internal DNS| PostgresDB
    end

    subgraph Host Network
        Traefik -->|Bridge Gateway: 10.0.0.1:8090| HostNginx[Host Nginx:8090]
        HostNginx -->|Proxy Pass| PM2[PM2: ai-agentix-backend:3001]
        HostNginx -->|Serve Files| DistFolder[/var/www/ai-agentix/frontend/dist]
    end

    subgraph External Networks
        PM2 -->|Remote MySQL: 3306| Hostinger[Hostinger MySQL DB]
        NocoDB -->|Remote MySQL: 3306| Hostinger
    end
```

---

## 📦 Active Applications Registry

| Application Name | Service Type | Deployment Path / Container | Internal Port | External Domain / Route | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **coolify-proxy** | Traefik SSL Proxy | Docker: `coolify-proxy` | `80`, `443` | Direct edge routing | `Running` |
| **coolify** | Management Panel | Docker: `coolify` | `8000` | Port 8000 | `Running` |
| **nocodb** | No-Code DB Layer | Docker: `nocodb-swcsokowgkko8ogwcsw0c044` | `8080` | `nocodb-swcsokowgkko8ogwcsw0c044.76.13.250.173.sslip.io` | `Running` |
| **pocketbase** | No-Code Backend | Docker: `pocketbase-jkc4oswoc00sw84wkgcsgk0c` | `8080` | Managed under Coolify | `Running` |
| **pagarbook-bot** | WhatsApp Bot API | Docker: `pagarbook-bot-container` | `3000` | `pagarbook.aiagentixdev.com` | `Running` |
| **kanban-crm** | CRM Dashboard | Docker: `kanban-crm` | `5000` | `crm.aiagentixdev.com` (mapped host: 5010) | `Running` |
| **ai-agentix-frontend** | React Static Frontend | Host Nginx: `/var/www/ai-agentix/frontend/dist` | `8090` | `ai-agentix.com` & `www.ai-agentix.com` | `Running` |
| **ai-agentix-backend** | Node Express API | PM2: `/var/www/ai-agentix/backend/server.js` | `3001` | `ai-agentix.com/api/` | `Running` |

---

## 🗄️ Database Infrastructure

### 1. Central PostgreSQL Container
- **Container Name:** `w04cscwsccsc880sc488cscg`
- **Docker DNS Alias:** `w04cscwsccsc880sc488cscg` (resolves internally inside Docker `coolify` network)
- **Port:** `5432` (Exposed to host `0.0.0.0:5432`)
- **Superuser Username:** `postgres`
- **Superuser Password:** `AGENTiX@2025`
- **Active Databases & Mappings:**
  1. `client_pagarbook_vms_db`: Stores WhatsApp Bot data (templates, chat sessions, campaign logs, contacts). Connected to **`pagarbook-bot-container`** and **NocoDB**.
  2. `crm`: Stores Kanban CRM records (leads, pipelines, custom tags). Connected to **`kanban-crm`** and **NocoDB**.
  3. `postgres`: Central administration and system config database. Connected to **NocoDB**.

### 2. External Hostinger MySQL Database
- **Host:** `srv1988.hstgr.io`
- **Port:** `3306`
- **Username:** `u540387157_AI_Agentix`
- **Password:** `AGENTiX@2025`
- **Database Name:** `u540387157_AI_Agentix`
- **Active Tables (12):** `case_studies`, `awards`, `admins`, `clients`, `contacts`, `demo_bookings`, `resources`, `posts`, `subscribers`, `services`, `team_members`, `voice_agent_leads`
- **Connected Applications:**
  - **`ai-agentix-backend`** (running via PM2 on the VPS)
  - **NocoDB** (mapped as data source `ai_agentix_db`)

### 3. NocoDB Metadata Database (SQLite)
- **Path inside Container:** `/usr/app/data/noco.db`
- **Path on Host Volume:** `/var/lib/docker/volumes/swcsokowgkko8ogwcsw0c044_nocodb-data/_data/noco.db`
- **User Sign-In:** `aiagentix2025@gmail.com`
- **User Password:** `AGENTiX@2025`
- **MCP Token:** `sf5oZ18JwSiwfiQZlALL52a7tYDtGfP7`
- **Configured Data Sources:**
  - `pagarbook_bot` (Postgres `client_pagarbook_vms_db`)
  - `kanban_crm` (Postgres `crm`)
  - `central_postgres` (Postgres `postgres`)
  - `ai_agentix_db` (Hostinger MySQL `u540387157_AI_Agentix`)

### 4. PocketBase Database (SQLite)
- **Path on Host Volume:** `/data/coolify/services/jkc4oswoc00sw84wkgcsgk0c/pb_data`
- **Dashboard FQDN:** Configured inside Coolify UI.

---

## 🔒 Security & Firewall Configurations

The host firewall uses `UFW` (Uncomplicated Firewall) with a strict default `DROP` policy. Only required ports are allowed:

### 1. UFW Rules List
- **`22/tcp` (OpenSSH):** Allowed from anywhere (admin shell access).
- **`80/tcp`, `443/tcp`:** Allowed from anywhere (public web traffic to Traefik).
- **`5433/tcp`:** Allowed from anywhere (management access).
- **Docker Network Loopback Rules:**
  To allow the Traefik docker container (`10.0.1.11`) to forward requests to Nginx running on the host port `8090`, UFW explicitly permits TCP traffic from Docker subnets:
  ```bash
  ufw allow proto tcp from 10.0.0.0/8 to any port 8090
  ufw allow proto tcp from 172.16.0.0/12 to any port 8090
  ```

### 2. Nginx Host Configuration (`/etc/nginx/sites-available/ai-agentix`)
Nginx binds locally to port `8090` without SSL (as Traefik handles Let's Encrypt SSL at the edge). It matches requests to `ai-agentix.com` / `www.ai-agentix.com`:
- **Static Assets:** Serves React app files directly from `/var/www/ai-agentix/frontend/dist`.
- **API Proxying:** Proxies all requests to `/api/` to `http://localhost:3001/api/`.

### 3. Traefik Routing Configuration (`/data/coolify/proxy/dynamic/ai-agentix.yaml`)
Enforces HTTP-to-HTTPS redirection and proxies HTTPS traffic to Nginx on the host gateway IP `host.docker.internal` (`10.0.0.1`):
```yaml
http:
  routers:
    ai-agentix-http:
      rule: "Host(`ai-agentix.com`) || Host(`www.ai-agentix.com`)"
      service: ai-agentix
      entryPoints:
        - http
      middlewares:
        - ai-agentix-redirect-to-https
    ai-agentix-https:
      rule: "Host(`ai-agentix.com`) || Host(`www.ai-agentix.com`)"
      service: ai-agentix
      entryPoints:
        - https
      tls:
        certResolver: letsencrypt
  middlewares:
    ai-agentix-redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    ai-agentix:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:8090"
```

---

## 🧹 Deprecated & Collapsed Resources (Cleaned Assets)

To optimize disk storage and memory consumption, the following legacy assets were fully decommissioned:
1. **`nritrust` Application:** Crashing PM2 process stopped and deleted. Source files at `/var/www/nritrust` removed.
2. **`aisummitjaipur.aiagentixdev.com` Landing Page:** Files at `/var/www/aisummitjaipur.aiagentixdev.com` and its host Nginx symlinks removed.
3. **Legacy Databases:** Dropped PostgreSQL databases `agentix` and `indiagrain_whatsapp_crm` (releasing space in the Postgres container).
4. **Outdated Backups:** Removed all historical dumps (`.dump`, `.sql`, `.tar.gz`) from `/root/` to recover host storage.
5. **Leftover Directories:** Deleted `/root/upload-api` and `/root/minio-data`.

---

## 🛠️ Maintenance & Operations Playbook

### 1. Process Monitoring
To check on the state of the Node.js backend:
```bash
# View active processes and resource usages
pm2 list

# Watch logs in real time
pm2 logs ai-agentix-backend

# Restart backend process
pm2 restart ai-agentix-backend
```

### 2. Router Configurations (Adding new custom routing)
Traefik dynamic configuration files are located under `/data/coolify/proxy/dynamic/`. When adding or editing configurations (like `crm.yaml` or `ai-agentix.yaml`), Traefik will automatically hot-reload them. If a hard reload is required:
```bash
docker restart coolify-proxy
```

### 3. Nginx Operations
```bash
# Test configurations for syntax errors
nginx -t

# Reload configuration changes
systemctl reload nginx

# Restart service
systemctl restart nginx
```

### 4. Database Access (Manual PostgreSQL Connection)
```bash
# Enter the Postgres container command line
docker exec -it w04cscwsccsc880sc488cscg psql -U postgres -d postgres
```
