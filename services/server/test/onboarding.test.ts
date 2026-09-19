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
    expect(flow1.state).toBe("AWAITING_GITHUB_ACCESS");
    expect(flow1.desired_repository_name).toBe("personal-vault");

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
        ) VALUES ('onb_duplicate', ?, ?, 'create', 'ceo-data', 'AWAITING_GITHUB_ACCESS', 1000, 1000, 2000);
      `).run(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    }).toThrow(/UNIQUE constraint failed/);
    db.close();

    // But if current flow is marked COMPLETED, a new active flow can be created
    ctx.onboardingStore.updateFlow(flow1.id, { state: "COMPLETED" });
    const flow3 = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
    expect(flow3.id).not.toBe(flow1.id);
    expect(flow3.state).toBe("AWAITING_GITHUB_ACCESS");
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

    // Mock createRepositoryAndBind on repositoryService
    vi.spyOn(ctx.repositoryService, "createRepositoryAndBind").mockImplementation(async () => {
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
    expect(updatedFlow.state).toBe("AWAITING_REPOSITORY_RESTRICTION");
    expect(updatedFlow.workspace_id).toBe(result.workspaceId);

    // Mock appClient methods for live restriction verification
    vi.spyOn(ctx.appClient, "getInstallation").mockResolvedValue({
      id: 6666,
      repository_selection: "selected",
      suspended_at: null,
    } as any);
    vi.spyOn(ctx.appClient, "mintInstallationVerificationToken").mockResolvedValue("verify_token_123");

    // Mock fetchFn on onboardingService to return exactly repo 999888
    (ctx.onboardingService as any).fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        repositories: [
          { id: 999888, name: "my-ceo-repo", full_name: "fresh-user/my-ceo-repo" },
        ],
      }),
    });

    const verifyResult = await ctx.onboardingService.verifyRepositoryAccessAndBootstrap(flow.id, ctx.freshUser.userId);
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.status).toBe("READY");

    const finalFlow = ctx.onboardingStore.getFlow(flow.id)!;
    expect(finalFlow.state).toBe("READY_TO_RESUME");
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

    // Mock createRepositoryAndBind throwing GitHubPartialCreationError
    vi.spyOn(ctx.repositoryService, "createRepositoryAndBind").mockRejectedValueOnce(
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

    // Mock importRepositoryAndBind for recovery
    vi.spyOn(ctx.repositoryService, "importRepositoryAndBind").mockImplementation(async () => {
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

    const recResult = await ctx.onboardingService.recoverPartialCreation(
      flow.id,
      {
        sessionId: "sess_1",
        userId: ctx.freshUser.userId,
        providerSubject: ctx.freshUser.providerSubject,
      },
      "grant_123",
    );

    expect(recResult.success).toBe(true);
    const recoveredFlow = ctx.onboardingStore.getFlow(flow.id)!;
    expect(recoveredFlow.state).toBe("AWAITING_REPOSITORY_RESTRICTION");
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
      onboardingService: ctx.onboardingService,
      onboardingStore: ctx.onboardingStore,
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
      // userWithWorkspace has 1 workspace. Let's make its bootstrap READY and verify scope
      const attempt = ctx.store.beginWorkspaceBootstrapAttempt(ctx.userWithWorkspace.workspaceId);
      ctx.store.markWorkspaceBootstrapReady(ctx.userWithWorkspace.workspaceId, attempt.attemptId, {
        readyCommitSha: "a".repeat(40),
      });
      ctx.store.markRepositoryBindingScopeVerified(ctx.userWithWorkspace.workspaceId);
      vi.spyOn(ctx.onboardingService, "verifyLiveInstallationScope").mockResolvedValue({
        success: true,
        binding: ctx.store.findRepositoryBindingByWorkspaceId(ctx.userWithWorkspace.workspaceId)!,
        liveRepo: { id: 1, name: "repo", full_name: "dev-user-1/repo" },
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
      ctx.store.markRepositoryBindingScopeVerified(ctx.userWithWorkspace.workspaceId);
      vi.spyOn(ctx.onboardingService, "verifyLiveInstallationScope").mockResolvedValue({
        success: true,
        binding: ctx.store.findRepositoryBindingByWorkspaceId(ctx.userWithWorkspace.workspaceId)!,
        liveRepo: { id: 1, name: "repo", full_name: "dev-user-1/repo" },
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

  it("GET /onboarding sends fresh user directly to GitHub App installation with zero intermediate UI", async () => {
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
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("https://github.com/apps/ceo-test-app/installations/new?state=");

      // Verify active flow created with default repository name and bound oauth request
      const activeFlow = ctx.onboardingStore.findActiveFlowForUser(ctx.freshUser.userId);
      expect(activeFlow).toBeDefined();
      expect(activeFlow?.desired_repository_name).toBe("personal-vault");
      expect(activeFlow?.host_oauth_request_id).toBe("auth_req_123");
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
      expect(html).toContain('value="personal-vault-2"');
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

      ctx.store.markRepositoryBindingScopeVerified(ctx.userWithWorkspace.workspaceId);

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

  describe("Authoritative Continuation & Dead Redirect Cleanup", () => {
    it("createAuthorizationRedirect binds onboardingFlowId and oauthRequest, handleOAuthCallback returns them", async () => {
      const ctx = await createTestContext();

      // Upsert installation for freshUser
      const inst = ctx.store.upsertGitHubInstallationWithUser({
        githubInstallationId: "554433",
        githubAppId: "12345",
        accountId: "654321",
        accountLogin: "fresh-user",
        accountType: "User",
        repositorySelection: "all",
        suspendedAtMs: null,
        userId: ctx.freshUser.userId,
      });

      const session = ctx.sessionManager.createSession({
        userId: ctx.freshUser.userId,
        provider: "github",
        providerSubject: ctx.freshUser.providerSubject,
        providerLogin: "fresh-user",
      });

      const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
      const oauthReq = "oar_authoritative_test";

      const auth = ctx.repositoryService.createAuthorizationRedirect({
        sessionId: session.sessionId,
        userId: session.userId,
        providerSubject: session.providerSubject,
        installationId: inst.installation.github_installation_id,
        onboardingFlowId: flow.id,
        oauthRequest: oauthReq,
      });

      expect(auth.state).toBeDefined();

      // Mock fetch for token exchange and user info
      const origFetch = (ctx.repositoryService as any).fetchFn;
      (ctx.repositoryService as any).fetchFn = async (urlStr: string) => {
        const u = String(urlStr);
        if (u.includes("oauth/access_token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "ghu_repo_auth_test" }),
          } as any;
        }
        if (u.includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [
                {
                  id: 554433,
                  app_id: 12345,
                  account: { id: 654321, login: "fresh-user", type: "User" },
                  repository_selection: "all",
                },
              ],
            }),
          } as any;
        }
        if (u.includes("/user")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 654321, login: "fresh-user" }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      const result = await ctx.repositoryService.handleOAuthCallback({
        state: auth.state,
        code: "test_oauth_code",
        currentSessionId: session.sessionId,
        currentUserId: session.userId,
        currentProviderSubject: session.providerSubject,
      });

      expect(result.grant).toBeDefined();
      expect(result.onboardingFlowId).toBe(flow.id);
      expect(result.oauthRequest).toBe(oauthReq);
    });

    it("GET /auth/github-app/repository/callback authoritatively completes onboarding when state has onboardingFlowId", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const inst = ctx.store.upsertGitHubInstallationWithUser({
          githubInstallationId: "554433",
          githubAppId: "12345",
          accountId: "654321",
          accountLogin: "fresh-user",
          accountType: "User",
          repositorySelection: "all",
          suspendedAtMs: null,
          userId: ctx.freshUser.userId,
        });

        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);
        const oauthReq = "oar_preservation_test";

        const auth = ctx.repositoryService.createAuthorizationRedirect({
          sessionId: session.sessionId,
          userId: session.userId,
          providerSubject: session.providerSubject,
          installationId: inst.installation.github_installation_id,
          onboardingFlowId: flow.id,
          oauthRequest: oauthReq,
        });

        (ctx.repositoryService as any).fetchFn = async (urlStr: string) => {
          const u = String(urlStr);
          if (u.includes("oauth/access_token")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ access_token: "ghu_repo_auth_test" }),
            } as any;
          }
          if (u.includes("/user/installations")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                total_count: 1,
                installations: [
                  {
                    id: 554433,
                    app_id: 12345,
                    account: { id: 654321, login: "fresh-user", type: "User" },
                    repository_selection: "all",
                  },
                ],
              }),
            } as any;
          }
          if (u.includes("/user")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ id: 654321, login: "fresh-user" }),
            } as any;
          }
          return { ok: false, status: 404 } as any;
        };

        // Spy provisionWorkspace
        const provisionSpy = vi.spyOn(ctx.onboardingService, "provisionWorkspace").mockResolvedValue({
          id: "ws_authtest",
          name: "ceo-data",
        } as any);

        const res = await fetch(`${testApp.baseUrl}/auth/github-app/repository/callback?state=${auth.state}&code=testcode`, {
          headers: {
            Cookie: `ceo_user_session=${session.sessionId}`,
          },
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
          `/onboarding/security?flow=${encodeURIComponent(flow.id)}&oauth_request=${encodeURIComponent(oauthReq)}`,
        );
        expect(provisionSpy).toHaveBeenCalledWith(
          flow.id,
          expect.objectContaining({ userId: session.userId }),
          expect.any(String),
        );
      } finally {
        await testApp.close();
      }
    });

    it("GET /auth/github-app/repository/callback without onboardingFlowId does NOT provision active flow", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const inst = ctx.store.upsertGitHubInstallationWithUser({
          githubInstallationId: "554433",
          githubAppId: "12345",
          accountId: "654321",
          accountLogin: "fresh-user",
          accountType: "User",
          repositorySelection: "all",
          suspendedAtMs: null,
          userId: ctx.freshUser.userId,
        });

        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        // User has an active flow in DB
        const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject);

        // Generic authorization created WITHOUT onboardingFlowId
        const auth = ctx.repositoryService.createAuthorizationRedirect({
          sessionId: session.sessionId,
          userId: session.userId,
          providerSubject: session.providerSubject,
          installationId: inst.installation.github_installation_id,
        });

        (ctx.repositoryService as any).fetchFn = async (urlStr: string) => {
          const u = String(urlStr);
          if (u.includes("oauth/access_token")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ access_token: "ghu_repo_auth_test" }),
            } as any;
          }
          if (u.includes("/user/installations")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                total_count: 1,
                installations: [
                  {
                    id: 554433,
                    app_id: 12345,
                    account: { id: 654321, login: "fresh-user", type: "User" },
                    repository_selection: "all",
                  },
                ],
              }),
            } as any;
          }
          if (u.includes("/user")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ id: 654321, login: "fresh-user" }),
            } as any;
          }
          return { ok: false, status: 404 } as any;
        };

        const provisionSpy = vi.spyOn(ctx.onboardingService, "provisionWorkspace");

        const res = await fetch(`${testApp.baseUrl}/auth/github-app/repository/callback?state=${auth.state}&code=testcode`, {
          headers: {
            Cookie: `ceo_user_session=${session.sessionId}`,
          },
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        // Cleaned up dead /settings/ redirect: goes to /onboarding
        expect(res.headers.get("location")).toBe("/onboarding");
        // Crucial invariant: never guess or fallback to active onboarding flow
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        await testApp.close();
      }
    });

    it("GET /auth/github-app/repository/callback redirects errors to /onboarding instead of /settings/*", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        const res = await fetch(`${testApp.baseUrl}/auth/github-app/repository/callback?error=access_denied`, {
          headers: {
            Cookie: `ceo_user_session=${session.sessionId}`,
          },
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/onboarding");
      } finally {
        await testApp.close();
      }
    });
  });

  describe("Component 6: Least-Privilege Repository Restriction & Durable OAuth Continuation", () => {
    it("GET /onboarding/security renders organization-aware settings URL and handles restriction check", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        const inst = ctx.store.upsertGitHubInstallationWithUser({
          githubAppId: "10",
          githubInstallationId: "8888",
          accountId: ctx.freshUser.providerSubject,
          accountLogin: "acme-corp",
          accountType: "Organization",
          repositorySelection: "selected",
          userId: ctx.freshUser.userId,
        });

        const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject, undefined, "oar_durable_999");
        const bound = ctx.store.createWorkspaceWithRepositoryBinding({
          userId: ctx.freshUser.userId,
          installationRowId: inst.installation.id,
          githubRepositoryId: "777888",
          ownerAccountId: ctx.freshUser.providerSubject,
          ownerLogin: "acme-corp",
          repositoryName: "ceo-data",
          fullName: "acme-corp/ceo-data",
          branch: "main",
        });

        ctx.onboardingStore.updateFlow(flow.id, {
          installation_row_id: inst.installation.id,
          repository_id: "777888",
          workspace_id: bound.workspace.id,
          state: "AWAITING_REPOSITORY_RESTRICTION",
        });

        const res = await fetch(`${testApp.baseUrl}/onboarding/security?flow=${encodeURIComponent(flow.id)}`, {
          headers: { Cookie: `ceo_user_session=${session.sessionId}` },
        });

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Restrict GitHub Access");
        expect(html).toContain("acme-corp/ceo-data");
        // Organization URL
        expect(html).toContain("https://github.com/organizations/acme-corp/settings/installations/8888");
      } finally {
        await testApp.close();
      }
    });

    it("POST /onboarding/verify-repository-access rejects STILL_ALL and SCOPE_MISMATCH", async () => {
      const ctx = await createTestContext();
      const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(ctx.freshUser.userId, ctx.freshUser.providerSubject, undefined, "oar_durable_888");

      const inst = ctx.store.upsertGitHubInstallationWithUser({
        githubAppId: "10",
        githubInstallationId: "9999",
        accountId: ctx.freshUser.providerSubject,
        accountLogin: "fresh-user",
        accountType: "User",
        repositorySelection: "all",
        userId: ctx.freshUser.userId,
      });

      const bound = ctx.store.createWorkspaceWithRepositoryBinding({
        userId: ctx.freshUser.userId,
        installationRowId: inst.installation.id,
        githubRepositoryId: "123456",
        ownerAccountId: ctx.freshUser.providerSubject,
        ownerLogin: "fresh-user",
        repositoryName: "ceo-data",
        fullName: "fresh-user/ceo-data",
        branch: "main",
      });

      ctx.onboardingStore.updateFlow(flow.id, {
        installation_row_id: inst.installation.id,
        repository_id: "123456",
        workspace_id: bound.workspace.id,
        state: "AWAITING_REPOSITORY_RESTRICTION",
      });

      // 1. STILL_ALL: live installation still reports 'all'
      vi.spyOn(ctx.appClient, "getInstallation").mockResolvedValueOnce({
        id: 9999,
        repository_selection: "all",
        suspended_at: null,
      } as any);

      const stillAllResult = await ctx.onboardingService.verifyRepositoryAccessAndBootstrap(flow.id, ctx.freshUser.userId);
      expect(stillAllResult.success).toBe(false);
      expect((stillAllResult as any).reason).toBe("STILL_ALL");

      // 2. SCOPE_MISMATCH: live installation has multiple repos including unrelated
      vi.spyOn(ctx.appClient, "getInstallation").mockResolvedValueOnce({
        id: 9999,
        repository_selection: "selected",
        suspended_at: null,
      } as any);
      vi.spyOn(ctx.appClient, "mintInstallationVerificationToken").mockResolvedValueOnce("ephemeral_token");
      (ctx.onboardingService as any).fetchFn = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          repositories: [
            { id: 123456, name: "ceo-data", full_name: "fresh-user/ceo-data" },
            { id: 999999, name: "my-secret-repo", full_name: "fresh-user/my-secret-repo" },
          ],
        }),
      });

      const mismatchResult = await ctx.onboardingService.verifyRepositoryAccessAndBootstrap(flow.id, ctx.freshUser.userId);
      expect(mismatchResult.success).toBe(false);
      expect((mismatchResult as any).reason).toBe("SCOPE_MISMATCH");
    });

    it("Durable host_oauth_request_id continuation: resumes OAuth without query parameter", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        // Register valid authorization request in OAuthStore
        const reqId = "oar_durable_continuation_test";
        ctx.oauthStore.createAuthorizationRequest({
          id: reqId,
          client_id: "test_client",
          client_name: "Test Client",
          redirect_uri: "https://chatgpt.com/callback",
          resource: "https://ceo.sentimentalk.com/mcp",
          scope: "openid",
          state: "xyz_state",
          code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx64Znqmqddqk3xqkL0",
          code_challenge_method: "S256",
          created_at_ms: Date.now(),
          expires_at_ms: Date.now() + 600000,
        });

        const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(
          ctx.freshUser.userId,
          ctx.freshUser.providerSubject,
          undefined,
          reqId,
        );

        ctx.onboardingStore.updateFlow(flow.id, {
          state: "READY_TO_RESUME",
        });

        // Request /onboarding/complete with ONLY flowId, NO oauth_request in query
        const res = await fetch(`${testApp.baseUrl}/onboarding/complete?flow=${encodeURIComponent(flow.id)}`, {
          headers: { Cookie: `ceo_user_session=${session.sessionId}` },
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        // Server-side durable binding redirects to resume with reqId
        expect(res.headers.get("location")).toBe(`/authorize/resume?request=${encodeURIComponent(reqId)}`);

        const updatedFlow = ctx.onboardingStore.getFlow(flow.id)!;
        expect(updatedFlow.state).toBe("COMPLETED");
      } finally {
        await testApp.close();
      }
    });

    it("POST /onboarding/verify-repository-access extracts Accept-Language and forwards locale to bootstrap", async () => {
      const ctx = await createTestContext();
      const testApp = setupFullApp(ctx);

      try {
        const session = ctx.sessionManager.createSession({
          userId: ctx.freshUser.userId,
          provider: "github",
          providerSubject: ctx.freshUser.providerSubject,
          providerLogin: "fresh-user",
        });

        const flow = ctx.onboardingStore.getOrCreateActiveFlowInTx(
          ctx.freshUser.userId,
          ctx.freshUser.providerSubject,
        );

        const verifySpy = vi
          .spyOn(ctx.onboardingService, "verifyRepositoryAccessAndBootstrap")
          .mockResolvedValueOnce({
            success: true,
            status: "READY",
          });

        const res = await fetch(`${testApp.baseUrl}/onboarding/verify-repository-access`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `ceo_user_session=${session.sessionId}`,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          body: new URLSearchParams({ flow_id: flow.id }).toString(),
          redirect: "manual",
        });

        expect(verifySpy).toHaveBeenCalledWith(flow.id, ctx.freshUser.userId, { locale: "zh" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`/onboarding/complete?flow=${encodeURIComponent(flow.id)}`);

        // Test retry endpoint forwarding locale
        const retrySpy = vi
          .spyOn(ctx.onboardingService, "retryBootstrap")
          .mockResolvedValueOnce("READY");

        const inst = ctx.store.upsertGitHubInstallationWithUser({
          githubAppId: "10",
          githubInstallationId: "9999",
          accountId: ctx.freshUser.providerSubject,
          accountLogin: "fresh-user",
          accountType: "User",
          repositorySelection: "selected",
          userId: ctx.freshUser.userId,
        });

        const bound = ctx.store.createWorkspaceWithRepositoryBinding({
          userId: ctx.freshUser.userId,
          installationRowId: inst.installation.id,
          githubRepositoryId: "123456",
          ownerAccountId: ctx.freshUser.providerSubject,
          ownerLogin: "fresh-user",
          repositoryName: "ceo-data",
          fullName: "fresh-user/ceo-data",
          branch: "main",
        });
        ctx.store.markRepositoryBindingScopeVerified(bound.workspace.id);

        ctx.onboardingStore.updateFlow(flow.id, {
          workspace_id: bound.workspace.id,
          state: "RECOVERY_REQUIRED",
        });

        const retryRes = await fetch(`${testApp.baseUrl}/onboarding/retry`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `ceo_user_session=${session.sessionId}`,
            "Accept-Language": "en-US,en;q=0.9",
          },
          body: new URLSearchParams({ flow_id: flow.id }).toString(),
          redirect: "manual",
        });

        expect(retrySpy).toHaveBeenCalledWith(flow.id, ctx.freshUser.userId, { locale: "en" });
        expect(retryRes.status).toBe(302);
      } finally {
        await testApp.close();
      }
    });
  });
});

