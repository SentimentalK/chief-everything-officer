import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { SingletonAccountProvisioner } from "../src/identity/provisioner.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { createGitHubAuthRouter } from "../src/auth/github.js";
import { createUserRouter } from "../src/auth/user-router.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupTestApp(mockFetch?: typeof fetch) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-gh-auth-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");

  const ident = provisionEmptyIdentityDatabase(dbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });

  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);

  const provisioner = new SingletonAccountProvisioner(store, ident);
  const sessionManager = new UserSessionManager({ secureCookies: false });

  const app = express();
  app.use(express.json());

  const githubRouter = createGitHubAuthRouter({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    callbackUrl: "http://127.0.0.1:3000/auth/github/callback",
    provisioner,
    sessionManager,
    fetchFn: mockFetch,
  });

  const userRouter = createUserRouter({
    store,
    sessionManager,
  });

  app.use("/auth/github", githubRouter);
  app.use("/api/user", userRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    store,
    ident,
    provisioner,
    sessionManager,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("GitHub OAuth PKCE Flow & User Session", () => {
  it("GET /auth/github initiates authorization and redirects with PKCE challenge", async () => {
    const env = await setupTestApp();
    try {
      const res = await fetch(`${env.baseUrl}/auth/github`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBeTruthy();

      const url = new URL(location!);
      expect(url.origin).toBe("https://github.com");
      expect(url.pathname).toBe("/login/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/github/callback");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("state")).toBeTruthy();
    } finally {
      await env.close();
    }
  });

  it("GET /auth/github/callback rejects missing or invalid state", async () => {
    const env = await setupTestApp();
    try {
      const res = await fetch(`${env.baseUrl}/auth/github/callback?code=foo&state=invalid_state`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe("/login?error=invalid_or_expired_state");
    } finally {
      await env.close();
    }
  });

  it("successful OAuth exchange issues ceo_user_session and binds external identity", async () => {
    let exchangeCalled = false;
    let userFetchCalled = false;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        exchangeCalled = true;
        const body = JSON.parse(String(init?.body));
        expect(body.client_id).toBe("test-client-id");
        expect(body.client_secret).toBe("test-client-secret");
        expect(body.code).toBe("valid-code");
        expect(body.code_verifier).toBeTruthy();
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "mock-gh-token-123" }),
        } as any;
      }
      if (url === "https://api.github.com/user") {
        userFetchCalled = true;
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer mock-gh-token-123",
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 40360455, login: "SentimentalK" }),
        } as any;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const env = await setupTestApp(mockFetch as any);
    try {
      // 1. Initiate OAuth to generate state
      const initRes = await fetch(`${env.baseUrl}/auth/github`, { redirect: "manual" });
      const authUrl = new URL(initRes.headers.get("location")!);
      const state = authUrl.searchParams.get("state")!;

      // 2. Callback with valid state and code
      const callbackRes = await fetch(
        `${env.baseUrl}/auth/github/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe("/login");
      expect(exchangeCalled).toBe(true);
      expect(userFetchCalled).toBe(true);

      const setCookie = callbackRes.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("ceo_user_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");

      const match = setCookie!.match(/ceo_user_session=([^;]+)/);
      const sessionToken = match![1];

      // 3. Verify external_identities table in DB has the binding
      const bound = env.store.findExternalIdentity("github", "40360455");
      expect(bound).not.toBeNull();
      expect(bound?.user_id).toBe(env.ident.user_id);
      expect(bound?.provider_login).toBe("SentimentalK");

      // 4. GET /api/user/session with cookie returns authenticated session
      const sessionRes = await fetch(`${env.baseUrl}/api/user/session`, {
        headers: {
          Cookie: `ceo_user_session=${sessionToken}`,
        },
      });
      expect(sessionRes.status).toBe(200);
      const sessionData = await sessionRes.json();
      expect(sessionData.authenticated).toBe(true);
      expect(sessionData.user.id).toBe(env.ident.user_id);
      expect(sessionData.user.provider).toBe("github");
      expect(sessionData.user.provider_login).toBe("SentimentalK");
      // Must NOT leak numeric ID to frontend!
      expect(sessionData.user.provider_subject).toBeUndefined();

      // 5. POST /api/user/session/logout clears session
      const logoutRes = await fetch(`${env.baseUrl}/api/user/session/logout`, {
        method: "POST",
        headers: {
          Cookie: `ceo_user_session=${sessionToken}`,
        },
      });
      expect(logoutRes.status).toBe(200);
      const logoutCookie = logoutRes.headers.get("set-cookie");
      expect(logoutCookie).toContain("Max-Age=0");

      // After logout, session is false
      const afterRes = await fetch(`${env.baseUrl}/api/user/session`, {
        headers: {
          Cookie: `ceo_user_session=${sessionToken}`,
        },
      });
      const afterData = await afterRes.json();
      expect(afterData.authenticated).toBe(false);
    } finally {
      await env.close();
    }
  });
});
