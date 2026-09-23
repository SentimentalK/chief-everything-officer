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
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v11-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

function createValidV10Database(dbPath: string): void {
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
    INSERT INTO users VALUES ('usr_alice', 1000, NULL);
    INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
      VALUES ('ext_alice', 'github', '12345', 'usr_alice', 'alice_gh', 1000, 1000);
  `);

  IdentityStore.migrateV9ToV10(db);
  db.close();
}

describe("Identity DB Migration v10 -> v11", () => {
  it("IDENTITY_DB_USER_VERSION is 12", () => {
    expect(IDENTITY_DB_USER_VERSION).toBe(12);
  });

  it("successfully migrates v10 database to v11 (and v12) on IdentityStore.open", async () => {
    const { dbPath } = await tempDbPath();
    createValidV10Database(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const db = new DatabaseSync(dbPath);
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number };
    expect(Number(versionRow.user_version)).toBe(IDENTITY_DB_USER_VERSION);

    // Verify existing user has NULL provider_email
    const existing = store.findExternalIdentity("github", "12345");
    expect(existing).not.toBeNull();
    expect(existing?.provider_login).toBe("alice_gh");
    expect(existing?.provider_email).toBeNull();

    // Verify findExternalIdentityByUser
    const byUser = store.findExternalIdentityByUser("github", "usr_alice");
    expect(byUser).not.toBeNull();
    expect(byUser?.provider_subject).toBe("12345");
    expect(byUser?.provider_email).toBeNull();

    // Update metadata with email
    store.updateExternalIdentityMetadata({
      provider: "github",
      providerSubject: "12345",
      providerEmail: "alice@example.com",
    });

    const updated = store.findExternalIdentity("github", "12345");
    expect(updated?.provider_email).toBe("alice@example.com");

    // Calling update without email preserves existing email
    store.updateExternalIdentityMetadata({
      provider: "github",
      providerSubject: "12345",
      providerLogin: "alice_renamed",
      providerEmail: null,
    });
    const preserved = store.findExternalIdentity("github", "12345");
    expect(preserved?.provider_login).toBe("alice_renamed");
    expect(preserved?.provider_email).toBe("alice@example.com");

    db.close();
  });

  it("fresh provisioned database has user_version 12 and provider_email column", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);

    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const res = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "99999",
      providerLogin: "bob_gh",
      providerEmail: "bob@example.com",
    });

    expect(res.created).toBe(true);
    expect(res.provider_email).toBe("bob@example.com");

    const found = store.findExternalIdentity("github", "99999");
    expect(found?.provider_email).toBe("bob@example.com");
  });

  it("rejects migration when user_version is not 10", async () => {
    const { dbPath } = await tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 9;");
    expect(() => IdentityStore.migrateV10ToV11(db)).toThrow(IdentityStructureError);
    db.close();
  });
});
