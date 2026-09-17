import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import {
  WorkspaceRuntimeRegistry,
} from "../src/runtime/registry.js";
import type { GitHubAppClient } from "../src/github/app-client.js";
import { CeoWorkspace } from "../src/workspace.js";
import type { WorkspaceRuntimeConfig } from "../src/runtime/types.js";

describe("WorkspaceRuntimeRegistry", () => {
  let tempDir: string;
  let dbPath: string;
  let store: IdentityStore;
  const cleanupDirs: string[] = [];
  const cleanupStores: IdentityStore[] = [];

  const mockAppClient = {
    getInstallationToken: async (installationId: string) => `ghs_mock_${installationId}`,
  } as unknown as GitHubAppClient;

  const defaultGitConfig = {
    gitAuthorName: "CEO Bot",
    gitAuthorEmail: "bot@ceo.dev",
    gitCommitterName: "CEO Committer",
    gitCommitterEmail: "committer@ceo.dev",
  };

  function createMockWorkspace(cfg: WorkspaceRuntimeConfig): CeoWorkspace {
    return {
      config: cfg,
      initialize: async () => {},
      withReadyWorkspace: async (fn: any) => fn(),
      workspaceStatus: async () => ({
        clean: true,
        branch: cfg.branch,
        head_commit: "0000000000000000000000000000000000000000",
        local_commit: "0000000000000000000000000000000000000000",
        remote_commit: "0000000000000000000000000000000000000000",
      }),
    } as unknown as CeoWorkspace;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ceo-runtime-test-"));
    cleanupDirs.push(tempDir);
    dbPath = path.join(tempDir, "identity.sqlite");

    provisionEmptyIdentityDatabase(dbPath, {
      remoteUrl: "git@github.com:test-owner/test-repo.git",
      branch: "main",
      apiKeyDigest: sha256Hex("test-key"),
    });

    store = IdentityStore.open(dbPath);
    cleanupStores.push(store);
  });

  afterEach(async () => {
    for (const s of cleanupStores) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    cleanupStores.length = 0;

    for (const dir of cleanupDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    cleanupDirs.length = 0;
  });

  function seedWorkspaceFixture(options: {
    workspaceId: string;
    userId?: string;
    installationRowId?: string;
    githubInstallationId?: string;
    isSuspended?: boolean;
    githubRepositoryId?: string;
    ownerLogin?: string;
    repositoryName?: string;
    fullName?: string;
    branch?: string;
    bootstrapState?: "PENDING" | "APPLYING" | "READY" | "FAILED";
  }) {
    const userId = options.userId ?? "usr_test_1";
    const installationRowId = options.installationRowId ?? "ghi_1";
    const githubInstallationId = options.githubInstallationId ?? "123456";
    const githubRepositoryId = options.githubRepositoryId ?? "654321";
    const ownerLogin = options.ownerLogin ?? "test-owner";
    const repositoryName = options.repositoryName ?? "test-repo";
    const fullName = options.fullName ?? `${ownerLogin}/${repositoryName}`;
    const branch = options.branch ?? "main";
    const bootstrapState = options.bootstrapState ?? "READY";

    store.withDb((db) => {
      const nowMs = Date.now();
      // Insert user if not exists
      db.prepare(`
        INSERT OR IGNORE INTO users (id, created_at)
        VALUES (?, ?);
      `).run(userId, nowMs);

      // Insert workspace
      db.prepare(`
        INSERT OR REPLACE INTO workspaces (id, owner_user_id, remote_url, branch, created_at)
        VALUES (?, ?, ?, ?, ?);
      `).run(options.workspaceId, userId, `https://github.com/${fullName}.git`, branch, nowMs);

      // Insert installation
      db.prepare(`
        INSERT OR REPLACE INTO github_installations (
          id, github_installation_id, github_app_id, account_id, account_login,
          account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'app_1', 'acct_1', ?, 'User', 'selected', ?, ?, ?);
      `).run(
        installationRowId,
        githubInstallationId,
        ownerLogin,
        options.isSuspended ? nowMs : null,
        nowMs,
        nowMs,
      );

      // Insert repository binding
      db.prepare(`
        INSERT OR REPLACE INTO github_repository_bindings (
          id, workspace_id, github_repository_id, github_installation_row_id,
          owner_account_id, owner_login, repository_name, full_name,
          branch, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'acct_1', ?, ?, ?, ?, ?, ?);
      `).run(
        `grb_${options.workspaceId}`,
        options.workspaceId,
        githubRepositoryId,
        installationRowId,
        ownerLogin,
        repositoryName,
        fullName,
        branch,
        nowMs,
        nowMs,
      );

      // Insert bootstrap
      if (bootstrapState) {
        db.prepare(`
          INSERT OR REPLACE INTO workspace_bootstraps (
            workspace_id, bootstrap_version, state, attempt_count,
            last_attempt_id, last_base_commit_sha, ready_commit_sha,
            created_at_ms, updated_at_ms, ready_at_ms
          ) VALUES (?, 1, ?, 1, 'att_1', '0123456789abcdef0123456789abcdef01234567', ?, ?, ?, ?);
        `).run(
          options.workspaceId,
          bootstrapState,
          bootstrapState === "READY" ? "abcdef0123456789abcdef0123456789abcdef01" : null,
          nowMs,
          nowMs,
          bootstrapState === "READY" ? nowMs : null,
        );
      }
    });
  }

  it("resolves descriptor, isolates filesystem, and constructs runtime", async () => {
    seedWorkspaceFixture({ workspaceId: "ws_alpha" });

    let capturedConfig: WorkspaceRuntimeConfig | null = null;
    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: tempDir,
      gitConfig: defaultGitConfig,
      appClient: mockAppClient,
      workspaceFactory: (cfg) => {
        capturedConfig = cfg;
        return createMockWorkspace(cfg);
      },
    });

    const runtime = await registry.get("ws_alpha");

    expect(runtime.workspaceId).toBe("ws_alpha");
    expect(runtime.descriptor).toEqual({
      workspaceId: "ws_alpha",
      repositoryId: "654321",
      installationId: "123456",
      ownerLogin: "test-owner",
      repositoryName: "test-repo",
      fullName: "test-owner/test-repo",
      branch: "main",
    });

    const expectedWsDir = path.join(tempDir, "workspaces", "ws_alpha");
    expect(runtime.paths.workspaceDir).toBe(expectedWsDir);
    expect(runtime.paths.repoDir).toBe(path.join(expectedWsDir, "repo"));
    expect(runtime.paths.txnDir).toBe(path.join(expectedWsDir, "txns"));
    expect(runtime.paths.stateDir).toBe(path.join(expectedWsDir, "state"));

    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.workspaceId).toBe("ws_alpha");
    expect(capturedConfig!.dataRoot).toBe(expectedWsDir);
    expect(capturedConfig!.repoDir).toBe(path.join(expectedWsDir, "repo"));
    expect(capturedConfig!.remoteUrl).toBe("https://github.com/test-owner/test-repo.git");
    expect(capturedConfig!.branch).toBe("main");
    expect(capturedConfig!.credentialProvider).toBeDefined();

    expect(runtime.resourceService).toBeDefined();
  });

  it("caches and reuses runtime instance for the same workspace_id", async () => {
    seedWorkspaceFixture({ workspaceId: "ws_alpha" });

    let initCallCount = 0;
    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: tempDir,
      gitConfig: defaultGitConfig,
      appClient: mockAppClient,
      workspaceFactory: (cfg) => {
        initCallCount++;
        return createMockWorkspace(cfg);
      },
    });

    const first = await registry.get("ws_alpha");
    const second = await registry.get("ws_alpha");

    expect(first).toBe(second);
    expect(initCallCount).toBe(1);
  });

  it("deduplicates concurrent initialization for the same workspace_id", async () => {
    seedWorkspaceFixture({ workspaceId: "ws_alpha" });

    let initCallCount = 0;
    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: tempDir,
      gitConfig: defaultGitConfig,
      appClient: mockAppClient,
      workspaceFactory: (cfg) => {
        initCallCount++;
        return createMockWorkspace(cfg);
      },
    });

    const [first, second, third] = await Promise.all([
      registry.get("ws_alpha"),
      registry.get("ws_alpha"),
      registry.get("ws_alpha"),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(initCallCount).toBe(1);
  });

  it("evicts failed initialization from cache so subsequent call retries", async () => {
    seedWorkspaceFixture({ workspaceId: "ws_alpha" });

    let shouldFail = true;
    let callCount = 0;
    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: tempDir,
      gitConfig: defaultGitConfig,
      appClient: mockAppClient,
      workspaceFactory: (cfg) => {
        callCount++;
        if (shouldFail) {
          throw new Error("Simulated initialization failure");
        }
        return createMockWorkspace(cfg);
      },
    });

    await expect(registry.get("ws_alpha")).rejects.toThrow("Simulated initialization failure");
    expect(callCount).toBe(1);

    // After failure, retry succeeds
    shouldFail = false;
    const runtime = await registry.get("ws_alpha");
    expect(runtime.workspaceId).toBe("ws_alpha");
    expect(callCount).toBe(2);

    // Subsequent call uses cached instance
    const cached = await registry.get("ws_alpha");
    expect(cached).toBe(runtime);
    expect(callCount).toBe(2);
  });

  it("maintains separate filesystem paths and state between multiple workspaces", async () => {
    seedWorkspaceFixture({
      workspaceId: "ws_alpha",
      ownerLogin: "alpha-org",
      repositoryName: "repo-a",
      githubRepositoryId: "1001",
      installationRowId: "ghi_alpha",
      githubInstallationId: "2001",
    });
    seedWorkspaceFixture({
      workspaceId: "ws_beta",
      ownerLogin: "beta-org",
      repositoryName: "repo-b",
      githubRepositoryId: "1002",
      installationRowId: "ghi_beta",
      githubInstallationId: "2002",
    });

    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: tempDir,
      gitConfig: defaultGitConfig,
      appClient: mockAppClient,
      workspaceFactory: createMockWorkspace,
    });

    const [runtimeA, runtimeB] = await Promise.all([
      registry.get("ws_alpha"),
      registry.get("ws_beta"),
    ]);

    expect(runtimeA.workspaceId).toBe("ws_alpha");
    expect(runtimeB.workspaceId).toBe("ws_beta");
    expect(runtimeA.paths.workspaceDir).not.toBe(runtimeB.paths.workspaceDir);
    expect(runtimeA.descriptor.fullName).toBe("alpha-org/repo-a");
    expect(runtimeB.descriptor.fullName).toBe("beta-org/repo-b");
  });

  describe("control plane validation errors", () => {
    it("rejects non-existent workspace with WORKSPACE_NOT_FOUND", async () => {
      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_nonexistent")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "WORKSPACE_NOT_FOUND",
      });
    });

    it("rejects workspace with missing repository binding", async () => {
      store.withDb((db) => {
        db.prepare(`
          INSERT OR IGNORE INTO users (id, created_at)
          VALUES ('usr_test_1', 1000);
        `).run();
        db.prepare(`
          INSERT INTO workspaces (id, owner_user_id, remote_url, branch, created_at)
          VALUES ('ws_no_binding', 'usr_test_1', 'https://github.com/a/b.git', 'main', 1000);
        `).run();
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_no_binding")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "REPOSITORY_BINDING_NOT_FOUND",
      });
    });

    it("rejects workspace when bootstrap is missing", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_no_bootstrap" });
      store.withDb((db) => {
        db.prepare("DELETE FROM workspace_bootstraps WHERE workspace_id = 'ws_no_bootstrap';").run();
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_no_bootstrap")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "BOOTSTRAP_NOT_FOUND",
      });
    });

    it("rejects workspace when bootstrap state is not READY", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_applying", bootstrapState: "APPLYING" });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_applying")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "BOOTSTRAP_NOT_READY",
      });
    });

    it("rejects workspace when GitHub installation is missing", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_no_inst" });
      store.withDb((db) => {
        db.exec("PRAGMA foreign_keys = OFF;");
        db.prepare("DELETE FROM github_installations WHERE id = 'ghi_1';").run();
        db.exec("PRAGMA foreign_keys = ON;");
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_no_inst")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INSTALLATION_NOT_FOUND",
      });
    });

    it("rejects workspace when GitHub installation is suspended", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_suspended", isSuspended: true });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_suspended")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INSTALLATION_SUSPENDED",
      });
    });

    it("rejects non-positive decimal repository ID", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_bad_repo_id", githubRepositoryId: "0" });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_bad_repo_id")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects non-positive decimal installation ID", async () => {
      seedWorkspaceFixture({ workspaceId: "ws_bad_inst_id", githubInstallationId: "-123" });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_bad_inst_id")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects invalid owner login format", async () => {
      seedWorkspaceFixture({
        workspaceId: "ws_bad_owner",
        ownerLogin: "-invalid-start-hyphen",
        fullName: "-invalid-start-hyphen/test-repo",
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_bad_owner")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects invalid repository name format", async () => {
      seedWorkspaceFixture({
        workspaceId: "ws_bad_repo_name",
        repositoryName: "..",
        fullName: "test-owner/..",
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_bad_repo_name")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects repository full_name mismatch with owner/repo", async () => {
      seedWorkspaceFixture({
        workspaceId: "ws_mismatch",
        ownerLogin: "test-owner",
        repositoryName: "test-repo",
        fullName: "test-owner/different-repo",
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_mismatch")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects full_name containing path traversal or scheme", async () => {
      seedWorkspaceFixture({
        workspaceId: "ws_traversal",
        ownerLogin: "test-owner",
        repositoryName: "repo",
        fullName: "test-owner/repo/../bad",
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_traversal")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });

    it("rejects invalid branch containing control characters or empty", async () => {
      seedWorkspaceFixture({
        workspaceId: "ws_bad_branch",
        branch: "main\0extra",
      });

      const registry = new WorkspaceRuntimeRegistry({
        store,
        dataRoot: tempDir,
        gitConfig: defaultGitConfig,
        appClient: mockAppClient,
        workspaceFactory: createMockWorkspace,
      });

      await expect(registry.get("ws_bad_branch")).rejects.toMatchObject({
        name: "WorkspaceRuntimeResolutionError",
        code: "INVALID_REPOSITORY_DATA",
      });
    });
  });
});
