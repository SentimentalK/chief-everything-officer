import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  IDENTITY_DB_USER_VERSION,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDbPath(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v8-migration-test-"));
  cleanupDirs.push(dir);
  return { dir, dbPath: path.join(dir, "identity.sqlite") };
}

describe("Identity DB v7 -> v8 migration (AWAITING_REPOSITORY_RESTRICTION)", () => {
  it("A. v7 database migrates to v8 with updated partial unique index", async () => {
    const { dbPath } = await tempDbPath();

    // Create a valid v7 database manually
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
        'READY_TO_RESUME',
        'RECOVERY_REQUIRED'
      );
      PRAGMA user_version = 7;

      -- Seed test user
      INSERT INTO users VALUES ('usr_mig_1', 1000, NULL);
    `);
    db.close();

    // Now open with IdentityStore.open - this should run migrateV7ToV8
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    // Verify user_version is 8
    store.withDb((rawDb: DatabaseSync) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(IDENTITY_DB_USER_VERSION);
      expect(IDENTITY_DB_USER_VERSION).toBe(9);

      // Verify the column host_oauth_request_id exists
      const columns = rawDb.prepare("PRAGMA table_info(onboarding_flows);").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "host_oauth_request_id")).toBe(true);

      // Verify the index now enforces single active flow for AWAITING_REPOSITORY_RESTRICTION
      rawDb.prepare(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name,
          installation_row_id, repository_id, workspace_id, state,
          last_error_code, last_error_message, host_oauth_request_id,
          created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (
          'onb_1', 'usr_mig_1', 'sub_1', 'create', 'ceo-data',
          NULL, 'repo_123', NULL, 'AWAITING_REPOSITORY_RESTRICTION', NULL, NULL, 'oar_test_123', 1000, 1000, 5000
        );
      `).run();

      // Verify reading host_oauth_request_id
      const flowRow = rawDb.prepare("SELECT host_oauth_request_id FROM onboarding_flows WHERE id = 'onb_1';").get() as any;
      expect(flowRow.host_oauth_request_id).toBe("oar_test_123");

      // Inserting second active flow for same user in AWAITING_REPOSITORY_RESTRICTION must fail
      expect(() => {
        rawDb.prepare(`
          INSERT INTO onboarding_flows (
            id, user_id, provider_subject, mode, desired_repository_name,
            installation_row_id, repository_id, workspace_id, state,
            last_error_code, last_error_message, host_oauth_request_id,
            created_at_ms, updated_at_ms, expires_at_ms
          ) VALUES (
            'onb_2', 'usr_mig_1', 'sub_1', 'create', 'ceo-data-2',
            NULL, NULL, NULL, 'AWAITING_REPOSITORY_RESTRICTION', NULL, NULL, NULL, 1000, 1000, 5000
          );
        `).run();
      }).toThrow(/UNIQUE constraint failed/);

      // Inserting completed flow for same user should succeed
      rawDb.prepare(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name,
          installation_row_id, repository_id, workspace_id, state,
          last_error_code, last_error_message, host_oauth_request_id,
          created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (
          'onb_3', 'usr_mig_1', 'sub_1', 'create', 'ceo-data-completed',
          NULL, NULL, NULL, 'COMPLETED', NULL, NULL, NULL, 1000, 1000, 5000
        );
      `).run();
    });
  });

  it("B. fresh database initialization creates schema with user_version = 8", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb: DatabaseSync) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(IDENTITY_DB_USER_VERSION);

      const columns = rawDb.prepare("PRAGMA table_info(onboarding_flows);").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "host_oauth_request_id")).toBe(true);
    });
  });

  it("C. reconcileRepositoryMetadataById atomically updates binding and workspace remote_url", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const user = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "gh_user_1",
      providerLogin: "testuser",
    });

    const inst = store.upsertGitHubInstallationWithUser({
      githubAppId: "123",
      githubInstallationId: "12345",
      accountId: "654321",
      accountLogin: "testuser",
      accountType: "User",
      repositorySelection: "selected",
      userId: user.user_id,
    });

    const bound = store.createWorkspaceWithRepositoryBinding({
      userId: user.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "999888",
      ownerAccountId: "654321",
      ownerLogin: "testuser",
      repositoryName: "ceo-data",
      fullName: "testuser/ceo-data",
      branch: "main",
    });

    // Check initial workspace remote_url
    const initialWs = store.findWorkspaceById(bound.workspace.id)!;
    expect(initialWs.remote_url).toBe("https://github.com/testuser/ceo-data.git");

    // Atomically reconcile metadata when renamed to my-life
    const reconciled = store.reconcileRepositoryMetadataById({
      githubRepositoryId: "999888",
      ownerLogin: "testuser",
      repositoryName: "my-life",
      fullName: "testuser/my-life",
    });

    expect(reconciled.binding.full_name).toBe("testuser/my-life");
    expect(reconciled.binding.repository_name).toBe("my-life");
    expect(reconciled.workspaceRemoteUrl).toBe("https://github.com/testuser/my-life.git");

    const updatedWs = store.findWorkspaceById(bound.workspace.id)!;
    expect(updatedWs.remote_url).toBe("https://github.com/testuser/my-life.git");
  });

  it("D. isWorkspaceReadyForHost fails-closed on non-READY bootstrap", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    const user = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "gh_user_1",
      providerLogin: "testuser",
    });

    const inst = store.upsertGitHubInstallationWithUser({
      githubAppId: "123",
      githubInstallationId: "12345",
      accountId: "654321",
      accountLogin: "testuser",
      accountType: "User",
      repositorySelection: "selected",
      userId: user.user_id,
    });

    const bound = store.createWorkspaceWithRepositoryBinding({
      userId: user.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "999888",
      ownerAccountId: "654321",
      ownerLogin: "testuser",
      repositoryName: "ceo-data",
      fullName: "testuser/ceo-data",
      branch: "main",
    });

    // Bootstrap is currently PENDING -> not ready
    expect(store.isWorkspaceReadyForHost(bound.workspace.id)).toBe(false);

    // Transition to READY -> still not ready until scope is verified
    const attempt = store.beginWorkspaceBootstrapAttempt(bound.workspace.id);
    store.markWorkspaceBootstrapReady(bound.workspace.id, attempt.attemptId, {
      readyCommitSha: "a".repeat(40),
    });
    expect(store.isWorkspaceReadyForHost(bound.workspace.id)).toBe(false);

    // After marking scope verified -> ready!
    store.markRepositoryBindingScopeVerified(bound.workspace.id);
    expect(store.isWorkspaceReadyForHost(bound.workspace.id)).toBe(true);
  });
});
