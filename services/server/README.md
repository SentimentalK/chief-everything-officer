# CEO Server (@sentimentalk/ceo-server)

A Git-backed MCP and state server for durable personal workspaces. It exposes MCP tools for safe state interaction, runtime policy queries, and audit trace persistence. Each authenticated request resolves a workspace from DB-backed credentials; the process no longer clones or serves a single deployment repository at startup. The audit web console is maintained separately in `web/`.

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

## Data layout

```
CEO_DATA_ROOT
├── identity/          # control-plane SQLite (users, workspaces, keys)
├── audit/             # workspace-scoped trace database
└── workspaces/
    └── <workspace_id>/
        ├── repo/
        ├── txns/
        └── state/
```

Git repositories are created per workspace under `workspaces/<workspace_id>/` when a request-scoped runtime is resolved. The server does not keep a process-global `repo/`, `txns/`, or `state/` directory.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `CEO_DATA_ROOT` | `/data` | Parent of `identity/`, `audit/`, and `workspaces/` |
| `CEO_GITHUB_APP_ENABLED` | **required `true` at startup** | GitHub App is a mandatory server capability |
| `CEO_GITHUB_APP_CLIENT_ID` | (required when enabled) | GitHub App client id |
| `CEO_GITHUB_APP_CLIENT_SECRET` | (required when enabled) | GitHub App client secret |
| `CEO_GITHUB_APP_SLUG` | (required when enabled) | GitHub App slug |
| `CEO_GITHUB_APP_PRIVATE_KEY_PATH` | (required when enabled) | PEM private key path; file must exist. Constructor parses the key; GitHub network calls happen later on workspace git operations |
| `CEO_GITHUB_APP_CALLBACK_URL` | derived | Optional App callback URL |
| `CEO_GIT_AUTHOR_NAME` | `CEO_GIT_COMMITTER_NAME` | Author name (credited as author of user-directed canonical changes) |
| `CEO_GIT_AUTHOR_EMAIL` | `CEO_GIT_COMMITTER_EMAIL` | Author email |
| `CEO_GIT_COMMITTER_NAME` | `CEO State MCP` | Runtime identity committing on behalf of the user |
| `CEO_GIT_COMMITTER_EMAIL` | `ceo-mcp@users.noreply.github.com` | Service identity email |
| `BIND_HOST` | `127.0.0.1` | HTTP bind host; use `0.0.0.0` for K3s Ingress |
| `PORT` | `3000` | HTTP port |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted by the Host guard |
| `ALLOWED_ORIGINS` | (empty) | Comma-separated Origins for CEO product/API Origin guard; absent Origin is always allowed |
| `CEO_PROTOCOL_ALLOWED_ORIGINS` | (empty) | Comma-separated Origins allowed as browser MCP/OAuth protocol clients; independent of `ALLOWED_ORIGINS` |
| `CEO_BRIDGE_ENABLED` | `false` | Enable Worker job bridge (Redis) |
| `CEO_REDIS_URL` | unset | Redis URL when the bridge is enabled. Redis is not a `/readyz` blocker |
| `CEO_OAUTH_ENABLED` | `false` | Enable OAuth 2.1; requires `CEO_PUBLIC_ORIGIN` (https origin) |

`CEO_REMOTE`, `CEO_BRANCH`, `CEO_SSH_KEY_PATH`, and `MCP_API_KEY` are not server configuration. Authentication is DB-backed; workspace git uses GitHub App installation credentials.

## Authentication

Requests authenticate against the stored identity, not against a process env token.

1. Bearer token → credential (`api_key_id`, `user_id`) via digest lookup. Unknown, revoked, or disabled-user keys return `401`.
2. Credential → membership. Exactly one accessible workspace is selected as the request workspace. Zero memberships or more than one membership return `403`.
3. Success stores `AuthIdentity` (`user_id`, `workspace_id`, `api_key_id`) in `res.locals.identity`. Identity is never taken from request bodies, query strings, `X-User-ID`, or a global current user.

Identity database unavailable on a live request → `503`. `/healthz` and `/readyz` are unauthenticated.

`GET /api/identity` (Bearer-authenticated) returns who this key connects to:

`{ user_id, workspace_id, deployment_mode: "request_scoped_workspace" }`.

The audit console keeps its login endpoint and session cookie but binds sessions to the same identity. Every Audit request re-verifies that the API key still exists and is not revoked, and that the user still has membership in the session workspace.

Audit traces are stored with `workspace_id NOT NULL` and queried only for the authenticated request workspace. An old Audit SQLite that lacks `workspace_id` is **fail-incompatible, not migrated**. The audit database is disposable: delete the local file and allow a fresh workspace-scoped schema.

### Persistent identity database

CEO keeps a durable control-plane identity in `<CEO_DATA_ROOT>/identity/identity.sqlite` (directory `0700`, file `0600`). The schema supports multiple users, workspaces, memberships, and API keys.

This database is **created only by** `node dist/identity/cli.js init`; the service never creates one silently. On missing/corrupt/structurally-mismatched identity the server fails to start and instructs to initialize.

`init` provisions an empty control-plane database: **0 users, 0 workspaces, 0 API keys**. It does not seed a deployment key or a repository binding. Re-running `init` is idempotent and will not overwrite an existing valid database.

The server boots with that empty (or later populated) database and a constructable GitHub App client. It does not clone git at startup. Workspaces appear after product onboarding (GitHub App install → workspace provisioning).

### Readiness

`GET /readyz` checks local control-plane dependencies only:

- `IdentityStore.ping()` (`SELECT 1`)
- GitHub App client constructed (RSA key parsed)

It does not run git commands, does not call GitHub, and does not require Redis.

### First-deploy runbook

1. Land code + tests and publish the container image.
2. Configure GitHub App env (`CEO_GITHUB_APP_ENABLED=true` plus client id/secret/slug/private key path) and `CEO_DATA_ROOT`.
3. Initialize the empty control plane:
   ```bash
   node dist/identity/cli.js init
   ```
   Output reports `deployment_mode: multi_workspace_runtime` and the database path. It does not print `user_id`/`workspace_id`.
4. Start the server. `/readyz` should be `READY` with zero users.
5. Complete GitHub App install and workspace provisioning so a user, membership, and API key exist. Then verify MCP, Audit, and `GET /api/identity`.

If an existing dogfood volume still has a pre-workspace-scoped Audit SQLite, delete `audit/` and let the server create a fresh file. Do not treat that fail-fast as a server regression.

Backups must include `identity/`; it is not a throwaway/log cache. Audit traces may be discarded.

## Transaction and recovery model

`apply_change_set` requires the base commit and expected blob OIDs returned by a read. It holds a single-writer lock, fetches the workspace remote, creates a detached temporary worktree, validates the actual diff, commits, fetches again, and performs a normal push. A stable `request_id` makes retries idempotent.

If a commit exists but push cannot be verified, `state/pending.json` and its worktree survive Pod restarts. The server retries only when the remote is still at the original base. It finalizes if the remote already contains the commit, and blocks for operator repair if history diverged. It never merges, rebases, resets remote history, or force-pushes.

## K3s Deployment

Standard Traefik Ingress → ClusterIP Service → Pod deployment on the `mtl0` ARM64 node. The Ingress routes only `/mcp` to the backend; `/healthz` and `/readyz` are not exposed to the public internet. TLS is handled by cert-manager with `letsencrypt-prod`. Authentication is enforced in the Express application layer, not in Traefik middleware.
