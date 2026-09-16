import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  OAuthStore,
  sha256Base64Url,
} from "../src/oauth/store.js";
import {
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";
import { OAuthService } from "../src/oauth/service.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { createMcpAuthMiddleware } from "../src/auth.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import {
  CimdClientResolver,
  CompositeClientResolver,
  isDcrClientId,
  OAuthClientResolutionError,
} from "../src/oauth/client-resolver.js";
import { DcrStore } from "../src/oauth/dcr/store.js";
import { DcrClientResolver, DcrRegistrationError, DcrService } from "../src/oauth/dcr/service.js";
import { createDcrRouter } from "../src/oauth/dcr/router.js";

const cleanupDirs: string[] = [];
const cleanupOAuthStores: OAuthStore[] = [];
const cleanupDcrStores: DcrStore[] = [];
const cleanupIdentServices: IdentityService[] = [];

afterEach(async () => {
  for (const st of cleanupOAuthStores.splice(0)) st.close();
  for (const st of cleanupDcrStores.splice(0)) st.close();
  for (const st of cleanupIdentServices.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LOOPBACK = "http://127.0.0.1:54321/oauth/callback";

async function setupDcrEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-dcr-test-"));
  cleanupDirs.push(dir);

  const identDbPath = path.join(dir, "identity.sqlite");
  const ident = provisionEmptyIdentityDatabase(identDbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });
  const identityService = IdentityService.open(
    {
      remoteUrl: "git@example.com:test/repo.git",
      branch: "main",
      envApiKey: "test-key",
    },
    identDbPath,
  );
  cleanupIdentServices.push(identityService);
  const identStore = identityService.storeInstance;

  const oauthStore = new OAuthStore(path.join(dir, "oauth.sqlite"));
  cleanupOAuthStores.push(oauthStore);
  const dcrStore = new DcrStore(path.join(dir, "oauth-dcr.sqlite"));
  cleanupDcrStores.push(dcrStore);
  const dcrService = new DcrService(dcrStore);

  const publicOrigin = "https://ceo.sentimentalk.com";
  const sessionManager = new UserSessionManager({ secureCookies: false });
  const oauthService = new OAuthService(oauthStore, identStore, {
    publicOrigin,
    workspaceId: ident.workspace_id,
    clientResolver: new CompositeClientResolver({
      cimd: new CimdClientResolver({
        allowHttpForTest: true,
        allowPrivateIpsForTest: true,
        dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
      dcr: new DcrClientResolver(dcrService),
      allowHttpForTest: true,
    }),
    registrationEndpoint: `${publicOrigin}/register`,
  });

  const app = express();
  app.use(express.json());
  app.use(createDcrRouter({ dcrService }));
  app.use(createOAuthRouter({ oauthService, sessionManager }));
  app.all("/mcp", createMcpAuthMiddleware(identityService, oauthService), (_req, res) => {
    res.status(200).json({
      ok: true,
      user_id: res.locals.identity?.user_id,
      workspace_id: res.locals.identity?.workspace_id,
    });
  });

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    dir,
    ident,
    identStore,
    dcrStore,
    dcrService,
    oauthService,
    sessionManager,
    publicOrigin,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function register(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = { "Content-Type": "application/json" },
) {
  return fetch(`${baseUrl}/register`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("RFC 7591 DCR compatibility", () => {
  it("registers a public client, persists it, and resolves after restart", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, {
        client_name: "Gemini CLI",
        redirect_uris: [LOOPBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: "mcp offline_access",
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("pragma")).toBe("no-cache");
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.client_id).toBe("string");
      expect(isDcrClientId(body.client_id as string)).toBe(true);
      expect(body.client_secret).toBeUndefined();
      expect(body.client_secret_expires_at).toBeUndefined();
      expect(body.registration_access_token).toBeUndefined();
      expect(body.client_name).toBe("Gemini CLI");
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.application_type).toBe("native");
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      expect(body.response_types).toEqual(["code"]);

      env.dcrStore.close();
      const reopened = new DcrStore(path.join(env.dir, "oauth-dcr.sqlite"));
      cleanupDcrStores.push(reopened);
      const row = reopened.getClient(body.client_id as string);
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.metadata_json).some_future_google_field).toBeUndefined();
      const resolved = new DcrService(reopened).resolve(body.client_id as string);
      expect(resolved.client_name).toBe("Gemini CLI");
      expect(resolved.redirect_uris).toEqual([LOOPBACK]);
    } finally {
      await env.close();
    }
  });

  it("ignores unknown extension metadata instead of rejecting the request", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, {
        redirect_uris: [LOOPBACK],
        token_endpoint_auth_method: "none",
        some_future_google_field: "foo",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.some_future_google_field).toBeUndefined();
      const row = env.dcrStore.getClient(body.client_id as string);
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.metadata_json)).not.toHaveProperty("some_future_google_field");
    } finally {
      await env.close();
    }
  });

  it("applies RFC 7591 grant_types and response_types omission defaults", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, { redirect_uris: [LOOPBACK] });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.grant_types).toEqual(["authorization_code"]);
      expect(body.response_types).toEqual(["code"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.client_name).toBe("Dynamic MCP Client");
    } finally {
      await env.close();
    }
  });

  it("treats omitted token_endpoint_auth_method as a CEO public-client override to none, not the RFC default", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, { redirect_uris: [LOOPBACK] });
      const body = (await res.json()) as Record<string, unknown>;
      // RFC 7591 default would be client_secret_basic; CEO overrides to none.
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.token_endpoint_auth_method).not.toBe("client_secret_basic");
    } finally {
      await env.close();
    }
  });

  it("rejects explicit unsupported grant_types without silently adding authorization_code", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, {
        redirect_uris: [LOOPBACK],
        grant_types: ["client_credentials"],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client_metadata");
    } finally {
      await env.close();
    }
  });

  it("accepts HTTPS, localhost, 127.0.0.1, and ::1 redirects; rejects the rest", async () => {
    const env = await setupDcrEnv();
    try {
      const accepted = [
        ["https://example.com/callback"],
        ["http://localhost:9/cb"],
        ["http://127.0.0.1:49152/oauth/callback"],
        ["http://[::1]:8080/cb"],
      ];
      for (const redirect_uris of accepted) {
        const res = await register(env.baseUrl, { redirect_uris });
        expect(res.status).toBe(201);
      }

      const rejected = [
        ["http://192.168.1.9/cb"],
        ["http://example.com/cb"],
        ["https://example.com/cb#frag"],
        ["myapp://callback"],
        [],
        Array.from({ length: 11 }, (_, i) => `https://example.com/cb${i}`),
        ["https://example.com/cb", "https://example.com/cb"],
        ["https://example.com/" + "a".repeat(2048)],
      ];
      for (const redirect_uris of rejected) {
        const res = await register(env.baseUrl, { redirect_uris });
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("invalid_redirect_uri");
      }
    } finally {
      await env.close();
    }
  });

  it("rejects confidential auth methods, implicit response types, and invalid application_type", async () => {
    const env = await setupDcrEnv();
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
        [{ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "client_secret_post" }, "invalid_client_metadata"],
        [{ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
        [{ redirect_uris: [LOOPBACK], response_types: ["token"] }, "invalid_client_metadata"],
        [{ redirect_uris: [LOOPBACK], application_type: "service" }, "invalid_client_metadata"],
        [{ redirect_uris: [LOOPBACK], client_secret: "nope" }, "invalid_client_metadata"],
      ];
      for (const [payload, error] of cases) {
        const res = await register(env.baseUrl, payload);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe(error);
      }

      for (const application_type of ["native", "web"]) {
        const res = await register(env.baseUrl, { redirect_uris: [LOOPBACK], application_type });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { application_type: string }).application_type).toBe(application_type);
      }
    } finally {
      await env.close();
    }
  });

  it("returns invalid_software_statement for software_statement", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(env.baseUrl, {
        redirect_uris: [LOOPBACK],
        software_statement: "eyJhbGciOiJub25lIn0.",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("pragma")).toBe("no-cache");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_software_statement");
    } finally {
      await env.close();
    }
  });

  it("returns 415 for non-JSON Content-Type", async () => {
    const env = await setupDcrEnv();
    try {
      const res = await register(
        env.baseUrl,
        "redirect_uris=http://127.0.0.1/cb",
        { "Content-Type": "application/x-www-form-urlencoded" },
      );
      expect(res.status).toBe(415);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await env.close();
    }
  });

  it("creates unique client IDs for concurrent equivalent registrations", async () => {
    const env = await setupDcrEnv();
    try {
      const payload = { redirect_uris: [LOOPBACK], client_name: "Parallel" };
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => register(env.baseUrl, payload)),
      );
      const ids = await Promise.all(responses.map(async (res) => {
        expect(res.status).toBe(201);
        return ((await res.json()) as { client_id: string }).client_id;
      }));
      expect(new Set(ids).size).toBe(8);
      for (const id of ids) {
        expect(env.dcrStore.getClient(id)).not.toBeNull();
      }
    } finally {
      await env.close();
    }
  });

  it("fails closed on corrupt persisted metadata", async () => {
    const env = await setupDcrEnv();
    try {
      const registered = env.dcrService.register({ redirect_uris: [LOOPBACK] });
      env.dcrStore.close();
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(env.dir, "oauth-dcr.sqlite"));
      db.prepare("UPDATE dynamic_clients SET metadata_json = ? WHERE client_id = ?").run(
        "{not-json",
        registered.client_id,
      );
      db.close();
      const reopened = new DcrStore(path.join(env.dir, "oauth-dcr.sqlite"));
      cleanupDcrStores.push(reopened);
      expect(() => new DcrService(reopened).resolve(registered.client_id)).toThrow(
        OAuthClientResolutionError,
      );
    } finally {
      await env.close();
    }
  });

  it("advertises registration_endpoint when DCR is composed and runs a full OAuth E2E", async () => {
    const env = await setupDcrEnv();
    try {
      const metaRes = await fetch(`${env.baseUrl}/.well-known/oauth-authorization-server`);
      const meta = (await metaRes.json()) as { registration_endpoint?: string };
      expect(meta.registration_endpoint).toBe(`${env.publicOrigin}/register`);

      const registeredRes = await register(env.baseUrl, {
        client_name: "DCR E2E Client",
        redirect_uris: [LOOPBACK],
        grant_types: ["authorization_code", "refresh_token"],
        application_type: "native",
      });
      const registered = (await registeredRes.json()) as { client_id: string };
      const verifier = "dcr_e2e_verifier_123456789012345678901234";
      const challenge = sha256Base64Url(verifier);

      const userSession = env.sessionManager.createSession({
        userId: env.ident.user_id,
        provider: "github",
        providerSubject: "12345",
      });

      const authorizeUrl = new URL(`${env.baseUrl}/authorize`);
      authorizeUrl.searchParams.set("client_id", registered.client_id);
      authorizeUrl.searchParams.set("redirect_uri", LOOPBACK);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("resource", `${env.publicOrigin}/mcp`);
      authorizeUrl.searchParams.set("scope", "mcp offline_access");
      authorizeUrl.searchParams.set("state", "e2e");

      const authorizeRes = await fetch(authorizeUrl, {
        headers: { Cookie: `ceo_user_session=${userSession.sessionId}` },
      });
      expect(authorizeRes.status).toBe(200);
      const html = await authorizeRes.text();
      const nonceMatch = html.match(/name="consent_nonce" value="([^"]+)"/);
      const requestMatch = html.match(/name="request_id" value="([^"]+)"/);
      expect(nonceMatch).toBeTruthy();
      expect(requestMatch).toBeTruthy();

      const decision = new URLSearchParams({
        request_id: requestMatch![1],
        consent_nonce: nonceMatch![1],
        decision: "approve",
      });
      const decisionRes = await fetch(`${env.baseUrl}/authorize/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `ceo_user_session=${userSession.sessionId}`,
        },
        body: decision.toString(),
        redirect: "manual",
      });
      expect(decisionRes.status).toBe(302);
      const loc = new URL(decisionRes.headers.get("location")!);
      const code = loc.searchParams.get("code");
      expect(code).toMatch(/^oac_/);

      const tokenRes = await fetch(`${env.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registered.client_id,
          redirect_uri: LOOPBACK,
          code: code!,
          code_verifier: verifier,
          resource: `${env.publicOrigin}/mcp`,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = (await tokenRes.json()) as { access_token: string };
      expect(tokens.access_token).toMatch(/^ceo_at_/);

      const mcpRes = await fetch(`${env.baseUrl}/mcp`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      expect(mcpRes.status).toBe(200);
      const mcpBody = (await mcpRes.json()) as { user_id: string };
      expect(mcpBody.user_id).toBe(env.ident.user_id);
    } finally {
      await env.close();
    }
  });
});

describe("DcrService unit contracts", () => {
  it("throws DcrRegistrationError for empty redirect_uris", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-dcr-unit-"));
    cleanupDirs.push(dir);
    const store = new DcrStore(path.join(dir, "oauth-dcr.sqlite"));
    cleanupDcrStores.push(store);
    const service = new DcrService(store);
    expect(() => service.register({ redirect_uris: [] })).toThrow(DcrRegistrationError);
  });
});
