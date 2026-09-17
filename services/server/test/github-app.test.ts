import { describe, expect, it, afterEach, beforeEach } from "vitest";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
} from "../src/identity/store.js";
import { seedIdentity } from "./helpers.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import {
  createGitHubAppJwt,
  GitHubAppClient,
  GitHubAppError,
} from "../src/github/app-client.js";
import {
  GitHubInstallationService,
  GitHubInstallationError,
  GitHubIdentityMismatchError,
  GitHubInstallationNotFoundError,
} from "../src/github/installation-service.js";
import {
  createGitHubAppAuthRouter,
  createGitHubInstallationsApiRouter,
} from "../src/github/router.js";
import { createGitHubAuthRouter } from "../src/auth/github.js";
import { IdentityAccountProvisioner } from "../src/identity/provisioner.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const s of cleanupStores.splice(0)) s.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Helper to generate an RSA key pair in-memory for testing
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
  rsaKeys: { privateKey: string; publicKey: string };
  clientId: string;
  clientSecret: string;
  slug: string;
  callbackUrl: string;
}

async function createTestContext(): Promise<TestContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-ghapp-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");

  seedIdentity({ identityDbPath: dbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" }, "test-key");

  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);

  const sessionManager = new UserSessionManager({ secureCookies: false });
  const rsaKeys = generateTestRsaKeyPair();

  return {
    dir,
    dbPath,
    store,
    sessionManager,
    rsaKeys,
    clientId: "Iv1.test_client_id",
    clientSecret: "test_client_secret",
    slug: "ceo-test-app",
    callbackUrl: "http://localhost:3000/auth/github-app/callback",
  };
}

describe("GitHub App JWT Claims & Signing", () => {
  it("generates RS256 JWT with correct iat, exp, and iss claims signed by private key", () => {
    const { privateKey, publicKey } = generateTestRsaKeyPair();
    const clientId = "Iv1.app123";
    const fixedNowMs = 1700000000000; // fixed timestamp
    const nowSec = Math.floor(fixedNowMs / 1000);

    const jwt = createGitHubAppJwt(clientId, privateKey, fixedNowMs);
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(clientId);
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.exp).toBe(nowSec + 600); // 10 minutes

    // Verify cryptographic signature with the public key
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    const valid = verifier.verify(publicKey, signatureB64!, "base64url");
    expect(valid).toBe(true);
  });

  it("fails fast with clear error on invalid private key", () => {
    expect(() => {
      new GitHubAppClient({
        clientId: "Iv1.app123",
        privateKey: "NOT_A_VALID_PEM_KEY",
      });
    }).toThrow(GitHubAppError);
  });
});

