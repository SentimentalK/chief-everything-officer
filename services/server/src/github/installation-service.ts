import crypto from "node:crypto";
import type { IdentityStore, UserGitHubInstallationItem } from "../identity/store.js";
import type { GitHubAppClient } from "./app-client.js";

export interface GitHubInstallationServiceOptions {
  appClient: GitHubAppClient;
  store: IdentityStore;
  clientId: string;
  clientSecret: string;
  slug: string;
  callbackUrl: string;
  fetchFn?: typeof fetch;
  stateTtlMs?: number;
}

export interface PendingInstallState {
  userId: string;
  providerSubject: string;
  expiresAt: number;
}

export interface PendingOAuthState {
  codeVerifier: string;
  userId: string;
  providerSubject: string;
  candidateInstallationId: string;
  expiresAt: number;
}

export class GitHubInstallationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GitHubInstallationError";
    this.status = status;
  }
}

export class GitHubIdentityMismatchError extends GitHubInstallationError {
  constructor(message: string) {
    super(message, 403);
    this.name = "GitHubIdentityMismatchError";
  }
}

export class GitHubInstallationNotFoundError extends GitHubInstallationError {
  constructor(message: string) {
    super(message, 403);
    this.name = "GitHubInstallationNotFoundError";
  }
}

export class GitHubInstallationService {
  private readonly appClient: GitHubAppClient;
  private readonly store: IdentityStore;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly slug: string;
  private readonly callbackUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly stateTtlMs: number;

  private readonly pendingInstallStates = new Map<string, PendingInstallState>();
  private readonly pendingOAuthStates = new Map<string, PendingOAuthState>();

  constructor(options: GitHubInstallationServiceOptions) {
    this.appClient = options.appClient;
    this.store = options.store;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.slug = options.slug;
    this.callbackUrl = options.callbackUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000; // 10 minutes
  }

  get appClientInstance(): GitHubAppClient {
    return this.appClient;
  }

  get appSlug(): string {
    return this.slug;
  }

  private cleanupStates(): void {
    const now = Date.now();
    for (const [state, data] of this.pendingInstallStates.entries()) {
      if (now > data.expiresAt) {
        this.pendingInstallStates.delete(state);
      }
    }
    for (const [state, data] of this.pendingOAuthStates.entries()) {
      if (now > data.expiresAt) {
        this.pendingOAuthStates.delete(state);
      }
    }
  }

