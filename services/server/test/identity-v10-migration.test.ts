import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  IDENTITY_DB_USER_VERSION,
  IdentityError,
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v10-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

function createValidV9Database(dbPath: string): void {
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
      access_scope_verified_at_ms INTEGER,
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
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, provider_subject TEXT NOT NULL, mode TEXT NOT NULL,
      desired_repository_name TEXT, installation_row_id TEXT, repository_id TEXT, workspace_id TEXT,
      state TEXT NOT NULL, last_error_code TEXT, last_error_message TEXT, host_oauth_request_id TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
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
    PRAGMA user_version = 9;
    INSERT INTO users VALUES ('usr_1', 1000, NULL);
  `);
  db.close();
}

describe("Identity DB v9 -> v10 migration (users.is_admin)", () => {
  it("migrates v9 users to is_admin=0 without granting anyone", async () => {
    const { dbPath } = await tempDbPath();
    createValidV9Database(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(IDENTITY_DB_USER_VERSION);
      expect(IDENTITY_DB_USER_VERSION).toBe(12);

      const columns = rawDb.prepare("PRAGMA table_info(users);").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "is_admin")).toBe(true);

      const row = rawDb.prepare("SELECT is_admin FROM users WHERE id = 'usr_1';").get() as { is_admin: number };
      expect(row.is_admin).toBe(0);

      const flows = rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_flows';",
      ).all();
      expect(flows).toHaveLength(1);
    });

    expect(store.isUserAdmin("usr_1")).toBe(false);
  });

  it("fresh control-plane DB is v10 with is_admin CHECK", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(IDENTITY_DB_USER_VERSION);
      const sql = (rawDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users';",
      ).get() as { sql: string }).sql;
      expect(sql).toContain("is_admin");
      expect(sql).toMatch(/CHECK \(is_admin IN \(0, 1\)\)/);
    });
  });

  it("grant-admin rejects disabled users; revoke-admin allows them", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((db) => {
      db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_active', 1, NULL);").run();
      db.prepare("INSERT INTO users (id, created_at, disabled_at) VALUES ('usr_off', 1, 2);").run();
    });

    store.grantAdmin("usr_active");
    expect(store.isUserAdmin("usr_active")).toBe(true);

    expect(() => store.grantAdmin("usr_off")).toThrow(IdentityError);

    store.revokeAdmin("usr_off");
    store.withDb((db) => {
      const row = db.prepare("SELECT is_admin FROM users WHERE id = 'usr_off';").get() as { is_admin: number };
      expect(row.is_admin).toBe(0);
    });

    expect(() => store.setUserAdmin("usr_active", "1" as unknown as boolean)).toThrow(IdentityStructureError);
    expect(() => store.grantAdmin("usr_missing")).toThrow(IdentityError);
  });

  it("migrateV9ToV10 fails if user_version is not 9", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 8;");
    expect(() => IdentityStore.migrateV9ToV10(db)).toThrow(IdentityStructureError);
    db.close();
  });
});
