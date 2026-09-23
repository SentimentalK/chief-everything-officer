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
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v12-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

function createValidV11Database(dbPath: string): void {
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
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      provider_email TEXT,
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
    PRAGMA user_version = 11;

    INSERT INTO users VALUES ('usr_alice', 1000, NULL, 0);
    INSERT INTO workspaces VALUES ('ws_alice', 'usr_alice', 'https://github.com/alice/repo.git', 'main', 1000);
    INSERT INTO workspace_memberships VALUES ('wsm_alice', 'ws_alice', 'usr_alice', 'owner', 1000);
    INSERT INTO api_keys VALUES ('ak_alice', 'usr_alice', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1000, NULL);
    INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms, provider_email)
      VALUES ('ext_alice', 'github', '12345', 'usr_alice', 'alice_gh', 1000, 1000, 'alice@example.com');
  `);
  db.close();
}

describe("Identity DB Migration v11 -> v12", () => {
  it("IDENTITY_DB_USER_VERSION is 12", () => {
    expect(IDENTITY_DB_USER_VERSION).toBe(12);
  });

  it("fresh provisioned database has user_version 12 and all 4 new tables", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const db = new DatabaseSync(dbPath);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(12);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("devices");
    expect(names).toContain("device_credentials");
    expect(names).toContain("execution_targets");
    expect(names).toContain("device_target_bindings");

    db.close();
  });

  it("successfully migrates v11 database to v12 on IdentityStore.open without data loss", async () => {
    const { dbPath } = await tempDbPath();
    createValidV11Database(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const db = new DatabaseSync(dbPath);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(12);

    // Verify existing v11 data is intact
    const userRow = db.prepare("SELECT id FROM users WHERE id = 'usr_alice';").get() as { id: string } | undefined;
    expect(userRow).not.toBeUndefined();
    expect(userRow?.id).toBe("usr_alice");

    const ext = store.findExternalIdentity("github", "12345");
    expect(ext).not.toBeNull();
    expect(ext?.provider_login).toBe("alice_gh");
    expect(ext?.provider_email).toBe("alice@example.com");

    const memberships = store.listWorkspaceMembershipsForUser("usr_alice");
    expect(memberships.length).toBe(1);
    expect(memberships[0]?.workspace_id).toBe("ws_alice");

    // Verify 4 new tables exist and are empty
    for (const table of ["devices", "device_credentials", "execution_targets", "device_target_bindings"]) {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
      expect(Number(count.c)).toBe(0);
    }

    db.close();
  });

  it("idempotently reopens an already-migrated v12 database", async () => {
    const { dbPath } = await tempDbPath();
    createValidV11Database(dbPath);

    const store1 = IdentityStore.open(dbPath);
    store1.close();

    const store2 = IdentityStore.open(dbPath);
    cleanupStores.push(store2);
    expect(store2.ping()).toBe(true);
  });

  it("direct migrateV11ToV12 rejects when user_version is not 11", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 10;");
    expect(() => IdentityStore.migrateV11ToV12(db)).toThrow(IdentityStructureError);
    db.close();
  });

  it("rolls back transaction if a required v11 table is missing during migrateV11ToV12", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
      PRAGMA user_version = 11;
    `);
    expect(() => IdentityStore.migrateV11ToV12(db)).toThrow(IdentityStructureError);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(11);
    db.close();
  });
});