describe("Installation Token Minting & Skew Cache", () => {
  it("mints token, caches it, reuses within 5-min skew, and refreshes near expiry", async () => {
    const { privateKey } = generateTestRsaKeyPair();
    let fetchCount = 0;
    let mintToken = "ghs_token_initial";
    const now = 1700000000000;
    let tokenExpiresAt = new Date(now + 60 * 60 * 1000).toISOString(); // 1 hour later

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      const url = String(input);
      expect(url).toContain("/app/installations/12345/access_tokens");
      expect(init?.headers).toBeDefined();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: mintToken,
          expires_at: tokenExpiresAt,
        }),
      } as any;
    };

    const client = new GitHubAppClient({
      clientId: "Iv1.test_client",
      privateKey,
      fetchFn: mockFetch,
    });

    // 1. Initial request: mints new token
    const token1 = await client.getInstallationToken("12345", now);
    expect(token1).toBe("ghs_token_initial");
    expect(fetchCount).toBe(1);

    // 2. Second request: 10 minutes later, still has 50 min validity (> 5 min skew) -> cached!
    const token2 = await client.getInstallationToken("12345", now + 10 * 60 * 1000);
    expect(token2).toBe("ghs_token_initial");
    expect(fetchCount).toBe(1); // No new network call

    // 3. Third request: 56 minutes later -> only 4 minutes left until expiry (<= 5 min skew)
    // -> Must mint new token!
    mintToken = "ghs_token_refreshed";
    tokenExpiresAt = new Date(now + 120 * 60 * 1000).toISOString();
    const token3 = await client.getInstallationToken("12345", now + 56 * 60 * 1000);
    expect(token3).toBe("ghs_token_refreshed");
    expect(fetchCount).toBe(2);
  });

  it("GitHub 401/403/404 does not cache and does not corrupt state", async () => {
    const { privateKey } = generateTestRsaKeyPair();

    for (const status of [401, 403, 404]) {
      const mockFetch = async () =>
        ({
          ok: false,
          status,
          json: async () => ({ message: "Error" }),
        } as any);

      const client = new GitHubAppClient({
        clientId: "Iv1.test_client",
        privateKey,
        fetchFn: mockFetch,
      });

      await expect(client.getInstallationToken("12345")).rejects.toThrow(GitHubAppError);
      expect(client.getCachedToken("12345")).toBeUndefined();
    }
  });

  it("rejects malformed token or expiry responses and does not populate cache", async () => {
    const { privateKey } = generateTestRsaKeyPair();
    const now = Date.now();
    const futureDate = new Date(now + 3600 * 1000).toISOString();
    const pastDate = new Date(now - 1000).toISOString();
    const nowDate = new Date(now).toISOString();

    const badPayloads = [
      { token: "", expires_at: futureDate },
      { token: "   ", expires_at: futureDate },
      { expires_at: futureDate },
      { token: null, expires_at: futureDate },
      { token: "ghs_valid", expires_at: "not-a-valid-date" },
      { token: "ghs_valid", expires_at: pastDate },
      { token: "ghs_valid", expires_at: nowDate },
      { token: "ghs_valid" },
      { token: "ghs_valid", expires_at: null },
      {},
    ];

    for (const payload of badPayloads) {
      const mockFetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => payload,
        } as any);

      const client = new GitHubAppClient({
        clientId: "Iv1.test_client",
        privateKey,
        fetchFn: mockFetch,
      });

      await expect(client.getInstallationToken("12345", now)).rejects.toThrow(GitHubAppError);
      expect(client.getCachedToken("12345")).toBeUndefined();
    }
  });
});

