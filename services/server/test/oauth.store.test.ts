import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  OAuthStore,
  OAUTH_DB_USER_VERSION,
  sha256Hex,
  sha256Base64Url,
} from "../src/oauth/store.js";

const cleanupDirs: string[] = [];
const cleanupStores: OAuthStore[] = [];

afterEach(async () => {
  for (const st of cleanupStores.splice(0)) st.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTestStore(): Promise<{ store: OAuthStore; dbPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-oauth-store-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "oauth.sqlite");
  const store = new OAuthStore(dbPath);
  cleanupStores.push(store);
  return { store, dbPath };
}

describe("OAuthStore Core & Durability", () => {
  it("initializes SQLite database with user_version = 1 and tables", async () => {
    const { store, dbPath } = await createTestStore();
    expect(store).toBeDefined();

    // Reopen directly and check user_version
    store.close();
    const reopened = new OAuthStore(dbPath);
    cleanupStores.push(reopened);
    expect(reopened).toBeDefined();
  });

  it("handles authorization request lifecycle: create, get, nonce, approve", async () => {
    const { store } = await createTestStore();
    const now = Date.now();
    const reqId = "oar_test_123";

    const verifier = "secret_verifier_string_12345678901234567890";
    const challenge = sha256Base64Url(verifier);

    store.createAuthorizationRequest({
      id: reqId,
      client_id: "https://client.example.com/oauth/metadata.json",
      client_name: "Test Client",
      redirect_uri: "https://client.example.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: "xyzState",
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: now,
      expires_at_ms: now + 600000,
    });

    const retrieved = store.getAuthorizationRequest(reqId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(reqId);
    expect(retrieved?.client_name).toBe("Test Client");
    expect(retrieved?.decision).toBeNull();

    // Set consent nonce digest
    const nonce = "test_nonce_value";
    const nonceDigest = sha256Hex(nonce);
    const nonceSet = store.setConsentNonceDigest(reqId, nonceDigest, now);
    expect(nonceSet).toBe(true);

    // Approve consent with matching nonce
    const codeId = "cd_123";
    const rawCode = "oac_secret_code_value";
    const codeDigest = sha256Hex(rawCode);

    const approved = store.approveConsentAndIssueCode({
      requestId: reqId,
      nonceDigest,
      userId: "usr_ceo",
      workspaceId: "ws_ceo",
      codeId,
      codeDigest,
      nowMs: now,
      codeExpiresAtMs: now + 300000,
    });

    expect(approved).not.toBeNull();
    expect(approved?.code_digest).toBe(codeDigest);
    expect(approved?.user_id).toBe("usr_ceo");

    // Re-approving fails (decision already set)
    const reApprove = store.approveConsentAndIssueCode({
      requestId: reqId,
      nonceDigest,
      userId: "usr_ceo",
      workspaceId: "ws_ceo",
      codeId: "cd_456",
      codeDigest: sha256Hex("another"),
      nowMs: now,
      codeExpiresAtMs: now + 300000,
    });
    expect(reApprove).toBeNull();
  });

  it("handles consent denial atomically", async () => {
    const { store } = await createTestStore();
    const now = Date.now();
    const reqId = "oar_deny_test";

    store.createAuthorizationRequest({
      id: reqId,
      client_id: "https://client.example.com/oauth/metadata.json",
      client_name: "Test Client",
      redirect_uri: "https://client.example.com/oauth/callback",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp",
      state: null,
      code_challenge: "dummy",
      code_challenge_method: "S256",
      created_at_ms: now,
      expires_at_ms: now + 600000,
    });

    const nonceDigest = sha256Hex("nonce_deny");
    store.setConsentNonceDigest(reqId, nonceDigest, now);

    const denied = store.denyConsent(reqId, nonceDigest, now);
    expect(denied).toBe(true);

    const req = store.getAuthorizationRequest(reqId);
    expect(req?.decision).toBe("denied");

    // Denying again fails
    const reDenied = store.denyConsent(reqId, nonceDigest, now);
    expect(reDenied).toBe(false);
  });

  it("consumes authorization code with PKCE and issues tokens with single-use replay protection", async () => {
    const { store } = await createTestStore();
    const now = Date.now();

    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = sha256Base64Url(verifier);

    const reqId = "oar_pkce_test";
    store.createAuthorizationRequest({
      id: reqId,
      client_id: "https://client.example.com/app",
      client_name: "App",
      redirect_uri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: now,
      expires_at_ms: now + 600000,
    });

    const nonceDigest = sha256Hex("pkce_nonce");
    store.setConsentNonceDigest(reqId, nonceDigest, now);

    const rawCode = "oac_pkce_code_123";
    const codeDigest = sha256Hex(rawCode);

    store.approveConsentAndIssueCode({
      requestId: reqId,
      nonceDigest,
      userId: "usr_ceo",
      workspaceId: "ws_ceo",
      codeId: "cd_pkce",
      codeDigest,
      nowMs: now,
      codeExpiresAtMs: now + 300000,
    });

    // 1. Wrong PKCE verifier fails
    const failRes = store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: "https://client.example.com/app",
      redirectUri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      codeVerifier: "wrong_verifier",
      accessTokenId: "at_1",
      accessTokenDigest: sha256Hex("at_raw_1"),
      accessTokenExpiresAtMs: now + 3600000,
      refreshTokenId: "rt_1",
      refreshTokenDigest: sha256Hex("rt_raw_1"),
      refreshTokenFamilyId: "fam_1",
      refreshTokenExpiresAtMs: now + 86400000,
      nowMs: now,
    });
    expect(failRes).toEqual({ error: "invalid_grant" });

    // 2. Correct PKCE verifier succeeds
    const rawAt = "at_valid_token";
    const rawRt = "rt_valid_token";
    const successRes = store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: "https://client.example.com/app",
      redirectUri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      codeVerifier: verifier,
      accessTokenId: "at_1",
      accessTokenDigest: sha256Hex(rawAt),
      accessTokenExpiresAtMs: now + 3600000,
      refreshTokenId: "rt_1",
      refreshTokenDigest: sha256Hex(rawRt),
      refreshTokenFamilyId: "fam_1",
      refreshTokenExpiresAtMs: now + 86400000,
      nowMs: now,
    });
    expect("code" in successRes).toBe(true);
    if ("code" in successRes) {
      expect(successRes.accessToken.token_digest).toBe(sha256Hex(rawAt));
      expect(successRes.refreshToken.token_digest).toBe(sha256Hex(rawRt));
      expect(successRes.refreshToken.family_id).toBe("fam_1");
    }

    // 3. Replaying the consumed code fails (single-use)
    const replayRes = store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: "https://client.example.com/app",
      redirectUri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      codeVerifier: verifier,
      accessTokenId: "at_2",
      accessTokenDigest: sha256Hex("at_raw_2"),
      accessTokenExpiresAtMs: now + 3600000,
      refreshTokenId: "rt_2",
      refreshTokenDigest: sha256Hex("rt_raw_2"),
      refreshTokenFamilyId: "fam_1",
      refreshTokenExpiresAtMs: now + 86400000,
      nowMs: now,
    });
    expect(replayRes).toEqual({ error: "invalid_grant" });
  });

  it("rotates refresh token within family and detects reuse", async () => {
    const { store } = await createTestStore();
    const now = Date.now();

    const verifier = "verifier_test_123456789012345678901234567890";
    const challenge = sha256Base64Url(verifier);
    const reqId = "oar_rot_test";
    store.createAuthorizationRequest({
      id: reqId,
      client_id: "https://client.example.com/app",
      client_name: "App",
      redirect_uri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp offline_access",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: now,
      expires_at_ms: now + 600000,
    });

    const nonceDigest = sha256Hex("nonce");
    store.setConsentNonceDigest(reqId, nonceDigest, now);
    const codeDigest = sha256Hex("oac_rot");

    store.approveConsentAndIssueCode({
      requestId: reqId,
      nonceDigest,
      userId: "usr_ceo",
      workspaceId: "ws_ceo",
      codeId: "cd_rot",
      codeDigest,
      nowMs: now,
      codeExpiresAtMs: now + 300000,
    });

    const initialTokens = store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: "https://client.example.com/app",
      redirectUri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      codeVerifier: verifier,
      accessTokenId: "at_1",
      accessTokenDigest: sha256Hex("at_1"),
      accessTokenExpiresAtMs: now + 3600000,
      refreshTokenId: "rt_1",
      refreshTokenDigest: sha256Hex("rt_1"),
      refreshTokenFamilyId: "fam_rot_1",
      refreshTokenExpiresAtMs: now + 86400000,
      nowMs: now,
    });
    expect("refreshToken" in initialTokens).toBe(true);

    // Rotate RT 1 -> RT 2
    const rotated = store.rotateRefreshTokenAndIssueTokens({
      oldTokenDigest: sha256Hex("rt_1"),
      clientId: "https://client.example.com/app",
      resource: "https://ceo.sentimentalk.com/mcp",
      newScope: "mcp offline_access",
      accessTokenId: "at_2",
      accessTokenDigest: sha256Hex("at_2"),
      accessTokenExpiresAtMs: now + 3600000,
      newRefreshTokenId: "rt_2",
      newRefreshTokenDigest: sha256Hex("rt_2"),
      newRefreshTokenExpiresAtMs: now + 86400000,
      nowMs: now + 100,
    });

    expect("newRefreshToken" in rotated).toBe(true);
    if ("newRefreshToken" in rotated) {
      expect(rotated.newRefreshToken.family_id).toBe("fam_rot_1");
    }

    // Attempt to reuse RT 1 fails (already consumed)
    const reuseFail = store.rotateRefreshTokenAndIssueTokens({
      oldTokenDigest: sha256Hex("rt_1"),
      clientId: "https://client.example.com/app",
      resource: "https://ceo.sentimentalk.com/mcp",
      newScope: "mcp offline_access",
      accessTokenId: "at_3",
      accessTokenDigest: sha256Hex("at_3"),
      accessTokenExpiresAtMs: now + 3600000,
      newRefreshTokenId: "rt_3",
      newRefreshTokenDigest: sha256Hex("rt_3"),
      newRefreshTokenExpiresAtMs: now + 86400000,
      nowMs: now + 200,
    });
    expect(reuseFail).toEqual({ error: "invalid_grant" });
  });

  it("persists tokens across close and reopen (durability)", async () => {
    const { store, dbPath } = await createTestStore();
    const now = Date.now();

    const verifier = "durability_verifier_string_1234567890123";
    const challenge = sha256Base64Url(verifier);
    store.createAuthorizationRequest({
      id: "oar_dur",
      client_id: "https://client.example.com/app",
      client_name: "App",
      redirect_uri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      scope: "mcp",
      state: null,
      code_challenge: challenge,
      code_challenge_method: "S256",
      created_at_ms: now,
      expires_at_ms: now + 600000,
    });

    const nonceDigest = sha256Hex("dur_nonce");
    store.setConsentNonceDigest("oar_dur", nonceDigest, now);
    const codeDigest = sha256Hex("oac_dur");
    store.approveConsentAndIssueCode({
      requestId: "oar_dur",
      nonceDigest,
      userId: "usr_ceo",
      workspaceId: "ws_ceo",
      codeId: "cd_dur",
      codeDigest,
      nowMs: now,
      codeExpiresAtMs: now + 300000,
    });

    const atDigest = sha256Hex("at_dur_token");
    const rtDigest = sha256Hex("rt_dur_token");
    store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: "https://client.example.com/app",
      redirectUri: "https://client.example.com/cb",
      resource: "https://ceo.sentimentalk.com/mcp",
      codeVerifier: verifier,
      accessTokenId: "at_dur",
      accessTokenDigest: atDigest,
      accessTokenExpiresAtMs: now + 3600000,
      refreshTokenId: "rt_dur",
      refreshTokenDigest: rtDigest,
      refreshTokenFamilyId: "fam_dur",
      refreshTokenExpiresAtMs: now + 86400000,
      nowMs: now,
    });

    // Close and reopen
    store.close();

    const reopenedStore = new OAuthStore(dbPath);
    cleanupStores.push(reopenedStore);

    const loadedAt = reopenedStore.findAccessTokenByDigest(atDigest);
    expect(loadedAt).not.toBeNull();
    expect(loadedAt?.user_id).toBe("usr_ceo");

    const loadedRt = reopenedStore.findRefreshTokenByDigest(rtDigest);
    expect(loadedRt).not.toBeNull();
    expect(loadedRt?.family_id).toBe("fam_dur");
  });
});
