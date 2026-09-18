import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  IDENTITY_DB_USER_VERSION,
  sha256Hex,
} from "../src/identity/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDbPath(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v7-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

describe("Identity DB v6 -> v7 migration (onboarding_flows)", () => {
  it("A. v6 database migrates to v7 with onboarding_flows table and partial unique index", async () => {
    const { dbPath } = await tempDbPath();

    // Create a valid v6 database manually
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, remote_url TEXT NOT NULL,
        branch TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, key_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE external_identities (
        id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL, provider_login TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(provider, provider_subject), UNIQUE(provider, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE workspace_memberships (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(workspace_id, user_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY NOT NULL, github_installation_id TEXT NOT NULL UNIQUE, github_app_id TEXT NOT NULL,
        account_id TEXT NOT NULL, account_login TEXT NOT NULL, account_type TEXT NOT NULL,
        repository_selection TEXT NOT NULL, suspended_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE github_installation_users (
        id TEXT PRIMARY KEY NOT NULL, github_installation_row_id TEXT NOT NULL, user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, verified_at_ms INTEGER NOT NULL,
        UNIQUE(github_installation_row_id, user_id),
        FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE github_repository_bindings (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL UNIQUE, github_repository_id TEXT NOT NULL UNIQUE,
        github_installation_row_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, owner_login TEXT NOT NULL,
        repository_name TEXT NOT NULL, full_name TEXT NOT NULL, branch TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id)
      );
      CREATE TABLE workspace_bootstraps (
        workspace_id TEXT PRIMARY KEY NOT NULL, bootstrap_version INTEGER NOT NULL, state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, last_attempt_id TEXT, last_base_commit_sha TEXT, ready_commit_sha TEXT,
        last_error_kind TEXT, last_error_code TEXT, last_error_message TEXT,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, ready_at_ms INTEGER,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id);
      CREATE INDEX idx_api_keys_user ON api_keys(user_id);
      CREATE INDEX idx_external_identities_user ON external_identities(user_id);
      CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
      CREATE INDEX idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);
      CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
      CREATE INDEX idx_github_installation_users_user ON github_installation_users(user_id);
      CREATE INDEX idx_github_installation_users_installation ON github_installation_users(github_installation_row_id);
      CREATE INDEX idx_github_repository_bindings_installation ON github_repository_bindings(github_installation_row_id);
      CREATE INDEX idx_workspace_bootstraps_state ON workspace_bootstraps(state);
      PRAGMA user_version = 6;

      -- Seed test user
      INSERT INTO users VALUES ('usr_mig_1', 1000, NULL);
    `);
    db.close();

    // Snapshot v6 for rollback test
    const v6BackupPath = `${dbPath}.v6.bak`;
    fs.copyFileSync(dbPath, v6BackupPath);

    // Open store -> triggers migrateV6ToV7
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    // Verify user_version is 7
    const raw = new DatabaseSync(dbPath);
    const ver = raw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(ver.user_version)).toBe(7);

    // Verify onboarding_flows table exists
    const table = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_flows';").all();
    expect(table).toHaveLength(1);

    // Verify idx_onboarding_one_active_per_user partial unique index exists
    const index = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_onboarding_one_active_per_user';").all() as any[];
    expect(index).toHaveLength(1);
    expect(index[0].sql).toContain("idx_onboarding_one_active_per_user");

    // Existing user row preserved
    const users = raw.prepare("SELECT id FROM users;").all();
    expect(users).toHaveLength(1);

    // Test DB partial unique index: inserting one active flow succeeds
    raw.exec(`
      INSERT INTO onboarding_flows (
        id, user_id, provider_subject, mode, desired_repository_name,
        installation_row_id, repository_id, workspace_id, state,
        last_error_code, last_error_message, created_at_ms, updated_at_ms, expires_at_ms
      ) VALUES (
        'onb_1', 'usr_mig_1', 'sub_1', 'create', 'ceo-data',
        NULL, NULL, NULL, 'AWAITING_REPOSITORY_CHOICE',
        NULL, NULL, 1000, 1000, 2000
      );
    `);

    // Inserting a second active flow for the same user fails with UNIQUE constraint violation
    expect(() => {
      raw.exec(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name,
          installation_row_id, repository_id, workspace_id, state,
          last_error_code, last_error_message, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (
          'onb_2', 'usr_mig_1', 'sub_1', 'create', 'ceo-data-2',
          NULL, NULL, NULL, 'PROVISIONING',
          NULL, NULL, 1100, 1100, 2100
        );
      `);
    }).toThrow(/UNIQUE constraint failed/);

    // Inserting an inactive/completed flow for the same user succeeds
    raw.exec(`
      INSERT INTO onboarding_flows (
        id, user_id, provider_subject, mode, desired_repository_name,
        installation_row_id, repository_id, workspace_id, state,
        last_error_code, last_error_message, created_at_ms, updated_at_ms, expires_at_ms
      ) VALUES (
        'onb_completed', 'usr_mig_1', 'sub_1', 'create', 'ceo-data',
        NULL, NULL, NULL, 'COMPLETED',
        NULL, NULL, 500, 500, 1500
      );
    `);

    raw.close();
    store.close();

    // Verify rollback: restoring v6 backup preserves v6 database integrity
    const restoredPath = `${dbPath}.restored`;
    fs.copyFileSync(v6BackupPath, restoredPath);
    const restoredRaw = new DatabaseSync(restoredPath);
    const restoredVer = restoredRaw.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(restoredVer.user_version)).toBe(6);
    const restoredIntegrity = restoredRaw.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
    expect(restoredIntegrity.integrity_check).toBe("ok");
    restoredRaw.close();
  });
});
