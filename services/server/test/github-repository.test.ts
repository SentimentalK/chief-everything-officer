import { describe, expect, it, afterEach } from "vitest";
import crypto from "node:crypto";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
  IdentityConflictError,
} from "../src/identity/store.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { GitHubAppClient, GitHubAppError } from "../src/github/app-client.js";
import {
  GitHubRepositoryService,
  GitHubRepositoryError,
  GitHubAppPermissionUpgradeRequiredError,
  GitHubPartialCreationError,
} from "../src/github/repository-service.js";
import {
  createGitHubAppAuthRouter,
  createGitHubRepositoryAuthorizationsRouter,
} from "../src/github/router.js";
import { GitHubInstallationService } from "../src/github/installation-service.js";
import packageJson from "../package.json" with { type: "json" };
import packageLockJson from "../package-lock.json" with { type: "json" };

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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
  dbPath: string;
  store: IdentityStore;
  sessionManager: UserSessionManager;
  sessionId: string;
  rsaKeys: { privateKey: string; publicKey: string };
  clientId: string;
  clientSecret: string;
  slug: string;
  callbackUrl: string;
  userId: string;
  providerSubject: string;
  installationRowId: string;
  installationId: string;
}

async function createTestContext(options?: { withoutInitialWorkspace?: boolean }): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-ghrepo-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");

  const ident = provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });

  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);

  // If testing a user with zero workspaces (e.g. for V1 create/import tests), create user2
  let userId = ident.user_id;
  const providerSubject = "123456";

  if (options?.withoutInitialWorkspace) {
    const extUser = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject,
      providerLogin: "dev-user",
    });
    userId = extUser.user_id;
  } else {
    // Bind external identity to the initial provisioned user
    const db = new DatabaseSync(dbPath);
    db.prepare(`
      INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
      VALUES ('ext_init', 'github', ?, ?, 'dev-user', 1000, 1000);
    `).run(providerSubject, userId);
    db.close();
  }

  // Setup GitHub installation
  const inst = store.upsertGitHubInstallationWithUser({
    githubInstallationId: "98765",
    githubAppId: "54321",
    accountId: "123456",
    accountLogin: "dev-user",
    accountType: "User",
    repositorySelection: "selected",
    userId,
  });

  const sessionManager = new UserSessionManager({ secureCookies: false });
  const session = sessionManager.createSession({
    userId,
    provider: "github",
    providerSubject,
    providerLogin: "dev-user",
  });
  const rsaKeys = generateTestRsaKeyPair();

  return {
    dir,
    dbPath,
    store,
    sessionManager,
    sessionId: session.sessionId,
    rsaKeys,
    clientId: "Iv1.client_id",
    clientSecret: "client_secret",
    slug: "ceo-app",
    callbackUrl: "http://localhost:3000/auth/github-app/repository/callback",
    userId,
    providerSubject,
    installationRowId: inst.installation.id,
    installationId: "98765",
  };
}

describe("Step 3.5B: Authorization & Grants", () => {
  it("9. start/callback require active GitHub CEO session and matching providerSubject", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
    });

    // Start with missing sessionId
    expect(() =>
      repoService.createAuthorizationRedirect({
        sessionId: "",
        userId: ctx.userId,
        providerSubject: ctx.providerSubject,
        installationId: ctx.installationId,
      }),
    ).toThrow(GitHubRepositoryError);

    // Start with missing userId
    expect(() =>
      repoService.createAuthorizationRedirect({
        sessionId: ctx.sessionId,
        userId: "",
        providerSubject: ctx.providerSubject,
        installationId: ctx.installationId,
      }),
    ).toThrow(GitHubRepositoryError);

    // Start with missing providerSubject
    expect(() =>
      repoService.createAuthorizationRedirect({
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        providerSubject: "",
        installationId: ctx.installationId,
      }),
    ).toThrow(GitHubRepositoryError);

    // Start with valid session produces authorization URL
    const start = repoService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });
    expect(start.authorizationUrl).toContain("https://github.com/login/oauth/authorize");
    expect(start.authorizationUrl).toContain(`state=${start.state}`);

    // Callback with mismatched session user fails
    await expect(
      repoService.handleOAuthCallback({
        state: start.state,
        code: "test-code",
        currentSessionId: ctx.sessionId,
        currentUserId: "usr_attacker",
        currentProviderSubject: ctx.providerSubject,
      }),
    ).rejects.toThrow(/Session user mismatch/);
  });

  it("10. expired/replayed/mismatched grant/state denied", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      stateTtlMs: -1, // Expired immediately
      grantTtlMs: -1,
    });

    // Start with expired TTL
    const start = repoService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });

    await expect(
      repoService.handleOAuthCallback({
        state: start.state,
        code: "test-code",
        currentSessionId: ctx.sessionId,
        currentUserId: ctx.userId,
        currentProviderSubject: ctx.providerSubject,
      }),
    ).rejects.toThrow(/expired/);

    // Replay attack: second use of state throws
    const validService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        if (String(url).includes("oauth/access_token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "ghu_valid" }),
          } as any;
        }
        if (String(url).endsWith("/user")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: Number(ctx.providerSubject), login: "dev-user" }),
          } as any;
        }
        if (String(url).includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [{ id: Number(ctx.installationId), app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const validStart = validService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });

    const grantRes = await validService.handleOAuthCallback({
      state: validStart.state,
      code: "code1",
      currentSessionId: ctx.sessionId,
      currentUserId: ctx.userId,
      currentProviderSubject: ctx.providerSubject,
    });
    expect(grantRes.grant).toBeDefined();

    // Replay callback with same state fails
    await expect(
      validService.handleOAuthCallback({
        state: validStart.state,
        code: "code1",
        currentSessionId: ctx.sessionId,
        currentUserId: ctx.userId,
        currentProviderSubject: ctx.providerSubject,
      }),
    ).rejects.toThrow(/Invalid or expired/);

    // Mismatched user on valid grant fails
    expect(() =>
      validService.getValidGrant(grantRes.grant, ctx.sessionId, "usr_different", ctx.providerSubject),
    ).toThrow(/does not belong to the active session user/);
  });

  it("11. grant token exists only in memory and never in identity/oauth DB or responses", async () => {
    const ctx = await createTestContext();
    const tokenSecret = "ghu_secret_access_token_12345";

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        if (String(url).includes("oauth/access_token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: tokenSecret, refresh_token: "ghr_discard_me" }),
          } as any;
        }
        if (String(url).endsWith("/user")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: Number(ctx.providerSubject), login: "dev-user" }),
          } as any;
        }
        if (String(url).includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [{ id: Number(ctx.installationId), app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });

    const callbackRes = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: ctx.sessionId,
      currentUserId: ctx.userId,
      currentProviderSubject: ctx.providerSubject,
    });

    // Returned response contains ONLY opaque grant handle and expiration; NO tokens!
    expect((callbackRes as any).access_token).toBeUndefined();
    expect((callbackRes as any).userAccessToken).toBeUndefined();
    expect((callbackRes as any).refresh_token).toBeUndefined();
    expect(callbackRes.grant).toMatch(/^[0-9a-f]{64}$/);

    // Verify tokenSecret is NOT present in any SQLite tables/columns
    const raw = new DatabaseSync(ctx.dbPath);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table';").all() as Array<{ name: string }>;
    for (const t of tables) {
      if (t.name.startsWith("sqlite_")) continue;
      const rows = raw.prepare(`SELECT * FROM ${t.name};`).all();
      const stringified = JSON.stringify(rows);
      expect(stringified).not.toContain(tokenSecret);
      expect(stringified).not.toContain("ghr_discard_me");
    }
    raw.close();
  });

  it("12. repository listing handles >100/multiple pages and is live user∩installation scope", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });

    let requestedPages: number[] = [];
    const mockReposPage1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      name: `repo-${i}`,
      full_name: `dev-user/repo-${i}`,
      owner: { id: 123456, login: "dev-user" },
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
      permissions: { admin: true, push: true, pull: true },
    }));

    const mockReposPage2 = Array.from({ length: 25 }, (_, i) => ({
      id: 2000 + i,
      name: `repo-p2-${i}`,
      full_name: `dev-user/repo-p2-${i}`,
      owner: { id: 123456, login: "dev-user" },
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
      permissions: { admin: false, push: true, pull: true },
    }));

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("/repositories")) {
          const page = Number(u.searchParams.get("page") || "1");
          requestedPages.push(page);
          if (page === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ total_count: 125, repositories: mockReposPage1 }),
            } as any;
          }
          if (page === 2) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ total_count: 125, repositories: mockReposPage2 }),
            } as any;
          }
        }
        if (u.pathname.includes("oauth/access_token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "token123" }) } as any;
        }
        if (u.pathname.endsWith("/user")) {
          return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [{ id: Number(ctx.installationId), app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });
    const cb = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: ctx.sessionId,
      currentUserId: ctx.userId,
      currentProviderSubject: ctx.providerSubject,
    });

    const list = await repoService.listRepositories(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject);
    expect(requestedPages).toEqual([1, 2]);
    expect(list.total_count).toBe(125);
    expect(list.repositories.length).toBe(125);
    expect(list.repositories[0]?.id).toBe("1000");
    expect(list.repositories[100]?.id).toBe("2000");
    expect(list.repositories[0]?.permissions?.admin).toBe(true);
    expect(list.repositories[100]?.permissions?.admin).toBe(false);
  });
});

