import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "os";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v13-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

/**
 * Historical v12 fixture: constructs the last schema generation that still
 * contained the legacy DB-backed `api_keys` credential table, with
 * representative modern identity / control-plane / device / target data.
 * Mentions of `api_keys` here exist only to prove its removal by migration.
 */
function createValidV12Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      key_digest TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE external_identities (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_login TEXT,
      provider_email TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE(provider, provider_subject),
      UNIQUE(provider, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_id TEXT NOT NULL UNIQUE,
      github_app_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      repository_selection TEXT NOT NULL,
      suspended_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE github_installation_users (
      id TEXT PRIMARY KEY NOT NULL,
      github_installation_row_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verified_at_ms INTEGER NOT NULL,
      UNIQUE(github_installation_row_id, user_id),
      FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE github_repository_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,
      github_repository_id TEXT NOT NULL UNIQUE,
      github_installation_row_id TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      owner_login TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      access_scope_verified_at_ms INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (github_installation_row_id) REFERENCES github_installations(id)
    );
    CREATE TABLE workspace_bootstraps (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      bootstrap_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_attempt_id TEXT,
      last_base_commit_sha TEXT,
      ready_commit_sha TEXT,
      last_error_kind TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ready_at_ms INTEGER,
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
    CREATE UNIQUE INDEX ux_workspace_memberships_owner ON workspace_memberships(workspace_id) WHERE role = 'owner';
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
    CREATE TABLE devices (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_devices_user ON devices(user_id);
    CREATE INDEX idx_devices_active_user ON devices(user_id, revoked_at_ms);
    CREATE TABLE device_credentials (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      secret_digest TEXT NOT NULL UNIQUE,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);
    CREATE INDEX idx_device_credentials_expiry ON device_credentials(expires_at_ms);
    CREATE TABLE execution_targets (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      repository_provider TEXT,
      repository_external_id TEXT,
      repository_full_name TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      disabled_at_ms INTEGER,
      UNIQUE(workspace_id, alias),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CHECK (
        (
          repository_provider IS NULL
          AND repository_external_id IS NULL
          AND repository_full_name IS NULL
        )
        OR
        (
          repository_provider IS NOT NULL
          AND repository_external_id IS NOT NULL
          AND repository_full_name IS NOT NULL
        )
      )
    );
    CREATE INDEX idx_execution_targets_workspace ON execution_targets(workspace_id);
    CREATE INDEX idx_execution_targets_workspace_state ON execution_targets(workspace_id, disabled_at_ms);
    CREATE TABLE device_target_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      disabled_at_ms INTEGER,
      UNIQUE(device_id, target_id),
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES execution_targets(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_device_target_bindings_device ON device_target_bindings(device_id);
    CREATE INDEX idx_device_target_bindings_target ON device_target_bindings(target_id);
    CREATE INDEX idx_device_target_bindings_device_state ON device_target_bindings(device_id, disabled_at_ms);
    PRAGMA user_version = 12;

    INSERT INTO users VALUES ('usr_alice', 1000, NULL, 0);
    INSERT INTO workspaces VALUES ('ws_alice', 'usr_alice', 'https://github.com/alice/repo.git', 'main', 1000);
    INSERT INTO workspace_memberships VALUES ('wsm_alice', 'ws_alice', 'usr_alice', 'owner', 1000);
    INSERT INTO api_keys VALUES ('ak_alice', 'usr_alice', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1000, NULL);
    INSERT INTO api_keys VALUES ('ak_alice_revoked', 'usr_alice', 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', 1000, 2000);
    INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, provider_email, created_at_ms, updated_at_ms)
      VALUES ('ext_alice', 'github', '12345', 'usr_alice', 'alice_gh', 'alice@example.com', 1000, 1000);
    INSERT INTO github_installations VALUES ('ghi_1', '98765', '9999', '54321', 'alice-org', 'Organization', 'selected', NULL, 1000, 1000);
    INSERT INTO github_installation_users VALUES ('ghiu_1', 'ghi_1', 'usr_alice', 1000, 1000);
    INSERT INTO github_repository_bindings (
      id, workspace_id, github_repository_id, github_installation_row_id,
      owner_account_id, owner_login, repository_name, full_name,
      branch, created_at_ms, updated_at_ms, access_scope_verified_at_ms
    ) VALUES ('grb_1', 'ws_alice', '11111', 'ghi_1', '54321', 'alice-org', 'repo', 'alice-org/repo', 'main', 1000, 1000, 1000);
    INSERT INTO workspace_bootstraps VALUES ('ws_alice', 1, 'PENDING', 0, NULL, NULL, NULL, NULL, NULL, NULL, 1000, 1000, NULL);
    INSERT INTO onboarding_flows (
      id, user_id, provider_subject, mode, desired_repository_name,
      installation_row_id, repository_id, workspace_id, state,
      last_error_code, last_error_message, host_oauth_request_id,
      created_at_ms, updated_at_ms, expires_at_ms
    ) VALUES ('onb_1', 'usr_alice', '12345', 'github_app', 'repo', 'ghi_1', '11111', 'ws_alice', 'READY_TO_RESUME', NULL, NULL, 'oar_1', 1000, 1000, 6000);
    INSERT INTO devices VALUES ('dev_1', 'usr_alice', 'Alice Laptop', 'linux', 1000, 1000, NULL);
    INSERT INTO device_credentials VALUES (
      'dcr_1', 'dev_1', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 1000, 999999999, NULL
    );
    INSERT INTO execution_targets VALUES (
      'tgt_1', 'ws_alice', 'default', 'Default Target', 'workspace', NULL, NULL, NULL, 1000, 1000, NULL
    );
    INSERT INTO device_target_bindings VALUES ('dtb_1', 'dev_1', 'tgt_1', 1000, 1000, NULL);
  `);
  db.close();
}

describe("Identity DB Migration v12 -> v13 (legacy api_keys retirement)", () => {
  it("IDENTITY_DB_USER_VERSION is 13", () => {
    expect(IDENTITY_DB_USER_VERSION).toBe(13);
  });

  it("fresh v13 database has no api_keys table or index", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const db = new DatabaseSync(dbPath);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(13);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("api_keys");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_api_keys_user';")
      .all();
    expect(indexes.length).toBe(0);
    db.close();
  });

  it("migrates a representative valid v12 database to v13, dropping api_keys and preserving modern data", async () => {
    const { dbPath } = await tempDbPath();
    createValidV12Database(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const db = new DatabaseSync(dbPath);

    // v13 reached
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(13);

    // api_keys is gone, including its index
    const apiKeysTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys';")
      .get() as { name: string } | undefined;
    expect(apiKeysTable).toBeUndefined();
    const apiKeysIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_api_keys_user';")
      .get();
    expect(apiKeysIndex).toBeUndefined();

    // Identity data preserved
    const user = db.prepare("SELECT id, is_admin FROM users WHERE id = 'usr_alice';").get() as
      | { id: string; is_admin: number }
      | undefined;
    expect(user).toEqual({ id: "usr_alice", is_admin: 0 });

    const workspace = db.prepare("SELECT id, owner_user_id FROM workspaces WHERE id = 'ws_alice';").get() as
      | { id: string; owner_user_id: string }
      | undefined;
    expect(workspace).toEqual({ id: "ws_alice", owner_user_id: "usr_alice" });

    const membership = db.prepare(
      "SELECT workspace_id, user_id, role FROM workspace_memberships;",
    ).get() as { workspace_id: string; user_id: string; role: string };
    expect(membership).toEqual({ workspace_id: "ws_alice", user_id: "usr_alice", role: "owner" });

    const ext = store.findExternalIdentity("github", "12345");
    expect(ext).not.toBeNull();
    expect(ext!.provider_email).toBe("alice@example.com");

    // Modern device / target control-plane data preserved
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM devices;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM device_credentials;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM execution_targets;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM device_target_bindings;").get() as { c: number }).c),
    ).toBe(1);

    const target = db.prepare(
      "SELECT id, workspace_id, alias, kind FROM execution_targets;",
    ).get() as { id: string; workspace_id: string; alias: string; kind: string };
    expect(target).toEqual({ id: "tgt_1", workspace_id: "ws_alice", alias: "default", kind: "workspace" });

    // GitHub onboarding surface preserved
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM github_installations;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM github_repository_bindings;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM workspace_bootstraps;").get() as { c: number }).c),
    ).toBe(1);
    expect(
      Number((db.prepare("SELECT COUNT(*) AS c FROM onboarding_flows;").get() as { c: number }).c),
    ).toBe(1);

    db.close();

    // The migrated database passes current structural validation (reopen)
    const reopened = IdentityStore.open(dbPath);
    expect(reopened.ping()).toBe(true);
    reopened.close();
  });

  it("direct migrateV12ToV13 rejects when user_version is not 12", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 11;");
    expect(() => IdentityStore.migrateV12ToV13(db)).toThrow(IdentityStructureError);
    db.close();
  });

  it("rolls back transaction and keeps api_keys when a required v12 table is missing", async () => {
    const { dbPath } = await tempDbPath();
    createValidV12Database(dbPath);

    // Simulate an invalid v12 database: its modern device/target tables are gone
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE device_target_bindings;
      DROP TABLE execution_targets;
      DROP TABLE device_credentials;
      DROP TABLE devices;
    `);
    raw.close();

    const db = new DatabaseSync(dbPath);
    expect(() => IdentityStore.migrateV12ToV13(db)).toThrow(IdentityStructureError);

    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(12);

    const apiKeysTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys';")
      .get() as { name: string } | undefined;
    expect(apiKeysTable).toBeDefined();
    db.close();
  });

  it("fail-closes on a v12 database that lost api_keys already (invalid v12)", async () => {
    const { dbPath } = await tempDbPath();
    createValidV12Database(dbPath);

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE api_keys;");
    raw.close();

    expect(() => IdentityStore.open(dbPath)).toThrow(IdentityStructureError);

    const db = new DatabaseSync(dbPath);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(12);
    db.close();
  });

  it("idempotently reopens an already-migrated v13 database", async () => {
    const { dbPath } = await tempDbPath();
    createValidV12Database(dbPath);

    const store1 = IdentityStore.open(dbPath);
    store1.close();

    const store2 = IdentityStore.open(dbPath);
    cleanupStores.push(store2);
    expect(store2.ping()).toBe(true);
  });
});