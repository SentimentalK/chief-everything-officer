import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class OAuthError extends Error {}
export class OAuthStoreUnavailable extends OAuthError {}
export class OAuthStoreStructureError extends OAuthError {}

export const OAUTH_DB_USER_VERSION = 1;

export const OAUTH_DDL = `
CREATE TABLE oauth_authorization_requests (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  decision TEXT,
  user_id TEXT,
  workspace_id TEXT,
  consent_nonce_digest TEXT
);

CREATE TABLE oauth_authorization_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_digest TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
);

CREATE TABLE oauth_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);

CREATE TABLE oauth_refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  revoked_at_ms INTEGER
);

CREATE INDEX idx_oauth_auth_requests_client ON oauth_authorization_requests(client_id);
CREATE INDEX idx_oauth_auth_codes_digest ON oauth_authorization_codes(code_digest);
CREATE INDEX idx_oauth_access_tokens_digest ON oauth_access_tokens(token_digest);
CREATE INDEX idx_oauth_refresh_tokens_digest ON oauth_refresh_tokens(token_digest);
CREATE INDEX idx_oauth_refresh_tokens_family ON oauth_refresh_tokens(family_id);
`;

export interface AuthorizationRequestRecord {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  created_at_ms: number;
  expires_at_ms: number;
  decision: "approved" | "denied" | null;
  user_id: string | null;
  workspace_id: string | null;
  consent_nonce_digest: string | null;
}

export interface AuthorizationCodeRecord {
  id: string;
  code_digest: string;
  client_id: string;
  redirect_uri: string;
  user_id: string;
  workspace_id: string;
  resource: string;
  scope: string;
  code_challenge: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
}