describe("Step 3.5B: Import Repository", () => {
  it("13 & 17. import revalidates exact repo at provision time and creates workspace/membership/binding", async () => {
    // Context with user having zero owned workspaces
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let installationAccessed = false;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("/app/installations/")) {
          if (String(url).includes("access_tokens")) {
            return {
              ok: true,
              status: 201,
              json: async () => ({ token: "ghs_install_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
            } as any;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 98765, permissions: { contents: "write", administration: "write" } }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "token123" }) } as any;
        }
        if (u.pathname.endsWith("/user")) {
          return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        }
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              repositories: [
                {
                  id: 777,
                  name: "my-private-repo",
                  full_name: "dev-user/my-private-repo",
                  owner: { id: 123456, login: "dev-user" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "production",
                  permissions: { admin: true, push: true, pull: true },
                },
              ],
            }),
          } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
            }),
          } as any;
        }
        if (u.pathname === "/repos/dev-user/my-private-repo") {
          installationAccessed = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 777,
              name: "my-private-repo",
              full_name: "dev-user/my-private-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "production",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      providerSubject: ctx.providerSubject,
      installationId: ctx.installationId,
    });
    const cb = await repoService.handleOAuthCallback({
      state: start.state,
      code: "code",
      currentSessionId: ctx.sessionId,
      currentUserId: ctx.userId,
      currentProviderSubject: ctx.providerSubject,
    });

    const result = await repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "777");
    expect(installationAccessed).toBe(true);

    expect(result.workspace.id).toMatch(/^ws_/);
    expect(result.workspace.owner_user_id).toBe(ctx.userId);
    expect(result.workspace.remote_url).toBe("https://github.com/dev-user/my-private-repo.git");
    expect(result.workspace.branch).toBe("production");

    expect(result.membership.workspace_id).toBe(result.workspace.id);
    expect(result.membership.user_id).toBe(ctx.userId);
    expect(result.membership.role).toBe("owner");

    expect(result.binding.github_repository_id).toBe("777");
    expect(result.binding.branch).toBe("production");
    expect(result.binding.workspace_id).toBe(result.workspace.id);
  });

  it("14. import rejects user permission below admin", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey });
    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              repositories: [
                {
                  id: 777,
                  name: "write-only-repo",
                  full_name: "dev-user/write-only-repo",
                  owner: { id: 123456, login: "dev-user" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "main",
                  permissions: { admin: false, push: true, pull: true }, // Not admin!
                },
              ],
            }),
          } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "777")).rejects.toThrow(/ADMIN_PERMISSION_REQUIRED/);
  });

  it("15. import rejects public, archived, disabled repo, wrong owner, malformed IDs, or installation without Contents:write", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let contentsPermission = "write";

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { contents: contentsPermission } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    let currentRepoPayload: any = {};

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, repositories: [currentRepoPayload] }) } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    // Public repo
    currentRepoPayload = { id: 101, name: "pub", full_name: "dev-user/pub", owner: { id: 123456, login: "dev-user" }, private: false, archived: false, disabled: false, default_branch: "main", permissions: { admin: true } };
    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "101")).rejects.toThrow(/REPOSITORY_NOT_PRIVATE/);

    // Archived repo
    currentRepoPayload = { id: 102, name: "arc", full_name: "dev-user/arc", owner: { id: 123456, login: "dev-user" }, private: true, archived: true, disabled: false, default_branch: "main", permissions: { admin: true } };
    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "102")).rejects.toThrow(/REPOSITORY_ARCHIVED/);

    // Disabled repo
    currentRepoPayload = { id: 103, name: "dis", full_name: "dev-user/dis", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: true, default_branch: "main", permissions: { admin: true } };
    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "103")).rejects.toThrow(/REPOSITORY_DISABLED/);

    // Wrong installation owner (owner account id != installation account id)
    currentRepoPayload = { id: 104, name: "wrong", full_name: "other/wrong", owner: { id: 999999, login: "other" }, private: true, archived: false, disabled: false, default_branch: "main", permissions: { admin: true } };
    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "104")).rejects.toThrow(/INSTALLATION_OWNER_MISMATCH/);

    // Contents permission missing
    currentRepoPayload = { id: 105, name: "valid", full_name: "dev-user/valid", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "main", permissions: { admin: true } };
    contentsPermission = "read"; // missing Contents: write
    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "105")).rejects.toThrow(GitHubAppPermissionUpgradeRequiredError);
  });

  it("16. import rejects if installation token cannot access exact repo", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "token", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              repositories: [
                {
                  id: 888,
                  name: "repo",
                  full_name: "dev-user/repo",
                  owner: { id: 123456, login: "dev-user" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "main",
                  permissions: { admin: true },
                },
              ],
            }),
          } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/repos/dev-user/repo") {
          // Installation token receives 404 (selected repositories list doesn't include it)
          return { ok: false, status: 404 } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    await expect(repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "888")).rejects.toThrow(/Installation token failed to access repository/);
  });
});

