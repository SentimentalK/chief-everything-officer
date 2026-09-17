import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  IdentityStore,
} from "../src/identity/store.js";
import { seedIdentity } from "./helpers.js";
import { IdentityAccountProvisioner } from "../src/identity/provisioner.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { createGitHubAuthRouter, validateGitHubProfile } from "../src/auth/github.js";
import { createUserRouter } from "../src/auth/user-router.js";

const cleanupDirs: string[] = [];
const cleanupStores: IdentityStore[] = [];

afterEach(async () => {
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function seedExternalIdentity(
  dbPath: string,
  input: {
    id: string;
    provider: string;
    providerSubject: string;
    userId: string;
    providerLogin?: string | null;
  },
): void {
  const raw = new DatabaseSync(dbPath);
  const now = Date.now();
  raw.prepare(
    `INSERT INTO external_identities (id, provider, provider_subject, user_id, provider_login, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
  ).run(
    input.id,
    input.provider,
    input.providerSubject,
    input.userId,
    input.providerLogin ?? null,
    now,
    now,
  );
  raw.close();
}

async function setupTestApp(mockFetch?: typeof fetch, seedDogfoodBinding = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-gh-auth-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");

  const ident = seedIdentity({ identityDbPath: dbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" }, "test-key");

  if (seedDogfoodBinding) {
    seedExternalIdentity(dbPath, {
      id: "ext_dogfood",
      provider: "github",
      providerSubject: "40360455",
      userId: ident.user_id,
      providerLogin: "SentimentalK",
    });
  }

  const store = IdentityStore.open(dbPath);
  cleanupStores.push(store);

  const provisioner = new IdentityAccountProvisioner(store);
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
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    store,
    ident,
    provisioner,
    sessionManager,
    baseUrl,
    dbPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("validateGitHubProfile", () => {
  it("rejects invalid GitHub profiles", () => {
    expect(validateGitHubProfile({ id: 0, login: "x" })).toBeNull();
    expect(validateGitHubProfile({ id: -1, login: "x" })).toBeNull();
    expect(validateGitHubProfile({ id: 1.5, login: "x" })).toBeNull();
    expect(validateGitHubProfile({ id: "123", login: "x" })).toBeNull();
    expect(validateGitHubProfile({ id: 123, login: "" })).toBeNull();
    expect(validateGitHubProfile({ id: 123, login: "   " })).toBeNull();
    expect(validateGitHubProfile({ id: 123, login: 42 })).toBeNull();
  });

  it("accepts valid GitHub profiles", () => {
    expect(validateGitHubProfile({ id: 40360455, login: "SentimentalK" })).toEqual({
      providerSubject: "40360455",
      providerLogin: "SentimentalK",
    });
  });
});

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

  it("successful OAuth exchange issues ceo_user_session for existing dogfood binding", async () => {
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
        } as Response;
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
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const env = await setupTestApp(mockFetch as typeof fetch, true);
    try {
      const initRes = await fetch(`${env.baseUrl}/auth/github`, { redirect: "manual" });
      const authUrl = new URL(initRes.headers.get("location")!);
      const state = authUrl.searchParams.get("state")!;

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

      const match = setCookie!.match(/ceo_user_session=([^;]+)/);
      const sessionToken = match![1];

      const bound = env.store.findExternalIdentity("github", "40360455");
      expect(bound).not.toBeNull();
      expect(bound?.user_id).toBe(env.ident.user_id);
      expect(bound?.provider_login).toBe("SentimentalK");

      const sessionRes = await fetch(`${env.baseUrl}/api/user/session`, {
        headers: { Cookie: `ceo_user_session=${sessionToken}` },
      });
      expect(sessionRes.status).toBe(200);
      const sessionData = await sessionRes.json();
      expect(sessionData.authenticated).toBe(true);
      expect(sessionData.user.id).toBe(env.ident.user_id);
      expect(sessionData.user.provider).toBe("github");
      expect(sessionData.user.provider_login).toBe("SentimentalK");
      expect(sessionData.user.provider_subject).toBeUndefined();

      const logoutRes = await fetch(`${env.baseUrl}/api/user/session/logout`, {
        method: "POST",
        headers: { Cookie: `ceo_user_session=${sessionToken}` },
      });
      expect(logoutRes.status).toBe(200);

      const afterRes = await fetch(`${env.baseUrl}/api/user/session`, {
        headers: { Cookie: `ceo_user_session=${sessionToken}` },
      });
      const afterData = await afterRes.json();
      expect(afterData.authenticated).toBe(false);
    } finally {
      await env.close();
    }
  });

  it("H. new GitHub user gets browser session without owning a workspace", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "mock-gh-token" }),
        } as Response;
      }
      if (url === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 999888777, login: "NewUser" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const env = await setupTestApp(mockFetch as typeof fetch, false);
    try {
      const initRes = await fetch(`${env.baseUrl}/auth/github`, { redirect: "manual" });
      const state = new URL(initRes.headers.get("location")!).searchParams.get("state")!;

      const callbackRes = await fetch(
        `${env.baseUrl}/auth/github/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(callbackRes.status).toBe(302);

      const bound = env.store.findExternalIdentity("github", "999888777");
      expect(bound).not.toBeNull();
      expect(bound!.user_id).not.toBe(env.ident.user_id);

      const raw = new DatabaseSync(env.dbPath);
      const wsCount = raw.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE owner_user_id = ?;").get(bound!.user_id) as {
        c: number;
      };
      const keyCount = raw.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?;").get(bound!.user_id) as {
        c: number;
      };
      raw.close();
      expect(Number(wsCount.c)).toBe(0);
      expect(Number(keyCount.c)).toBe(0);

      const sessionToken = callbackRes.headers.get("set-cookie")!.match(/ceo_user_session=([^;]+)/)![1];
      const sessionRes = await fetch(`${env.baseUrl}/api/user/session`, {
        headers: { Cookie: `ceo_user_session=${sessionToken}` },
      });
      const sessionData = await sessionRes.json();
      expect(sessionData.authenticated).toBe(true);
      expect(sessionData.user.id).toBe(bound!.user_id);
    } finally {
      await env.close();
    }
  });
});
