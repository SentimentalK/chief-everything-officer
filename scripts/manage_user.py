#!/usr/bin/env python3
"""
scripts/manage_user.py — CEO Production/Cluster User Operations Tool

Zero-dependency tool to inspect, list, and completely reset test user accounts
across SQLite databases (identity, oauth, audit), workspace directories, and
in-memory session state (via Kubernetes rollout restart).

Can be executed locally (tunnels via `ssh mtl0`) or directly on the mtl0 host.

Usage:
  python3 scripts/manage_user.py list
  python3 scripts/manage_user.py inspect <login | subject | user_id>
  python3 scripts/manage_user.py reset <login | subject | user_id> [--no-restart]
  python3 scripts/manage_user.py restart
"""

import sys
import os
import argparse
import subprocess
import json

REMOTE_HOST = "mtl0"
STATE_DIR = "/home/ubuntu/codes/ceo-state-mcp"
IDENTITY_DB = f"{STATE_DIR}/identity/identity.sqlite"
OAUTH_DB = f"{STATE_DIR}/identity/oauth.sqlite"
TRACE_DB = f"{STATE_DIR}/audit/ceo-trace.sqlite"
WORKSPACES_DIR = f"{STATE_DIR}/workspaces"


def is_local_on_mtl0() -> bool:
    return os.path.exists(IDENTITY_DB)