describe("Step 3.5B: Create Repository", () => {
  it("18. user-account create calls /user/repos with private=true, auto_init=false", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let postUrl = "";
    let postBody: any = null;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "user_tok" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos" && init?.method === "POST") {
          postUrl = String(url);
          postBody = JSON.parse(String(init.body));
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 9991,
              name: "new-user-repo",
              full_name: "dev-user/new-user-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        if (u.pathname === "/repos/dev-user/new-user-repo") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 9991,
              name: "new-user-repo",
              full_name: "dev-user/new-user-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    const created = await repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, {
      name: "new-user-repo",
      description: "testing user repo creation",
    });

    expect(postUrl).toBe("https://api.github.com/user/repos");
    expect(postBody).toEqual({
      name: "new-user-repo",
      description: "testing user repo creation",
      private: true,
      auto_init: false,
    });
    expect(created.binding.github_repository_id).toBe("9991");
    expect(created.workspace.remote_url).toBe("https://github.com/dev-user/new-user-repo.git");
  });

  it("19. org-account create calls /orgs/{org}/repos with private=true, auto_init=false", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    // Update installation account to Organization
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE github_installations SET account_id = '55555', account_login = 'acme-org', account_type = 'Organization' WHERE id = ?;").run(ctx.installationRowId);
    raw.close();

    let postUrl = "";
    let postBody: any = null;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "user_tok" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 55555, login: "acme-org", type: "Organization" } }] }) } as any;
        }
        if (u.pathname === "/orgs/acme-org/repos" && init?.method === "POST") {
          postUrl = String(url);
          postBody = JSON.parse(String(init.body));
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 9992,
              name: "new-org-repo",
              full_name: "acme-org/new-org-repo",
              owner: { id: 55555, login: "acme-org" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        if (u.pathname === "/repos/acme-org/new-org-repo") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 9992,
              name: "new-org-repo",
              full_name: "acme-org/new-org-repo",
              owner: { id: 55555, login: "acme-org" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    const created = await repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, {
      name: "new-org-repo",
    });

    expect(postUrl).toBe("https://api.github.com/orgs/acme-org/repos");
    expect(postBody).toEqual({
      name: "new-org-repo",
      private: true,
      auto_init: false,
    });
    expect(created.binding.github_repository_id).toBe("9992");
    expect(created.workspace.remote_url).toBe("https://github.com/acme-org/new-org-repo.git");
  });

  it("20. create rejects missing Administration:write or Contents:write before external create", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let appPermissions = { administration: "read", contents: "write" }; // missing administration write!
    let externalCreated = false;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: appPermissions }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos") {
          externalCreated = true;
          return { ok: true, status: 201, json: async () => ({}) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    await expect(
      repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "test-repo" }),
    ).rejects.toThrow(GitHubAppPermissionUpgradeRequiredError);
    expect(externalCreated).toBe(false);

    // Missing contents: write
    appPermissions = { administration: "write", contents: "read" };
    await expect(
      repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "test-repo" }),
    ).rejects.toThrow(GitHubAppPermissionUpgradeRequiredError);
    expect(externalCreated).toBe(false);
  });

  it("21. create verifies new repo through installation token before DB bind", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let installationVerified = false;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "user_tok" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 9993,
              name: "verified-repo",
              full_name: "dev-user/verified-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        if (u.pathname === "/repos/dev-user/verified-repo") {
          installationVerified = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 9993,
              name: "verified-repo",
              full_name: "dev-user/verified-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    await repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "verified-repo" });
    expect(installationVerified).toBe(true);
  });

  it("22. user with an existing owned workspace is rejected before external create", async () => {
    // Note: ctx has an initial owned workspace provisioned by default!
    const ctx = await createTestContext({ withoutInitialWorkspace: false });
    expect(ctx.store.countOwnedWorkspacesForUser(ctx.userId)).toBe(1);

    let externalCreated = false;
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any),
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos") {
          externalCreated = true;
          return { ok: true, status: 201, json: async () => ({}) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    await expect(
      repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "test-repo" }),
    ).rejects.toThrow(/USER_ALREADY_OWNS_WORKSPACE/);

    expect(externalCreated).toBe(false);
  });

  it("23. concurrent create attempts for same CEO user cannot produce two successful creations in the single-pod process", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let concurrentCalls = 0;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos") {
          concurrentCalls++;
          // Add artificial delay to provoke race condition
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 9994,
              name: "concurrent-repo",
              full_name: "dev-user/concurrent-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        if (u.pathname === "/repos/dev-user/concurrent-repo") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 9994,
              name: "concurrent-repo",
              full_name: "dev-user/concurrent-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    // Launch two creates concurrently for the same user
    const p1 = repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "concurrent-repo" });
    const p2 = repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "concurrent-repo" });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one must succeed and one must be rejected by the race guard!
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("already in progress");
    expect(concurrentCalls).toBe(1);
  });

  it("24. GitHub create success + forced DB failure returns explicit partial-side-effect/recovery result, does not delete repo, does not claim workspace/READY; subsequent import path can bind it", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });
    let deleteCalled = false;

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url, init) => {
        const u = new URL(String(url));
        if (init?.method === "DELETE") {
          deleteCalled = true;
        }
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "user_tok" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              repositories: [
                {
                  id: 9995,
                  name: "partial-repo",
                  full_name: "dev-user/partial-repo",
                  owner: { id: 123456, login: "dev-user" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "main",
                  permissions: { admin: true },
                },
              ],
            }),
          } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/user/repos") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: 9995,
              name: "partial-repo",
              full_name: "dev-user/partial-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        if (u.pathname === "/repos/dev-user/partial-repo") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 9995,
              name: "partial-repo",
              full_name: "dev-user/partial-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
    const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

    // Force DB failure by temporarily inserting a conflicting binding with ID 9995
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare(`
      INSERT INTO workspaces VALUES ('ws_conflict', ?, 'https://github.com/c.git', 'main', 1000);
    `).run(ctx.userId);
    raw.prepare(`
      INSERT INTO github_repository_bindings VALUES ('grb_conf', 'ws_conflict', '9995', ?, '123456', 'dev-user', 'other', 'dev-user/other', 'main', 1000, 1000);
    `).run(ctx.installationRowId);
    raw.close();

    let partialErr: GitHubPartialCreationError | null = null;
    try {
      await repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "partial-repo" });
    } catch (e) {
      if (e instanceof GitHubPartialCreationError) {
        partialErr = e;
      }
    }

    expect(partialErr).not.toBeNull();
    expect(partialErr?.name).toBe("GitHubPartialCreationError");
    expect(partialErr?.status).toBe(500);
    expect(partialErr?.repository.id).toBe("9995");
    expect(partialErr?.repository.full_name).toBe("dev-user/partial-repo");
    expect(deleteCalled).toBe(false); // NEVER auto-delete repository

    // Now remove the artificial conflict so user can subsequently import it
    const raw2 = new DatabaseSync(ctx.dbPath);
    raw2.prepare("DELETE FROM github_repository_bindings WHERE id = 'grb_conf';").run();
    raw2.prepare("DELETE FROM workspaces WHERE id = 'ws_conflict';").run();
    raw2.close();

    // Subsequent import path successfully binds the repository
    const imported = await repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "9995");
    expect(imported.binding.github_repository_id).toBe("9995");
    expect(imported.workspace.remote_url).toBe("https://github.com/dev-user/partial-repo.git");
  });

  it("25. repo already bound to another workspace/user conflicts and never reassigns", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });

    // Create user A and bind repo 9999
    const bindingA = ctx.store.createWorkspaceWithRepositoryBinding({
      userId: ctx.userId,
      installationRowId: ctx.installationRowId,
      githubRepositoryId: "9999",
      ownerAccountId: "123456",
      ownerLogin: "dev-user",
      repositoryName: "bound-repo",
      fullName: "dev-user/bound-repo",
      branch: "main",
    });
    expect(bindingA.binding.id).toBeDefined();

    // Now User B tries to bind the same repo 9999
    const userB = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "654321",
      providerLogin: "user-b",
    });

    const instB = ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "88888",
      githubAppId: "54321",
      accountId: "654321",
      accountLogin: "user-b",
      accountType: "User",
      repositorySelection: "selected",
      userId: userB.user_id,
    });

    expect(() => {
      ctx.store.createWorkspaceWithRepositoryBinding({
        userId: userB.user_id,
        installationRowId: instB.installation.id,
        githubRepositoryId: "9999",
        ownerAccountId: "654321",
        ownerLogin: "user-b",
        repositoryName: "bound-repo",
        fullName: "user-b/bound-repo",
        branch: "main",
      });
    }).toThrow(/already bound to a workspace/);

    // Verify existing binding still belongs to User A's workspace
    const bound = ctx.store.findRepositoryBindingByGitHubRepoId("9999");
    expect(bound?.workspace_id).toBe(bindingA.workspace.id);
  });
});