describe("GitHub App Authorization Flow & Verification", () => {
  it("rejects unauthenticated requests to /auth/github-app/install", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const app = express();
    app.use("/auth/github-app", router);

    // Simulated request without session cookie
    const req = {
      method: "GET",
      url: "/install",
      headers: {},
    } as any;
    let redirectStatus = 0;
    let redirectLocation = "";
    const res = {
      redirect: (status: number, loc: string) => {
        redirectStatus = status;
        redirectLocation = loc;
      },
    } as any;

    router(req, res, () => {});
    expect(redirectStatus).toBe(302);
    expect(redirectLocation).toBe("/login?error=unauthenticated");
  });

  it("generates opaque one-time install state bound to CEO user", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    const installUrl = installationService.createInstallRedirect("usr_123", "99999");
    const parsed = new URL(installUrl);
    expect(parsed.origin + parsed.pathname).toBe(`https://github.com/apps/${ctx.slug}/installations/new`);
    const state = parsed.searchParams.get("state");
    expect(state).toBeDefined();
    expect(state?.length).toBe(64); // 32 hex bytes
  });

  it("handles setup state: one-time use prevents replay, and expired state rejects", async () => {
    const ctx = await createTestContext();
    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      stateTtlMs: 100, // short TTL for test
    });

    const installUrl = installationService.createInstallRedirect("usr_123", "99999");
    const state = new URL(installUrl).searchParams.get("state")!;

    // First setup call succeeds and returns OAuth authorize redirect
    const oauthUrl = installationService.startSetupOAuth({
      state,
      installationId: "54321",
      userId: "usr_123",
    });
    expect(oauthUrl).toContain("https://github.com/login/oauth/authorize");
    expect(oauthUrl).toContain(`client_id=${ctx.clientId}`);

    // Replay attack: second call with same state fails
    expect(() =>
      installationService.startSetupOAuth({
        state,
        installationId: "54321",
        userId: "usr_123",
      }),
    ).toThrow(/Invalid or expired install state/);

    // Expired state test
    const expiredInstallUrl = installationService.createInstallRedirect("usr_123", "99999");
    const expiredState = new URL(expiredInstallUrl).searchParams.get("state")!;
    // Wait for TTL to pass
    await new Promise((r) => setTimeout(r, 120));

    expect(() =>
      installationService.startSetupOAuth({
        state: expiredState,
        installationId: "54321",
        userId: "usr_123",
      }),
    ).toThrow(/Invalid or expired install state|expired/);
  });

  it("rejects spoofed installation_id absent from /user/installations with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "ghu_user_token" }),
        } as any;
      }
      if (url.includes("/user/installations")) {
        // Returns installations that DO NOT include candidate installation 999999
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            installations: [
              {
                id: 12345,
                app_id: 100,
                target_id: 11111,
                account: { id: 11111, login: "alice", type: "User" },
                repository_selection: "all",
                suspended_at: null,
              },
            ],
          }),
        } as any;
      }
      if (url.includes("/user")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 11111, login: "alice" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    // 1. Install
    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;

    // 2. Setup with spoofed installation ID 999999
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "999999", // Spoofed!
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    // 3. Callback must reject
    await expect(
      installationService.handleOAuthCallback({
        state: oauthState,
        code: "valid_code",
        currentUserId: user.user_id,
        currentProviderSubject: "11111",
      }),
    ).rejects.toThrow(GitHubInstallationNotFoundError);

    // Verify ZERO writes occurred in DB
    const raw = new DatabaseSync(ctx.dbPath);
    const instRows = raw.prepare("SELECT COUNT(*) as c FROM github_installations;").get() as { c: number };
    const userInstRows = raw.prepare("SELECT COUNT(*) as c FROM github_installation_users;").get() as { c: number };
    raw.close();

    expect(Number(instRows.c)).toBe(0);
    expect(Number(userInstRows.c)).toBe(0);
  });

  it("rejects CEO/GitHub identity mismatch with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "ghu_user_token" }),
        } as any;
      }
      if (url.includes("/user")) {
        // GitHub authenticated user id is 22222, but CEO session expected 11111!
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 22222, login: "bob" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;

    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "12345",
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    await expect(
      installationService.handleOAuthCallback({
        state: oauthState,
        code: "valid_code",
        currentUserId: user.user_id,
        currentProviderSubject: "11111",
      }),
    ).rejects.toThrow(GitHubIdentityMismatchError);

    // Verify ZERO writes occurred in DB
    const raw = new DatabaseSync(ctx.dbPath);
    const instRows = raw.prepare("SELECT COUNT(*) as c FROM github_installations;").get() as { c: number };
    const userInstRows = raw.prepare("SELECT COUNT(*) as c FROM github_installation_users;").get() as { c: number };
    raw.close();

    expect(Number(instRows.c)).toBe(0);
    expect(Number(userInstRows.c)).toBe(0);
  });

  it("accepts mutable login when numeric subject matches, and writes no tokens to DB", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice-original",
    });

    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "ghu_user_token_secret_123" }),
        } as any;
      }
      if (url.includes("/user/installations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            installations: [
              {
                id: 555,
                app_id: 99,
                target_id: 11111,
                account: { id: 11111, login: "alice-renamed", type: "User" },
                repository_selection: "selected",
                suspended_at: null,
              },
            ],
          }),
        } as any;
      }
      if (url.includes("/user")) {
        // Numeric id matches 11111, but handle changed to alice-renamed!
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 11111, login: "alice-renamed" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;

    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "555",
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    const result = await installationService.handleOAuthCallback({
      state: oauthState,
      code: "code_123",
      currentUserId: user.user_id,
      currentProviderSubject: "11111",
    });

    expect(result.installationId).toBe("555");
    expect(result.accountLogin).toBe("alice-renamed");

    // Check DB records: installation exists with updated login
    const inst = ctx.store.findGitHubInstallationById("555");
    expect(inst).not.toBeNull();
    expect(inst?.account_login).toBe("alice-renamed");
    expect(inst?.repository_selection).toBe("selected");

    // ABSENCE OF TOKENS IN DB:
    // Verify no tokens or private keys were stored in SQLite
    const raw = new DatabaseSync(ctx.dbPath);
    const dump = raw.prepare("SELECT * FROM github_installations;").all() as any[];
    const linkDump = raw.prepare("SELECT * FROM github_installation_users;").all() as any[];
    raw.close();

    const dumpStr = JSON.stringify({ dump, linkDump });
    expect(dumpStr).not.toContain("ghu_user_token");
    expect(dumpStr).not.toContain("secret");
    expect(dumpStr).not.toContain("BEGIN PRIVATE KEY");
  });

  it("exposes authenticated metadata only at GET /api/github/installations", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "123",
      githubAppId: "99",
      accountId: "11111",
      accountLogin: "alice",
      accountType: "User",
      repositorySelection: "all",
      userId: user.user_id,
    });

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    const apiRouter = createGitHubInstallationsApiRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    // 1. Unauthenticated request -> 401
    const unauthReq = { method: "GET", url: "/", headers: {} } as any;
    let statusCode = 0;
    let jsonBody: any = null;
    const resUnauth = {
      status: (c: number) => {
        statusCode = c;
        return {
          json: (b: any) => {
            jsonBody = b;
          },
        };
      },
    } as any;

    apiRouter(unauthReq, resUnauth, () => {});
    expect(statusCode).toBe(401);

    // 2. Authenticated request -> 200 with metadata
    const session = ctx.sessionManager.createSession({
      userId: user.user_id,
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const authReq = {
      method: "GET",
      url: "/",
      headers: {
        cookie: `ceo_user_session=${encodeURIComponent(session.sessionId)}`,
      },
    } as any;

    const resAuth = {
      status: (c: number) => {
        statusCode = c;
        return {
          json: (b: any) => {
            jsonBody = b;
          },
        };
      },
    } as any;

    apiRouter(authReq, resAuth, () => {});
    expect(statusCode).toBe(200);
    expect(jsonBody.installations).toBeDefined();
    expect(jsonBody.installations.length).toBe(1);
    const item = jsonBody.installations[0];
    expect(item.github_installation_id).toBe("123");
    expect(item.verified_at_ms).toBeDefined();
    // Zero secrets/tokens/workspace bindings exposed
    expect(item.token).toBeUndefined();
    expect(item.privateKey).toBeUndefined();
    expect(item.workspace_id).toBeUndefined();
  });

  it("supports zero-workspace user installing GitHub App", async () => {
    const ctx = await createTestContext();
    // User with external identity and ZERO workspaces
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "33333",
      providerLogin: "zero-ws-user",
    });

    // Verify user has 0 workspaces
    const raw = new DatabaseSync(ctx.dbPath);
    const memberships = raw
      .prepare("SELECT COUNT(*) as c FROM workspace_memberships WHERE user_id = ?;")
      .get(user.user_id) as { c: number };
    raw.close();
    expect(Number(memberships.c)).toBe(0);

    // Link installation for zero-workspace user
    const result = ctx.store.upsertGitHubInstallationWithUser({
      githubInstallationId: "789",
      githubAppId: "99",
      accountId: "33333",
      accountLogin: "zero-ws-user",
      accountType: "User",
      repositorySelection: "all",
      userId: user.user_id,
    });

    expect(result.installation.github_installation_id).toBe("789");
    const list = ctx.store.listGitHubInstallationsForUser(user.user_id);
    expect(list.length).toBe(1);
  });

  it("preserves existing /auth/github login behavior unchanged", async () => {
    const ctx = await createTestContext();
    const provisioner = new IdentityAccountProvisioner(ctx.store);

    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "login_access_token" }),
        } as any;
      }
      if (url.includes("/user")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 88888, login: "login_user" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const router = createGitHubAuthRouter({
      clientId: "login_client_id",
      clientSecret: "login_client_secret",
      callbackUrl: "http://localhost:3000/auth/github/callback",
      provisioner,
      sessionManager: ctx.sessionManager,
      fetchFn: mockFetch,
    });

    // Test GET /auth/github initiates login redirect
    let redirectUrl = "";
    router(
      { method: "GET", url: "/", query: {}, headers: {} } as any,
      {
        redirect: (_status: number, url: string) => {
          redirectUrl = url;
        },
      } as any,
      () => {},
    );
    expect(redirectUrl).toContain("https://github.com/login/oauth/authorize");
    expect(redirectUrl).toContain("client_id=login_client_id");
  });

  it("rejects /auth/github-app/callback when session is missing, expired, or logged-out with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    let networkCallMade = false;
    const mockFetch = async () => {
      networkCallMade = true;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "123",
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    // 1. JSON request without session cookie -> 401
    const reqJson = {
      method: "GET",
      url: `/callback?state=${oauthState}&code=test_code`,
      headers: { accept: "application/json" },
      query: { state: oauthState, code: "test_code" },
    } as any;
    let statusCode = 0;
    let jsonBody: any = null;
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return {
            json: (b: any) => {
              jsonBody = b;
              resolve();
            },
          };
        },
        redirect: () => resolve(),
      } as any;
      router(reqJson, res, () => resolve());
    });

    expect(statusCode).toBe(401);
    expect(jsonBody).toEqual({ error: "unauthenticated" });
    expect(networkCallMade).toBe(false);

    // 2. HTML request without session cookie -> 302 /login?error=unauthenticated
    const reqHtml = {
      method: "GET",
      url: `/callback?state=${oauthState}&code=test_code`,
      headers: { accept: "text/html" },
      query: { state: oauthState, code: "test_code" },
    } as any;
    let redirectLocation = "";
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return { json: () => resolve() };
        },
        redirect: (s: number, loc: string) => {
          statusCode = s;
          redirectLocation = loc;
          resolve();
        },
      } as any;
      router(reqHtml, res, () => resolve());
    });

    expect(statusCode).toBe(302);
    expect(redirectLocation).toBe("/login?error=unauthenticated");

    // Zero DB writes
    expect(ctx.store.listGitHubInstallationsForUser(user.user_id).length).toBe(0);
  });

  it("rejects /auth/github-app/callback when user is disabled with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    let networkCallMade = false;
    const mockFetch = async () => {
      networkCallMade = true;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const session = ctx.sessionManager.createSession({
      userId: user.user_id,
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    // Disable the user in DB
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), user.user_id);
    raw.close();

    const req = {
      method: "GET",
      url: "/callback?state=dummy_state&code=test_code",
      headers: {
        cookie: `ceo_user_session=${encodeURIComponent(session.sessionId)}`,
        accept: "application/json",
      },
      query: { state: "dummy_state", code: "test_code" },
    } as any;

    let statusCode = 0;
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return { json: () => resolve() };
        },
        redirect: () => resolve(),
      } as any;
      router(req, res, () => resolve());
    });

    expect(statusCode).toBe(401);
    expect(networkCallMade).toBe(false);
  });

  it("rejects /auth/github-app/callback when active session user differs from state owner with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const userA = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });
    const userB = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "22222",
      providerLogin: "bob",
    });

    let networkCallMade = false;
    const mockFetch = async () => {
      networkCallMade = true;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    // Alice starts install & setup flow
    const installUrl = installationService.createInstallRedirect(userA.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "123",
      userId: userA.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    // Bob tries to complete callback using Alice's OAuth state
    const bobSession = ctx.sessionManager.createSession({
      userId: userB.user_id,
      provider: "github",
      providerSubject: "22222",
      providerLogin: "bob",
    });

    const req = {
      method: "GET",
      url: `/callback?state=${oauthState}&code=test_code`,
      headers: {
        cookie: `ceo_user_session=${encodeURIComponent(bobSession.sessionId)}`,
        accept: "application/json",
      },
      query: { state: oauthState, code: "test_code" },
    } as any;

    let statusCode = 0;
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return { json: () => resolve() };
        },
        redirect: () => resolve(),
      } as any;
      router(req, res, () => resolve());
    });

    expect(statusCode).toBe(403);
    expect(networkCallMade).toBe(false);
    expect(ctx.store.listGitHubInstallationsForUser(userA.user_id).length).toBe(0);
    expect(ctx.store.listGitHubInstallationsForUser(userB.user_id).length).toBe(0);
  });

  it("rejects /auth/github-app/callback when session provider is not GitHub", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    // Session with non-github provider
    const nonGithubSession = ctx.sessionManager.createSession({
      userId: user.user_id,
      provider: "google" as any,
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const req = {
      method: "GET",
      url: "/callback?state=dummy_state&code=test_code",
      headers: {
        cookie: `ceo_user_session=${encodeURIComponent(nonGithubSession.sessionId)}`,
        accept: "application/json",
      },
      query: { state: "dummy_state", code: "test_code" },
    } as any;

    let statusCode = 0;
    let jsonBody: any = null;
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return {
            json: (b: any) => {
              jsonBody = b;
              resolve();
            },
          };
        },
        redirect: () => resolve(),
      } as any;
      router(req, res, () => resolve());
    });

    expect(statusCode).toBe(403);
    expect(jsonBody).toEqual({ error: "github_identity_required" });
  });

  it("successfully completes /auth/github-app/callback with matching live GitHub session and links installation", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "user_token_123" }),
        } as any;
      }
      if (url.includes("/user/installations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            installations: [
              {
                id: 12345,
                app_id: 99,
                target_id: 11111,
                account: {
                  id: 11111,
                  login: "alice",
                  type: "User",
                },
                repository_selection: "all",
                suspended_at: null,
              },
            ],
          }),
        } as any;
      }
      if (url.includes("/user")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 11111, login: "alice" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const router = createGitHubAppAuthRouter({
      installationService,
      sessionManager: ctx.sessionManager,
      store: ctx.store,
    });

    const session = ctx.sessionManager.createSession({
      userId: user.user_id,
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "12345",
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    const req = {
      method: "GET",
      url: `/callback?state=${oauthState}&code=valid_code`,
      headers: {
        cookie: `ceo_user_session=${encodeURIComponent(session.sessionId)}`,
        accept: "application/json",
      },
      query: { state: oauthState, code: "valid_code" },
    } as any;

    let statusCode = 0;
    let jsonBody: any = null;
    await new Promise<void>((resolve) => {
      const res = {
        status: (c: number) => {
          statusCode = c;
          return {
            json: (b: any) => {
              jsonBody = b;
              resolve();
            },
          };
        },
        redirect: () => resolve(),
      } as any;
      router(req, res, () => resolve());
    });

    expect(statusCode).toBe(200);
    expect(jsonBody).toEqual({ success: true });

    const installations = ctx.store.listGitHubInstallationsForUser(user.user_id);
    expect(installations.length).toBe(1);
    expect(installations[0].github_installation_id).toBe("12345");
  });

  it("verifies candidate installation located beyond page 1 (>100 installations pagination)", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const requestedPages: number[] = [];
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "token_page_test" }),
        } as any;
      }
      if (url.includes("/user/installations")) {
        const parsedUrl = new URL(url);
        const page = Number(parsedUrl.searchParams.get("page") || "1");
        requestedPages.push(page);

        if (page === 1) {
          // Page 1 has 100 installations (ids 1001..1100), candidate 99999 is NOT here
          const page1Insts = Array.from({ length: 100 }, (_, i) => ({
            id: 1001 + i,
            app_id: 99,
            account: { id: 11111, login: "alice", type: "User" },
            repository_selection: "all",
            suspended_at: null,
          }));
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 105, installations: page1Insts }),
          } as any;
        } else if (page === 2) {
          // Page 2 has 5 installations, including candidate 99999
          const page2Insts = [
            {
              id: 99999,
              app_id: 99,
              account: { id: 11111, login: "alice", type: "User" },
              repository_selection: "selected",
              suspended_at: null,
            },
            ...Array.from({ length: 4 }, (_, i) => ({
              id: 2001 + i,
              app_id: 99,
              account: { id: 11111, login: "alice", type: "User" },
              repository_selection: "all",
              suspended_at: null,
            })),
          ];
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 105, installations: page2Insts }),
          } as any;
        }
      }
      if (url.includes("/user")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 11111, login: "alice" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "99999",
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    const result = await installationService.handleOAuthCallback({
      state: oauthState,
      code: "code_page_test",
      currentUserId: user.user_id,
      currentProviderSubject: "11111",
    });

    expect(result.installationId).toBe("99999");
    expect(requestedPages).toEqual([1, 2]);

    const inst = ctx.store.findGitHubInstallationById("99999");
    expect(inst).not.toBeNull();
    expect(inst?.repository_selection).toBe("selected");
  });

  it("rejects candidate installation absent across all pages with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const requestedPages: number[] = [];
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "token_absent_test" }),
        } as any;
      }
      if (url.includes("/user/installations")) {
        const parsedUrl = new URL(url);
        const page = Number(parsedUrl.searchParams.get("page") || "1");
        requestedPages.push(page);

        if (page === 1) {
          const page1Insts = Array.from({ length: 100 }, (_, i) => ({
            id: 1001 + i,
            app_id: 99,
            account: { id: 11111, login: "alice", type: "User" },
            repository_selection: "all",
            suspended_at: null,
          }));
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 105, installations: page1Insts }),
          } as any;
        } else if (page === 2) {
          const page2Insts = Array.from({ length: 5 }, (_, i) => ({
            id: 2001 + i,
            app_id: 99,
            account: { id: 11111, login: "alice", type: "User" },
            repository_selection: "all",
            suspended_at: null,
          }));
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 105, installations: page2Insts }),
          } as any;
        }
      }
      if (url.includes("/user")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 11111, login: "alice" }),
        } as any;
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
      fetchFn: mockFetch,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
      fetchFn: mockFetch,
    });

    const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
    const installState = new URL(installUrl).searchParams.get("state")!;
    const setupUrl = installationService.startSetupOAuth({
      state: installState,
      installationId: "88888", // Not in page 1 or page 2
      userId: user.user_id,
    });
    const oauthState = new URL(setupUrl).searchParams.get("state")!;

    await expect(
      installationService.handleOAuthCallback({
        state: oauthState,
        code: "code_absent_test",
        currentUserId: user.user_id,
        currentProviderSubject: "11111",
      }),
    ).rejects.toThrow(GitHubInstallationNotFoundError);

    expect(requestedPages).toEqual([1, 2]);

    // Zero DB writes
    const raw = new DatabaseSync(ctx.dbPath);
    const count = raw.prepare("SELECT COUNT(*) as c FROM github_installations;").get() as { c: number };
    raw.close();
    expect(Number(count.c)).toBe(0);
  });

  it("fails closed on malformed installation payload semantics with ZERO DB writes", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const malformedPayloads = [
      // invalid account.type
      {
        id: 555,
        app_id: 99,
        account: { id: 11111, login: "alice", type: "Bot" },
        repository_selection: "all",
        suspended_at: null,
      },
      // invalid repository_selection
      {
        id: 555,
        app_id: 99,
        account: { id: 11111, login: "alice", type: "User" },
        repository_selection: "none",
        suspended_at: null,
      },
      // non-number installation id
      {
        id: "555" as any,
        app_id: 99,
        account: { id: 11111, login: "alice", type: "User" },
        repository_selection: "all",
        suspended_at: null,
      },
      // negative app_id
      {
        id: 555,
        app_id: -1,
        account: { id: 11111, login: "alice", type: "User" },
        repository_selection: "all",
        suspended_at: null,
      },
      // float account.id
      {
        id: 555,
        app_id: 99,
        account: { id: 1.5, login: "alice", type: "User" },
        repository_selection: "all",
        suspended_at: null,
      },
      // empty account.login
      {
        id: 555,
        app_id: 99,
        account: { id: 11111, login: "   ", type: "User" },
        repository_selection: "all",
        suspended_at: null,
      },
      // invalid suspended_at date
      {
        id: 555,
        app_id: 99,
        account: { id: 11111, login: "alice", type: "User" },
        repository_selection: "all",
        suspended_at: "not-a-date",
      },
      // non-positive suspended_at (epoch 0)
      {
        id: 555,
        app_id: 99,
        account: { id: 11111, login: "alice", type: "User" },
        repository_selection: "all",
        suspended_at: "1970-01-01T00:00:00.000Z",
      },
    ];

    for (const badInst of malformedPayloads) {
      const candidateId = "555";
      const mockFetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/login/oauth/access_token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "token_test" }),
          } as any;
        }
        if (url.includes("/user/installations")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 1,
              installations: [badInst],
            }),
          } as any;
        }
        if (url.includes("/user")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: 11111, login: "alice" }),
          } as any;
        }
        throw new Error(`Unexpected url: ${url}`);
      };

      const appClient = new GitHubAppClient({
        clientId: ctx.clientId,
        privateKey: ctx.rsaKeys.privateKey,
        fetchFn: mockFetch,
      });
      const installationService = new GitHubInstallationService({
        appClient,
        store: ctx.store,
        clientId: ctx.clientId,
        clientSecret: ctx.clientSecret,
        slug: ctx.slug,
        callbackUrl: ctx.callbackUrl,
        fetchFn: mockFetch,
      });

      const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
      const installState = new URL(installUrl).searchParams.get("state")!;
      const setupUrl = installationService.startSetupOAuth({
        state: installState,
        installationId: candidateId,
        userId: user.user_id,
      });
      const oauthState = new URL(setupUrl).searchParams.get("state")!;

      await expect(
        installationService.handleOAuthCallback({
          state: oauthState,
          code: "test_code",
          currentUserId: user.user_id,
          currentProviderSubject: "11111",
        }),
      ).rejects.toThrow(GitHubInstallationError);

      // Verify ZERO DB writes
      const raw = new DatabaseSync(ctx.dbPath);
      const count = raw.prepare("SELECT COUNT(*) as c FROM github_installations;").get() as { c: number };
      raw.close();
      expect(Number(count.c)).toBe(0);
    }
  });

  it("startSetupOAuth rejects non-positive-decimal installation_id", async () => {
    const ctx = await createTestContext();
    const user = ctx.store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "11111",
      providerLogin: "alice",
    });

    const appClient = new GitHubAppClient({
      clientId: ctx.clientId,
      privateKey: ctx.rsaKeys.privateKey,
    });
    const installationService = new GitHubInstallationService({
      appClient,
      store: ctx.store,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
      slug: ctx.slug,
      callbackUrl: ctx.callbackUrl,
    });

    for (const badId of ["0", "0123", "-1", "+1", "abc", "", "1.5"]) {
      const installUrl = installationService.createInstallRedirect(user.user_id, "11111");
      const installState = new URL(installUrl).searchParams.get("state")!;
      expect(() =>
        installationService.startSetupOAuth({
          state: installState,
          installationId: badId,
          userId: user.user_id,
        }),
      ).toThrow(GitHubInstallationError);
    }
  });
});
