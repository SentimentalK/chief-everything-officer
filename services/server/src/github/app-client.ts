import crypto from "node:crypto";

export interface GitHubAppClientOptions {
  clientId: string;
  privateKey: string | crypto.KeyObject;
  fetchFn?: typeof fetch;
}

export interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Creates an RS256 JWT for GitHub App authentication using node:crypto only.
 * Claims:
 * - iat = now - 60s
 * - exp <= now + 10m
 * - iss = GitHub App client ID
 */
export function createGitHubAppJwt(
  clientId: string,
  privateKey: crypto.KeyObject | string,
  nowMs = Date.now(),
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iat: nowSec - 60,
    exp: nowSec + 10 * 60,
    iss: clientId,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signInput = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signInput);
  const signature = signer.sign(privateKey, "base64url");

  return `${signInput}.${signature}`;
}

export class GitHubAppError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}

export class GitHubAppClient {
  private readonly clientId: string;
  private readonly privateKey: crypto.KeyObject;
  private readonly fetchFn: typeof fetch;
  private readonly tokenCache = new Map<string, CachedInstallationToken>();

  constructor(options: GitHubAppClientOptions) {
    this.clientId = options.clientId;
    this.fetchFn = options.fetchFn ?? fetch;

    try {
      this.privateKey =
        typeof options.privateKey === "string"
          ? crypto.createPrivateKey(options.privateKey)
          : options.privateKey;
    } catch (error) {
      throw new GitHubAppError(
        `Invalid GitHub App private key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  createAppJwt(nowMs = Date.now()): string {
    return createGitHubAppJwt(this.clientId, this.privateKey, nowMs);
  }

  /**
   * Retrieves an installation access token, reusing cached tokens while expiry
   * remains safely beyond a 5-minute skew. Otherwise mints a new token.
   * Never logs or persists tokens.
   */
  async getInstallationToken(githubInstallationId: string, nowMs = Date.now()): Promise<string> {
    const SKEW_MS = 5 * 60 * 1000; // 5-minute skew
    const cached = this.tokenCache.get(githubInstallationId);

    if (cached && cached.expiresAtMs - nowMs > SKEW_MS) {
      return cached.token;
    }

    const jwt = this.createAppJwt(nowMs);
    const res = await this.fetchFn(
      `https://api.github.com/app/installations/${encodeURIComponent(githubInstallationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!res.ok) {
      // Do NOT cache error responses. Throw immediately.
      throw new GitHubAppError(
        `GitHub App installation token request failed with HTTP ${res.status}`,
        res.status,
      );
    }

    const data = (await res.json()) as { token?: string; expires_at?: string };
    if (
      !data ||
      typeof data.token !== "string" ||
      data.token.trim().length === 0 ||
      typeof data.expires_at !== "string"
    ) {
      throw new GitHubAppError("Invalid installation token response from GitHub: missing or empty token/expires_at");
    }

    const expiresAtMs = new Date(data.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new GitHubAppError(
        "Invalid installation token response from GitHub: expires_at must be a finite future timestamp",
      );
    }

    this.tokenCache.set(githubInstallationId, {
      token: data.token,
      expiresAtMs,
    });

    return data.token;
  }

  getCachedToken(githubInstallationId: string): CachedInstallationToken | undefined {
    return this.tokenCache.get(githubInstallationId);
  }

  clearTokenCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Retrieves GitHub App installation metadata (including permissions) using App JWT.
   */
  async getInstallation(
    githubInstallationId: string,
    nowMs = Date.now(),
  ): Promise<{
    id: number;
    permissions?: Record<string, string>;
    [key: string]: unknown;
  }> {
    const jwt = this.createAppJwt(nowMs);
    const res = await this.fetchFn(
      `https://api.github.com/app/installations/${encodeURIComponent(githubInstallationId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!res.ok) {
      throw new GitHubAppError(
        `GitHub App getInstallation failed with HTTP ${res.status}`,
        res.status,
      );
    }

    const data = (await res.json()) as any;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GitHubAppError("Invalid installation response from GitHub: response is not an object");
    }

    if (typeof data.id !== "number" || !Number.isSafeInteger(data.id) || data.id <= 0) {
      throw new GitHubAppError("Invalid installation response from GitHub: id must be a positive safe integer");
    }

    if (String(data.id) !== String(githubInstallationId)) {
      throw new GitHubAppError(
        `GitHub installation id mismatch: expected '${githubInstallationId}', got '${data.id}'`,
      );
    }

    if (data.permissions !== undefined) {
      if (typeof data.permissions !== "object" || data.permissions === null || Array.isArray(data.permissions)) {
        throw new GitHubAppError("Invalid installation response from GitHub: permissions must be an object");
      }
    }

    return data as { id: number; permissions?: Record<string, string>; [key: string]: unknown };
  }
}
