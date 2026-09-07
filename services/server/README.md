# CEO Server (@sentimentalk/ceo-server)

A narrow, Git-backed MCP and state server for the user's durable personal state workspace. It exposes MCP tools for safe state interaction, runtime policy queries, and audit trace persistence. The audit web console is maintained separately in `web/`.

## Tools

- `workspace_status`: synchronize and report local/remote state.
- `list_files`: hierarchical / bounded discovery of allowed CEO Markdown files and directories.
- `read_files`: batch-read up to 20 files with a base commit.
- `search_text`: literal search inside allowlisted Markdown.
- `apply_change_set`: validate, commit, fast-forward push, and verify one logical update (`create`, `replace`, `append`, `delete`, `move`).
- `policy_read`: read runtime product policy documents (e.g. `tasks`, `personal`, `journal`).

Writable content is open to all Markdown (`.md`) files in the workspace outside runtime security invariants (hidden paths `.*`, symlinks, non-Markdown files) and workspace access boundaries defined in `.ceoignore`. `apply_change_set` provides five generic atomic operations: `create`, `replace`, `append`, `delete`, and `move`. Domain conventions like task archiving or journal appending are governed by workspace rules (`rules/<area>.md`) or runtime default policies (`policy/<area>.md`), not hardcoded into the filesystem engine.

### Host Tool Schema Caching

Some hosts may expose stale MCP tool-discovery metadata even after the server runtime has been updated, and opening a new conversation does not necessarily force schema rediscovery. Use runtime version/build identity (reported in `workspace_status`, `/healthz`, and `/readyz`) and observed server behavior to distinguish host-side discovery metadata from the deployed server.

## Development

Requires Node.js 22+ and Git.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `CEO_DATA_ROOT` | `/data` | Parent of `repo/`, `txns/`, `state/`, `audit/`, and `identity/` |
| `CEO_REMOTE` | **(required)** | Fixed Git origin URL (startup fails if missing) |
| `CEO_BRANCH` | `main` | Fixed writable branch |
| `CEO_SSH_KEY_PATH` | unset | Read/write deploy key path |
| `CEO_GIT_AUTHOR_NAME` | `CEO_GIT_COMMITTER_NAME` | Author name (credited as author of user-directed canonical changes) |
| `CEO_GIT_AUTHOR_EMAIL` | `CEO_GIT_COMMITTER_EMAIL` | Author email (associated with user GitHub account for contribution credit) |
| `CEO_GIT_COMMITTER_NAME` | `CEO State MCP` | Runtime identity committing on behalf of the user |
| `CEO_GIT_COMMITTER_EMAIL` | `ceo-mcp@users.noreply.github.com` | Service identity email |
| `BIND_HOST` | `127.0.0.1` | HTTP bind host; use `0.0.0.0` for K3s Ingress |
| `PORT` | `3000` | MCP HTTP port |
| `MCP_API_KEY` | **(required, all binds)** | Static Bearer token; leading/trailing whitespace is rejected |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted by the Host guard |
| `ALLOWED_ORIGINS` | (empty) | Comma-separated Origins accepted by the Origin guard; absent Origin is always allowed |

## Authentication

Requests authenticate against the stored identity, not against a raw env value.

- `Authorization: Bearer <MCP_API_KEY>` is verified by digest against the active
  stored key; the owning user and workspace must be enabled and bound to the
  deployment's `CEO_REMOTE`/`CEO_BRANCH`.
- Success stores the resolved `AuthIdentity` in `res.locals.identity` per
  request. Identity is never taken from request bodies, query strings,
  `X-User-ID`, or a global current user.
- Status: missing / wrong / revoked key, or disabled user → `401`;
  authenticated but bound to a different workspace → `403`; identity database
  unavailable on a live request → `503`.
- `/healthz` and `/readyz` are unauthenticated and structurally outside the
  protected middleware scope.

`GET /api/identity` (Bearer-authenticated) returns who this key connects to:
`{ user_id, workspace_id, deployment_mode: "single_user" }`.

The audit console keeps its login endpoint and session cookie but binds
sessions to the same identity. Audit queries accept either a valid Bearer key
or the bound session cookie, both identity-checked.

### Persistent single-user identity

CEO keeps a durable identity in a dedicated SQLite database at
`<CEO_DATA_ROOT>/identity/identity.sqlite` (directory `0700`, file `0600`)
holding exactly one `users`, one `workspaces`, and one active `api_keys` row.
The original `MCP_API_KEY` is injected via Kubernetes/Infisical Secret; only
its SHA-256 digest is stored.

This database is **created only by** `node dist/identity/cli.js init`; the
service never creates one silently. On missing/corrupt/structurally-mismatched
identity the server fails to start and instructs to initialize.

### First-deploy / upgrade runbook

1. Land code + tests and publish the container image.
2. Stop the old server, keeping the existing `/data` volume and Secrets.
3. With the new image on the same volume + environment variables, run the
   one-time initializer:
   ```bash
   node dist/identity/cli.js init
   ```
   It reads `MCP_API_KEY`/`CEO_REMOTE`/`CEO_BRANCH`/`CEO_DATA_ROOT` and prints
   only `user_id`/`workspace_id` (never the key/digest).
4. Start the new server only after a successful `init`.
5. With the existing key, verify MCP, Audit, and `GET /api/identity`, then
   restart to confirm `user_id`/`workspace_id` stay unchanged.

Backups must include `identity/`; it is not a throwaway/log cache and must not
be cleaned up alongside trace logs. `init` is idempotent: re-running returns the
existing ids, refuses to rebind to a different repository/branch, and will not
revive a disabled user or a revoked key.

## Transaction and recovery model

`apply_change_set` requires the base commit and expected blob OIDs returned by a read. It holds a single-writer lock, fetches `origin/main`, creates a detached temporary worktree, validates the actual diff, commits, fetches again, and performs a normal push. A stable `request_id` makes retries idempotent.

If a commit exists but push cannot be verified, `state/pending.json` and its worktree survive Pod restarts. The server retries only when the remote is still at the original base. It finalizes if the remote already contains the commit, and blocks for operator repair if history diverged. It never merges, rebases, resets remote history, or force-pushes.

## K3s Deployment

Standard Traefik Ingress → ClusterIP Service → Pod deployment on the `mtl0` ARM64 node. The Ingress routes only `/mcp` to the backend; `/healthz` and `/readyz` are not exposed to the public internet. TLS is handled by cert-manager with `letsencrypt-prod`. Authentication is enforced in the Express application layer, not in Traefik middleware.
