import { describe, expect, it, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
} from "../src/identity/store.js";
import { OnboardingStore } from "../src/onboarding/store.js";
import { OnboardingService } from "../src/onboarding/service.js";
import { OnboardingError } from "../src/onboarding/types.js";
import { createOnboardingRouter } from "../src/onboarding/router.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OAuthService } from "../src/oauth/service.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { GitHubAppClient } from "../src/github/app-client.js";
import { GitHubInstallationService } from "../src/github/installation-service.js";
import {
  GitHubRepositoryService,
  GitHubPartialCreationError,
} from "../src/github/repository-service.js";
import {
  WorkspaceBootstrapService,
} from "../src/github/bootstrap-service.js";
import {
  createGitHubAppAuthRouter,
} from "../src/github/router.js";
import { seedIdentity } from "./helpers.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];
const cleanupOAuthStores: OAuthStore[] = [];

afterEach(async () => {
  for (const st of cleanupOAuthStores.splice(0)) st.close();
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function generateTestRsaKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

interface TestContext {
  dir: string;
  identDbPath: string;
  store: IdentityStore;
  onboardingStore: OnboardingStore;
  sessionManager: UserSessionManager;
  rsaKeys: { privateKey: string; publicKey: string };
  appClient: GitHubAppClient;
  installationService: GitHubInstallationService;
  repositoryService: GitHubRepositoryService;
  bootstrapService: WorkspaceBootstrapService;
  onboardingService: OnboardingService;
  oauthStore: OAuthStore;
  oauthService: OAuthService;
  userWithWorkspace: {
    userId: string;
    workspaceId: string;
    providerSubject: string;
  };
  freshUser: {
    userId: string;
    providerSubject: string;
  };
}

async function createTestContext(): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-onboarding-test-"));
  cleanupDirs.push(dir);
  const identDbPath = path.join(dir, "identity.sqlite");

  // Seed user with 1 workspace
  const ident = seedIdentity(
    { identityDbPath: identDbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" },
    "test-key",
  );
  const store = IdentityStore.open(identDbPath);
  cleanupStores.push(store);

  const onboardingStore = new OnboardingStore(store);

  // Link GitHub external identity to userWithWorkspace
  const db = new DatabaseSync(identDbPath);
  db.prepare(`
    INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
    VALUES ('ext_init', 'github', '123456', ?, 'dev-user-1', 1000, 1000);
  `).run(ident.user_id);
  db.close();

  // Create GitHub installation for seeded user
  const initInst = store.upsertGitHubInstallationWithUser({
    githubAppId: "10",
    githubInstallationId: "5555",
    accountId: "123456",
    accountLogin: "dev-user-1",
    accountType: "User",
    repositorySelection: "all",
    userId: ident.user_id,
  });

  // Bind repository and initialize workspace bootstrap
  store.withDb((db) => {
    db.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name,
        branch, created_at_ms, updated_at_ms
      ) VALUES ('grb_init', ?, '998877', ?, '123456', 'dev-user-1', 'initial-repo', 'dev-user-1/initial-repo', 'main', 1000, 1000);
    `).run(ident.workspace_id, initInst.installation.id);

    db.prepare(`
      INSERT INTO workspace_bootstraps (
        workspace_id, bootstrap_version, state, attempt_count,
        last_attempt_id, last_base_commit_sha, ready_commit_sha,
        last_error_kind, last_error_code, last_error_message,
        created_at_ms, updated_at_ms, ready_at_ms
      ) VALUES (?, 1, 'PENDING', 0, NULL, NULL, NULL, NULL, NULL, NULL, 1000, 1000, NULL);
    `).run(ident.workspace_id);
  });

  // Create a fresh user with 0 workspaces
  const freshUserExt = store.resolveOrCreateExternalUser({
    provider: "github",
    providerSubject: "654321",
    providerLogin: "fresh-user",
  });

  const sessionManager = new UserSessionManager({ secureCookies: false });
  const rsaKeys = generateTestRsaKeyPair();

  const appClient = new GitHubAppClient({
    clientId: "Iv1.test_client_id",
    privateKey: rsaKeys.privateKey,
  });

  const installationService = new GitHubInstallationService({
    store,
    appClient,
    clientId: "Iv1.test_client_id",
    clientSecret: "test_client_secret",
    slug: "ceo-test-app",
    callbackUrl: "http://localhost:3000/auth/github-app/callback",
  });

  const repositoryService = new GitHubRepositoryService({
    appClient,
    store,
    clientId: "Iv1.test_client_id",
    clientSecret: "test_client_secret",
    callbackUrl: "http://localhost:3000/auth/github-app/repository/callback",
  });

  const bootstrapService = new WorkspaceBootstrapService({
    store,
    appClient,
  });

  const onboardingService = new OnboardingService({
    store: onboardingStore,
    identityStore: store,
    installationService,
    repositoryService,
    bootstrapService,
    appClient,
  });

  const oauthDbPath = path.join(dir, "oauth.sqlite");
  const oauthStore = new OAuthStore(oauthDbPath);
  cleanupOAuthStores.push(oauthStore);

  const oauthService = new OAuthService(oauthStore, store, {
    publicOrigin: "https://ceo.sentimentalk.com",
    workspaceId: ident.workspace_id,
    clientResolver: {
      resolve: async (clientId: string) => ({
        client_id: clientId,
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/callback"],
      }),
    } as any,
  });

  return {
    dir,
    identDbPath,
    store,
    onboardingStore,
    sessionManager,
    rsaKeys,
    appClient,
    installationService,
    repositoryService,
    bootstrapService,
    onboardingService,
    oauthStore,
    oauthService,
    userWithWorkspace: {
      userId: ident.user_id,
      workspaceId: ident.workspace_id,
      providerSubject: "123456",
    },
    freshUser: {
      userId: freshUserExt.user_id,
      providerSubject: "654321",
    },
  };
}

describe("Component 1 & 2: Onboarding Store & Concurrency", () => {
  it("getOrCreateActiveFlowInTx creates a new flow and repeated calls return the same flow", async () => {
    const ctx = await createTestContext();
    const flow1 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    expect(flow1).toBeDefined();
    expect(flow1.id).toMatch(/^onb_/);
    expect(flow1.user_id).toBe(ctx.freshUser.userId);
    expect(flow1.state).toBe("AWAITING_REPOSITORY_CHOICE");
    expect(flow1.desired_repository_name).toBe("ceo-data");

    // Repeated call should return exact same active flow
    const flow2 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    expect(flow2.id).toBe(flow1.id);
  });

  it("enforces partial unique index: at most one active flow per user", async () => {
    const ctx = await createTestContext();
    const flow1 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    // Attempting raw insert of another active flow for the same user should violate partial unique index
    const db = new DatabaseSync(ctx.identDbPath);
    expect(() => {
      db.prepare(`
        INSERT INTO onboarding_flows (
          id, user_id, provider_subject, mode, desired_repository_name, state, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES ('onb_duplicate', ?, ?, 'create_new', 'ceo-data', 'AWAITING_REPOSITORY_CHOICE', 1000, 1000, 2000);
      `).run(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    }).toThrow(/UNIQUE constraint failed/);
    db.close();

    // But if current flow is marked COMPLETED, a new active flow can be created
    ctx.onboardingStore.updateFlow(flow1.id, { state: "COMPLETED" });
    const flow3 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    expect(flow3.id).not.toBe(flow1.id);
    expect(flow3.state).toBe("AWAITING_REPOSITORY_CHOICE");
  });

  it("cleanupExpired only cleans flows with NO repository and NO workspace", async () => {
    const ctx = await createTestContext();
    const oldMs = Date.now() - 3600_000; // 1 hour ago

    // Flow 1: expired, no repo, no workspace -> Should be cleaned up
    const db = new DatabaseSync(ctx.identDbPath);
    db.prepare(`
      INSERT INTO onboarding_flows (
        id, user_id, provider_subject, mode, desired_repository_name, state, created_at_ms, updated_at_ms, expires_at_ms
      ) VALUES ('onb_expired_1', ?, ?, 'create_new', 'ceo-data', 'ABORTED', ?, ?, ?);
    `).run(ctx.freshUser.userId, ctx.freshUser.providerSubject, oldMs, oldMs, oldMs + 100);
    db.close();

    // Flow 2: expired, but has repository_id -> MUST NOT be cleaned up
    const f2 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    ctx.onboardingStore.updateFlow(f2.id, {
      repository_id: "gh_repo_123",
      repository_name: "ceo-data",
      repository_owner: "dev-user",
      repository_full_name: "dev-user/ceo-data",
      state: "RECOVERY_REQUIRED",
      expires_at_ms: oldMs + 100,
    });

    // Run cleanup
    const cleaned = ctx.onboardingStore.cleanupExpired(Date.now());
    expect(cleaned).toBe(1);

    expect(ctx.onboardingStore.getFlow("onb_expired_1")).toBeNull();
    expect(ctx.onboardingStore.getFlow(f2.id)).not.toBeNull();
  });
});

describe("Component 2: Onboarding Service Logic", () => {
  it("submitRepositoryChoice validates repository names and updates flow", async () => {
    const ctx = await createTestContext();
    const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    // Invalid repo names
    expect(() => {
      ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, "invalid name with spaces");
    }).toThrow(OnboardingError);

    expect(() => {
      ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, ".");
    }).toThrow(OnboardingError);

    expect(() => {
      ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, "..");
    }).toThrow(OnboardingError);

    expect(() => {
      ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, "bad$character");
    }).toThrow(OnboardingError);

    expect(() => {
      ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, "a".repeat(101));
    }).toThrow(OnboardingError);

    // Valid repo name
    const updated = ctx.onboardingService.submitRepositoryChoice(flow.id, ctx.freshUser.userId, "my-ceo-repo");
    expect(updated.desired_repository_name).toBe("my-ceo-repo");
    expect(updated.state).toBe("AWAITING_GITHUB_ACCESS");
  });

  it("resolveInstallationState deep verification: requires live metadata matching DB row", async () => {
    const ctx = await createTestContext();
    const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    // 0 installations in DB
    const res1 = await ctx.onboardingService.resolveInstallationState(flow.id, ctx.freshUser.userId);
    expect(res1.status).toBe("NEED_INSTALL");

    // Insert an installation into DB
    ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "112233",
      githubAppId: "998877",
      accountId: ctx.freshUser.providerSubject,
      accountLogin: "fresh-user",
      accountType: "User",
      repositorySelection: "selected",
      userId: ctx.freshUser.userId,
    });

    // Mock live getInstallation returning mismatched app_id
    vi.spyOn(ctx.appClient, "getInstallation").mockResolvedValueOnce({
      id: 112233,
      app_id: 12345, // mismatch!
      target_id: 123,
      target_type: "User",
      account: { id: ctx.freshUser.providerSubject, type: "User" },
    });

    const res2 = await ctx.onboardingService.resolveInstallationState(flow.id, ctx.freshUser.userId);
    expect(res2.status).toBe("NEED_INSTALL");

    // Mock live getInstallation matching completely
    vi.spyOn(ctx.appClient, "getInstallation").mockResolvedValueOnce({
      id: 112233,
      app_id: 998877,
      target_id: 123,
      target_type: "User",
      account: { id: ctx.freshUser.providerSubject, type: "User" },
    });

    const res3 = await ctx.onboardingService.resolveInstallationState(flow.id, ctx.freshUser.userId);
    expect(res3.status).toBe("READY");
    if (res3.status === "READY") {
      expect(res3.installation.github_installation_id).toBe("112233");
    }
  });

  it("resolveInstallationState fails closed on multiple live installations", async () => {
    const ctx = await createTestContext();
    const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "111",
      githubAppId: "998877",
      accountId: ctx.freshUser.providerSubject,
      accountLogin: "fresh-user",
      accountType: "User",
      repositorySelection: "selected",
      userId: ctx.freshUser.userId,
    });
    ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "222",
      githubAppId: "998877",
      accountId: ctx.freshUser.providerSubject,
      accountLogin: "fresh-user",
      accountType: "User",
      repositorySelection: "selected",
      userId: ctx.freshUser.userId,
    });

    vi.spyOn(ctx.appClient, "getInstallation").mockImplementation(async (id) => ({
      id: Number(id),
      app_id: 998877,
      target_id: 123,
      target_type: "User",
      account: { id: ctx.freshUser.providerSubject, type: "User" },
    }));

    await expect(
      ctx.onboardingService.resolveInstallationState(flow.id, ctx.freshUser.userId),
    ).rejects.toThrow(/Multiple live GitHub App installations found/);
  });

  it("provisionWorkspace creates repository and transitions flow to READY_TO_RESUME", async () => {
    const ctx = await createTestContext();
    const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    const freshInst = ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "6666",
      accountId: ctx.freshUser.providerSubject,
      accountLogin: "fresh-user",
      accountType: "User",
      repositorySelection: "all",
      userId: ctx.freshUser.userId,
    });

    // Mock createRepository on repositoryService
    vi.spyOn(ctx.repositoryService, "createRepository").mockImplementation(async () => {
      const bound = ctx.store.createWorkspaceWithRepositoryBinding({
        userId: ctx.freshUser.userId,
        installationRowId: freshInst.installation.id,
        githubRepositoryId: "999888",
        ownerAccountId: ctx.freshUser.providerSubject,
        ownerLogin: "fresh-user",
        repositoryName: "my-ceo-repo",
        fullName: "fresh-user/my-ceo-repo",
        branch: "main",
      });
      return {
        workspace: bound.workspace,
        binding: bound.binding,
        bootstrap: bound.bootstrap,
      };
    });

    // Mock bootstrapWorkspace to mark ready
    vi.spyOn(ctx.bootstrapService, "bootstrapWorkspace").mockImplementation(async (workspaceId) => {
      const attempt = ctx.store.beginWorkspaceBootstrapAttempt(workspaceId);
      const ready = ctx.store.markWorkspaceBootstrapReady(workspaceId, attempt.attemptId, {
        readyCommitSha: "a".repeat(40),
      });
      return {
        workspace: ctx.store.findWorkspaceById(workspaceId)!,
        binding: ctx.store.findRepositoryBindingByWorkspaceId(workspaceId)!,
        bootstrap: ready,
        status: "READY",
      };
    });

    const result = await ctx.onboardingService.provisionWorkspace(
      flow.id,
      { sessionId: "sess_1", userId: ctx.freshUser.userId, providerSubject: ctx.freshUser.providerSubject },
      "grant_123",
    );

    expect(result.success).toBe(true);
    expect(result.workspaceId).toBeDefined();

    const updatedFlow = ctx.onboardingStore.getFlow(flow.id)!;
    expect(updatedFlow.state).toBe("READY_TO_RESUME");
    expect(updatedFlow.workspace_id).toBe(result.workspaceId);
  });

  it("handles GitHubPartialCreationError and recovers via recoverPartialCreation", async () => {
    const ctx = await createTestContext();
    const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

    const freshInst = ctx.store.upsertGitHubInstallationWithUser({
      githubAppId: "10",
      githubInstallationId: "6666",
      accountId: ctx.freshUser.providerSubject,
      accountLogin: "fresh-user",
      accountType: "User",
      repositorySelection: "all",
      userId: ctx.freshUser.userId,
    });

    // Mock createRepository throwing GitHubPartialCreationError
    vi.spyOn(ctx.repositoryService, "createRepository").mockRejectedValueOnce(
      new GitHubPartialCreationError("DB commit failed after repo creation", {
        id: "999889",
        owner: "dev-user",
        name: "ceo-data",
        full_name: "dev-user/ceo-data",
      }),
    );

    const result = await ctx.onboardingService.provisionWorkspace(
      flow.id,
      { sessionId: "sess_1", userId: ctx.freshUser.userId, providerSubject: ctx.freshUser.providerSubject },
      "grant_123",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("PARTIAL_REPOSITORY_CREATION");

    const partialFlow = ctx.onboardingStore.getFlow(flow.id)!;
    expect(partialFlow.state).toBe("RECOVERY_REQUIRED");
    expect(partialFlow.repository_id).toBe("999889");
    expect(partialFlow.last_error_message).toContain("DB commit failed");

    // Mock importRepository for recovery
    vi.spyOn(ctx.repositoryService, "importRepository").mockImplementation(async () => {
      const bound = ctx.store.createWorkspaceWithRepositoryBinding({
        userId: ctx.freshUser.userId,
        installationRowId: freshInst.installation.id,
        githubRepositoryId: "999889",
        ownerAccountId: ctx.freshUser.providerSubject,
        ownerLogin: "dev-user",
        repositoryName: "ceo-data",
        fullName: "dev-user/ceo-data",
        branch: "main",
      });
      return {
        workspace: bound.workspace,
        binding: bound.binding,
        bootstrap: bound.bootstrap,
      };
    });

    const recResult = await ctx.onboardingService.recoverPartialCreation(flow.id, {
      sessionId: "sess_1",
      userId: ctx.freshUser.userId,
      providerSubject: ctx.freshUser.providerSubject,
    });

    expect(recResult.success).toBe(true);
    const recoveredFlow = ctx.onboardingStore.getFlow(flow.id)!;
    expect(recoveredFlow.state).toBe("READY_TO_RESUME");
    expect(recoveredFlow.workspace_id).toBe(recResult.workspaceId);
  });
});

describe("Component 4: OAuth Interception & Zero-Workspace Routing", () => {
  function setupOAuthApp(ctx: TestContext) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());

    const oauthRouter = createOAuthRouter({
      oauthService: ctx.oauthService,
      sessionManager: ctx.sessionManager,
      identityStore: ctx.store,
      bootstrapService: ctx.bootstrapService,
    });
    app.use(oauthRouter);

    const onboardingRouter = createOnboardingRouter({
      onboardingService: ctx.onboardingService,
      sessionManager: ctx.sessionManager,
      identityStore: ctx.store,
      installationService: ctx.installationService,
      repositoryService: ctx.repositoryService,
      oauthService: ctx.oauthService,
    });
    app.use("/onboarding", onboardingRouter);

    const server = app.listen(0);
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      app,
      baseUrl,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("GET /authorize redirects fresh user (0 memberships) to /onboarding?oauth_request=...", async () => {
    const ctx = await createTestContext();
    const testApp = setupOAuthApp(ctx);

    try {
      // Create session for fresh user
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      // Valid CIMD authorize URL with PKCE
      const authUrl = `${testApp.baseUrl}/authorize?response_type=code&client_id=${encodeURIComponent("https://chatgpt.com/client.json")}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&scope=mcp&state=xyz123&code_challenge=E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0&code_challenge_method=S256&resource=${encodeURIComponent("https://ceo.sentimentalk.com/mcp")}`;

      const res = await fetch(authUrl, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("/onboarding?oauth_request=");
    } finally {
      await testApp.close();
    }
  });

  it("GET /authorize/resume redirects fresh user (0 memberships) to /onboarding?oauth_request=...", async () => {
    const ctx = await createTestContext();
    const testApp = setupOAuthApp(ctx);

    try {
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const reqId = "oar_resume_fresh_test";
      ctx.oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "https://chatgpt.com/client.json",
        client_name: "ChatGPT",
        redirect_uri: "https://chatgpt.com/callback",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "openid",
        state: "xyz",
        code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0",
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });

      const res = await fetch(`${testApp.baseUrl}/authorize/resume?request=${encodeURIComponent(reqId)}`, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe(`/onboarding?oauth_request=${encodeURIComponent(reqId)}`);
    } finally {
      await testApp.close();
    }
  });

  it("OAuthService.approveConsent() fails closed with 403 when user has 0 memberships", async () => {
    const ctx = await createTestContext();

    const reqId = "oar_consent_fail_test";
    ctx.oauthStore.createAuthorizationRequest({
      id: reqId,
      client_id: "https://chatgpt.com/client.json",
      client_name: "ChatGPT",
      redirect_uri: "https://chatgpt.com/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "openid",
      state: "xyz",
      code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0",
      code_challenge_method: "S256",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 600000,
    });

    const nonce = ctx.oauthService.createConsentNonce(reqId);

    expect(() => {
      ctx.oauthService.approveConsent(reqId, nonce, ctx.freshUser.userId);
    }).toThrow(/User has no accessible workspaces/);
  });

  it("GET /authorize with 1 membership: renders consent screen if bootstrap is READY", async () => {
    const ctx = await createTestContext();
    const testApp = setupOAuthApp(ctx);

    try {
      // userWithWorkspace has 1 workspace. Let's make its bootstrap READY
      const attempt = ctx.store.beginWorkspaceBootstrapAttempt(ctx.userWithWorkspace.workspaceId);
      ctx.store.markWorkspaceBootstrapReady(ctx.userWithWorkspace.workspaceId, attempt.attemptId, {
        readyCommitSha: "a".repeat(40),
      });

      const session = ctx.sessionManager.createSession({
        userId: ctx.userWithWorkspace.userId,
        provider: "github",
        providerSubject: ctx.userWithWorkspace.providerSubject,
        providerLogin: "dev-user-1",
      });

      const authUrl = `${testApp.baseUrl}/authorize?response_type=code&client_id=${encodeURIComponent("https://chatgpt.com/client.json")}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&scope=mcp&state=xyz123&code_challenge=E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0&code_challenge_method=S256&resource=${encodeURIComponent("https://ceo.sentimentalk.com/mcp")}`;

      const res = await fetch(authUrl, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
        redirect: "manual",
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorization Request");
    } finally {
      await testApp.close();
    }
  });

  it("GET /authorize with 1 membership: redirects to recovery if bootstrap is NOT ready", async () => {
    const ctx = await createTestContext();
    const testApp = setupOAuthApp(ctx);

    try {
      // Seeded workspace has state 'PENDING'
      const session = ctx.sessionManager.createSession({
        userId: ctx.userWithWorkspace.userId,
        provider: "github",
        providerSubject: ctx.userWithWorkspace.providerSubject,
        providerLogin: "dev-user-1",
      });

      const authUrl = `${testApp.baseUrl}/authorize?response_type=code&client_id=${encodeURIComponent("https://chatgpt.com/client.json")}&redirect_uri=${encodeURIComponent("https://chatgpt.com/callback")}&scope=mcp&state=xyz123&code_challenge=E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0&code_challenge_method=S256&resource=${encodeURIComponent("https://ceo.sentimentalk.com/mcp")}`;

      const res = await fetch(authUrl, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("/onboarding/recovery?workspace_id=");
    } finally {
      await testApp.close();
    }
  });
});

describe("Component 5: Full Onboarding HTTP Flow & Callback", () => {
  function setupFullApp(ctx: TestContext) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());

    const ghRouter = createGitHubAppAuthRouter({
      store: ctx.store,
      sessionManager: ctx.sessionManager,
      installationService: ctx.installationService,
      repositoryService: ctx.repositoryService,
      onboardingService: ctx.onboardingService,
    });
    app.use("/auth/github-app", ghRouter);

    const onboardingRouter = createOnboardingRouter({
      onboardingService: ctx.onboardingService,
      sessionManager: ctx.sessionManager,
      identityStore: ctx.store,
      installationService: ctx.installationService,
      repositoryService: ctx.repositoryService,
      oauthService: ctx.oauthService,
    });
    app.use("/onboarding", onboardingRouter);

    const server = app.listen(0);
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      app,
      baseUrl,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("GET /onboarding renders setup screen with default repository name", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding?oauth_request=auth_req_123`, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Set up your CEO workspace");
      expect(html).toContain('value="ceo-data"');
      expect(html).toContain('value="auth_req_123"');
    } finally {
      await testApp.close();
    }
  });

  it("POST /onboarding/repository-choice redirects to GitHub installation when 0 installations exist", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

      const params = new URLSearchParams({
        flow_id: flow.id,
        repository_name: "my-ceo-data",
        oauth_request: "auth_req_123",
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding/repository-choice`, {
        method: "POST",
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("https://github.com/apps/ceo-test-app/installations/new");
      expect(location).toContain("state=");
    } finally {
      await testApp.close();
    }
  });

  it("GET /onboarding/complete redirects to resume OAuth if request is active", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const reqId = "oar_complete_active_test";
      ctx.oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "https://chatgpt.com/client.json",
        client_name: "ChatGPT",
        redirect_uri: "https://chatgpt.com/callback",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "openid",
        state: "xyz",
        code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0",
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding/complete?oauth_request=${encodeURIComponent(reqId)}`, {
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/authorize/resume?request=${encodeURIComponent(reqId)}`);
    } finally {
      await testApp.close();
    }
  });

  it("GET /onboarding/complete shows graceful message if original OAuth request expired", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const res = await fetch(`${testApp.baseUrl}/onboarding/complete?oauth_request=expired_req_999`, {
        redirect: "manual",
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Your CEO workspace is ready!");
      expect(html).toContain("The original Host authorization request has expired");
    } finally {
      await testApp.close();
    }
  });

  it("cross-user isolation: User B cannot view User A's recovery screen", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const flowA = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
      ctx.onboardingStore.updateFlow(flowA.id, {
        state: "RECOVERY_REQUIRED",
        last_error_code: "BOOTSTRAP_FAILED",
        last_error_message: "Failed to connect",
      });

      // User B logs in
      const sessionB = ctx.sessionManager.createSession({
        userId: ctx.userWithWorkspace.userId,
        provider: "github",
        providerSubject: ctx.userWithWorkspace.providerSubject,
        providerLogin: "dev-user-1",
      });

      // User B tries to view flowA's recovery screen
      const res = await fetch(`${testApp.baseUrl}/onboarding/recovery?flow=${encodeURIComponent(flowA.id)}`, {
        headers: {
          Cookie: `ceo_user_session=${sessionB.sessionId}`,
        },
        redirect: "manual",
      });

      // Access denied / redirected
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/onboarding");
    } finally {
      await testApp.close();
    }
  });

  it("GET /onboarding/recovery with REPOSITORY_NAME_CONFLICT renders alternate name input", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
      ctx.onboardingStore.updateFlow(flow.id, {
        state: "AWAITING_REPOSITORY_CHOICE",
        last_error_code: "REPOSITORY_NAME_CONFLICT",
        last_error_message: "Repository name 'ceo-data' already exists on GitHub.",
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding/recovery?flow=${encodeURIComponent(flow.id)}`, {
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
        },
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Setup Notice");
      expect(html).toContain("already exists on GitHub");
      expect(html).toContain('value="ceo-data-2"');
    } finally {
      await testApp.close();
    }
  });

  it("POST /onboarding/retry with workspace_id retries bootstrap and redirects to complete", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      const session = ctx.sessionManager.createSession({
        userId: ctx.userWithWorkspace.userId,
        provider: "github",
        providerSubject: ctx.userWithWorkspace.providerSubject,
        providerLogin: "dev-user-1",
      });

      // Mock bootstrapWorkspace to succeed
      vi.spyOn(ctx.bootstrapService, "bootstrapWorkspace").mockImplementation(async (workspaceId) => {
        const attempt = ctx.store.beginWorkspaceBootstrapAttempt(workspaceId);
        const ready = ctx.store.markWorkspaceBootstrapReady(workspaceId, attempt.attemptId, {
          readyCommitSha: "a".repeat(40),
        });
        return {
          workspace: ctx.store.findWorkspaceById(workspaceId)!,
          binding: ctx.store.findRepositoryBindingByWorkspaceId(workspaceId)!,
          bootstrap: ready,
          status: "READY",
        };
      });

      const params = new URLSearchParams({
        workspace_id: ctx.userWithWorkspace.workspaceId,
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding/retry`, {
        method: "POST",
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/onboarding/complete");
    } finally {
      await testApp.close();
    }
  });

  it("POST /onboarding/retry with unauthorized workspace_id returns 403", async () => {
    const ctx = await createTestContext();
    const testApp = setupFullApp(ctx);

    try {
      // freshUser does NOT own userWithWorkspace's workspace
      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const params = new URLSearchParams({
        workspace_id: ctx.userWithWorkspace.workspaceId,
      });

      const res = await fetch(`${testApp.baseUrl}/onboarding/retry`, {
        method: "POST",
        headers: {
          Cookie: `ceo_user_session=${session.sessionId}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "manual",
      });

      expect(res.status).toBe(403);
    } finally {
      await testApp.close();
    }
  });
});
