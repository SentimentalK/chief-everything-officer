import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  IDENTITY_DB_USER_VERSION,
  IdentityStructureError,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDbPath(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v9-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

function createValidV8Database(dbPath: string): void {
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
    CREATE TABLE onboarding_flows (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      mode TEXT NOT NULL,
      desired_repository_name TEXT,
      installation_row_id TEXT,
      repository_id TEXT,
      workspace_id TEXT,
      state TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT,
      host_oauth_request_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (installation_row_id) REFERENCES github_installations(id) ON DELETE SET NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
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
    CREATE INDEX idx_onboarding_flows_user ON onboarding_flows(user_id);
    CREATE INDEX idx_onboarding_flows_state ON onboarding_flows(state);
    CREATE UNIQUE INDEX idx_onboarding_one_active_per_user
    ON onboarding_flows(user_id)
    WHERE state IN (
      'AWAITING_REPOSITORY_CHOICE',
      'AWAITING_GITHUB_ACCESS',
      'PROVISIONING',
      'AWAITING_REPOSITORY_RESTRICTION',
      'READY_TO_RESUME',
      'RECOVERY_REQUIRED'
    );
    PRAGMA user_version = 8;
  `);
  db.close();
}

describe("Identity DB v8 -> v9 migration (access_scope_verified_at_ms)", () => {
  it("A. v8 database migrates cleanly to v9 with nullable column and NO blanket backfill", async () => {
    const { dbPath } = await tempDbPath();
    createValidV8Database(dbPath);

    // Seed v8 data with a repository binding and a READY bootstrap
    const seedDb = new DatabaseSync(dbPath);
    seedDb.exec(`
      INSERT INTO users VALUES ('usr_1', 1000, NULL);
      INSERT INTO workspaces VALUES ('ws_1', 'usr_1', 'https://github.com/acme/vault.git', 'main', 1000);
      INSERT INTO workspace_memberships VALUES ('wsm_1', 'ws_1', 'usr_1', 'owner', 1000);
      INSERT INTO github_installations VALUES ('ghi_1', '12345678', '123456', '111111', 'acme', 'User', 'selected', NULL, 1000, 1000);
      INSERT INTO github_installation_users VALUES ('ghiu_1', 'ghi_1', 'usr_1', 1000, 1000);
      INSERT INTO github_repository_bindings VALUES (
        'grb_1', 'ws_1', '98765432', 'ghi_1', '111111', 'acme', 'vault', 'acme/vault', 'main', 1000, 1000
      );
      INSERT INTO workspace_bootstraps VALUES (
        'ws_1', 1, 'READY', 1, 'att_1', '0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567', NULL, NULL, NULL, 1000, 1000, 1000
      );
    `);
    seedDb.close();

    // Opening with IdentityStore triggers migration
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(9);
      expect(IDENTITY_DB_USER_VERSION).toBe(9);

      // Verify column exists
      const columns = rawDb.prepare("PRAGMA table_info(github_repository_bindings);").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "access_scope_verified_at_ms")).toBe(true);

      // Verify NO blanket backfill: value MUST be NULL
      const row = rawDb.prepare("SELECT access_scope_verified_at_ms FROM github_repository_bindings WHERE id = 'grb_1';").get() as any;
      expect(row.access_scope_verified_at_ms).toBeNull();
    });

    // Verify dual-condition readiness: bootstrap is READY but scope is NULL -> NOT READY FOR HOST!
    expect(store.isWorkspaceReadyForHost("ws_1")).toBe(false);

    // Finding binding returns record with null access_scope_verified_at_ms
    const binding = store.findRepositoryBindingByWorkspaceId("ws_1");
    expect(binding).not.toBeNull();
    expect(binding?.access_scope_verified_at_ms).toBeNull();

    // Now mark scope verified
    const verifiedMs = 123456789;
    store.markRepositoryBindingScopeVerified("ws_1", verifiedMs);

    const updatedBinding = store.findRepositoryBindingByWorkspaceId("ws_1");
    expect(updatedBinding?.access_scope_verified_at_ms).toBe(verifiedMs);

    // Now dual-condition check passes!
    expect(store.isWorkspaceReadyForHost("ws_1")).toBe(true);

    // If scope is cleared, dual-condition check immediately fails closed!
    store.clearRepositoryBindingScopeVerified("ws_1");
    expect(store.isWorkspaceReadyForHost("ws_1")).toBe(false);
  });

  it("B. migrateV8ToV9 fails if user_version is not 8", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 7;");
    expect(() => IdentityStore.migrateV8ToV9(db)).toThrow(IdentityStructureError);
    db.close();
  });

  it("C. fresh empty control plane database provisions at v9 with correct structural integrity", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(9);
    });
  });
});
