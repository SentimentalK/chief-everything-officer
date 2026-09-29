import { describe, it, expect, afterEach } from "vitest";
import express, { type Request, type Response } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  OAuthStore,
  sha256Base64Url,
} from "../src/oauth/store.js";
import {
  sha256Hex,
} from "../src/identity/store.js";
import { IdentityService } from "../src/identity/service.js";
import { seedIdentity } from "./helpers.js";
import { OAuthService } from "../src/oauth/service.js";
import { createCimdOnlyClientResolver } from "../src/oauth/client-resolver.js";
import { createMcpAuthMiddleware } from "../src/auth.js";
import { OAuthStoreUnavailable } from "../src/oauth/store.js";

const cleanupDirs: string[] = [];
const cleanupOAuthStores: OAuthStore[] = [];
const cleanupIdentServices: IdentityService[] = [];

afterEach(async () => {
  for (const st of cleanupOAuthStores.splice(0)) st.close();
  for (const st of cleanupIdentServices.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A historical raw MCP API key. It is NOT stored anywhere: the legacy
 * DB-backed API-key credential surface is fully retired, so this string
 * must always be rejected as an invalid token.
 */
const LEGACY_RAW_API_KEY = "test-legacy-mcp-api-key";

async function setupMcpAuthTestApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-mcp-oauth-test-"));
  cleanupDirs.push(dir);

  const identDbPath = path.join(dir, "identity.sqlite");
  const ident = seedIdentity({ identityDbPath: identDbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" });

  const identityService = IdentityService.open(identDbPath);
  cleanupIdentServices.push(identityService);

  const oauthDbPath = path.join(dir, "oauth.sqlite");
  const oauthStore = new OAuthStore(oauthDbPath);
  cleanupOAuthStores.push(oauthStore);

  const publicOrigin = "https://ceo.sentimentalk.com";
  const oauthService = new OAuthService(oauthStore, identityService.storeInstance, {
    publicOrigin,
    workspaceId: ident.workspace_id,
    clientResolver: createCimdOnlyClientResolver(),
  });

  const app = express();
  app.use(express.json());

  // Protected /mcp endpoint (OAuth-only resource-server middleware)
  app.all(
    "/mcp",
    createMcpAuthMiddleware(oauthService),
    (req: Request, res: Response) => {
      res.status(200).json({
        jsonrpc: "2.0",
        result: {
          authenticated: true,
          user_id: res.locals.identity?.user_id,
          workspace_id: res.locals.identity?.workspace_id,
        },
        id: null,
      });
    }
  );

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    ident,
    identityService,
    oauthStore,
    oauthService,
    baseUrl,
    publicOrigin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("MCP Resource Server OAuth-Only Authentication Integration", () => {
  it("rejects a historical legacy raw MCP API key with 401 (invalid_token)", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${LEGACY_RAW_API_KEY}`,
        },
      });

      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toContain('error="invalid_token"');
      expect(wwwAuth).toContain(`resource_metadata="${env.publicOrigin}/.well-known/oauth-protected-resource/mcp"`);
      const data = (await res.json()) as any;
      expect(data.error.code).toBe(-32001);
    } finally {
      await env.close();
    }
  });

  it("authenticates /mcp using valid OAuth Bearer access token", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      // Issue an OAuth access token
      const verifier = "verifier_mcp_test_12345678901234567890";
      const challenge = sha256Base64Url(verifier);
      const reqId = "oar_mcp_val";

      env.oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "https://chatgpt.com/client.json",
        client_name: "ChatGPT",
        redirect_uri: "https://chatgpt.com/callback",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "mcp offline_access",
        state: null,
        code_challenge: challenge,
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });

      const nonce = env.oauthService.createConsentNonce(reqId);
      const approval = env.oauthService.approveConsent(reqId, nonce, env.ident.user_id);
      const tokens = env.oauthService.exchangeAuthorizationCode({
        clientId: "https://chatgpt.com/client.json",
        redirectUri: "https://chatgpt.com/callback",
        code: approval.code,
        codeVerifier: verifier,
        resource: "https://ceo.sentimentalk.com/mcp",
      });

      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.result.authenticated).toBe(true);
      expect(data.result.user_id).toBe(env.ident.user_id);
      expect(data.result.workspace_id).toBe(env.ident.workspace_id);
    } finally {
      await env.close();
    }
  });

  it("logs mcp-auth oauth success and rejection without bearer secrets", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      const verifier = "verifier_mcp_obs_secret_do_not_log_123456";
      const challenge = sha256Base64Url(verifier);
      const reqId = "oar_mcp_obs";
      env.oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "dcr_mcp_obs_client_must_not_be_logged",
        client_name: "Google",
        redirect_uri: "https://oauth-redirect.googleusercontent.com/r/ceo-test",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "mcp offline_access",
        state: null,
        code_challenge: challenge,
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });
      const nonce = env.oauthService.createConsentNonce(reqId);
      const approval = env.oauthService.approveConsent(reqId, nonce, env.ident.user_id);
      const tokens = env.oauthService.exchangeAuthorizationCode({
        clientId: "dcr_mcp_obs_client_must_not_be_logged",
        redirectUri: "https://oauth-redirect.googleusercontent.com/r/ceo-test",
        code: approval.code,
        codeVerifier: verifier,
        resource: "https://ceo.sentimentalk.com/mcp",
      });

      const successLogs = await captureStderr(async () => {
        const res = await fetch(`${env.baseUrl}/mcp`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(res.status).toBe(200);
      });
      const successJoined = successLogs.join("");
      expect(successJoined).toContain("mcp-auth: outcome=success");
      expect(successJoined).toContain("credential=oauth");
      expect(successJoined).toContain(`user=${env.ident.user_id}`);
      expect(successJoined).toContain(`workspace=${env.ident.workspace_id}`);
      expect(successJoined).not.toContain(tokens.access_token);
      expect(successJoined).not.toContain(tokens.refresh_token);
      expect(successJoined).not.toContain("dcr_mcp_obs_client_must_not_be_logged");
      expect(successJoined).not.toContain(verifier);

      const rejectedLogs = await captureStderr(async () => {
        const res = await fetch(`${env.baseUrl}/mcp`, {
          headers: { Authorization: "Bearer ceo_at_invalid_obs_token" },
        });
        expect(res.status).toBe(401);
      });
      const rejectedJoined = rejectedLogs.join("");
      expect(rejectedJoined).toContain("mcp-auth: outcome=rejected");
      expect(rejectedJoined).toContain("credential=oauth");
      expect(rejectedJoined).toContain("reason=invalid_token");
      expect(rejectedJoined).toContain("status=401");
      expect(rejectedJoined).not.toContain("ceo_at_invalid_obs_token");

      const now = Date.now();
      const rawToken = "ceo_at_wrong_scope_obs_token";
      const digest = sha256Hex(rawToken);
      const db = (env.oauthStore as any).requireDb();
      db.prepare(`
        INSERT INTO oauth_access_tokens (
          id, token_digest, client_id, user_id, workspace_id, resource, scope,
          issued_at_ms, expires_at_ms, revoked_at_ms
        ) VALUES ('at_obs_bad_scope', ?, 'client', ?, ?, 'https://ceo.sentimentalk.com/mcp', 'read_only', ?, ?, NULL);
      `).run(digest, env.ident.user_id, env.ident.workspace_id, now, now + 3600000);

      const scopeLogs = await captureStderr(async () => {
        const res = await fetch(`${env.baseUrl}/mcp`, {
          headers: { Authorization: `Bearer ${rawToken}` },
        });
        expect(res.status).toBe(403);
      });
      const scopeJoined = scopeLogs.join("");
      expect(scopeJoined).toContain("mcp-auth: outcome=rejected");
      expect(scopeJoined).toContain("reason=insufficient_scope");
      expect(scopeJoined).toContain("status=403");
      expect(scopeJoined).not.toContain(rawToken);
    } finally {
      await env.close();
    }
  });

  it("returns 401 with WWW-Authenticate containing resource_metadata and scope on missing token", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`);
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain(`resource_metadata="${env.publicOrigin}/.well-known/oauth-protected-resource/mcp"`);
      expect(wwwAuth).toContain('scope="mcp"');
    } finally {
      await env.close();
    }
  });

  it("returns 401 with invalid_token on unknown or revoked token", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: {
          Authorization: "Bearer invalid_opaque_token",
        },
      });

      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toContain('error="invalid_token"');
      expect(wwwAuth).toContain("resource_metadata=");
      expect(wwwAuth).toContain('scope="mcp"');
    } finally {
      await env.close();
    }
  });

  it("returns 403 with insufficient_scope if access token lacks mcp scope", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      // Manually insert an access token with scope "read_only"
      const now = Date.now();
      const rawToken = "ceo_at_wrong_scope_token";
      const digest = sha256Hex(rawToken);

      const db = (env.oauthStore as any).requireDb();
      db.prepare(`
        INSERT INTO oauth_access_tokens (
          id, token_digest, client_id, user_id, workspace_id, resource, scope,
          issued_at_ms, expires_at_ms, revoked_at_ms
        ) VALUES ('at_bad_scope', ?, 'client', ?, ?, 'https://ceo.sentimentalk.com/mcp', 'read_only', ?, ?, NULL);
      `).run(digest, env.ident.user_id, env.ident.workspace_id, now, now + 3600000);

      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${rawToken}`,
        },
      });

      expect(res.status).toBe(403);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toContain('error="insufficient_scope"');
      expect(wwwAuth).toContain('scope="mcp"');
    } finally {
      await env.close();
    }
  });

  it("fail-closes with 503 when the OAuth backing store fails", async () => {
    const env = await setupMcpAuthTestApp();
    try {
      const origValidate = env.oauthService.validateAccessToken.bind(env.oauthService);
      (env.oauthService as any).validateAccessToken = () => {
        throw new OAuthStoreUnavailable("Simulated OAuth store failure");
      };

      const res = await fetch(`${env.baseUrl}/mcp`, {
        headers: { Authorization: `Bearer ${LEGACY_RAW_API_KEY}` },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe(-32050);

      (env.oauthService as any).validateAccessToken = origValidate;
    } finally {
      await env.close();
    }
  });

  it("fail-closes /mcp entirely (503) when OAuth is disabled; never accepts opaque bearer tokens", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-mcp-no-oauth-test-"));
    cleanupDirs.push(dir);
    const identDbPath = path.join(dir, "identity.sqlite");
    seedIdentity({ identityDbPath: identDbPath, remoteUrl: "git@example.com:test/repo.git", branch: "main" });
    const identityService = IdentityService.open(identDbPath);
    cleanupIdentServices.push(identityService);

    const app = express();
    app.all(
      "/mcp",
      createMcpAuthMiddleware(null),
      (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      }
    );

    const server = app.listen(0);
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Missing token: unavailable, fail closed
      const resMissing = await fetch(`${baseUrl}/mcp`);
      expect(resMissing.status).toBe(503);
      const bodyMissing = (await resMissing.json()) as any;
      expect(bodyMissing.error.code).toBe(-32050);
      expect(resMissing.headers.get("www-authenticate")).toBeNull();

      // Opaque/legacy token: never interpreted through the identity store
      const resToken = await fetch(`${baseUrl}/mcp`, {
        headers: { Authorization: `Bearer ${LEGACY_RAW_API_KEY}` },
      });
      expect(resToken.status).toBe(503);
      const bodyToken = (await resToken.json()) as any;
      expect(bodyToken.error.code).toBe(-32050);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const fake = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = fake as never;
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig as never;
  }
  return lines;
}