def run_cmd(cmd_str: str) -> str:
    """Run command locally if on mtl0, else tunnel via ssh mtl0."""
    if is_local_on_mtl0():
        full_cmd = ["bash", "-c", cmd_str]
    else:
        full_cmd = ["ssh", REMOTE_HOST, cmd_str]

    res = subprocess.run(full_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Command failed (code {res.returncode}):\n{res.stderr.strip()}")
    return res.stdout


def run_sql(db_path: str, sql_statements: str) -> str:
    escaped_sql = sql_statements.replace('"', '\\"')
    cmd = f'sudo sqlite3 "{db_path}" "{escaped_sql}"'
    return run_cmd(cmd)


def list_users():
    query = """
    SELECT
      u.id AS user_id,
      COALESCE(e.provider_login, '<none>') AS login,
      COALESCE(e.provider_subject, '<none>') AS subject,
      COALESCE(w.id, '<no workspace>') AS workspace_id,
      COALESCE(b.full_name, '<no binding>') AS repo,
      COALESCE(f.state, '<no flow>') AS flow_state,
      datetime(u.created_at / 1000, 'unixepoch') AS created_at
    FROM users u
    LEFT JOIN external_identities e ON e.user_id = u.id
    LEFT JOIN workspaces w ON w.owner_user_id = u.id
    LEFT JOIN github_repository_bindings b ON b.workspace_id = w.id
    LEFT JOIN onboarding_flows f ON f.user_id = u.id
    ORDER BY u.created_at DESC;
    """
    output = run_sql(IDENTITY_DB, query).strip()
    if not output:
        print("No users found in database.")
        return

    rows = [line.split("|") for line in output.splitlines()]
    headers = ["User ID", "Login", "Subject", "Workspace ID", "Bound Repo", "Flow State", "Created At"]
    col_widths = [len(h) for h in headers]

    for row in rows:
        for i, val in enumerate(row):
            if i < len(col_widths):
                col_widths[i] = max(col_widths[i], len(val))

    fmt = "  ".join(f"{{:<{w}}}" for w in col_widths)
    print("=" * (sum(col_widths) + 2 * (len(col_widths) - 1)))
    print(fmt.format(*headers))
    print("=" * (sum(col_widths) + 2 * (len(col_widths) - 1)))
    for row in rows:
        print(fmt.format(*row))


def resolve_user(identifier: str):
    """Find user_id and workspace_id by login, subject, or user_id."""
    clean_id = identifier.strip()
    query = f"""
    SELECT
      u.id AS user_id,
      e.provider_login,
      e.provider_subject,
      w.id AS workspace_id,
      f.id AS flow_id
    FROM users u
    LEFT JOIN external_identities e ON e.user_id = u.id
    LEFT JOIN workspaces w ON w.owner_user_id = u.id
    LEFT JOIN onboarding_flows f ON f.user_id = u.id
    WHERE u.id = '{clean_id}'
       OR e.provider_login = '{clean_id}'
       OR e.provider_subject = '{clean_id}'
    LIMIT 1;
    """
    out = run_sql(IDENTITY_DB, query).strip()
    if not out:
        return None
    parts = out.split("|")
    return {
        "user_id": parts[0] if len(parts) > 0 and parts[0] else None,
        "login": parts[1] if len(parts) > 1 and parts[1] else None,
        "subject": parts[2] if len(parts) > 2 and parts[2] else None,
        "workspace_id": parts[3] if len(parts) > 3 and parts[3] else None,
        "flow_id": parts[4] if len(parts) > 4 and parts[4] else None,
    }


def inspect_user(identifier: str):
    user = resolve_user(identifier)
    if not user or not user["user_id"]:
        print(f"User not found matching: '{identifier}'")
        return

    uid = user["user_id"]
    ws_id = user["workspace_id"] or ""

    print(f"\n[User Overview]")
    print(f"  User ID:       {uid}")
    print(f"  GitHub Login:  {user['login'] or '<none>'}")
    print(f"  GitHub Subject:{user['subject'] or '<none>'}")
    print(f"  Workspace ID:  {ws_id or '<none>'}")
    print(f"  Flow ID:       {user['flow_id'] or '<none>'}")

    # Flow details
    flow_sql = f"SELECT state, desired_repository_name, repository_id, last_error_code, last_error_message, host_oauth_request_id FROM onboarding_flows WHERE user_id = '{uid}';"
    flow_out = run_sql(IDENTITY_DB, flow_sql).strip()
    if flow_out:
        f = flow_out.split("|")
        print(f"\n[Onboarding Flow]")
        print(f"  State:              {f[0]}")
        print(f"  Desired Repo:       {f[1]}")
        print(f"  GitHub Repo ID:     {f[2]}")
        print(f"  Last Error Code:    {f[3] or 'None'}")
        print(f"  Last Error Message: {f[4] or 'None'}")
        print(f"  Durable OAuth Req:  {f[5] or 'None'}")

    # Repository binding details
    if ws_id:
        bind_sql = f"SELECT github_repository_id, full_name, branch FROM github_repository_bindings WHERE workspace_id = '{ws_id}';"
        bind_out = run_sql(IDENTITY_DB, bind_sql).strip()
        if bind_out:
            b = bind_out.split("|")
            print(f"\n[Repository Binding]")
            print(f"  Repo ID:   {b[0]}")
            print(f"  Full Name: {b[1]}")
            print(f"  Branch:    {b[2]}")

    # OAuth tokens
    tok_sql = f"""
    SELECT
      (SELECT count(*) FROM oauth_authorization_requests WHERE user_id = '{uid}'),
      (SELECT count(*) FROM oauth_access_tokens WHERE user_id = '{uid}'),
      (SELECT count(*) FROM oauth_refresh_tokens WHERE user_id = '{uid}');
    """
    tok_out = run_sql(OAUTH_DB, tok_sql).strip()
    if tok_out:
        t = tok_out.split("|")
        print(f"\n[Host OAuth Store]")
        print(f"  Pending Requests: {t[0]}")
        print(f"  Access Tokens:    {t[1]}")
        print(f"  Refresh Tokens:   {t[2]}")
    print()


def reset_user(identifier: str, restart: bool = True):
    user = resolve_user(identifier)
    if not user or not user["user_id"]:
        print(f"No user found matching '{identifier}'. Nothing to clean.")
        return

    uid = user["user_id"]
    ws_id = user["workspace_id"] or ""
    login = user["login"] or identifier

    print(f"\n>>> Preparing to reset user: {login} (ID: {uid})")
    if ws_id:
        print(f"    Associated workspace: {ws_id}")

    # 1. Clean Identity DB
    ident_cleanup = f"""
    PRAGMA foreign_keys = ON;
    BEGIN IMMEDIATE;

    DELETE FROM workspace_bootstraps WHERE workspace_id = '{ws_id}';
    DELETE FROM github_repository_bindings WHERE workspace_id = '{ws_id}';
    DELETE FROM onboarding_flows WHERE user_id = '{uid}';
    DELETE FROM api_keys WHERE user_id = '{uid}';
    DELETE FROM workspace_memberships WHERE user_id = '{uid}';
    DELETE FROM workspaces WHERE id = '{ws_id}';
    DELETE FROM github_installation_users WHERE user_id = '{uid}';
    DELETE FROM external_identities WHERE user_id = '{uid}';
    DELETE FROM users WHERE id = '{uid}';

    DELETE FROM github_installations
    WHERE NOT EXISTS (
      SELECT 1 FROM github_installation_users u
      WHERE u.github_installation_row_id = github_installations.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_repository_bindings b
      WHERE b.github_installation_row_id = github_installations.id
    );

    COMMIT;
    """
    run_sql(IDENTITY_DB, ident_cleanup)
    print("  ✓ Identity DB records cleaned")

    # 2. Clean Host OAuth DB
    oauth_cleanup = f"""
    BEGIN IMMEDIATE;
    DELETE FROM oauth_refresh_tokens WHERE user_id = '{uid}' OR workspace_id = '{ws_id}';
    DELETE FROM oauth_access_tokens WHERE user_id = '{uid}' OR workspace_id = '{ws_id}';
    DELETE FROM oauth_authorization_codes WHERE user_id = '{uid}' OR workspace_id = '{ws_id}';
    DELETE FROM oauth_authorization_requests WHERE user_id = '{uid}' OR workspace_id = '{ws_id}';
    COMMIT;
    """
    run_sql(OAUTH_DB, oauth_cleanup)
    print("  ✓ OAuth DB tokens and requests cleaned")

    # 3. Clean audit traces
    if ws_id:
        trace_cmd = f"if [ -f '{TRACE_DB}' ]; then sudo sqlite3 '{TRACE_DB}' \"DELETE FROM traces WHERE workspace_id = '{ws_id}';\"; fi"
        run_cmd(trace_cmd)
        print("  ✓ Audit traces cleaned")

    # 4. Remove local checkout directory
    if ws_id:
        rm_cmd = f"sudo rm -rf '{WORKSPACES_DIR}/{ws_id}'"
        run_cmd(rm_cmd)
        print(f"  ✓ Workspace files removed ({ws_id})")

    # 5. Restart CEO Server if requested
    if restart:
        restart_server()
    else:
        print("  (Skipping container restart as requested)")

    print(f"\n>>> Reset complete for user '{login}'.\n")


def restart_server():
    print("  >>> Rolling out restart of ceo-server on mtl0...")
    cmd = "sudo kubectl -n ceo rollout restart deploy/ceo-server && sudo kubectl -n ceo rollout status deploy/ceo-server"
    run_cmd(cmd)
    print("  ✓ ceo-server rollout completed successfully.")


def main():
    parser = argparse.ArgumentParser(
        description="CEO User Management & Reset Tool (Zero Dependencies)",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # list
    subparsers.add_parser("list", help="List all users, workspaces, and onboarding status")

    # inspect
    inspect_parser = subparsers.add_parser("inspect", help="Inspect detailed status of a specific user")
    inspect_parser.add_argument("identifier", help="GitHub login, GitHub subject ID, or CEO user ID")

    # reset
    reset_parser = subparsers.add_parser("reset", help="Reset and purge user, workspace, and OAuth state")
    reset_parser.add_argument("identifier", help="GitHub login, GitHub subject ID, or CEO user ID")
    reset_parser.add_argument("--no-restart", action="store_true", help="Do not restart ceo-server pod")

    # restart
    subparsers.add_parser("restart", help="Restart ceo-server deployment in k3s")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == "list":
            list_users()
        elif args.command == "inspect":
            inspect_user(args.identifier)
        elif args.command == "reset":
            reset_user(args.identifier, restart=not args.no_restart)
        elif args.command == "restart":
            restart_server()
    except Exception as e:
        print(f"\n[ERROR] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
