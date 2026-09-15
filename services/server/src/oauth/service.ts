import crypto from "node:crypto";
import {
  OAuthStore,
  AuthorizationRequestRecord,
  AuthorizationCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  sha256Hex,
} from "./store.js";
import {
  resolveClientMetadata,
  ClientMetadata,
  ClientMetadataResolverOptions,
} from "./client-metadata.js";
import { IdentityStore } from "../identity/store.js";

export class OAuthServerError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly errorDescription?: string,
    public readonly statusCode: number = 400
  ) {
    super(errorDescription ? `${errorCode}: ${errorDescription}` : errorCode);
    this.name = "OAuthServerError";
  }
}

export interface OAuthServiceOptions {
  publicOrigin: string;
  workspaceId: string;
  clientMetadataResolverOptions?: ClientMetadataResolverOptions;
  authCodeTtlMs?: number; // default 5m
  authRequestTtlMs?: number; // default 10m
  accessTokenTtlMs?: number; // default 1h
  refreshTokenTtlMs?: number; // default 30d
}

const DEFAULT_AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function validateCanonicalResource(uri: unknown, canonicalResource: string): string {
  if (typeof uri !== "string" || !uri.trim()) {
    throw new OAuthServerError("invalid_target", "Resource parameter is required", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new OAuthServerError("invalid_target", `Invalid resource URL: '${uri}'`, 400);
  }
  if (parsed.search) {
    throw new OAuthServerError("invalid_target", "Resource URL must not contain query parameters", 400);
  }
  if (parsed.hash) {
    throw new OAuthServerError("invalid_target", "Resource URL must not contain fragments", 400);
  }
  if (parsed.username || parsed.password) {
    throw new OAuthServerError("invalid_target", "Resource URL must not contain credentials", 400);
  }
  const canonicalParsed = new URL(canonicalResource);
  if (parsed.origin !== canonicalParsed.origin || parsed.pathname !== canonicalParsed.pathname) {
    throw new OAuthServerError(
      "invalid_target",
      `Requested resource '${uri}' does not match canonical resource '${canonicalResource}'`,
      400
    );
  }
  return canonicalResource;
}

export class OAuthService {
  readonly publicOrigin: string;
  readonly canonicalResource: string;
  readonly workspaceId: string;
  private readonly store: OAuthStore;
  private readonly identityStore: IdentityStore;
  private readonly clientMetadataResolverOptions?: ClientMetadataResolverOptions;
  private readonly authCodeTtlMs: number;
  private readonly authRequestTtlMs: number;
  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;

  constructor(
    store: OAuthStore,
    identityStore: IdentityStore,
    options: OAuthServiceOptions
  ) {
    this.store = store;
    this.identityStore = identityStore;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
    this.canonicalResource = `${this.publicOrigin}/mcp`;
    this.workspaceId = options.workspaceId;
    this.clientMetadataResolverOptions = options.clientMetadataResolverOptions;
    this.authCodeTtlMs = options.authCodeTtlMs ?? DEFAULT_AUTH_CODE_TTL_MS;
    this.authRequestTtlMs = options.authRequestTtlMs ?? DEFAULT_AUTH_REQUEST_TTL_MS;
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
    this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS;
  }

  getAuthorizationServerMetadata(): Record<string, any> {
    return {
      issuer: this.publicOrigin,
      authorization_endpoint: `${this.publicOrigin}/authorize`,
      token_endpoint: `${this.publicOrigin}/token`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp", "offline_access"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://github.com/SentimentalK/chief-everything-officer",
    };
  }

  async initiateAuthorizationRequest(input: {
    clientId: string;
    redirectUri: string;
    responseType: string;
    scope?: string;
    state?: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource?: string;
  }): Promise<{
    request: AuthorizationRequestRecord;
    clientMetadata: ClientMetadata;
  }> {
    if (input.responseType !== "code") {
      throw new OAuthServerError(
        "unsupported_response_type",
        "Only response_type=code is supported",
        400
      );
    }

    if (!input.codeChallenge || input.codeChallengeMethod !== "S256") {
      throw new OAuthServerError(
        "invalid_request",
        "code_challenge is required and code_challenge_method must be S256",
        400
      );
    }

    // Resource validation (mandatory explicit resource binding)
    const targetResource = validateCanonicalResource(input.resource, this.canonicalResource);

    // Resolve client metadata via CIMD
    let clientMetadata: ClientMetadata;
    try {
      clientMetadata = await resolveClientMetadata(
        input.clientId,
        this.clientMetadataResolverOptions
      );
    } catch (err: any) {
      throw new OAuthServerError(
        "invalid_client",
        `Failed to resolve client metadata: ${err.message}`,
        400
      );
    }

    // Validate redirect_uri matches client metadata
    if (!clientMetadata.redirect_uris.includes(input.redirectUri)) {
      throw new OAuthServerError(
        "invalid_request",
        "redirect_uri is not registered in client metadata",
        400
      );
    }

    // Scopes validation
    const rawScope = input.scope ? input.scope.trim() : "mcp";
    const requestedTokens = rawScope.split(/\s+/).filter(Boolean);
    const allowedScopes = new Set(["mcp", "offline_access"]);

    for (const t of requestedTokens) {
      if (!allowedScopes.has(t)) {
        throw new OAuthServerError(
          "invalid_scope",
          `Unsupported scope: ${t}`,
          400
        );
      }
    }

    if (!requestedTokens.includes("mcp")) {
      throw new OAuthServerError(
        "invalid_scope",
        "The 'mcp' scope is required",
        400
      );
    }

    const finalScope = requestedTokens.join(" ");
    const now = Date.now();
    const requestId = `oar_${crypto.randomUUID().replace(/-/g, "")}`;

    this.store.createAuthorizationRequest({
      id: requestId,
      client_id: input.clientId,
      client_name: clientMetadata.client_name,
      redirect_uri: input.redirectUri,
      resource: targetResource,
      scope: finalScope,
      state: input.state ?? null,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      created_at_ms: now,
      expires_at_ms: now + this.authRequestTtlMs,
    });

    const request = this.store.getAuthorizationRequest(requestId);
    if (!request) {
      throw new OAuthServerError("server_error", "Failed to store authorization request", 500);
    }

    return { request, clientMetadata };
  }

  getAuthorizationRequest(requestId: string): AuthorizationRequestRecord | null {
    const req = this.store.getAuthorizationRequest(requestId);
    if (!req) return null;
    if (req.expires_at_ms <= Date.now()) return null;
    return req;
  }

  createConsentNonce(requestId: string): string {
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceDigest = sha256Hex(nonce);
    const updated = this.store.setConsentNonceDigest(requestId, nonceDigest, Date.now());
    if (!updated) {
      throw new OAuthServerError("invalid_request", "Authorization request expired or already decided", 400);
    }
    return nonce;
  }

  approveConsent(
    requestId: string,
    nonce: string,
    userId: string
  ): { code: string; redirectUri: string; state: string | null } {
    // Re-verify IdentityStore user and workspace
    if (!this.identityStore.isUserActive(userId)) {
      throw new OAuthServerError("access_denied", "User is disabled or inactive", 403);
    }
    if (!this.identityStore.hasWorkspaceAccess(this.workspaceId, userId)) {
      throw new OAuthServerError("access_denied", "User does not have access to deployment workspace", 403);
    }

    const nonceDigest = sha256Hex(nonce);
    const now = Date.now();
    const rawCode = `oac_${crypto.randomBytes(32).toString("hex")}`;
    const codeDigest = sha256Hex(rawCode);
    const codeId = `cd_${crypto.randomUUID().replace(/-/g, "")}`;

    const record = this.store.approveConsentAndIssueCode({
      requestId,
      nonceDigest,
      userId,
      workspaceId: this.workspaceId,
      codeId,
      codeDigest,
      nowMs: now,
      codeExpiresAtMs: now + this.authCodeTtlMs,
    });

    if (!record) {
      throw new OAuthServerError(
        "invalid_request",
        "Failed to approve consent: invalid nonce or request expired/already decided",
        400
      );
    }

    const authReq = this.store.getAuthorizationRequest(requestId);
    return {
      code: rawCode,
      redirectUri: record.redirect_uri,
      state: authReq?.state ?? null,
    };
  }

  denyConsent(
    requestId: string,
    nonce: string
  ): { redirectUri: string; state: string | null } {
    const authReq = this.store.getAuthorizationRequest(requestId);
    if (!authReq) {
      throw new OAuthServerError("invalid_request", "Authorization request not found", 400);
    }

    const nonceDigest = sha256Hex(nonce);
    const denied = this.store.denyConsent(requestId, nonceDigest, Date.now());
    if (!denied) {
      throw new OAuthServerError("invalid_request", "Invalid nonce or request already decided", 400);
    }

    return {
      redirectUri: authReq.redirect_uri,
      state: authReq.state,
    };
  }

  exchangeAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
    resource?: string;
  }): {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
    scope: string;
  } {
    if (!input.code || !input.codeVerifier || !input.clientId || !input.redirectUri) {
      throw new OAuthServerError(
        "invalid_request",
        "code, code_verifier, client_id, and redirect_uri are required",
        400
      );
    }

    const targetResource = validateCanonicalResource(input.resource, this.canonicalResource);

    const codeDigest = sha256Hex(input.code);
    const now = Date.now();

    const rawAccessToken = `ceo_at_${crypto.randomBytes(32).toString("base64url")}`;
    const accessTokenDigest = sha256Hex(rawAccessToken);
    const accessTokenId = `at_${crypto.randomUUID().replace(/-/g, "")}`;

    const rawRefreshToken = `ceo_rt_${crypto.randomBytes(32).toString("base64url")}`;
    const refreshTokenDigest = sha256Hex(rawRefreshToken);
    const refreshTokenId = `rt_${crypto.randomUUID().replace(/-/g, "")}`;
    const refreshTokenFamilyId = `fam_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = this.store.consumeCodeAndIssueTokens({
      codeDigest,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: targetResource,
      codeVerifier: input.codeVerifier,
      accessTokenId,
      accessTokenDigest,
      accessTokenExpiresAtMs: now + this.accessTokenTtlMs,
      refreshTokenId,
      refreshTokenDigest,
      refreshTokenFamilyId,
      refreshTokenExpiresAtMs: now + this.refreshTokenTtlMs,
      nowMs: now,
    });

    if ("error" in result) {
      if (result.error === "invalid_target") {
        throw new OAuthServerError("invalid_target", "Resource does not match granted resource", 400);
      }
      throw new OAuthServerError("invalid_grant", "Invalid or expired authorization code", 400);
    }

    return {
      access_token: rawAccessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTokenTtlMs / 1000),
      refresh_token: rawRefreshToken,
      scope: result.code.scope,
    };
  }

  refreshTokens(input: {
    clientId: string;
    refreshToken: string;
    scope?: string;
    resource?: string;
  }): {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
    scope: string;
  } {
    if (!input.refreshToken || !input.clientId) {
      throw new OAuthServerError("invalid_request", "refresh_token and client_id are required", 400);
    }

    const oldTokenDigest = sha256Hex(input.refreshToken);
    const existing = this.store.findRefreshTokenByDigest(oldTokenDigest);
    const now = Date.now();

    if (!existing) {
      throw new OAuthServerError("invalid_grant", "Refresh token not found", 400);
    }

    // Replay detection: if token was already consumed, revoke the entire token family!
    if (existing.consumed_at_ms !== null) {
      this.store.revokeRefreshTokenFamily(existing.family_id, now);
      throw new OAuthServerError("invalid_grant", "Refresh token already consumed (replay detected)", 400);
    }

    // Revocation or expiry check
    if (existing.revoked_at_ms !== null || existing.expires_at_ms <= now) {
      throw new OAuthServerError("invalid_grant", "Refresh token expired or revoked", 400);
    }

    // Client ID match
    if (existing.client_id !== input.clientId) {
      throw new OAuthServerError("invalid_grant", "Client ID mismatch", 400);
    }

    // Resource check (mandatory explicit resource binding)
    const targetResource = validateCanonicalResource(input.resource, existing.resource);

    // Identity validation: user still active & has workspace access
    const userActive = this.identityStore.isUserActive(existing.user_id);
    const workspaceValid =
      existing.workspace_id === this.workspaceId &&
      this.identityStore.hasWorkspaceAccess(existing.workspace_id, existing.user_id);

    if (!userActive || !workspaceValid) {
      // Invalidate the token family
      this.store.revokeRefreshTokenFamily(existing.family_id, now);
      throw new OAuthServerError("invalid_grant", "User or workspace is no longer active", 400);
    }

    // Scope check: cannot expand scopes
    let newScope = existing.scope;
    if (input.scope) {
      const requested = input.scope.trim().split(/\s+/).filter(Boolean);
      const existingScopes = new Set(existing.scope.split(/\s+/));
      for (const s of requested) {
        if (!existingScopes.has(s)) {
          throw new OAuthServerError("invalid_scope", `Cannot expand scope to: ${s}`, 400);
        }
      }
      newScope = requested.join(" ");
    }

    // Generate new tokens
    const rawAccessToken = `ceo_at_${crypto.randomBytes(32).toString("base64url")}`;
    const accessTokenDigest = sha256Hex(rawAccessToken);
    const accessTokenId = `at_${crypto.randomUUID().replace(/-/g, "")}`;

    const newRefreshToken = `ceo_rt_${crypto.randomBytes(32).toString("base64url")}`;
    const newRefreshTokenDigest = sha256Hex(newRefreshToken);
    const newRefreshTokenId = `rt_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = this.store.rotateRefreshTokenAndIssueTokens({
      oldTokenDigest,
      clientId: input.clientId,
      resource: targetResource,
      newScope,
      accessTokenId,
      accessTokenDigest,
      accessTokenExpiresAtMs: now + this.accessTokenTtlMs,
      newRefreshTokenId,
      newRefreshTokenDigest,
      newRefreshTokenExpiresAtMs: now + this.refreshTokenTtlMs,
      nowMs: now,
    });

    if ("error" in result) {
      if (result.error === "invalid_target") {
        throw new OAuthServerError("invalid_target", "Resource mismatch", 400);
      }
      throw new OAuthServerError("invalid_grant", "Failed to rotate refresh token", 400);
    }

    return {
      access_token: rawAccessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTokenTtlMs / 1000),
      refresh_token: newRefreshToken,
      scope: newScope,
    };
  }

  validateAccessToken(token: string): {
    valid: true;
    user_id: string;
    workspace_id: string;
    scope: string;
    resource: string;
  } | {
    valid: false;
    error: "invalid_token" | "insufficient_scope" | "invalid_target";
    description: string;
  } {
    const digest = sha256Hex(token);
    const record = this.store.findAccessTokenByDigest(digest);
    const now = Date.now();

    if (!record) {
      return { valid: false, error: "invalid_token", description: "Token not found" };
    }

    if (record.revoked_at_ms !== null) {
      return { valid: false, error: "invalid_token", description: "Token has been revoked" };
    }

    if (record.expires_at_ms <= now) {
      return { valid: false, error: "invalid_token", description: "Token has expired" };
    }

    if (record.resource !== this.canonicalResource) {
      return { valid: false, error: "invalid_target", description: "Token resource mismatch" };
    }

    // Verify scope has "mcp"
    const scopes = record.scope.split(/\s+/);
    if (!scopes.includes("mcp")) {
      return { valid: false, error: "insufficient_scope", description: "Token does not have mcp scope" };
    }

    // Verify identity
    if (!this.identityStore.isUserActive(record.user_id)) {
      return { valid: false, error: "invalid_token", description: "User is disabled or inactive" };
    }

    if (
      record.workspace_id !== this.workspaceId ||
      !this.identityStore.hasWorkspaceAccess(record.workspace_id, record.user_id)
    ) {
      return { valid: false, error: "invalid_token", description: "Workspace mismatch or access denied" };
    }

    return {
      valid: true,
      user_id: record.user_id,
      workspace_id: record.workspace_id,
      scope: record.scope,
      resource: record.resource,
    };
  }
}
