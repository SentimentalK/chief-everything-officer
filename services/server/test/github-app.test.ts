import { describe, expect, it, afterEach, beforeEach } from "vitest";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import {
  createGitHubAppJwt,
  GitHubAppClient,
  GitHubAppError,
} from "../src/github/app-client.js";
import {
  GitHubInstallationService,
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

  provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });

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
});
