import crypto from "node:crypto";
import type {
  GitHubAccountType,
  GitHubRepositorySelection,
  IdentityStore,
  UserGitHubInstallationItem,
} from "../identity/store.js";
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
  onboardingFlowId?: string;
  oauthRequest?: string;
}

export interface PendingOAuthState {
  codeVerifier: string;
  userId: string;
  providerSubject: string;
  candidateInstallationId: string;
  expiresAt: number;
  onboardingFlowId?: string;
  oauthRequest?: string;
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
  createInstallRedirect(
    userId: string,
    providerSubject: string,
    options?: { onboardingFlowId?: string; oauthRequest?: string },
  ): string {
    this.cleanupStates();

    const state = crypto.randomBytes(32).toString("hex");
    this.pendingInstallStates.set(state, {
      userId,
      providerSubject,
      expiresAt: Date.now() + this.stateTtlMs,
      onboardingFlowId: options?.onboardingFlowId,
      oauthRequest: options?.oauthRequest,
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

    if (!input.installationId || typeof input.installationId !== "string" || !/^[1-9][0-9]*$/.test(input.installationId)) {
      throw new GitHubInstallationError("Invalid candidate installation_id: must be a positive decimal string", 400);
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
      onboardingFlowId: pending.onboardingFlowId,
      oauthRequest: pending.oauthRequest,
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
   * Step 3: Revalidates live CEO session against pending state,
   * consumes OAuth state, exchanges code, fetches user profile,
   * verifies String(github user id) == existing CEO session providerSubject,
   * then fetches /user/installations with pagination and requires candidate installation to be present.
   * Validates installation payload semantics strictly, then atomically upserts
   * installation metadata + user link in DB. Discards GitHub user access token afterward.
   */
  async handleOAuthCallback(input: {
    state: string;
    code: string;
    currentUserId: string;
    currentProviderSubject: string;
    currentSessionId?: string;
    onTokenVerified?: (context: {
      sessionId: string;
      userId: string;
      providerSubject: string;
      installationRowId: string;
      installationId: string;
      installationAccount: { id: string; login: string; type: "User" | "Organization" };
      userAccessToken: string;
    }) => Promise<{ grantId: string }> | { grantId: string };
  }): Promise<{
    installationId: string;
    accountLogin: string;
    installationRowId: string;
    grantId?: string;
    onboardingFlowId?: string;
    oauthRequest?: string;
  }> {
    this.cleanupStates();

    if (!input.currentUserId || !input.currentProviderSubject) {
      throw new GitHubIdentityMismatchError("Active CEO session required");
    }

    const pending = this.pendingOAuthStates.get(input.state);
    if (!pending) {
      throw new GitHubInstallationError("Invalid or expired OAuth state", 400);
    }
    // Consume-once
    this.pendingOAuthStates.delete(input.state);

    if (Date.now() > pending.expiresAt) {
      throw new GitHubInstallationError("OAuth state has expired", 400);
    }

    // Require current session userId/providerSubject to match pending OAuth state
    if (
      pending.userId !== input.currentUserId ||
      pending.providerSubject !== input.currentProviderSubject
    ) {
      throw new GitHubIdentityMismatchError(
        "OAuth state user mismatch: active session does not match state owner",
      );
    }

    // Require current session user to be active in identity store
    if (!this.store.isUserActive(input.currentUserId)) {
      throw new GitHubInstallationError("User is disabled or does not exist", 401);
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

      // 3. Fetch user installations from GitHub with bounded pagination
      const perPage = 100;
      const maxPages = 100; // Bounded pagination safety limit (up to 10,000 installations)
      let page = 1;
      let targetInst: any = null;

      while (page <= maxPages) {
        const instRes = await this.fetchFn(
          `https://api.github.com/user/installations?per_page=${perPage}&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${userAccessToken}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "CEO-Server",
            },
          },
        );

        if (!instRes.ok) {
          throw new GitHubInstallationError(
            `GitHub user installations fetch failed with HTTP ${instRes.status}`,
            instRes.status,
          );
        }

        const instData = (await instRes.json()) as {
          total_count?: number;
          installations?: Array<any>;
        };

        const installations = Array.isArray(instData.installations)
          ? instData.installations
          : [];
        targetInst = installations.find(
          (inst) => String(inst?.id) === pending.candidateInstallationId,
        );

        if (targetInst) {
          break;
        }

        if (installations.length === 0 || installations.length < perPage) {
          break;
        }

        if (
          typeof instData.total_count === "number" &&
          page * perPage >= instData.total_count
        ) {
          break;
        }

        page++;
      }

      if (!targetInst) {
        // Spoofed or inaccessible installation: reject with zero DB writes!
        throw new GitHubInstallationNotFoundError(
          `Candidate installation '${pending.candidateInstallationId}' is not accessible by GitHub user '${githubSubject}'`,
        );
      }

      // 4. Validate GitHub installation payload semantics before DB write
      if (
        typeof targetInst.id !== "number" ||
        !Number.isSafeInteger(targetInst.id) ||
        targetInst.id <= 0
      ) {
        throw new GitHubInstallationError("Invalid GitHub installation id: must be a positive safe integer", 400);
      }

      if (
        typeof targetInst.app_id !== "number" ||
        !Number.isSafeInteger(targetInst.app_id) ||
        targetInst.app_id <= 0
      ) {
        throw new GitHubInstallationError("Invalid GitHub installation app_id: must be a positive safe integer", 400);
      }

      if (!targetInst.account || typeof targetInst.account !== "object") {
        throw new GitHubInstallationError("Invalid GitHub installation account payload", 400);
      }

      if (
        typeof targetInst.account.id !== "number" ||
        !Number.isSafeInteger(targetInst.account.id) ||
        targetInst.account.id <= 0
      ) {
        throw new GitHubInstallationError("Invalid GitHub installation account id: must be a positive safe integer", 400);
      }

      if (
        typeof targetInst.account.login !== "string" ||
        targetInst.account.login.trim().length === 0
      ) {
        throw new GitHubInstallationError("Invalid GitHub installation account login: must be non-empty", 400);
      }

      if (targetInst.account.type !== "User" && targetInst.account.type !== "Organization") {
        throw new GitHubInstallationError(
          `Invalid GitHub installation account type '${targetInst.account.type}': must be 'User' or 'Organization'`,
          400,
        );
      }
      const accountType: GitHubAccountType = targetInst.account.type;

      if (targetInst.repository_selection !== "all" && targetInst.repository_selection !== "selected") {
        throw new GitHubInstallationError(
          `Invalid GitHub installation repository_selection '${targetInst.repository_selection}': must be 'all' or 'selected'`,
          400,
        );
      }
      const repositorySelection: GitHubRepositorySelection = targetInst.repository_selection;

      let suspendedAtMs: number | null = null;
      if (targetInst.suspended_at !== null && targetInst.suspended_at !== undefined) {
        if (typeof targetInst.suspended_at !== "string") {
          throw new GitHubInstallationError("Invalid GitHub installation suspended_at: must be an ISO string", 400);
        }
        const parsed = new Date(targetInst.suspended_at).getTime();
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new GitHubInstallationError("Invalid GitHub installation suspended_at: must parse to a finite positive timestamp", 400);
        }
        suspendedAtMs = parsed;
      }

      // 5. Atomically upsert installation metadata + user link
      const upsertResult = this.store.upsertGitHubInstallationWithUser({
        githubInstallationId: String(targetInst.id),
        githubAppId: String(targetInst.app_id),
        accountId: String(targetInst.account.id),
        accountLogin: targetInst.account.login.trim(),
        accountType,
        repositorySelection,
        suspendedAtMs,
        userId: pending.userId,
      });

      let grantId: string | undefined;
      if (input.onTokenVerified) {
        const handoff = await input.onTokenVerified({
          sessionId: input.currentSessionId ?? "",
          userId: pending.userId,
          providerSubject: pending.providerSubject,
          installationRowId: upsertResult.installation.id,
          installationId: String(targetInst.id),
          installationAccount: {
            id: String(targetInst.account.id),
            login: targetInst.account.login.trim(),
            type: accountType,
          },
          userAccessToken,
        });
        grantId = handoff.grantId;
      }

      return {
        installationId: String(targetInst.id),
        accountLogin: targetInst.account.login.trim(),
        installationRowId: upsertResult.installation.id,
        grantId,
        onboardingFlowId: pending.onboardingFlowId,
        oauthRequest: pending.oauthRequest,
      };
    } finally {
      // The reference is dropped after the synchronous handoff and the token is never retained, returned, persisted, or logged.
    }
  }

  listUserInstallations(userId: string): UserGitHubInstallationItem[] {
    return this.store.listGitHubInstallationsForUser(userId);
  }
}
