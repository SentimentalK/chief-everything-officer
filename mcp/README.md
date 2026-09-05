# CEO State MCP

A narrow, Git-backed MCP server for the user's durable personal state workspace. It exposes four read tools, one runtime policy read tool, and one atomic write transaction (`apply_change_set`); it does not expose a shell, arbitrary non-Markdown filesystem access, raw Git commands, branch switching, history rewrites, rebases, or force pushes.

## Tools

- `workspace_status`: synchronize and report local/remote state.
- `list_files`: hierarchical / bounded discovery of allowed CEO Markdown files and directories.
- `read_files`: batch-read up to 20 files with a base commit.
- `search_text`: literal search inside allowlisted Markdown.
- `apply_change_set`: validate, commit, fast-forward push, and verify one logical update (`create`, `replace`, `append`, `delete`, `move`).
- `policy_read`: read runtime product policy documents (e.g. `tasks`, `personal`, `journal`).

Writable content is open to all Markdown (`.md`) files in the workspace outside runtime security invariants (hidden paths `.*`, symlinks, non-Markdown files) and workspace access boundaries defined in `.ceoignore`. `apply_change_set` provides five generic atomic operations: `create`, `replace`, `append`, `delete`, and `move`. Domain conventions like task archiving or journal appending are governed by workspace rules (`rules/<area>.md`) or runtime default policies (`policy/<area>.md`), not hardcoded into the filesystem engine.

## Development

Requires Node.js 22+ and Git.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `CEO_DATA_ROOT` | `/data` | Parent of `repo/`, `txns/`, `state/`, and `audit/` |
| `CEO_REMOTE` | **(required)** | Fixed Git origin URL (startup fails if missing) |
| `CEO_BRANCH` | `main` | Fixed writable branch |
| `CEO_SSH_KEY_PATH` | unset | Read/write deploy key path |
| `CEO_KNOWN_HOSTS_PATH` | unset | Pinned SSH known-hosts file |
| `CEO_GIT_AUTHOR_NAME` | `CEO State MCP` | Commit author name |
| `CEO_GIT_AUTHOR_EMAIL` | noreply address | Commit author email |
| `CEO_AUDIT_DB_PATH` | `/data/audit/ceo-trace.sqlite` | SQLite trace database path |
| `BIND_HOST` | `127.0.0.1` | HTTP bind host; use `0.0.0.0` for K3s Ingress |
| `PORT` | `3000` | MCP HTTP port |
| `MCP_API_KEY` | unset | Static Bearer token; **required** when binding to a non-loopback address |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted by the Host guard |
| `ALLOWED_ORIGINS` | (empty) | Comma-separated Origins accepted by the Origin guard; absent Origin is always allowed |

## Authentication

CEO uses a deliberately simple static Bearer credential gate rather than implementing MCP OAuth authorization. The server validates:

```
Authorization: Bearer <MCP_API_KEY>
```

- Requests to `/mcp` without a valid Bearer token receive 401 Unauthorized.
- `/healthz` and `/readyz` are unauthenticated — they are structurally outside the `/mcp` middleware scope.
- Token comparison uses `crypto.timingSafeEqual`. Tokens are never logged.

Additionally, the server enforces:
- **Host validation**: `req.hostname` must be in `ALLOWED_HOSTS`, otherwise 421 Misdirected Request.
- **Origin validation**: per MCP Streamable HTTP spec, if an `Origin` header is present and not in `ALLOWED_ORIGINS`, the server returns 403 Forbidden. Absent `Origin` is allowed (server-to-server clients typically do not send it).

## Transaction and recovery model

`apply_change_set` requires the base commit and expected blob OIDs returned by a read. It holds a single-writer lock, fetches `origin/main`, creates a detached temporary worktree, validates the actual diff, commits, fetches again, and performs a normal push. A stable `request_id` makes retries idempotent.

If a commit exists but push cannot be verified, `state/pending.json` and its worktree survive Pod restarts. The server retries only when the remote is still at the original base. It finalizes if the remote already contains the commit, and blocks for operator repair if history diverged. It never merges, rebases, resets remote history, or force-pushes.

## K3s Deployment

Standard Traefik Ingress → ClusterIP Service → Pod deployment on the `mtl0` ARM64 node. The Ingress routes only `/mcp` to the backend; `/healthz` and `/readyz` are not exposed to the public internet. TLS is handled by cert-manager with `letsencrypt-prod`. Authentication is enforced in the Express application layer, not in Traefik middleware.
