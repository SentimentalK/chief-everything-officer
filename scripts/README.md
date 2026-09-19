# CEO Operations & Cluster Management Scripts

This directory contains lightweight, zero-dependency tools for managing users, databases, and deployments across the CEO cluster.

## `manage_user.py`

Pure Python 3 standard library script. Requires no external dependencies or pip packages. Can be run directly from your local dev machine (which connects via `ssh mtl0`) or directly on the `mtl0` host.

### Commands

#### 1. List All Users
Displays a table of registered users, their GitHub logins, workspace IDs, bound repositories, and current onboarding flow states:
```bash
python3 scripts/manage_user.py list
```

#### 2. Inspect a User
Inspects full details for a specific user (onboarding state, repository binding, token counts) by GitHub login, subject ID, or CEO user ID:
```bash
python3 scripts/manage_user.py inspect sentimentalk0229
python3 scripts/manage_user.py inspect 330677925
python3 scripts/manage_user.py inspect usr_3716f414-f645-4d59-bbd7-73f003a1556f
```

#### 3. Reset a User (Clean Test Account)
Atomically and cleanly purges all data for a user across:
- `identity.sqlite`: `workspace_bootstraps`, `github_repository_bindings`, `onboarding_flows`, `api_keys`, `workspace_memberships`, `workspaces`, `github_installation_users`, `external_identities`, `users`, orphan `github_installations`.
- `oauth.sqlite`: all tokens, codes, and authorization requests.
- `ceo-trace.sqlite`: traces for that workspace.
- `/data/workspaces/<workspace_id>`: checked out repository files on disk.
- Automatically rolls out restart of `ceo-server` container on K3s to clear in-memory sessions/grants:
```bash
python3 scripts/manage_user.py reset sentimentalk0229
```
*(Add `--no-restart` if you only want to clear database rows without restarting the container)*.

#### 4. Restart Server
Rollout restarts the `ceo-server` deployment on K3s and waits for rollout to complete:
```bash
python3 scripts/manage_user.py restart
```
