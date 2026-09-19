import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { IdentityStore } from "../src/identity/store.js";
import { OnboardingStore } from "../src/onboarding/store.js";
import { OnboardingService } from "../src/onboarding/service.js";
import { createOnboardingRouter } from "../src/onboarding/router.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { OAuthService } from "../src/oauth/service.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { GitHubInstallationService } from "../src/github/installation-service.js";
import { GitHubRepositoryService, GitHubPartialCreationError } from "../src/github/repository-service.js";
import { WorkspaceBootstrapService } from "../src/github/bootstrap-service.js";
import { GitHubAppGitCredentialProvider } from "../src/runtime/credentials.js";
import { WorkspaceRuntimeRegistry } from "../src/runtime/registry.js";
import { seedIdentity } from "./helpers.js";

import { OAuthStore } from "../src/oauth/store.js";

describe("Onboarding & Host Runtime Security Hardening", () => {
  let tempDir: string;
  let dbPath: string;
  let store: IdentityStore;
  let onboardingStore: OnboardingStore;
  let oauthStore: OAuthStore;
  let sessionManager: UserSessionManager;
  let oauthService: OAuthService;
  let bootstrapService: WorkspaceBootstrapService;
  let installationService: GitHubInstallationService;
  let repositoryService: GitHubRepositoryService;
  let onboardingService: OnboardingService;

  const mockAppClient: any = {
    getInstallation: vi.fn(),
    getInstallationToken: vi.fn().mockResolvedValue("ghs_mock_inst_token"),
    getScopedInstallationToken: vi.fn().mockResolvedValue("ghs_scoped_token"),
    mintInstallationVerificationToken: vi.fn().mockResolvedValue("ghs_verify_token"),
    invalidateInstallationTokens: vi.fn(),
  };

  let mockFetch: any;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ceo-sec-hardening-"));
    dbPath = path.join(tempDir, "identity.sqlite");
    seedIdentity({ identityDbPath: dbPath, remoteUrl: "https://github.com/test-owner/test-repo.git", branch: "main" }, "test-key");

    store = IdentityStore.open(dbPath);
    onboardingStore = new OnboardingStore(store);
    oauthStore = new OAuthStore(path.join(tempDir, "oauth.sqlite"));

    sessionManager = new UserSessionManager(store, {
      cookieSecret: "test-secret-at-least-32-chars-long!!",
      cookieName: "ceo_user_session",
    });

    oauthService = new OAuthService(oauthStore, store, {
      publicOrigin: "https://ceo.sentimentalk.com",
      clientResolver: {
        resolve: async (clientId: string) => ({
          client_id: clientId,
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/callback"],
        }),
      } as any,
    });

    mockFetch = vi.fn();

    bootstrapService = new WorkspaceBootstrapService({
      appClient: mockAppClient,
      store,
      fetchFn: mockFetch,
    });

    installationService = new GitHubInstallationService({
      appClient: mockAppClient,
      store,
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      appSlug: "ceo-app",
      callbackUrl: "http://localhost/auth/callback",
    });

    repositoryService = new GitHubRepositoryService({
      appClient: mockAppClient,
      store,
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
      callbackUrl: "http://localhost/repo/callback",
      fetchFn: mockFetch,
    });

    onboardingService = new OnboardingService({
      store: onboardingStore,
      identityStore: store,
      installationService,
      repositoryService,
      bootstrapService,
      appClient: mockAppClient,
      fetchFn: mockFetch,
    });
  });

  afterEach(async () => {
    store.close();
    oauthStore.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedUserWithWorkspace(options?: {
    scopeVerified?: boolean;
    bootstrapState?: "PENDING" | "READY" | "RETRYABLE_FAILURE";
  }) {
    const userId = "usr_sec_1";
    const workspaceId = "ws_sec_1";
    const repoId = "100200";
    const now = Date.now();

    store.withDb((db) => {
      db.prepare("INSERT OR REPLACE INTO users (id, created_at) VALUES (?, ?);").run(userId, now);
      db.prepare("INSERT OR REPLACE INTO workspaces (id, owner_user_id, remote_url, branch, created_at) VALUES (?, ?, ?, 'main', ?);")
        .run(workspaceId, userId, "https://github.com/alice/personal-vault.git", now);
      db.prepare("INSERT OR REPLACE INTO workspace_memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?);")
        .run("wsm_sec_1", workspaceId, userId, now);
      db.prepare(`
        INSERT OR REPLACE INTO github_installations (
          id, github_installation_id, github_app_id, account_id, account_login,
          account_type, repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('ghi_sec_1', '998877', 'app_1', '12345', 'alice', 'User', 'selected', NULL, ?, ?);
      `).run(now, now);
      db.prepare(`
        INSERT OR REPLACE INTO github_repository_bindings (
          id, workspace_id, github_repository_id, github_installation_row_id,
          owner_account_id, owner_login, repository_name, full_name,
          branch, access_scope_verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('grb_sec_1', ?, ?, 'ghi_sec_1', '12345', 'alice', 'personal-vault', 'alice/personal-vault', 'main', ?, ?, ?);
      `).run(workspaceId, repoId, options?.scopeVerified ? now : null, now, now);
      db.prepare(`
        INSERT OR REPLACE INTO workspace_bootstraps (
          workspace_id, bootstrap_version, state, attempt_count,
          last_attempt_id, last_base_commit_sha, ready_commit_sha,
          created_at_ms, updated_at_ms, ready_at_ms
        ) VALUES (?, 1, ?, 1, 'att_1', 'sha_base', ?, ?, ?, ?);
      `).run(
        workspaceId,
        options?.bootstrapState ?? "READY",
        options?.bootstrapState === "READY" ? "sha_ready" : null,
        now,
        now,
        options?.bootstrapState === "READY" ? now : null,
      );
    });

    return { userId, workspaceId, repoId };
  }

  it("1. verifyLiveInstallationScope fails closed when repository_selection is 'all'", async () => {
    const { workspaceId } = seedUserWithWorkspace();
    mockAppClient.getInstallation.mockResolvedValueOnce({
      id: 998877,
      repository_selection: "all",
      suspended_at: null,
    });

    const result = await onboardingService.verifyLiveInstallationScope(workspaceId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("STILL_ALL");
    }
  });

  it("2. verifyLiveInstallationScope fails closed when extra repositories or repo mismatch occurs", async () => {
    const { workspaceId } = seedUserWithWorkspace();
    mockAppClient.getInstallation.mockResolvedValueOnce({
      id: 998877,
      repository_selection: "selected",
      suspended_at: null,
    });
    // Return multiple repositories (broad scope violation)
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      total_count: 2,
      repositories: [
        { id: 100200, name: "personal-vault", full_name: "alice/personal-vault" },
        { id: 100201, name: "other-secret-repo", full_name: "alice/other-secret-repo" },
      ],
    }), { status: 200 }));

    const result = await onboardingService.verifyLiveInstallationScope(workspaceId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("SCOPE_MISMATCH");
    }
  });

  it("3. verifyLiveInstallationScope succeeds only on exact match and reconciles metadata", async () => {
    const { workspaceId } = seedUserWithWorkspace();
    mockAppClient.getInstallation.mockResolvedValueOnce({
      id: 998877,
      repository_selection: "selected",
      suspended_at: null,
    });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      total_count: 1,
      repositories: [
        { id: 100200, name: "personal-vault", full_name: "alice/personal-vault" },
      ],
    }), { status: 200 }));

    const result = await onboardingService.verifyLiveInstallationScope(workspaceId);
    expect(result.success).toBe(true);
  });

  it("4. isWorkspaceReadyForHost() fails-closed if access_scope_verified_at_ms is NULL", () => {
    const { workspaceId } = seedUserWithWorkspace({ scopeVerified: false, bootstrapState: "READY" });
    expect(store.isWorkspaceReadyForHost(workspaceId)).toBe(false);

    store.markRepositoryBindingScopeVerified(workspaceId);
    expect(store.isWorkspaceReadyForHost(workspaceId)).toBe(true);

    store.clearRepositoryBindingScopeVerified(workspaceId);
    expect(store.isWorkspaceReadyForHost(workspaceId)).toBe(false);
  });

  it("5. Host OAuth /authorize revokes access and redirects to security gate if live verification fails", async () => {
    const { userId, workspaceId } = seedUserWithWorkspace({ scopeVerified: true, bootstrapState: "READY" });
    const session = sessionManager.createSession({
      userId,
      provider: "github",
      providerSubject: "12345",
      providerLogin: "alice",
    });

    const app = express();
    app.use(createOAuthRouter({
      oauthService,
      sessionManager,
      identityStore: store,
      onboardingService,
      onboardingStore,
    }));

    const server = app.listen(0);
    const port = (server.address() as any).port;

    // Simulate GitHub App access being re-expanded to 'all'
    mockAppClient.getInstallation.mockResolvedValueOnce({
      id: 998877,
      repository_selection: "all",
      suspended_at: null,
    });

    try {
      const authUrl = `http://127.0.0.1:${port}/authorize?response_type=code&client_id=${encodeURIComponent("https://chatgpt.com/client.json")}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&scope=mcp&state=xyz123&code_challenge=E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0&code_challenge_method=S256&resource=${encodeURIComponent("https://ceo.sentimentalk.com/mcp")}`;
      const res = await fetch(authUrl, {
        headers: { Cookie: `ceo_user_session=${session.sessionId}` },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/onboarding/security");

      // Durable DB check: access_scope_verified_at_ms was revoked!
      const binding = store.findRepositoryBindingByWorkspaceId(workspaceId);
      expect(binding?.access_scope_verified_at_ms).toBeNull();
      expect(store.isWorkspaceReadyForHost(workspaceId)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("6. POST /onboarding/retry rejects retry when access_scope_verified_at_ms is NULL", async () => {
    const { userId, workspaceId } = seedUserWithWorkspace({ scopeVerified: false, bootstrapState: "READY" });
    const session = sessionManager.createSession({
      userId,
      provider: "github",
      providerSubject: "12345",
      providerLogin: "alice",
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use("/onboarding", createOnboardingRouter({
      onboardingService,
      sessionManager,
      identityStore: store,
      installationService,
      repositoryService,
      oauthService,
    }));

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/onboarding/retry`, {
        method: "POST",
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ workspace_id: workspaceId }).toString(),
        redirect: "manual",
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Repository access restriction has not been verified");
    } finally {
      server.close();
    }
  });

  it("7. GET /onboarding cleanly reconciles crash during PROVISIONING without re-authenticating", async () => {
    const { userId, workspaceId } = seedUserWithWorkspace({ scopeVerified: false, bootstrapState: "READY" });
    const session = sessionManager.createSession({
      userId,
      provider: "github",
      providerSubject: "12345",
      providerLogin: "alice",
    });

    // Create flow in PROVISIONING state
    const flow = onboardingStore.getOrCreateActiveFlowInTx(userId, "12345");
    onboardingStore.updateFlow(flow.id, {
      workspace_id: workspaceId,
      state: "PROVISIONING",
    });

    const app = express();
    app.use("/onboarding", createOnboardingRouter({
      onboardingService,
      sessionManager,
      identityStore: store,
      installationService,
      repositoryService,
      oauthService,
    }));

    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/onboarding`, {
        headers: { Cookie: `ceo_user_session=${session.sessionId}` },
        redirect: "manual",
      });

      // Redirects to security gate since scope is unverified
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/onboarding/security");

      const updatedFlow = onboardingStore.getFlow(flow.id);
      expect(updatedFlow?.state).toBe("AWAITING_REPOSITORY_RESTRICTION");
    } finally {
      server.close();
    }
  });

  it("8. GitHubAppGitCredentialProvider strictly mints scoped tokens per repository ID", async () => {
    let requestedScope: any;
    const client: any = {
      getScopedInstallationToken: async (req: any) => {
        requestedScope = req;
        return "ghs_strictly_scoped_token";
      },
    };

    const provider = new GitHubAppGitCredentialProvider(client, "inst_123", "repo_456");
    const cred = await provider.getCredential();

    expect(cred).toEqual({
      username: "x-access-token",
      token: "ghs_strictly_scoped_token",
    });
    expect(requestedScope).toEqual({
      githubInstallationId: "inst_123",
      repositoryIds: ["repo_456"],
      permissions: { contents: "write" },
    });
  });

  it("9. WorkspaceRuntimeRegistry rejects unverified workspace runtime resolution", async () => {
    const { workspaceId } = seedUserWithWorkspace({ scopeVerified: false, bootstrapState: "READY" });
    const registry = new WorkspaceRuntimeRegistry({
      store,
      dataRoot: path.join(tempDir, "runtimes"),
      gitConfig: {
        gitAuthorName: "CEO Bot",
        gitAuthorEmail: "bot@ceo.dev",
        gitCommitterName: "CEO Bot",
        gitCommitterEmail: "bot@ceo.dev",
      },
      credentialProviderFactory: () => ({ getCredential: async () => ({ kind: "none" }) }),
      workspaceFactory: (cfg) => ({
        config: cfg,
        initialize: async () => {},
        withReadyWorkspace: async (fn: any) => fn(),
      } as any),
    });

    await expect(registry.get(workspaceId)).rejects.toMatchObject({
      name: "WorkspaceRuntimeResolutionError",
      code: "REPOSITORY_SCOPE_NOT_VERIFIED",
    });

    store.markRepositoryBindingScopeVerified(workspaceId);
    // After verification, it passes the verification check
    const runtime = await registry.get(workspaceId);
    expect(runtime).toBeDefined();
  });
});