export interface AccessTokenRecord {
  id: string;
  token_digest: string;
  client_id: string;
  user_id: string;
  workspace_id: string;
  resource: string;
  scope: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

export interface RefreshTokenRecord {
  id: string;
  token_digest: string;
  family_id: string;
  client_id: string;
  user_id: string;
  workspace_id: string;
  resource: string;
  scope: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
  revoked_at_ms: number | null;
}

export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

export function sha256Base64Url(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("base64url");
}

export class OAuthStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 200;");
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        /* ignore */
      }

      this.initSchema();
    } catch (error) {
      this.close();
      throw new OAuthStoreStructureError(`Failed to open or initialize OAuth database: ${error}`);
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new OAuthStoreUnavailable("OAuth database is not open.");
    return this.db;
  }

  private withDb<T>(op: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    try {
      return op(db);
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthStoreUnavailable(`OAuth database access failed: ${error}`);
    }
  }

  private initSchema(): void {
    const db = this.requireDb();
    const versionRow = db.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);

    if (version === 0) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.exec(OAUTH_DDL);
        db.exec(`PRAGMA user_version = ${OAUTH_DB_USER_VERSION};`);
        db.exec("COMMIT;");
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
    } else if (version !== OAUTH_DB_USER_VERSION) {
      throw new OAuthStoreStructureError(
        `OAuth database has unsupported user_version ${version}; expected ${OAUTH_DB_USER_VERSION}.`,
      );
    }
  }

  createAuthorizationRequest(record: {
    id: string;
    client_id: string;
    client_name: string;
    redirect_uri: string;
    resource: string;
    scope: string;
    state: string | null;
    code_challenge: string;
    code_challenge_method: string;
    created_at_ms: number;
    expires_at_ms: number;
  }): void {
    this.withDb((db) => {
      db.prepare(`
        INSERT INTO oauth_authorization_requests (
          id, client_id, client_name, redirect_uri, resource, scope, state,
          code_challenge, code_challenge_method, created_at_ms, expires_at_ms,
          decision, user_id, workspace_id, consent_nonce_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL);
      `).run(
        record.id,
        record.client_id,
        record.client_name,
        record.redirect_uri,
        record.resource,
        record.scope,
        record.state,
        record.code_challenge,
        record.code_challenge_method,
        record.created_at_ms,
        record.expires_at_ms,
      );
    });
  }

  getAuthorizationRequest(id: string): AuthorizationRequestRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT * FROM oauth_authorization_requests WHERE id = ? LIMIT 1;
      `).get(id) as AuthorizationRequestRecord | undefined;
      return row ?? null;
    });
  }

  /**
   * Sets the consent nonce digest for a pending authorization request.
   */
  setConsentNonceDigest(id: string, nonceDigest: string, nowMs: number): boolean {
    return this.withDb((db) => {
      const res = db.prepare(`
        UPDATE oauth_authorization_requests
        SET consent_nonce_digest = ?
        WHERE id = ? AND decision IS NULL AND expires_at_ms > ?;
      `).run(nonceDigest, id, nowMs);
      return res.changes === 1;
    });
  }

  /**
   * Atomic CAS: Approves authorization request and issues authorization code in ONE transaction.
   */
  approveConsentAndIssueCode(input: {
    requestId: string;
    nonceDigest: string;
    userId: string;
    workspaceId: string;
    codeId: string;
    codeDigest: string;
    nowMs: number;
    codeExpiresAtMs: number;
  }): AuthorizationCodeRecord | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const req = db.prepare(`
          SELECT * FROM oauth_authorization_requests
          WHERE id = ? AND decision IS NULL AND expires_at_ms > ?
          LIMIT 1;
        `).get(input.requestId, input.nowMs) as AuthorizationRequestRecord | undefined;

        if (!req) {
          db.exec("ROLLBACK;");
          return null;
        }

        // Verify nonce digest matches
        if (!req.consent_nonce_digest || req.consent_nonce_digest !== input.nonceDigest) {
          db.exec("ROLLBACK;");
          return null;
        }

        // Atomic CAS update of request decision
        const updateRes = db.prepare(`
          UPDATE oauth_authorization_requests
          SET decision = 'approved', user_id = ?, workspace_id = ?
          WHERE id = ? AND decision IS NULL;
        `).run(input.userId, input.workspaceId, input.requestId);

        if (updateRes.changes !== 1) {
          db.exec("ROLLBACK;");
          return null;
        }

        // Insert code
        db.prepare(`
          INSERT INTO oauth_authorization_codes (
            id, code_digest, client_id, redirect_uri, user_id, workspace_id,
            resource, scope, code_challenge, issued_at_ms, expires_at_ms, consumed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);
        `).run(
          input.codeId,
          input.codeDigest,
          req.client_id,
          req.redirect_uri,
          input.userId,
          input.workspaceId,
          req.resource,
          req.scope,
          req.code_challenge,
          input.nowMs,
          input.codeExpiresAtMs,
        );

        db.exec("COMMIT;");

        return {
          id: input.codeId,
          code_digest: input.codeDigest,
          client_id: req.client_id,
          redirect_uri: req.redirect_uri,
          user_id: input.userId,
          workspace_id: input.workspaceId,
          resource: req.resource,
          scope: req.scope,
          code_challenge: req.code_challenge,
          issued_at_ms: input.nowMs,
          expires_at_ms: input.codeExpiresAtMs,
          consumed_at_ms: null,
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  /**
   * Atomic CAS: Denies consent for an authorization request.
   */
  denyConsent(requestId: string, nonceDigest: string, nowMs: number): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const req = db.prepare(`
          SELECT * FROM oauth_authorization_requests
          WHERE id = ? AND decision IS NULL AND expires_at_ms > ?
          LIMIT 1;
        `).get(requestId, nowMs) as AuthorizationRequestRecord | undefined;

        if (!req || req.consent_nonce_digest !== nonceDigest) {
          db.exec("ROLLBACK;");
          return false;
        }

        const updateRes = db.prepare(`
          UPDATE oauth_authorization_requests
          SET decision = 'denied'
          WHERE id = ? AND decision IS NULL;
        `).run(requestId);

        db.exec("COMMIT;");
        return updateRes.changes === 1;
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  /**
   * Atomic consumption of authorization code and token issuance.
   */
  consumeCodeAndIssueTokens(input: {
    codeDigest: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
    accessTokenId: string;
    accessTokenDigest: string;
    accessTokenExpiresAtMs: number;
    refreshTokenId: string;
    refreshTokenDigest: string;
    refreshTokenFamilyId: string;
    refreshTokenExpiresAtMs: number;
    nowMs: number;
  }): {
    code: AuthorizationCodeRecord;
    accessToken: AccessTokenRecord;
    refreshToken: RefreshTokenRecord;
  } | { error: "invalid_grant" | "invalid_target" } {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const code = db.prepare(`
          SELECT * FROM oauth_authorization_codes
          WHERE code_digest = ? LIMIT 1;
        `).get(input.codeDigest) as AuthorizationCodeRecord | undefined;

        if (!code) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Must be unconsumed and not expired
        if (code.consumed_at_ms !== null || code.expires_at_ms <= input.nowMs) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Client and redirect_uri must match exactly
        if (code.client_id !== input.clientId || code.redirect_uri !== input.redirectUri) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Resource must match exactly
        if (code.resource !== input.resource) {
          db.exec("ROLLBACK;");
          return { error: "invalid_target" };
        }

        // PKCE S256 verification
        const challenge = sha256Base64Url(input.codeVerifier);
        if (challenge !== code.code_challenge) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Mark code consumed
        const consumeRes = db.prepare(`
          UPDATE oauth_authorization_codes
          SET consumed_at_ms = ?
          WHERE id = ? AND consumed_at_ms IS NULL;
        `).run(input.nowMs, code.id);

        if (consumeRes.changes !== 1) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Insert access token
        db.prepare(`
          INSERT INTO oauth_access_tokens (
            id, token_digest, client_id, user_id, workspace_id, resource, scope,
            issued_at_ms, expires_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);
        `).run(
          input.accessTokenId,
          input.accessTokenDigest,
          code.client_id,
          code.user_id,
          code.workspace_id,
          code.resource,
          code.scope,
          input.nowMs,
          input.accessTokenExpiresAtMs,
        );

        // Insert refresh token
        db.prepare(`
          INSERT INTO oauth_refresh_tokens (
            id, token_digest, family_id, client_id, user_id, workspace_id, resource, scope,
            issued_at_ms, expires_at_ms, consumed_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL);
        `).run(
          input.refreshTokenId,
          input.refreshTokenDigest,
          input.refreshTokenFamilyId,
          code.client_id,
          code.user_id,
          code.workspace_id,
          code.resource,
          code.scope,
          input.nowMs,
          input.refreshTokenExpiresAtMs,
        );

        db.exec("COMMIT;");

        return {
          code,
          accessToken: {
            id: input.accessTokenId,
            token_digest: input.accessTokenDigest,
            client_id: code.client_id,
            user_id: code.user_id,
            workspace_id: code.workspace_id,
            resource: code.resource,
            scope: code.scope,
            issued_at_ms: input.nowMs,
            expires_at_ms: input.accessTokenExpiresAtMs,
            revoked_at_ms: null,
          },
          refreshToken: {
            id: input.refreshTokenId,
            token_digest: input.refreshTokenDigest,
            family_id: input.refreshTokenFamilyId,
            client_id: code.client_id,
            user_id: code.user_id,
            workspace_id: code.workspace_id,
            resource: code.resource,
            scope: code.scope,
            issued_at_ms: input.nowMs,
            expires_at_ms: input.refreshTokenExpiresAtMs,
            consumed_at_ms: null,
            revoked_at_ms: null,
          },
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  /**
   * Find an active refresh token by digest (used for preliminary checks before rotation).
   */
  findRefreshTokenByDigest(tokenDigest: string): RefreshTokenRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT * FROM oauth_refresh_tokens
        WHERE token_digest = ? LIMIT 1;
      `).get(tokenDigest) as RefreshTokenRecord | undefined;
      return row ?? null;
    });
  }

  /**
   * Atomic rotation: consumes old refresh token and issues new access token + new refresh token.
   */
  rotateRefreshTokenAndIssueTokens(input: {
    oldTokenDigest: string;
    clientId: string;
    resource: string;
    newScope: string;
    accessTokenId: string;
    accessTokenDigest: string;
    accessTokenExpiresAtMs: number;
    newRefreshTokenId: string;
    newRefreshTokenDigest: string;
    newRefreshTokenExpiresAtMs: number;
    nowMs: number;
  }): {
    oldRefreshToken: RefreshTokenRecord;
    accessToken: AccessTokenRecord;
    newRefreshToken: RefreshTokenRecord;
  } | { error: "invalid_grant" | "invalid_target" } {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const oldToken = db.prepare(`
          SELECT * FROM oauth_refresh_tokens
          WHERE token_digest = ? LIMIT 1;
        `).get(input.oldTokenDigest) as RefreshTokenRecord | undefined;

        if (!oldToken) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Must not be consumed, revoked, or expired
        if (
          oldToken.consumed_at_ms !== null ||
          oldToken.revoked_at_ms !== null ||
          oldToken.expires_at_ms <= input.nowMs
        ) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        if (oldToken.client_id !== input.clientId) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        if (oldToken.resource !== input.resource) {
          db.exec("ROLLBACK;");
          return { error: "invalid_target" };
        }

        // Atomically consume old token
        const consumeRes = db.prepare(`
          UPDATE oauth_refresh_tokens
          SET consumed_at_ms = ?
          WHERE id = ? AND consumed_at_ms IS NULL;
        `).run(input.nowMs, oldToken.id);

        if (consumeRes.changes !== 1) {
          db.exec("ROLLBACK;");
          return { error: "invalid_grant" };
        }

        // Insert new access token
        db.prepare(`
          INSERT INTO oauth_access_tokens (
            id, token_digest, client_id, user_id, workspace_id, resource, scope,
            issued_at_ms, expires_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);
        `).run(
          input.accessTokenId,
          input.accessTokenDigest,
          oldToken.client_id,
          oldToken.user_id,
          oldToken.workspace_id,
          oldToken.resource,
          input.newScope,
          input.nowMs,
          input.accessTokenExpiresAtMs,
        );

        // Insert rotated child refresh token in same family
        db.prepare(`
          INSERT INTO oauth_refresh_tokens (
            id, token_digest, family_id, client_id, user_id, workspace_id, resource, scope,
            issued_at_ms, expires_at_ms, consumed_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL);
        `).run(
          input.newRefreshTokenId,
          input.newRefreshTokenDigest,
          oldToken.family_id,
          oldToken.client_id,
          oldToken.user_id,
          oldToken.workspace_id,
          oldToken.resource,
          input.newScope,
          input.nowMs,
          input.newRefreshTokenExpiresAtMs,
        );

        db.exec("COMMIT;");

        return {
          oldRefreshToken: oldToken,
          accessToken: {
            id: input.accessTokenId,
            token_digest: input.accessTokenDigest,
            client_id: oldToken.client_id,
            user_id: oldToken.user_id,
            workspace_id: oldToken.workspace_id,
            resource: oldToken.resource,
            scope: input.newScope,
            issued_at_ms: input.nowMs,
            expires_at_ms: input.accessTokenExpiresAtMs,
            revoked_at_ms: null,
          },
          newRefreshToken: {
            id: input.newRefreshTokenId,
            token_digest: input.newRefreshTokenDigest,
            family_id: oldToken.family_id,
            client_id: oldToken.client_id,
            user_id: oldToken.user_id,
            workspace_id: oldToken.workspace_id,
            resource: oldToken.resource,
            scope: input.newScope,
            issued_at_ms: input.nowMs,
            expires_at_ms: input.newRefreshTokenExpiresAtMs,
            consumed_at_ms: null,
            revoked_at_ms: null,
          },
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* ignore */
        }
        throw err;
      }
    });
  }

  findAccessTokenByDigest(tokenDigest: string): AccessTokenRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT * FROM oauth_access_tokens
        WHERE token_digest = ? LIMIT 1;
      `).get(tokenDigest) as AccessTokenRecord | undefined;
      return row ?? null;
    });
  }

  revokeRefreshTokenFamily(familyId: string, nowMs: number): void {
    this.withDb((db) => {
      db.prepare(`
        UPDATE oauth_refresh_tokens
        SET revoked_at_ms = ?
        WHERE family_id = ? AND revoked_at_ms IS NULL;
      `).run(nowMs, familyId);
    });
  }
}

