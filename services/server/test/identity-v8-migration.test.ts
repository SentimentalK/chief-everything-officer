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

describe("onboarding host readiness and repository metadata reconcile", () => {
  it("enforces one active onboarding flow including AWAITING_REPOSITORY_RESTRICTION", async () => {
    const { dbPath } = await tempDbPath();
    provisionEmptyControlPlaneDatabase(dbPath);
    const store = IdentityStore.open(dbPath);
    cleanupStores.push(store);

    store.withDb((rawDb: DatabaseSync) => {
      const v = rawDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(Number(v.user_version)).toBe(IDENTITY_DB_USER_VERSION);

      const columns = rawDb.prepare("PRAGMA table_info(onboarding_flows);").all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === "host_oauth_request_id")).toBe(true);

      rawDb.prepare("INSERT INTO users (id, created_at) VALUES ('usr_flow_1', 1000);").run();
      rawDb.prepare(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name,
          installation_row_id, repository_id, workspace_id, state,
          last_error_code, last_error_message, host_oauth_request_id,
          created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (
          'onb_1', 'usr_flow_1', 'sub_1', 'create', 'ceo-data',
          NULL, 'repo_123', NULL, 'AWAITING_REPOSITORY_RESTRICTION', NULL, NULL, 'oar_test_123', 1000, 1000, 5000
        );
      `).run();

      const flowRow = rawDb.prepare("SELECT host_oauth_request_id FROM onboarding_flows WHERE id = 'onb_1';").get() as {
        host_oauth_request_id: string;
      };
      expect(flowRow.host_oauth_request_id).toBe("oar_test_123");

      expect(() => {
        rawDb.prepare(`
          INSERT INTO onboarding_flows (
            id, user_id, provider_subject, mode, desired_repository_name,
            installation_row_id, repository_id, workspace_id, state,
            last_error_code, last_error_message, host_oauth_request_id,
            created_at_ms, updated_at_ms, expires_at_ms
          ) VALUES (
            'onb_2', 'usr_flow_1', 'sub_1', 'create', 'ceo-data-2',
            NULL, NULL, NULL, 'AWAITING_REPOSITORY_RESTRICTION', NULL, NULL, NULL, 1000, 1000, 5000
          );
        `).run();
      }).toThrow(/UNIQUE constraint failed/);

      rawDb.prepare(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name,
          installation_row_id, repository_id, workspace_id, state,
          last_error_code, last_error_message, host_oauth_request_id,
          created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (
          'onb_3', 'usr_flow_1', 'sub_1', 'create', 'ceo-data-completed',
          NULL, NULL, NULL, 'COMPLETED', NULL, NULL, NULL, 1000, 1000, 5000
        );
      `).run();
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
