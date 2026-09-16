import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  OAuthStore,
  sha256Base64Url,
} from "../src/oauth/store.js";
import {
  IdentityStore,
  provisionEmptyIdentityDatabase,
  sha256Hex,
} from "../src/identity/store.js";
import { OAuthService, OAuthServerError } from "../src/oauth/service.js";
import { createCimdOnlyClientResolver } from "../src/oauth/client-resolver.js";

const cleanupDirs: string[] = [];
const cleanupOAuthStores: OAuthStore[] = [];
const cleanupIdentStores: IdentityStore[] = [];

afterEach(async () => {
  for (const st of cleanupOAuthStores.splice(0)) st.close();
  for (const st of cleanupIdentStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupTestEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-oauth-svc-test-"));
  cleanupDirs.push(dir);

  const identDbPath = path.join(dir, "identity.sqlite");
  const ident = provisionEmptyIdentityDatabase(identDbPath, {
    remoteUrl: "git@example.com:test/repo.git",
    branch: "main",
    apiKeyDigest: sha256Hex("test-key"),
  });
  const identStore = IdentityStore.open(identDbPath);
  cleanupIdentStores.push(identStore);

  const oauthDbPath = path.join(dir, "oauth.sqlite");
  const oauthStore = new OAuthStore(oauthDbPath);
  cleanupOAuthStores.push(oauthStore);

  const publicOrigin = "https://ceo.sentimentalk.com";
  const service = new OAuthService(oauthStore, identStore, {
    publicOrigin,
    workspaceId: ident.workspace_id,
    clientResolver: createCimdOnlyClientResolver({
      allowHttpForTest: true,
      allowPrivateIpsForTest: true,
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
  });

  return { dir, ident, identStore, oauthStore, service, publicOrigin };
}

describe("OAuthService Core & Security Constraints", () => {
  it("exposes RFC 8414 server metadata with code and S256", async () => {
    const { service, publicOrigin } = await setupTestEnv();
    const meta = service.getAuthorizationServerMetadata();
    expect(meta.issuer).toBe(publicOrigin);
    expect(meta.authorization_endpoint).toBe(`${publicOrigin}/authorize`);
    expect(meta.token_endpoint).toBe(`${publicOrigin}/token`);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("handles complete authorize -> consent -> code exchange -> refresh flow", async () => {
    const { service, ident, oauthStore } = await setupTestEnv();

    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-test";
    const challenge = sha256Base64Url(verifier);

    // Mock client metadata by inserting an auth request directly
    const reqId = "oar_flow_1";
    oauthStore.createAuthorizationRequest({
      id: reqId,
      client_id: "https://chatgpt.com/client.json",
      client_name: "ChatGPT",
      redirect_uri: "https://chatgpt.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: "xyzState",
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 600000,
    });

    // 1. Consent approval
    const nonce = service.createConsentNonce(reqId);
    expect(nonce).toBeTruthy();

    const approval = service.approveConsent(reqId, nonce, ident.user_id);
    expect(approval.code).toMatch(/^oac_/);
    expect(approval.redirectUri).toBe("https://chatgpt.com/oauth/callback");
    expect(approval.state).toBe("xyzState");

    // 2. Token exchange
    const tokenRes = service.exchangeAuthorizationCode({
      clientId: "https://chatgpt.com/client.json",
      redirectUri: "https://chatgpt.com/oauth/callback",
      code: approval.code,
      codeVerifier: verifier,
      resource: "https://ceo.sentimentalk.com/mcp",
    });

    expect(tokenRes.token_type).toBe("Bearer");
    expect(tokenRes.access_token).toMatch(/^ceo_at_/);
    expect(tokenRes.refresh_token).toMatch(/^ceo_rt_/);
    expect(tokenRes.expires_in).toBe(3600);
    expect(tokenRes.scope).toBe("mcp offline_access");

    // 3. Access token validation
    const valResult = service.validateAccessToken(tokenRes.access_token);
    expect(valResult.valid).toBe(true);
    if (valResult.valid) {
      expect(valResult.user_id).toBe(ident.user_id);
      expect(valResult.workspace_id).toBe(ident.workspace_id);
      expect(valResult.scope).toBe("mcp offline_access");
    }

    // 4. Token refresh rotation
    const refreshRes = service.refreshTokens({
      clientId: "https://chatgpt.com/client.json",
      refreshToken: tokenRes.refresh_token,
      resource: "https://ceo.sentimentalk.com/mcp",
    });

    expect(refreshRes.token_type).toBe("Bearer");
    expect(refreshRes.access_token).toMatch(/^ceo_at_/);
    expect(refreshRes.refresh_token).toMatch(/^ceo_rt_/);
    expect(refreshRes.refresh_token).not.toBe(tokenRes.refresh_token);

    // 5. Replay attack: old refresh token consumed -> revokes family
    expect(() =>
      service.refreshTokens({
        clientId: "https://chatgpt.com/client.json",
        refreshToken: tokenRes.refresh_token,
        resource: "https://ceo.sentimentalk.com/mcp",
      })
    ).toThrow(OAuthServerError);

    // Child refresh token is now also invalid because family was revoked!
    expect(() =>
      service.refreshTokens({
        clientId: "https://chatgpt.com/client.json",
        refreshToken: refreshRes.refresh_token,
        resource: "https://ceo.sentimentalk.com/mcp",
      })
    ).toThrow(OAuthServerError);
  });

  it("re-verifies identity on refresh: disabled user rejects refresh and revokes family", async () => {
    const { service, ident, identStore, oauthStore } = await setupTestEnv();

    const verifier = "verifier_disabled_user_test_1234567890123456789";
    const challenge = sha256Base64Url(verifier);

    const reqId = "oar_flow_disabled";
    oauthStore.createAuthorizationRequest({
      id: reqId,
      client_id: "https://chatgpt.com/client.json",
      client_name: "ChatGPT",
      redirect_uri: "https://chatgpt.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 600000,
    });

    const nonce = service.createConsentNonce(reqId);
    const approval = service.approveConsent(reqId, nonce, ident.user_id);
    const tokens = service.exchangeAuthorizationCode({
      clientId: "https://chatgpt.com/client.json",
      redirectUri: "https://chatgpt.com/oauth/callback",
      code: approval.code,
      codeVerifier: verifier,
      resource: "https://ceo.sentimentalk.com/mcp",
    });

    // Disable the user in IdentityStore!
    const db = (identStore as any).requireDb();
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?;").run(Date.now(), ident.user_id);

    // Refresh must fail and revoke tokens!
    expect(() =>
      service.refreshTokens({
        clientId: "https://chatgpt.com/client.json",
        refreshToken: tokens.refresh_token,
        resource: "https://ceo.sentimentalk.com/mcp",
      })
    ).toThrow(OAuthServerError);

    // Access token validation also fails when user is disabled
    const atCheck = service.validateAccessToken(tokens.access_token);
    expect(atCheck.valid).toBe(false);
  });

  it("re-verifies identity on refresh: mismatched deployment workspace rejects refresh", async () => {
    const { service, ident, oauthStore } = await setupTestEnv();

    const verifier = "verifier_ws_mismatch_test_1234567890123456789";
    const challenge = sha256Base64Url(verifier);

    const reqId = "oar_flow_ws";
    oauthStore.createAuthorizationRequest({
      id: reqId,
      client_id: "https://chatgpt.com/client.json",
      client_name: "ChatGPT",
      redirect_uri: "https://chatgpt.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 600000,
    });

    const nonce = service.createConsentNonce(reqId);
    const approval = service.approveConsent(reqId, nonce, ident.user_id);
    const tokens = service.exchangeAuthorizationCode({
      clientId: "https://chatgpt.com/client.json",
      redirectUri: "https://chatgpt.com/oauth/callback",
      code: approval.code,
      codeVerifier: verifier,
      resource: "https://ceo.sentimentalk.com/mcp",
    });

    // Manipulate the refresh token workspace to simulate migrating or mismatched workspace
    const db = (oauthStore as any).requireDb();
    db.prepare("UPDATE oauth_refresh_tokens SET workspace_id = 'ws_different' WHERE client_id = ?;").run(
      "https://chatgpt.com/client.json"
    );

    // Refresh must fail and revoke family
    expect(() =>
      service.refreshTokens({
        clientId: "https://chatgpt.com/client.json",
        refreshToken: tokens.refresh_token,
        resource: "https://ceo.sentimentalk.com/mcp",
      })
    ).toThrow(OAuthServerError);
  });

  describe("Mandatory Explicit Resource Binding (3 Legs)", () => {
    it("rejects initiateAuthorizationRequest when resource is missing or malformed", async () => {
      const { service } = await setupTestEnv();

      const baseReq = {
        clientId: "https://chatgpt.com/client.json",
        redirectUri: "https://chatgpt.com/oauth/callback",
        responseType: "code",
        codeChallenge: sha256Base64Url("test_verifier_123456789012345678901234"),
        codeChallengeMethod: "S256",
      };

      // Missing resource
      await expect(service.initiateAuthorizationRequest(baseReq as any)).rejects.toThrow(
        /Resource parameter is required/
      );

      // Resource with query parameter
      await expect(
        service.initiateAuthorizationRequest({
          ...baseReq,
          resource: "https://ceo.sentimentalk.com/mcp?param=1",
        })
      ).rejects.toThrow(/Resource URL must not contain query parameters/);

      // Resource with fragment
      await expect(
        service.initiateAuthorizationRequest({
          ...baseReq,
          resource: "https://ceo.sentimentalk.com/mcp#frag",
        })
      ).rejects.toThrow(/Resource URL must not contain fragments/);

      // Resource with credentials
      await expect(
        service.initiateAuthorizationRequest({
          ...baseReq,
          resource: "https://user:pass@ceo.sentimentalk.com/mcp",
        })
      ).rejects.toThrow(/Resource URL must not contain credentials/);

      // Resource mismatch
      await expect(
        service.initiateAuthorizationRequest({
          ...baseReq,
          resource: "https://other.domain.com/mcp",
        })
      ).rejects.toThrow(/does not match canonical resource/);

      // Trailing slash mismatch
      await expect(
        service.initiateAuthorizationRequest({
          ...baseReq,
          resource: "https://ceo.sentimentalk.com/mcp/",
        })
      ).rejects.toThrow(/does not match canonical resource/);
    });

    it("rejects exchangeAuthorizationCode when resource is missing or mismatching", async () => {
      const { service, ident, oauthStore } = await setupTestEnv();

      const verifier = "verifier_res_binding_1234567890123456789";
      const challenge = sha256Base64Url(verifier);
      const reqId = "oar_res_binding";

      oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "https://chatgpt.com/client.json",
        client_name: "ChatGPT",
        redirect_uri: "https://chatgpt.com/oauth/callback",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "mcp",
        state: null,
        code_challenge: challenge,
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });

      const nonce = service.createConsentNonce(reqId);
      const approval = service.approveConsent(reqId, nonce, ident.user_id);

      // Missing resource
      expect(() =>
        service.exchangeAuthorizationCode({
          clientId: "https://chatgpt.com/client.json",
          redirectUri: "https://chatgpt.com/oauth/callback",
          code: approval.code,
          codeVerifier: verifier,
        })
      ).toThrow(/Resource parameter is required/);

      // Wrong resource
      expect(() =>
        service.exchangeAuthorizationCode({
          clientId: "https://chatgpt.com/client.json",
          redirectUri: "https://chatgpt.com/oauth/callback",
          code: approval.code,
          codeVerifier: verifier,
          resource: "https://other.domain.com/mcp",
        })
      ).toThrow(/does not match canonical resource/);
    });

    it("rejects refreshTokens when resource is missing or mismatching", async () => {
      const { service, ident, oauthStore } = await setupTestEnv();

      const verifier = "verifier_refresh_res_1234567890123456789";
      const challenge = sha256Base64Url(verifier);
      const reqId = "oar_refresh_res";

      oauthStore.createAuthorizationRequest({
        id: reqId,
        client_id: "https://chatgpt.com/client.json",
        client_name: "ChatGPT",
        redirect_uri: "https://chatgpt.com/oauth/callback",
        resource: "https://ceo.sentimentalk.com/mcp",
        scope: "mcp offline_access",
        state: null,
        code_challenge: challenge,
        code_challenge_method: "S256",
        created_at_ms: Date.now(),
        expires_at_ms: Date.now() + 600000,
      });

      const nonce = service.createConsentNonce(reqId);
      const approval = service.approveConsent(reqId, nonce, ident.user_id);
      const tokens = service.exchangeAuthorizationCode({
        clientId: "https://chatgpt.com/client.json",
        redirectUri: "https://chatgpt.com/oauth/callback",
        code: approval.code,
        codeVerifier: verifier,
        resource: "https://ceo.sentimentalk.com/mcp",
      });

      // Missing resource
      expect(() =>
        service.refreshTokens({
          clientId: "https://chatgpt.com/client.json",
          refreshToken: tokens.refresh_token,
        })
      ).toThrow(/Resource parameter is required/);

      // Wrong resource
      expect(() =>
        service.refreshTokens({
          clientId: "https://chatgpt.com/client.json",
          refreshToken: tokens.refresh_token,
          resource: "https://other.domain.com/mcp",
        })
      ).toThrow(/does not match canonical resource/);
    });
  });

  it("L. deleting owner membership invalidates access tokens and refresh revokes family", async () => {
    const { service, ident, identStore, oauthStore } = await setupTestEnv();

    const verifier = "verifier_membership_revoke_test_123456789012345678";
    const challenge = sha256Base64Url(verifier);
    const reqId = "oar_flow_membership_revoke";
    oauthStore.createAuthorizationRequest({
      id: reqId,
      client_id: "https://chatgpt.com/client.json",
      client_name: "ChatGPT",
      redirect_uri: "https://chatgpt.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 600000,
    });

    const nonce = service.createConsentNonce(reqId);
    const approval = service.approveConsent(reqId, nonce, ident.user_id);
    const tokens = service.exchangeAuthorizationCode({
      clientId: "https://chatgpt.com/client.json",
      redirectUri: "https://chatgpt.com/oauth/callback",
      code: approval.code,
      codeVerifier: verifier,
      resource: "https://ceo.sentimentalk.com/mcp",
    });

    const db = (identStore as { requireDb(): import("node:sqlite").DatabaseSync }).requireDb();
    db.prepare("DELETE FROM workspace_memberships WHERE workspace_id = ?;").run(ident.workspace_id);

    const atCheck = service.validateAccessToken(tokens.access_token);
    expect(atCheck.valid).toBe(false);

    expect(() =>
      service.refreshTokens({
        clientId: "https://chatgpt.com/client.json",
        refreshToken: tokens.refresh_token,
        resource: "https://ceo.sentimentalk.com/mcp",
      }),
    ).toThrow(OAuthServerError);
  });
});
