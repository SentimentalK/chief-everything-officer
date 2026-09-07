# CEO Service & Web Deployment Architecture

This document describes the unified domain routing, standalone services, and rollout procedure for `chief-everything-officer`.

---

## 1. Unified Domain Routing Architecture

Both the CEO backend service (`server`) and the audit web console (`web`) operate under a single domain (e.g. `ceo.sentimentalk.com`) via reverse proxy / Ingress routing without path rewrites:

| Path Prefix | Target Service | Container Port | Purpose |
|---|---|---|---|
| `/audit`, `/audit/*` | `ceo-web` (Frontend) | `8080` (HTTP) | Static audit web console, Vite SPA routing, assets |
| `/api/*` | `ceo-server` (Backend) | `3000` (HTTP) | Audit session authentication & SQLite trace query APIs |
| `/mcp` | `ceo-server` (Backend) | `3000` (HTTP) | Streamable HTTP MCP server (AI tool invocations) |

### Header Forwarding Requirements

The Ingress / reverse proxy must forward incoming requests without stripping:
- `Cookie` (required for `ceo_audit_session` cookie authentication)
- `Authorization` (required for Bearer `MCP_API_KEY`)
- `Host` / `X-Forwarded-Host` (validated by server host guards)
- `Origin` / `X-Forwarded-Proto` (validated by server origin guards and secure cookie flags)
- `Accept: text/event-stream` / `Transfer-Encoding: chunked` (MCP Streamable HTTP protocol)

---

## 2. Independent Component Specifications

### Backend Service (`ceo-server`)
- **Image**: `ghcr.io/sentimentalk/ceo-server:latest`
- **Port**: `3000`
- **Replicas**: Strictly `1` (single-writer Git lock and embedded SQLite trace store)
- **Health Probes**:
  - Liveness: `/healthz` (HTTP 200)
  - Readiness: `/readyz` (HTTP 200 when Git repository and readiness is `READY`)
- **Volumes**:
  - Git data directory: `/data` (persistent volume storing `repo/`, `txns/`, `audit/`, `state/`)
  - SSH deploy key: `/secrets/id_ed25519`
- **Environment**:
  - `CEO_DATA_ROOT=/data`
  - `BIND_HOST=0.0.0.0`
  - `PORT=3000`
  - `MCP_API_KEY` (secret)

### Frontend Service (`ceo-web`)
- **Image**: `ghcr.io/sentimentalk/ceo-web:latest`
- **Port**: `8080` (non-root `nginxinc/nginx-unprivileged:alpine`)
- **Replicas**: `1` or more (completely stateless)
- **Health Probes**:
  - Liveness / Readiness: `/healthz` (HTTP 200 static JSON `{"ok":true}`)
- **Volumes**: None (pure static assets; does not mount Git repo, SQLite, or secrets)
- **Routing Behavior**:
  - `/audit` redirects to `/audit/` (relative redirect, does not leak internal port `8080`)
  - `/audit/` serves `index.html`
  - `/audit/traces/*` SPA client routes fall back to `/audit/index.html`
  - `/audit/assets/*` missing static assets return HTTP 404 (never HTML)
  - `/api/*` returns HTTP 404 (handled by Ingress to backend, not web container)

---

## 3. Production Rollout & Rollback in K3s Homelab

Actual K3s configuration is managed GitOps-style in `k3s-homelab` (under `apps/ceo-state-mcp` or `apps/ceo/`).

### Deployment Steps
1. **Push & Build**: Push changes on `main` to trigger GitHub Actions image builds:
   - `ghcr.io/sentimentalk/ceo-server:latest`
   - `ghcr.io/sentimentalk/ceo-web:latest`
2. **Deploy Frontend Service & Ingress**:
   - Create `ceo-web` Deployment (1 replica, port 8080) and ClusterIP Service.
   - Update Traefik Ingress routes to split `/audit` traffic to `ceo-web` and `/api/*` / `/mcp` traffic to `ceo-server`.
3. **Switch Backend Deployment**:
   - Update backend image to `ghcr.io/sentimentalk/ceo-server:latest` with `imagePullPolicy: Always`.
   - Backend restarts, verifies readiness, and serves MCP and API requests.
4. **Verification**:
   - Open `/audit/` in browser, log in with `MCP_API_KEY`.
   - Inspect trace list and trace details.
   - Run an MCP tool call against `/mcp`.

### Rollback Strategy
If any issues occur, rollback does not require data migration:
- Point Traefik Ingress `/audit` routes back to backend Service.
- Revert backend image back to `ghcr.io/sentimentalk/ceo-state-mcp:latest`.
- The underlying Git repository and SQLite database remain intact.