describe("Step 3.5 Routes & Package Version", () => {
  it("HTTP endpoints enforce session, provide grant, list repos, and import/create workspace", async () => {
    const ctx = await createTestContext({ withoutInitialWorkspace: true });

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: async (url) => {
        if (String(url).includes("access_tokens")) {
          return { ok: true, status: 201, json: async () => ({ token: "inst_tok", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
        }
        if (String(url).includes("/app/installations/")) {
          return { ok: true, status: 200, json: async () => ({ id: 98765, permissions: { administration: "write", contents: "write" } }) } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    const repoService = new GitHubRepositoryService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      callbackUrl: ctx.callbackUrl,
      fetchFn: async (url) => {
        const u = new URL(String(url));
        if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "user_tok" }) } as any;
        if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
        if (u.pathname.includes("/user/installations/98765/repositories")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              repositories: [
                {
                  id: 1234,
                  name: "repo-import",
                  full_name: "dev-user/repo-import",
                  owner: { id: 123456, login: "dev-user" },
                  private: true,
                  archived: false,
                  disabled: false,
                  default_branch: "main",
                  permissions: { admin: true },
                },
              ],
            }),
          } as any;
        }
        if (u.pathname.includes("/user/installations")) {
          return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
        }
        if (u.pathname === "/repos/dev-user/repo-import") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 1234,
              name: "repo-import",
              full_name: "dev-user/repo-import",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      },
    });

    const authRouter = createGitHubAppAuthRouter({
      installationService,
      repositoryService: repoService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const repoRouter = createGitHubRepositoryAuthorizationsRouter({
      repositoryService: repoService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const app = express();
    app.use(express.json());
    app.use("/auth/github-app", authRouter);
    app.use("/api/github/repository-authorizations", repoRouter);

    // Mock session cookie helper
    const userSession = ctx.sessionManager.createSession({
      userId: ctx.userId,
      provider: "github",
      providerSubject: ctx.providerSubject,
      providerLogin: "dev-user",
    });

    // Helper to simulate request
    const invoke = async (method: string, url: string, body?: any, headers: Record<string, string> = {}) => {
      return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
        const parsedUrl = new URL(url, "http://localhost");
        const queryObj: Record<string, string> = {};
        for (const [k, v] of parsedUrl.searchParams.entries()) {
          queryObj[k] = v;
        }

        const req = {
          method,
          url,
          originalUrl: url,
          headers: {
            cookie: `ceo_user_session=${userSession.sessionId}`,
            accept: "application/json",
            "content-type": "application/json",
            ...headers,
          },
          body: body || {},
          query: queryObj,
          params: {},
        } as any;

        let resStatus = 200;
        const resHeaders: Record<string, string> = {};
        const res = {
          status: (code: number) => {
            resStatus = code;
            return res;
          },
          setHeader: (k: string, v: string) => {
            resHeaders[k.toLowerCase()] = v;
          },
          getHeader: (k: string) => resHeaders[k.toLowerCase()],
          json: (data: any) => {
            resolve({ status: resStatus, body: data, headers: resHeaders });
          },
          redirect: (code: number, loc: string) => {
            resolve({ status: code, body: { redirect: loc }, headers: { location: loc } });
          },
        } as any;

        app(req, res, () => {
          resolve({ status: 404, body: { error: "Not Found" }, headers: resHeaders });
        });
      });
    };

    // 1. POST /api/github/repository-authorizations without auth
    const unauthRes = await invoke("POST", "/api/github/repository-authorizations", { installation_id: "98765" }, { cookie: "" });
    expect(unauthRes.status).toBe(401);

    // 2. POST /api/github/repository-authorizations with valid session
    const postAuth = await invoke("POST", "/api/github/repository-authorizations", {
      installation_id: "98765",
    });
    expect(postAuth.status).toBe(200);
    expect(postAuth.body.authorization_url).toContain("https://github.com/login/oauth/authorize");
    const state = postAuth.body.state;

    // 3. GET /auth/github-app/repository/callback
    const cbRes = await invoke("GET", `/auth/github-app/repository/callback?state=${state}&code=testcode`);
    expect(cbRes.status).toBe(200);
    expect(cbRes.body.grant).toBeDefined();
    const grant = cbRes.body.grant;

    // 4. GET /api/github/repository-authorizations/:grant/repositories
    const listRes = await invoke("GET", `/api/github/repository-authorizations/${grant}/repositories`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.repositories.length).toBe(1);
    expect(listRes.body.repositories[0].id).toBe("1234");

    // 5. POST /api/github/repository-authorizations/:grant/workspace (import)
    const importRes = await invoke("POST", `/api/github/repository-authorizations/${grant}/workspace`, {
      mode: "import",
      repository_id: "1234",
    });
    expect(importRes.status).toBe(201);
    expect(importRes.body.binding.github_repository_id).toBe("1234");
    expect(importRes.body.workspace.remote_url).toBe("https://github.com/dev-user/repo-import.git");
  });

  describe("Step 3.5 Final Review Hardening Regressions", () => {
    describe("Item 1: Session binding on RepositoryAuthorizationGrant", () => {
      it("rejects grant if session changes (logout and re-login as same user)", async () => {
        const ctx = await createTestContext({ withoutInitialWorkspace: true });
        const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey });
        const repoService = new GitHubRepositoryService({
          appClient,
          store: ctx.store,
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          callbackUrl: ctx.callbackUrl,
          fetchFn: async (url) => {
            if (String(url).includes("oauth/access_token")) {
              return { ok: true, status: 200, json: async () => ({ access_token: "ghu_valid" }) } as any;
            }
            if (String(url).endsWith("/user")) {
              return { ok: true, status: 200, json: async () => ({ id: Number(ctx.providerSubject), login: "dev-user" }) } as any;
            }
            if (String(url).includes("/user/installations")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  total_count: 1,
                  installations: [{ id: Number(ctx.installationId), app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
                }),
              } as any;
            }
            return { ok: false, status: 404 } as any;
          },
        });

        const start = repoService.createAuthorizationRedirect({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          providerSubject: ctx.providerSubject,
          installationId: ctx.installationId,
        });
        const cb = await repoService.handleOAuthCallback({
          state: start.state,
          code: "code1",
          currentSessionId: ctx.sessionId,
          currentUserId: ctx.userId,
          currentProviderSubject: ctx.providerSubject,
        });

        // Valid with original session
        const grant = repoService.getValidGrant(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject);
        expect(grant.sessionId).toBe(ctx.sessionId);

        // Same user creates a new session (re-login)
        const newSession = ctx.sessionManager.createSession({
          userId: ctx.userId,
          provider: "github",
          providerSubject: ctx.providerSubject,
          providerLogin: "dev-user",
        });
        expect(newSession.sessionId).not.toBe(ctx.sessionId);

        // All operations with new session and old grant fail with 403
        expect(() =>
          repoService.getValidGrant(cb.grant, newSession.sessionId, ctx.userId, ctx.providerSubject),
        ).toThrow(/grant does not belong to the active session/i);

        await expect(
          repoService.listRepositories(cb.grant, newSession.sessionId, ctx.userId, ctx.providerSubject),
        ).rejects.toThrow(/grant does not belong to the active session/i);

        await expect(
          repoService.importRepository(cb.grant, newSession.sessionId, ctx.userId, ctx.providerSubject, "123"),
        ).rejects.toThrow(/grant does not belong to the active session/i);

        await expect(
          repoService.createRepository(cb.grant, newSession.sessionId, ctx.userId, ctx.providerSubject, { name: "new-repo" }),
        ).rejects.toThrow(/grant does not belong to the active session/i);
      });

      it("rejects callback if currentSessionId does not match initiating sessionId", async () => {
        const ctx = await createTestContext();
        const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey });
        const repoService = new GitHubRepositoryService({
          appClient,
          store: ctx.store,
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          callbackUrl: ctx.callbackUrl,
        });

        const start = repoService.createAuthorizationRedirect({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          providerSubject: ctx.providerSubject,
          installationId: ctx.installationId,
        });

        await expect(
          repoService.handleOAuthCallback({
            state: start.state,
            code: "test-code",
            currentSessionId: "different-session-id",
            currentUserId: ctx.userId,
            currentProviderSubject: ctx.providerSubject,
          }),
        ).rejects.toThrow(/Session mismatch/);
      });
    });

    describe("Item 2: Partial side-effect boundary across ALL post-creation failures", () => {
      async function setupCreateRepoService(options: {
        createdPayload: any;
        verifyStatus?: number;
        verifyPayload?: any;
      }) {
        const ctx = await createTestContext({ withoutInitialWorkspace: true });
        let deleteCalled = false;

        const appClient = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async (url) => {
            if (String(url).includes("/app/installations/")) {
              if (String(url).includes("access_tokens")) {
                return {
                  ok: true,
                  status: 201,
                  json: async () => ({ token: "ghs_inst_token", expires_at: new Date(Date.now() + 3600000).toISOString() }),
                } as any;
              }
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  id: 98765,
                  app_id: 54321,
                  permissions: { administration: "write", contents: "write" },
                }),
              } as any;
            }
            return { ok: false, status: 404 } as any;
          },
        });

        const repoService = new GitHubRepositoryService({
          appClient,
          store: ctx.store,
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          callbackUrl: ctx.callbackUrl,
          fetchFn: async (url, init) => {
            const method = (init?.method || "GET").toUpperCase();
            if (method === "DELETE") {
              deleteCalled = true;
              return { ok: true, status: 204 } as any;
            }
            const u = new URL(String(url));
            if (u.pathname.includes("oauth/access_token")) {
              return { ok: true, status: 200, json: async () => ({ access_token: "ghu_token" }) } as any;
            }
            if (u.pathname.endsWith("/user")) {
              return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
            }
            if (u.pathname.includes("/user/installations")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  total_count: 1,
                  installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }],
                }),
              } as any;
            }
            if (u.pathname === "/user/repos") {
              return {
                ok: true,
                status: 201,
                json: async () => options.createdPayload,
              } as any;
            }
            if (u.pathname.startsWith("/repos/")) {
              if (options.verifyStatus && options.verifyStatus !== 200) {
                return { ok: false, status: options.verifyStatus, json: async () => ({ message: "Not Found" }) } as any;
              }
              return {
                ok: true,
                status: 200,
                json: async () => options.verifyPayload ?? options.createdPayload,
              } as any;
            }
            return { ok: false, status: 404 } as any;
          },
        });

        const start = repoService.createAuthorizationRedirect({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          providerSubject: ctx.providerSubject,
          installationId: ctx.installationId,
        });
        const cb = await repoService.handleOAuthCallback({
          state: start.state,
          code: "c",
          currentSessionId: ctx.sessionId,
          currentUserId: ctx.userId,
          currentProviderSubject: ctx.providerSubject,
        });

        return { ctx, repoService, grant: cb.grant, getDeleteCalled: () => deleteCalled };
      }

      it("returns GitHubPartialCreationError with undefined repo when creation payload is malformed, never deletes", async () => {
        const { ctx, repoService, grant, getDeleteCalled } = await setupCreateRepoService({
          createdPayload: { not_a_repo: true },
        });

        let err: any;
        try {
          await repoService.createRepository(grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "malformed-repo" });
        } catch (e) {
          err = e;
        }

        expect(err).toBeInstanceOf(GitHubPartialCreationError);
        expect(err.status).toBe(500);
        expect(err.repository).toBeUndefined();
        expect(getDeleteCalled()).toBe(false);
      });

      it("returns GitHubPartialCreationError when owner does not match installation account, never deletes", async () => {
        const { ctx, repoService, grant, getDeleteCalled } = await setupCreateRepoService({
          createdPayload: {
            id: 1111,
            name: "wrong-owner-repo",
            full_name: "other-user/wrong-owner-repo",
            owner: { id: 999999, login: "other-user" },
            private: true,
            archived: false,
            disabled: false,
            default_branch: "main",
          },
        });

        let err: any;
        try {
          await repoService.createRepository(grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "wrong-owner-repo" });
        } catch (e) {
          err = e;
        }

        expect(err).toBeInstanceOf(GitHubPartialCreationError);
        expect(err.status).toBe(500);
        expect(getDeleteCalled()).toBe(false);
      });

      it("returns GitHubPartialCreationError when repo is public/archived/disabled or missing default_branch, never deletes", async () => {
        for (const badProp of [
          { private: false },
          { archived: true },
          { disabled: true },
          { default_branch: "" },
        ]) {
          const { ctx, repoService, grant, getDeleteCalled } = await setupCreateRepoService({
            createdPayload: {
              id: 2222,
              name: "bad-repo",
              full_name: "dev-user/bad-repo",
              owner: { id: 123456, login: "dev-user" },
              private: true,
              archived: false,
              disabled: false,
              default_branch: "main",
              ...badProp,
            },
          });

          let err: any;
          try {
            await repoService.createRepository(grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "bad-repo" });
          } catch (e) {
            err = e;
          }

          expect(err).toBeInstanceOf(GitHubPartialCreationError);
          expect(err.status).toBe(500);
          expect(getDeleteCalled()).toBe(false);
        }
      });

      it("returns GitHubPartialCreationError when installation token verification fails, never deletes", async () => {
        const { ctx, repoService, grant, getDeleteCalled } = await setupCreateRepoService({
          createdPayload: {
            id: 3333,
            name: "verify-fail-repo",
            full_name: "dev-user/verify-fail-repo",
            owner: { id: 123456, login: "dev-user" },
            private: true,
            archived: false,
            disabled: false,
            default_branch: "main",
          },
          verifyStatus: 404,
        });

        let err: any;
        try {
          await repoService.createRepository(grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "verify-fail-repo" });
        } catch (e) {
          err = e;
        }

        expect(err).toBeInstanceOf(GitHubPartialCreationError);
        expect(err.status).toBe(500);
        expect(err.repository?.id).toBe("3333");
        expect(getDeleteCalled()).toBe(false);
      });
    });

    describe("Item 3: Strict repository parsing and verification for import and discovery", () => {
      it("rejects import with malformed repository metadata", async () => {
        const invalidPayloads = [
          { id: "not_a_number", name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "main" },
          { id: -10, name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "main" },
          { id: 12.34, name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "main" },
          { id: 4444, name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "" },
          { id: 4444, name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: "true", archived: false, disabled: false, default_branch: "main" },
          { id: 4444, name: "r", full_name: "dev-user/r", owner: { id: 123456, login: "dev-user" }, private: true, archived: 1, disabled: false, default_branch: "main" },
        ];

        for (const badPayload of invalidPayloads) {
          const ctx = await createTestContext({ withoutInitialWorkspace: true });
          const appClient = new GitHubAppClient({
            clientId: ctx.clientId,
            privateKey: ctx.rsaKeys.privateKey,
            fetchFn: async (url) => {
              if (String(url).includes("access_tokens")) {
                return { ok: true, status: 201, json: async () => ({ token: "t", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
              }
              return { ok: true, status: 200, json: async () => ({ id: 98765, app_id: 54321, permissions: { contents: "write" } }) } as any;
            },
          });

          const repoService = new GitHubRepositoryService({
            appClient,
            store: ctx.store,
            clientId: ctx.clientId,
            clientSecret: ctx.clientSecret,
            callbackUrl: ctx.callbackUrl,
            fetchFn: async (url) => {
              const u = new URL(String(url));
              if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
              if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
              if (u.pathname.includes("/user/installations")) {
                return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
              }
              if (u.pathname.startsWith("/repositories/")) {
                return { ok: true, status: 200, json: async () => ({ ...badPayload, permissions: { admin: true } }) } as any;
              }
              return { ok: false, status: 404 } as any;
            },
          });

          const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
          const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

          await expect(
            repoService.importRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, "4444"),
          ).rejects.toThrow(GitHubRepositoryError);
        }
      });

      it("omits malformed repositories during discovery without throwing", async () => {
        const ctx = await createTestContext({ withoutInitialWorkspace: true });
        const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey });
        const repoService = new GitHubRepositoryService({
          appClient,
          store: ctx.store,
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          callbackUrl: ctx.callbackUrl,
          fetchFn: async (url) => {
            const u = new URL(String(url));
            if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
            if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
            if (u.pathname.includes(`/user/installations/${ctx.installationId}/repositories`)) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  total_count: 3,
                  repositories: [
                    {
                      id: 101,
                      name: "valid-repo",
                      full_name: "dev-user/valid-repo",
                      owner: { id: 123456, login: "dev-user" },
                      private: true,
                      archived: false,
                      disabled: false,
                      default_branch: "main",
                      permissions: { admin: true },
                    },
                    {
                      id: "not-a-number",
                      name: "invalid-id",
                      full_name: "dev-user/invalid-id",
                      owner: { id: 123456, login: "dev-user" },
                    },
                    {
                      id: 102,
                      name: "missing-branch",
                      full_name: "dev-user/missing-branch",
                      owner: { id: 123456, login: "dev-user" },
                      private: true,
                      archived: false,
                      disabled: false,
                      default_branch: "",
                    },
                  ],
                }),
              } as any;
            }
            if (u.pathname.includes("/user/installations")) {
              return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
            }
            return { ok: false, status: 404 } as any;
          },
        });

        const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
        const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

        const list = await repoService.listRepositories(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject);
        expect(list.repositories.length).toBe(1);
        expect(list.repositories[0]?.id).toBe("101");
        expect(list.repositories[0]?.name).toBe("valid-repo");
      });
    });

    describe("Item 4: OAuth callback strictly validates live installation payload", () => {
      it("rejects callback with malformed or mismatched installation payloads", async () => {
        const invalidInstallations = [
          { id: 0, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } },
          { id: -98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } },
          { id: 98765.5, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } },
          { id: "abc", app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } },
          { id: 98765, app_id: -1, account: { id: 123456, login: "dev-user", type: "User" } },
          { id: 98765, app_id: 54321, account: { id: -123, login: "dev-user", type: "User" } },
          { id: 98765, app_id: 54321, account: { id: 123456, login: "   ", type: "User" } },
          { id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "Bot" } },
          { id: 98765, app_id: 54321, account: { id: 999999, login: "dev-user", type: "User" } }, // Account ID mismatch with DB (123456)
          { id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "Organization" } }, // Account Type mismatch with DB ("User")
        ];

        for (const badInst of invalidInstallations) {
          const ctx = await createTestContext();
          const appClient = new GitHubAppClient({ clientId: ctx.clientId, privateKey: ctx.rsaKeys.privateKey });
          const repoService = new GitHubRepositoryService({
            appClient,
            store: ctx.store,
            clientId: ctx.clientId,
            clientSecret: ctx.clientSecret,
            callbackUrl: ctx.callbackUrl,
            fetchFn: async (url) => {
              const u = new URL(String(url));
              if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
              if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
              if (u.pathname.includes("/user/installations")) {
                return {
                  ok: true,
                  status: 200,
                  json: async () => ({ total_count: 1, installations: [badInst] }),
                } as any;
              }
              return { ok: false, status: 404 } as any;
            },
          });

          const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });

          await expect(
            repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject }),
          ).rejects.toThrow(GitHubRepositoryError);
        }
      });
    });

    describe("Item 5: store.createWorkspaceWithRepositoryBinding single-owned-workspace invariant", () => {
      it("atomically prevents a user from creating more than one owned workspace", async () => {
        const ctx = await createTestContext({ withoutInitialWorkspace: true });

        // First creation succeeds
        const first = ctx.store.createWorkspaceWithRepositoryBinding({
          userId: ctx.userId,
          installationRowId: ctx.installationRowId,
          githubRepositoryId: "1001",
          ownerAccountId: "123456",
          ownerLogin: "dev-user",
          repositoryName: "repo-1",
          fullName: "dev-user/repo-1",
          branch: "main",
        });
        expect(first.workspace.id).toBeDefined();

        // Second creation for same user throws IdentityConflictError
        expect(() =>
          ctx.store.createWorkspaceWithRepositoryBinding({
            userId: ctx.userId,
            installationRowId: ctx.installationRowId,
            githubRepositoryId: "1002",
            ownerAccountId: "123456",
            ownerLogin: "dev-user",
            repositoryName: "repo-2",
            fullName: "dev-user/repo-2",
            branch: "main",
          }),
        ).toThrow(IdentityConflictError);
      });

      it("concurrent calls for the same user result in exactly one success", async () => {
        const ctx = await createTestContext({ withoutInitialWorkspace: true });

        const results = await Promise.allSettled([
          Promise.resolve().then(() =>
            ctx.store.createWorkspaceWithRepositoryBinding({
              userId: ctx.userId,
              installationRowId: ctx.installationRowId,
              githubRepositoryId: "2001",
              ownerAccountId: "123456",
              ownerLogin: "dev-user",
              repositoryName: "repo-c1",
              fullName: "dev-user/repo-c1",
              branch: "main",
            }),
          ),
          Promise.resolve().then(() =>
            ctx.store.createWorkspaceWithRepositoryBinding({
              userId: ctx.userId,
              installationRowId: ctx.installationRowId,
              githubRepositoryId: "2002",
              ownerAccountId: "123456",
              ownerLogin: "dev-user",
              repositoryName: "repo-c2",
              fullName: "dev-user/repo-c2",
              branch: "main",
            }),
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdentityConflictError);
      });
    });

    describe("Item 6: Installation-token repository verification rejects identity and metadata mismatches", () => {
      it("rejects create if verified repository identity/metadata does not match created repository", async () => {
        const mismatches = [
          { verifyPayload: { id: 9999, name: "repo-m", full_name: "dev-user/repo-m", owner: { id: 123456, login: "dev-user" }, private: true, archived: false, disabled: false, default_branch: "main" } },
          { verifyPayload: { id: 5555, name: "repo-m", full_name: "other/repo-m", owner: { id: 999999, login: "other" }, private: true, archived: false, disabled: false, default_branch: "main" } },
          { verifyPayload: { id: 5555, name: "repo-m", full_name: "dev-user/repo-m", owner: { id: 123456, login: "dev-user" }, private: false, archived: false, disabled: false, default_branch: "main" } },
          { verifyPayload: { id: 5555, name: "repo-m", full_name: "dev-user/repo-m", owner: { id: 123456, login: "dev-user" }, private: true, archived: true, disabled: false, default_branch: "main" } },
        ];

        for (const testCase of mismatches) {
          const ctx = await createTestContext({ withoutInitialWorkspace: true });
          const appClient = new GitHubAppClient({
            clientId: ctx.clientId,
            privateKey: ctx.rsaKeys.privateKey,
            fetchFn: async (url) => {
              if (String(url).includes("access_tokens")) {
                return { ok: true, status: 201, json: async () => ({ token: "t", expires_at: new Date(Date.now() + 3600000).toISOString() }) } as any;
              }
              return { ok: true, status: 200, json: async () => ({ id: 98765, app_id: 54321, permissions: { administration: "write", contents: "write" } }) } as any;
            },
          });

          const repoService = new GitHubRepositoryService({
            appClient,
            store: ctx.store,
            clientId: ctx.clientId,
            clientSecret: ctx.clientSecret,
            callbackUrl: ctx.callbackUrl,
            fetchFn: async (url) => {
              const u = new URL(String(url));
              if (u.pathname.includes("oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as any;
              if (u.pathname.endsWith("/user")) return { ok: true, status: 200, json: async () => ({ id: 123456, login: "dev-user" }) } as any;
              if (u.pathname.includes("/user/installations")) {
                return { ok: true, status: 200, json: async () => ({ total_count: 1, installations: [{ id: 98765, app_id: 54321, account: { id: 123456, login: "dev-user", type: "User" } }] }) } as any;
              }
              if (u.pathname === "/user/repos") {
                return {
                  ok: true,
                  status: 201,
                  json: async () => ({
                    id: 5555,
                    name: "repo-m",
                    full_name: "dev-user/repo-m",
                    owner: { id: 123456, login: "dev-user" },
                    private: true,
                    archived: false,
                    disabled: false,
                    default_branch: "main",
                  }),
                } as any;
              }
              if (u.pathname.startsWith("/repos/")) {
                return { ok: true, status: 200, json: async () => testCase.verifyPayload } as any;
              }
              return { ok: false, status: 404 } as any;
            },
          });

          const start = repoService.createAuthorizationRedirect({ sessionId: ctx.sessionId, userId: ctx.userId, providerSubject: ctx.providerSubject, installationId: ctx.installationId });
          const cb = await repoService.handleOAuthCallback({ state: start.state, code: "c", currentSessionId: ctx.sessionId, currentUserId: ctx.userId, currentProviderSubject: ctx.providerSubject });

          await expect(
            repoService.createRepository(cb.grant, ctx.sessionId, ctx.userId, ctx.providerSubject, { name: "repo-m" }),
          ).rejects.toThrow(GitHubPartialCreationError);
        }
      });
    });

    describe("Item 7: GitHubAppClient.getInstallation validates returned installation payload", () => {
      it("rejects installation payload with invalid id, id mismatch, or non-object permissions", async () => {
        const ctx = await createTestContext();

        // 1. Non-safe-integer id
        const client1 = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: "not-int", app_id: 1, account: { id: 1, login: "a", type: "User" } }),
          } as any),
        });
        await expect(client1.getInstallation("12345")).rejects.toThrow(GitHubAppError);

        // 2. Float id
        const client2 = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: 12345.67, app_id: 1, account: { id: 1, login: "a", type: "User" } }),
          } as any),
        });
        await expect(client2.getInstallation("12345")).rejects.toThrow(GitHubAppError);

        // 3. ID mismatch
        const client3 = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: 99999, app_id: 1, account: { id: 1, login: "a", type: "User" } }),
          } as any),
        });
        await expect(client3.getInstallation("12345")).rejects.toThrow(GitHubAppError);

        // 4. Non-object permissions
        const client4 = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: 12345, app_id: 1, account: { id: 1, login: "a", type: "User" }, permissions: "all" }),
          } as any),
        });
        await expect(client4.getInstallation("12345")).rejects.toThrow(GitHubAppError);

        // 5. Valid installation succeeds
        const client5 = new GitHubAppClient({
          clientId: ctx.clientId,
          privateKey: ctx.rsaKeys.privateKey,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: 12345, app_id: 1, account: { id: 1, login: "a", type: "User" }, permissions: { contents: "write" } }),
          } as any),
        });
        const inst = await client5.getInstallation("12345");
        expect(inst.id).toBe(12345);
        expect(inst.permissions?.contents).toBe("write");
      });
    });
  });

  it("27. package versions are 0.3.8", () => {
    expect(packageJson.version).toBe("0.3.8");
    expect(packageLockJson.version).toBe("0.3.8");
    expect(packageLockJson.packages[""].version).toBe("0.3.8");
  });
});