  /**
   * Step 1: Creates opaque one-time install state bound to CEO user and returns
   * the GitHub App installation URL.
   */
  createInstallRedirect(userId: string, providerSubject: string): string {
    this.cleanupStates();

    const state = crypto.randomBytes(32).toString("hex");
    this.pendingInstallStates.set(state, {
      userId,
      providerSubject,
      expiresAt: Date.now() + this.stateTtlMs,
    });

    const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(this.slug)}/installations/new`);
    installUrl.searchParams.set("state", state);
    return installUrl.toString();
  }

  /**
   * Step 2: Accepts installation_id/state/setup_action from GitHub App setup redirect.
   * Treats installation_id as untrusted! Validates state (one-time, not expired, user match).
   * Generates PKCE + OAuth state carrying candidateInstallationId.
   * Returns GitHub OAuth authorization URL.
   */
  startSetupOAuth(input: {
    state: string;
    installationId: string;
    userId: string;
  }): string {
    this.cleanupStates();

    const pending = this.pendingInstallStates.get(input.state);
    if (!pending) {
      throw new GitHubInstallationError("Invalid or expired install state", 400);
    }
    // Consume-once
    this.pendingInstallStates.delete(input.state);

    if (Date.now() > pending.expiresAt) {
      throw new GitHubInstallationError("Install state has expired", 400);
    }
    if (pending.userId !== input.userId) {
      throw new GitHubInstallationError("Install state does not match active session user", 403);
    }

    if (!input.installationId || typeof input.installationId !== "string" || !/^\d+$/.test(input.installationId)) {
      throw new GitHubInstallationError("Invalid candidate installation_id", 400);
    }

    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const oauthState = crypto.randomBytes(32).toString("hex");

    this.pendingOAuthStates.set(oauthState, {
      codeVerifier,
      userId: pending.userId,
      providerSubject: pending.providerSubject,
      candidateInstallationId: input.installationId,
      expiresAt: Date.now() + this.stateTtlMs,
    });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", this.clientId);
    authorizeUrl.searchParams.set("redirect_uri", this.callbackUrl);
    authorizeUrl.searchParams.set("state", oauthState);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return authorizeUrl.toString();
  }

  /**
   * Step 3: Consumes OAuth state, exchanges code, fetches user profile,
   * verifies String(github user id) == existing CEO session providerSubject,
   * then fetches /user/installations and requires candidate installation to be present.
   * Only then atomically upserts installation metadata + user link in DB.
   * Discards GitHub user access token afterward.
   */
  async handleOAuthCallback(input: {
    state: string;
    code: string;
  }): Promise<{ installationId: string; accountLogin: string }> {
    this.cleanupStates();

    const pending = this.pendingOAuthStates.get(input.state);
    if (!pending) {
      throw new GitHubInstallationError("Invalid or expired OAuth state", 400);
    }
    // Consume-once
    this.pendingOAuthStates.delete(input.state);

    if (Date.now() > pending.expiresAt) {
      throw new GitHubInstallationError("OAuth state has expired", 400);
    }

    // 1. Exchange code for user access token
    const tokenRes = await this.fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: input.code,
        code_verifier: pending.codeVerifier,
        redirect_uri: this.callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      throw new GitHubInstallationError(`Token exchange failed with HTTP ${tokenRes.status}`, tokenRes.status);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (tokenData.error || !tokenData.access_token) {
      throw new GitHubInstallationError(tokenData.error_description || tokenData.error || "Token exchange failed", 400);
    }

    const userAccessToken = tokenData.access_token;

    try {
      // 2. Fetch authenticated GitHub user
      const userRes = await this.fetchFn("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      });

      if (!userRes.ok) {
        throw new GitHubInstallationError(`GitHub user profile fetch failed with HTTP ${userRes.status}`, userRes.status);
      }

      const githubUser = (await userRes.json()) as { id?: unknown; login?: unknown };
      if (typeof githubUser.id !== "number" || typeof githubUser.login !== "string") {
        throw new GitHubInstallationError("Invalid GitHub user response", 400);
      }

      // Verify String(github user id) == existing CEO session providerSubject
      const githubSubject = String(githubUser.id);
      if (githubSubject !== pending.providerSubject) {
        // CEO / GitHub identity mismatch: reject with NO DB write!
        throw new GitHubIdentityMismatchError(
          `GitHub user mismatch: authenticated as '${githubSubject}' (${githubUser.login}), expected '${pending.providerSubject}'`,
        );
      }

      // 3. Fetch user installations from GitHub
      const instRes = await this.fetchFn("https://api.github.com/user/installations", {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      });

      if (!instRes.ok) {
        throw new GitHubInstallationError(
          `GitHub user installations fetch failed with HTTP ${instRes.status}`,
          instRes.status,
        );
      }

      const instData = (await instRes.json()) as {
        total_count?: number;
        installations?: Array<{
          id: number;
          app_id: number;
          target_id: number;
          account: {
            id: number;
            login: string;
            type: string;
          };
          repository_selection: string;
          suspended_at: string | null;
        }>;
      };

      const installations = instData.installations ?? [];
      const targetInst = installations.find(
        (inst) => String(inst.id) === pending.candidateInstallationId,
      );

      if (!targetInst) {
        // Spoofed or inaccessible installation: reject with zero DB writes!
        throw new GitHubInstallationNotFoundError(
          `Candidate installation '${pending.candidateInstallationId}' is not accessible by GitHub user '${githubSubject}'`,
        );
      }

      // 4. Atomically upsert installation metadata + user link
      const accountType =
        targetInst.account.type === "Organization" ? "Organization" : "User";
      const repositorySelection =
        targetInst.repository_selection === "selected" ? "selected" : "all";
      const suspendedAtMs = targetInst.suspended_at
        ? new Date(targetInst.suspended_at).getTime()
        : null;

      this.store.upsertGitHubInstallationWithUser({
        githubInstallationId: String(targetInst.id),
        githubAppId: String(targetInst.app_id),
        accountId: String(targetInst.account.id),
        accountLogin: targetInst.account.login,
        accountType,
        repositorySelection,
        suspendedAtMs,
        userId: pending.userId,
      });

      return {
        installationId: String(targetInst.id),
        accountLogin: targetInst.account.login,
      };
    } finally {
      // User access token discarded immediately. Never persisted or logged.
    }
  }

  listUserInstallations(userId: string): UserGitHubInstallationItem[] {
    return this.store.listGitHubInstallationsForUser(userId);
  }
}
