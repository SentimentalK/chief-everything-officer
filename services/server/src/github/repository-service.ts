import crypto from "node:crypto";
import type {
  IdentityStore,
  GitHubRepositoryBindingRecord,
} from "../identity/store.js";
import { IdentityConflictError, IdentityStructureError } from "../identity/store.js";
import type { GitHubAppClient } from "./app-client.js";
import type { UserSessionManager } from "../auth/user-session.js";

export interface GitHubRepositoryServiceOptions {
  appClient: GitHubAppClient;
  store: IdentityStore;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  fetchFn?: typeof fetch;
  stateTtlMs?: number;
  grantTtlMs?: number;
  sessionManager?: UserSessionManager;
}

export interface PendingRepoOAuthState {
  codeVerifier: string;
  sessionId: string;
  userId: string;
  providerSubject: string;
  installationRowId: string;
  installationId: string;
  expiresAt: number;
}

export interface RepositoryAuthorizationGrant {
  id: string;
  sessionId: string;
  userId: string;
  providerSubject: string;
  installationRowId: string;
  installationId: string;
  installationAccountId: string;
  installationAccountLogin: string;
  installationAccountType: "User" | "Organization";
  userAccessToken: string;
  expiresAtMs: number;
}

export interface SafeRepositoryMetadata {
  id: string;
  name: string;
  full_name: string;
  owner: {
    id: string;
    login: string;
  };
  private: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  permissions?: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

export class GitHubRepositoryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GitHubRepositoryError";
    this.status = status;
  }
}

export class GitHubAppPermissionUpgradeRequiredError extends GitHubRepositoryError {
  constructor(message: string) {
    super(message, 403);
    this.name = "GitHubAppPermissionUpgradeRequiredError";
  }
}

export class GitHubPartialCreationError extends Error {
  readonly status = 500;
  readonly repository?: SafeRepositoryMetadata;
  constructor(message: string, repository?: SafeRepositoryMetadata) {
    super(message);
    this.name = "GitHubPartialCreationError";
    this.repository = repository;
  }
}

export const POSITIVE_SAFE_INT_REGEX = /^[1-9][0-9]*$/;

export function parseStrictRepositoryPayload(
  raw: unknown,
  options?: { requirePermissions?: boolean; requireAdmin?: boolean },
): SafeRepositoryMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GitHubRepositoryError("Repository payload must be a JSON object", 400);
  }

  const obj = raw as Record<string, unknown>;

  // repo id: positive safe integer
  let repoId: string;
  if (typeof obj.id === "number") {
    if (!Number.isSafeInteger(obj.id) || obj.id <= 0) {
      throw new GitHubRepositoryError("Repository id must be a positive safe integer", 400);
    }
    repoId = String(obj.id);
  } else if (typeof obj.id === "string") {
    if (!POSITIVE_SAFE_INT_REGEX.test(obj.id) || !Number.isSafeInteger(Number(obj.id))) {
      throw new GitHubRepositoryError("Repository id must be a positive safe integer string", 400);
    }
    repoId = obj.id;
  } else {
    throw new GitHubRepositoryError("Repository id must be a positive safe integer", 400);
  }

  // name: non-empty string, exact trim
  if (typeof obj.name !== "string" || obj.name.trim().length === 0 || obj.name.trim() !== obj.name) {
    throw new GitHubRepositoryError("Repository name must be a non-empty string", 400);
  }
  const name = obj.name;

  // full_name: non-empty string, exact trim
  if (typeof obj.full_name !== "string" || obj.full_name.trim().length === 0 || obj.full_name.trim() !== obj.full_name) {
    throw new GitHubRepositoryError("Repository full_name must be a non-empty string", 400);
  }
  const fullName = obj.full_name;

  // owner
  if (!obj.owner || typeof obj.owner !== "object" || Array.isArray(obj.owner)) {
    throw new GitHubRepositoryError("Repository owner must be an object", 400);
  }
  const ownerObj = obj.owner as Record<string, unknown>;

  let ownerId: string;
  if (typeof ownerObj.id === "number") {
    if (!Number.isSafeInteger(ownerObj.id) || ownerObj.id <= 0) {
      throw new GitHubRepositoryError("Repository owner id must be a positive safe integer", 400);
    }
    ownerId = String(ownerObj.id);
  } else if (typeof ownerObj.id === "string") {
    if (!POSITIVE_SAFE_INT_REGEX.test(ownerObj.id) || !Number.isSafeInteger(Number(ownerObj.id))) {
      throw new GitHubRepositoryError("Repository owner id must be a positive safe integer string", 400);
    }
    ownerId = ownerObj.id;
  } else {
    throw new GitHubRepositoryError("Repository owner id must be a positive safe integer", 400);
  }

  if (typeof ownerObj.login !== "string" || ownerObj.login.trim().length === 0 || ownerObj.login.trim() !== ownerObj.login) {
    throw new GitHubRepositoryError("Repository owner login must be a non-empty string", 400);
  }
  const ownerLogin = ownerObj.login;

  if (fullName !== `${ownerLogin}/${name}`) {
    throw new GitHubRepositoryError(
      `Repository full_name '${fullName}' does not match expected '${ownerLogin}/${name}'`,
      400,
    );
  }

  // private: actual boolean
  if (typeof obj.private !== "boolean") {
    throw new GitHubRepositoryError("Repository private must be a boolean", 400);
  }
  const isPrivate = obj.private;

  // archived: actual boolean
  if (typeof obj.archived !== "boolean") {
    throw new GitHubRepositoryError("Repository archived must be a boolean", 400);
  }
  const isArchived = obj.archived;

  // disabled: actual boolean
  if (typeof obj.disabled !== "boolean") {
    throw new GitHubRepositoryError("Repository disabled must be a boolean", 400);
  }
  const isDisabled = obj.disabled;

  // default_branch: non-empty string, no NUL, NEVER default to "main"
  if (
    typeof obj.default_branch !== "string" ||
    obj.default_branch.trim().length === 0 ||
    obj.default_branch.includes("\0")
  ) {
    throw new GitHubRepositoryError("Repository default_branch must be a non-empty string without NUL", 400);
  }
  const defaultBranch = obj.default_branch.trim();

  // permissions
  let permissions: { admin: boolean; push: boolean; pull: boolean } | undefined;
  if (obj.permissions !== undefined) {
    if (!obj.permissions || typeof obj.permissions !== "object" || Array.isArray(obj.permissions)) {
      throw new GitHubRepositoryError("Repository permissions must be an object when present", 400);
    }
    const permObj = obj.permissions as Record<string, unknown>;
    if (typeof permObj.admin !== "boolean") {
      throw new GitHubRepositoryError("Repository permissions must contain boolean admin field", 400);
    }
    if (permObj.push !== undefined && typeof permObj.push !== "boolean") {
      throw new GitHubRepositoryError("Repository permissions push must be a boolean", 400);
    }
    if (permObj.pull !== undefined && typeof permObj.pull !== "boolean") {
      throw new GitHubRepositoryError("Repository permissions pull must be a boolean", 400);
    }
    permissions = {
      admin: permObj.admin,
      push: permObj.push === true,
      pull: permObj.pull === true,
    };
  }

  if (options?.requirePermissions && !permissions) {
    throw new GitHubRepositoryError("Repository permissions object is required", 400);
  }

  if (options?.requireAdmin && (!permissions || permissions.admin !== true)) {
    throw new GitHubRepositoryError(
      "ADMIN_PERMISSION_REQUIRED: User must have admin permission on the repository to import",
      403,
    );
  }

  return {
    id: repoId,
    name,
    full_name: fullName,
    owner: {
      id: ownerId,
      login: ownerLogin,
    },
    private: isPrivate,
    archived: isArchived,
    disabled: isDisabled,
    default_branch: defaultBranch,
    permissions,
  };
}

export function tryParseStrictRepository(raw: unknown): SafeRepositoryMetadata | null {
  try {
    return parseStrictRepositoryPayload(raw);
  } catch {
    return null;
  }
}

export class GitHubRepositoryService {
  private readonly appClient: GitHubAppClient;
  private readonly store: IdentityStore;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly stateTtlMs: number;
  private readonly grantTtlMs: number;
  private readonly sessionManager?: UserSessionManager;

  private readonly pendingStates = new Map<string, PendingRepoOAuthState>();
  private readonly grants = new Map<string, RepositoryAuthorizationGrant>();
  private readonly activeCreations = new Set<string>();

  constructor(options: GitHubRepositoryServiceOptions) {
    this.appClient = options.appClient;
    this.store = options.store;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.callbackUrl = options.callbackUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000;
    this.grantTtlMs = options.grantTtlMs ?? 10 * 60 * 1000;
    this.sessionManager = options.sessionManager;
  }

  get appClientInstance(): GitHubAppClient {
    return this.appClient;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [state, data] of this.pendingStates.entries()) {
      if (now > data.expiresAt) {
        this.pendingStates.delete(state);
      }
    }
    for (const [grantId, grant] of this.grants.entries()) {
      if (now > grant.expiresAtMs) {
        this.grants.delete(grantId);
      }
    }
  }

  /**
   * Begins a purpose-bound repository authorization flow for an already authenticated CEO GitHub browser session.
   * Generates PKCE verifier/challenge and binds pending state to userId + providerSubject + installation.
   */
  createAuthorizationRedirect(input: {
    sessionId: string;
    userId: string;
    providerSubject: string;
    installationId: string;
  }): { authorizationUrl: string; state: string } {
    this.cleanup();

    if (!input.sessionId || typeof input.sessionId !== "string" || input.sessionId.trim().length === 0) {
      throw new GitHubRepositoryError("Active CEO session required", 401);
    }
    if (!input.userId || !input.providerSubject) {
      throw new GitHubRepositoryError("Active CEO GitHub session required", 401);
    }
    if (this.sessionManager) {
      const liveSession = this.sessionManager.getSessionFromToken(input.sessionId);
      if (!liveSession || liveSession.userId !== input.userId) {
        throw new GitHubRepositoryError("Active CEO session is invalid or expired", 401);
      }
    }
    if (!this.store.isUserActive(input.userId)) {
      throw new GitHubRepositoryError("User is disabled or does not exist", 401);
    }
    if (!input.installationId || typeof input.installationId !== "string" || input.installationId.trim().length === 0) {
      throw new GitHubRepositoryError("installation_id is required", 400);
    }

    const trimmedInstId = input.installationId.trim();
    // Resolve installation by external numeric ID or internal row ID
    const inst =
      this.store.findGitHubInstallationById(trimmedInstId) ||
      this.store.findGitHubInstallationByRowId(trimmedInstId);

    if (!inst) {
      throw new GitHubRepositoryError("GitHub installation not found", 404);
    }

    const userLink = this.store.findGitHubInstallationUser(inst.id, input.userId);
    if (!userLink) {
      throw new GitHubRepositoryError("User has no verified association with this installation", 403);
    }

    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");

    this.pendingStates.set(state, {
      codeVerifier,
      sessionId: input.sessionId,
      userId: input.userId,
      providerSubject: input.providerSubject,
      installationRowId: inst.id,
      installationId: inst.github_installation_id,
      expiresAt: Date.now() + this.stateTtlMs,
    });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", this.clientId);
    authorizeUrl.searchParams.set("redirect_uri", this.callbackUrl);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return {
      authorizationUrl: authorizeUrl.toString(),
      state,
    };
  }

  /**
   * Completes OAuth callback: exchanges code, validates user identity and live installation access,
   * then creates an ephemeral in-memory RepositoryAuthorizationGrant bound to the CEO product session.
   */
  async handleOAuthCallback(input: {
    state: string;
    code: string;
    currentSessionId: string;
    currentUserId: string;
    currentProviderSubject: string;
  }): Promise<{ grant: string; expiresAtMs: number }> {
    this.cleanup();

    if (!input.currentSessionId || typeof input.currentSessionId !== "string" || input.currentSessionId.trim().length === 0) {
      throw new GitHubRepositoryError("Active CEO session required", 401);
    }
    if (!input.currentUserId || !input.currentProviderSubject) {
      throw new GitHubRepositoryError("Active CEO GitHub session required", 401);
    }

    const pending = this.pendingStates.get(input.state);
    if (!pending) {
      throw new GitHubRepositoryError("Invalid or expired authorization state", 400);
    }
    // Single-use
    this.pendingStates.delete(input.state);

    if (Date.now() > pending.expiresAt) {
      throw new GitHubRepositoryError("Authorization state has expired", 400);
    }

    if (pending.sessionId !== input.currentSessionId) {
      throw new GitHubRepositoryError("Session mismatch: active session does not match authorization state", 403);
    }

    if (
      pending.userId !== input.currentUserId ||
      pending.providerSubject !== input.currentProviderSubject
    ) {
      throw new GitHubRepositoryError("Session user mismatch: active session does not match authorization state", 403);
    }

    if (this.sessionManager) {
      const liveSession = this.sessionManager.getSessionFromToken(input.currentSessionId);
      if (!liveSession || liveSession.userId !== input.currentUserId) {
        throw new GitHubRepositoryError("Active CEO session is invalid or expired", 401);
      }
    }

    if (!this.store.isUserActive(input.currentUserId)) {
      throw new GitHubRepositoryError("User is disabled or does not exist", 401);
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
      throw new GitHubRepositoryError(`Token exchange failed with HTTP ${tokenRes.status}`, tokenRes.status);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (tokenData.error || !tokenData.access_token) {
      throw new GitHubRepositoryError(tokenData.error_description || tokenData.error || "Token exchange failed", 400);
    }

    const userAccessToken = tokenData.access_token;

    // 2. Fetch authenticated GitHub user
    const userRes = await this.fetchFn("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "CEO-Server",
      },
    });

    if (!userRes.ok) {
      throw new GitHubRepositoryError(`GitHub user profile fetch failed with HTTP ${userRes.status}`, userRes.status);
    }

    const githubUser = (await userRes.json()) as { id?: unknown; login?: unknown };
    if (typeof githubUser.id !== "number" || typeof githubUser.login !== "string") {
      throw new GitHubRepositoryError("Invalid GitHub user response", 400);
    }

    const githubSubject = String(githubUser.id);
    if (githubSubject !== pending.providerSubject) {
      throw new GitHubRepositoryError(
        `GitHub user mismatch: authenticated as '${githubSubject}' (${githubUser.login}), expected '${pending.providerSubject}'`,
        403,
      );
    }

    // 3. Live-verify the installation is accessible to this user
    const perPage = 100;
    const maxPages = 100;
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
        throw new GitHubRepositoryError(
          `GitHub user installations fetch failed with HTTP ${instRes.status}`,
          instRes.status,
        );
      }

      const instData = (await instRes.json()) as {
        total_count?: number;
        installations?: Array<any>;
      };

      const installations = Array.isArray(instData.installations) ? instData.installations : [];
      targetInst = installations.find((inst) => String(inst?.id) === pending.installationId);
      if (targetInst) break;
      if (installations.length === 0 || installations.length < perPage) break;
      if (typeof instData.total_count === "number" && page * perPage >= instData.total_count) break;
      page++;
    }

    if (!targetInst) {
      throw new GitHubRepositoryError(
        `Installation '${pending.installationId}' is not accessible by GitHub user '${githubSubject}'`,
        403,
      );
    }

    // 4. Strictly validate installation payload semantics
    if (
      typeof targetInst.id !== "number" ||
      !Number.isSafeInteger(targetInst.id) ||
      targetInst.id <= 0 ||
      String(targetInst.id) !== pending.installationId
    ) {
      throw new GitHubRepositoryError(
        "Invalid GitHub installation id: must be a positive safe integer matching pending installation",
        400,
      );
    }

    if (
      typeof targetInst.app_id !== "number" ||
      !Number.isSafeInteger(targetInst.app_id) ||
      targetInst.app_id <= 0
    ) {
      throw new GitHubRepositoryError(
        "Invalid GitHub installation app_id: must be a positive safe integer",
        400,
      );
    }

    if (!targetInst.account || typeof targetInst.account !== "object" || Array.isArray(targetInst.account)) {
      throw new GitHubRepositoryError("Invalid GitHub installation account payload", 400);
    }

    if (
      typeof targetInst.account.id !== "number" ||
      !Number.isSafeInteger(targetInst.account.id) ||
      targetInst.account.id <= 0
    ) {
      throw new GitHubRepositoryError(
        "Invalid GitHub installation account id: must be a positive safe integer",
        400,
      );
    }

    if (
      typeof targetInst.account.login !== "string" ||
      targetInst.account.login.trim().length === 0
    ) {
      throw new GitHubRepositoryError(
        "Invalid GitHub installation account login: must be non-empty",
        400,
      );
    }

    if (targetInst.account.type !== "User" && targetInst.account.type !== "Organization") {
      throw new GitHubRepositoryError(
        `Invalid GitHub installation account type '${targetInst.account.type}': must be 'User' or 'Organization'`,
        400,
      );
    }

    if (
      targetInst.repository_selection !== undefined &&
      targetInst.repository_selection !== "all" &&
      targetInst.repository_selection !== "selected"
    ) {
      throw new GitHubRepositoryError(
        `Invalid GitHub installation repository_selection '${targetInst.repository_selection}': must be 'all' or 'selected'`,
        400,
      );
    }

    // Live installation account id/type must be consistent with the persisted installation row
    const persistedInst = this.store.findGitHubInstallationByRowId(pending.installationRowId);
    if (!persistedInst) {
      throw new GitHubRepositoryError("Persisted installation row not found", 404);
    }

    if (String(targetInst.account.id) !== persistedInst.account_id) {
      throw new GitHubRepositoryError(
        `GitHub installation account id mismatch: live '${targetInst.account.id}' does not match persisted '${persistedInst.account_id}'`,
        400,
      );
    }

    if (targetInst.account.type !== persistedInst.account_type) {
      throw new GitHubRepositoryError(
        `GitHub installation account type mismatch: live '${targetInst.account.type}' does not match persisted '${persistedInst.account_type}'`,
        400,
      );
    }

    // 5. Create ephemeral in-memory grant bound to CEO session
    const grantId = crypto.randomBytes(32).toString("hex");
    const expiresAtMs = Date.now() + this.grantTtlMs;

    this.grants.set(grantId, {
      id: grantId,
      sessionId: pending.sessionId,
      userId: pending.userId,
      providerSubject: pending.providerSubject,
      installationRowId: pending.installationRowId,
      installationId: pending.installationId,
      installationAccountId: String(targetInst.account.id),
      installationAccountLogin: targetInst.account.login.trim(),
      installationAccountType: targetInst.account.type,
      userAccessToken,
      expiresAtMs,
    });

    return {
      grant: grantId,
      expiresAtMs,
    };
  }

  getValidGrant(
    grantId: string,
    currentSessionId: string,
    currentUserId: string,
    currentProviderSubject: string,
  ): RepositoryAuthorizationGrant {
    this.cleanup();

    if (!grantId || typeof grantId !== "string") {
      throw new GitHubRepositoryError("Grant id required", 400);
    }
    if (!currentSessionId || typeof currentSessionId !== "string" || currentSessionId.trim().length === 0) {
      throw new GitHubRepositoryError("Active CEO session required", 401);
    }

    const grant = this.grants.get(grantId);
    if (!grant) {
      throw new GitHubRepositoryError("Invalid or expired repository grant", 401);
    }

    if (Date.now() > grant.expiresAtMs) {
      this.grants.delete(grantId);
      throw new GitHubRepositoryError("Repository grant has expired", 401);
    }

    if (grant.sessionId !== currentSessionId) {
      throw new GitHubRepositoryError("Repository grant does not belong to the active session", 403);
    }

    if (grant.userId !== currentUserId || grant.providerSubject !== currentProviderSubject) {
      throw new GitHubRepositoryError("Repository grant does not belong to the active session user", 403);
    }

    if (this.sessionManager) {
      const liveSession = this.sessionManager.getSessionFromToken(currentSessionId);
      if (!liveSession || liveSession.userId !== currentUserId) {
        throw new GitHubRepositoryError("Active CEO session is invalid or expired", 401);
      }
    }

    if (!this.store.isUserActive(currentUserId)) {
      throw new GitHubRepositoryError("User is disabled or does not exist", 401);
    }

    const userLink = this.store.findGitHubInstallationUser(grant.installationRowId, currentUserId);
    if (!userLink) {
      throw new GitHubRepositoryError("User has no verified association with this installation", 403);
    }

    return grant;
  }

  /**
   * Lists repositories in user∩installation scope with bounded pagination.
   * Discovery omits malformed rows with no side effects.
   */
  async listRepositories(
    grantId: string,
    currentSessionId: string,
    currentUserId: string,
    currentProviderSubject: string,
  ): Promise<{ repositories: SafeRepositoryMetadata[]; total_count: number }> {
    const grant = this.getValidGrant(grantId, currentSessionId, currentUserId, currentProviderSubject);

    const perPage = 100;
    const maxPages = 100;
    let page = 1;
    const allRepos: SafeRepositoryMetadata[] = [];
    let reportedTotal = 0;

    while (page <= maxPages) {
      const res = await this.fetchFn(
        `https://api.github.com/user/installations/${encodeURIComponent(grant.installationId)}/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${grant.userAccessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "CEO-Server",
          },
        },
      );

      if (!res.ok) {
        throw new GitHubRepositoryError(
          `GitHub user installation repositories fetch failed with HTTP ${res.status}`,
          res.status,
        );
      }

      const data = (await res.json()) as {
        total_count?: number;
        repositories?: Array<any>;
      };

      if (typeof data.total_count === "number") {
        reportedTotal = data.total_count;
      }

      const rawRepos = Array.isArray(data.repositories) ? data.repositories : [];
      for (const r of rawRepos) {
        const parsed = tryParseStrictRepository(r);
        if (!parsed) {
          // Discovery may omit malformed rows with no side effects
          continue;
        }
        allRepos.push(parsed);
      }

      if (rawRepos.length === 0 || rawRepos.length < perPage) {
        break;
      }
      if (typeof data.total_count === "number" && page * perPage >= data.total_count) {
        break;
      }

      page++;
    }

    return {
      repositories: allRepos,
      total_count: reportedTotal || allRepos.length,
    };
  }

  private async findUserInstallationRepositoryRaw(
    grant: RepositoryAuthorizationGrant,
    repositoryId: string,
  ): Promise<unknown | null> {
    const perPage = 100;
    const maxPages = 100;
    let page = 1;

    while (page <= maxPages) {
      const res = await this.fetchFn(
        `https://api.github.com/user/installations/${encodeURIComponent(grant.installationId)}/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${grant.userAccessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "CEO-Server",
          },
        },
      );

      if (!res.ok) {
        throw new GitHubRepositoryError(
          `GitHub user installation repositories fetch failed with HTTP ${res.status}`,
          res.status,
        );
      }

      const data = (await res.json()) as {
        total_count?: number;
        repositories?: Array<any>;
      };

      const rawRepos = Array.isArray(data.repositories) ? data.repositories : [];
      const match = rawRepos.find((r) => r && String(r.id) === repositoryId);
      if (match) {
        return match;
      }

      if (rawRepos.length === 0 || rawRepos.length < perPage) {
        break;
      }
      if (typeof data.total_count === "number" && page * perPage >= data.total_count) {
        break;
      }

      page++;
    }

    return null;
  }

  /**
   * Imports an existing private repository.
   */
  async importRepository(
    grantId: string,
    currentSessionId: string,
    currentUserId: string,
    currentProviderSubject: string,
    repositoryId: string,
  ): Promise<{
    workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
    membership: { id: string; workspace_id: string; user_id: string; role: string; created_at: number };
    binding: GitHubRepositoryBindingRecord;
  }> {
    if (!repositoryId || typeof repositoryId !== "string" || !POSITIVE_SAFE_INT_REGEX.test(repositoryId)) {
      throw new GitHubRepositoryError("repository_id must be a positive decimal string", 400);
    }

    const grant = this.getValidGrant(grantId, currentSessionId, currentUserId, currentProviderSubject);

    // Product V1 provisioning policy: reject if user already owns a workspace
    if (this.store.countOwnedWorkspacesForUser(currentUserId) > 0) {
      throw new GitHubRepositoryError("USER_ALREADY_OWNS_WORKSPACE: User already owns a workspace", 409);
    }

    // Reject if repo already bound
    if (this.store.findRepositoryBindingByGitHubRepoId(repositoryId)) {
      throw new GitHubRepositoryError("REPOSITORY_ALREADY_BOUND: GitHub repository is already bound to a workspace", 409);
    }

    // Re-fetch exact repo from user∩installation scope and strictly re-validate
    const rawRepo = await this.findUserInstallationRepositoryRaw(grant, repositoryId);
    if (!rawRepo) {
      throw new GitHubRepositoryError(
        "Repository not found in installation or not accessible by user",
        404,
      );
    }

    const repo = parseStrictRepositoryPayload(rawRepo, { requirePermissions: true, requireAdmin: true });

    // Validate repo properties
    if (!repo.private) {
      throw new GitHubRepositoryError("REPOSITORY_NOT_PRIVATE: Only private repositories may be bound", 400);
    }
    if (repo.archived) {
      throw new GitHubRepositoryError("REPOSITORY_ARCHIVED: Archived repositories cannot be bound", 400);
    }
    if (repo.disabled) {
      throw new GitHubRepositoryError("REPOSITORY_DISABLED: Disabled repositories cannot be bound", 400);
    }
    if (repo.owner.id !== grant.installationAccountId) {
      throw new GitHubRepositoryError(
        "INSTALLATION_OWNER_MISMATCH: Repository owner does not match installation account",
        400,
      );
    }

    // Live installation capability check: Contents: write
    const instDetails = await this.appClient.getInstallation(grant.installationId);
    if (instDetails.permissions?.contents !== "write") {
      throw new GitHubAppPermissionUpgradeRequiredError(
        "GITHUB_APP_PERMISSION_UPGRADE_REQUIRED: GitHub App installation requires Contents: write permission",
      );
    }

    // Verify installation token access to exact repo
    const instToken = await this.appClient.getInstallationToken(grant.installationId);
    const repoRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`,
      {
        headers: {
          Authorization: `Bearer ${instToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!repoRes.ok) {
      throw new GitHubRepositoryError(
        `Installation token failed to access repository with HTTP ${repoRes.status}`,
        repoRes.status === 404 ? 404 : 403,
      );
    }

    const verifiedRepoRaw = await repoRes.json();
    const verifiedRepo = parseStrictRepositoryPayload(verifiedRepoRaw);

    if (verifiedRepo.id !== repo.id) {
      throw new GitHubRepositoryError("Installation verified repository id mismatch", 400);
    }
    if (verifiedRepo.owner.id !== repo.owner.id) {
      throw new GitHubRepositoryError("Installation verified repository owner id mismatch", 400);
    }
    if (verifiedRepo.owner.login !== repo.owner.login) {
      throw new GitHubRepositoryError("Installation verified repository owner login mismatch", 400);
    }
    if (verifiedRepo.name !== repo.name) {
      throw new GitHubRepositoryError("Installation verified repository name mismatch", 400);
    }
    if (verifiedRepo.full_name !== repo.full_name) {
      throw new GitHubRepositoryError("Installation verified repository full_name mismatch", 400);
    }
    if (verifiedRepo.default_branch !== repo.default_branch) {
      throw new GitHubRepositoryError("Installation verified repository default_branch mismatch", 400);
    }
    if (!verifiedRepo.private || verifiedRepo.archived || verifiedRepo.disabled) {
      throw new GitHubRepositoryError("Installation verified repository must be private, not archived, and not disabled", 400);
    }

    // Atomically create Workspace + membership + binding
    return this.store.createWorkspaceWithRepositoryBinding({
      userId: currentUserId,
      installationRowId: grant.installationRowId,
      githubRepositoryId: verifiedRepo.id,
      ownerAccountId: verifiedRepo.owner.id,
      ownerLogin: verifiedRepo.owner.login,
      repositoryName: verifiedRepo.name,
      fullName: verifiedRepo.full_name,
      branch: verifiedRepo.default_branch,
    });
  }

  /**
   * Programmatically creates a new private repository and provisions a workspace.
   */
  async createRepository(
    grantId: string,
    currentSessionId: string,
    currentUserId: string,
    currentProviderSubject: string,
    input: { name: string; description?: string },
  ): Promise<{
    workspace: { id: string; owner_user_id: string; remote_url: string; branch: string; created_at: number };
    membership: { id: string; workspace_id: string; user_id: string; role: string; created_at: number };
    binding: GitHubRepositoryBindingRecord;
  }> {
    // Single-pod in-memory per-CEO-user provisioning guard
    if (this.activeCreations.has(currentUserId)) {
      throw new GitHubRepositoryError("Repository creation already in progress for this user", 409);
    }
    this.activeCreations.add(currentUserId);

    try {
      if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
        throw new GitHubRepositoryError("Repository name is required", 400);
      }
      const repoName = input.name.trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(repoName) || repoName === "." || repoName === ".." || repoName.length > 100) {
        throw new GitHubRepositoryError("Invalid repository name", 400);
      }

      const grant = this.getValidGrant(grantId, currentSessionId, currentUserId, currentProviderSubject);

      // Product V1 provisioning policy: reject BEFORE external side effect
      if (this.store.countOwnedWorkspacesForUser(currentUserId) > 0) {
        throw new GitHubRepositoryError("USER_ALREADY_OWNS_WORKSPACE: User already owns a workspace", 409);
      }

      // Live installation capability check BEFORE external side effect
      const instDetails = await this.appClient.getInstallation(grant.installationId);
      if (instDetails.permissions?.administration !== "write") {
        throw new GitHubAppPermissionUpgradeRequiredError(
          "GITHUB_APP_PERMISSION_UPGRADE_REQUIRED: GitHub App requires Administration: write permission for repository creation",
        );
      }
      if (instDetails.permissions?.contents !== "write") {
        throw new GitHubAppPermissionUpgradeRequiredError(
          "GITHUB_APP_PERMISSION_UPGRADE_REQUIRED: GitHub App requires Contents: write permission",
        );
      }

      // External creation via user access token
      let createUrl: string;
      if (grant.installationAccountType === "User") {
        if (grant.installationAccountId !== grant.providerSubject) {
          throw new GitHubRepositoryError("User installation account does not match authenticated user", 403);
        }
        createUrl = "https://api.github.com/user/repos";
      } else {
        createUrl = `https://api.github.com/orgs/${encodeURIComponent(grant.installationAccountLogin)}/repos`;
      }

      const createRes = await this.fetchFn(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.userAccessToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          name: repoName,
          description: input.description?.trim() || undefined,
          private: true,
          auto_init: false,
        }),
      });

      if (!createRes.ok) {
        const errJson = (await createRes.json().catch(() => ({}))) as { message?: string };
        const msg = errJson.message || `GitHub repository creation failed with HTTP ${createRes.status}`;
        throw new GitHubRepositoryError(msg, createRes.status >= 400 && createRes.status < 500 ? createRes.status : 400);
      }

      // IMMEDIATELY after createRes.ok, all steps are inside the partial-side-effect boundary!
      let safeRecoveryRepo: SafeRepositoryMetadata | undefined;

      try {
        let createdRaw: unknown;
        try {
          createdRaw = await createRes.json();
        } catch (jsonErr) {
          throw new Error("Creation response body was not valid JSON");
        }

        // Try to extract safe recovery metadata if safe id and full_name are trustworthy
        if (
          createdRaw &&
          typeof createdRaw === "object" &&
          !Array.isArray(createdRaw)
        ) {
          const rawObj = createdRaw as Record<string, unknown>;
          const rawId = typeof rawObj.id === "number" && Number.isSafeInteger(rawObj.id) && rawObj.id > 0
            ? String(rawObj.id)
            : typeof rawObj.id === "string" && POSITIVE_SAFE_INT_REGEX.test(rawObj.id) && Number.isSafeInteger(Number(rawObj.id))
            ? rawObj.id
            : null;

          const rawFullName = typeof rawObj.full_name === "string" && rawObj.full_name.trim().length === 0
            ? null
            : typeof rawObj.full_name === "string"
            ? rawObj.full_name.trim()
            : null;

          const rawName = typeof rawObj.name === "string" && rawObj.name.trim().length === 0
            ? null
            : typeof rawObj.name === "string"
            ? rawObj.name.trim()
            : null;

          const ownerObj = rawObj.owner && typeof rawObj.owner === "object" && !Array.isArray(rawObj.owner)
            ? (rawObj.owner as Record<string, unknown>)
            : null;

          const rawOwnerId = ownerObj && typeof ownerObj.id === "number" && Number.isSafeInteger(ownerObj.id) && ownerObj.id > 0
            ? String(ownerObj.id)
            : ownerObj && typeof ownerObj.id === "string" && POSITIVE_SAFE_INT_REGEX.test(ownerObj.id) && Number.isSafeInteger(Number(ownerObj.id))
            ? ownerObj.id
            : null;

          const rawOwnerLogin = ownerObj && typeof ownerObj.login === "string" && ownerObj.login.trim().length > 0
            ? ownerObj.login.trim()
            : null;

          if (rawId && rawFullName && rawName && rawOwnerId && rawOwnerLogin && rawFullName === `${rawOwnerLogin}/${rawName}`) {
            safeRecoveryRepo = {
              id: rawId,
              name: rawName,
              full_name: rawFullName,
              owner: {
                id: rawOwnerId,
                login: rawOwnerLogin,
              },
              private: typeof rawObj.private === "boolean" ? rawObj.private : false,
              archived: typeof rawObj.archived === "boolean" ? rawObj.archived : false,
              disabled: typeof rawObj.disabled === "boolean" ? rawObj.disabled : false,
              default_branch: typeof rawObj.default_branch === "string" && rawObj.default_branch.trim().length > 0
                ? rawObj.default_branch.trim()
                : "",
            };
          }
        }

        // Strict semantic validation on creation payload
        const createdRepo = parseStrictRepositoryPayload(createdRaw);

        if (!createdRepo.private) {
          throw new Error("Created repository is not private");
        }
        if (createdRepo.archived) {
          throw new Error("Created repository is archived");
        }
        if (createdRepo.disabled) {
          throw new Error("Created repository is disabled");
        }
        if (createdRepo.owner.id !== grant.installationAccountId) {
          throw new Error(`Created repository owner '${createdRepo.owner.id}' does not match installation account '${grant.installationAccountId}'`);
        }
        if (createdRepo.name !== repoName) {
          throw new Error(`Created repository name '${createdRepo.name}' does not match requested name '${repoName}'`);
        }

        // Update safeRecoveryRepo with strict validated data
        safeRecoveryRepo = createdRepo;

        // Installation-token verification
        const instToken = await this.appClient.getInstallationToken(grant.installationId);
        const verifyRes = await this.fetchFn(
          `https://api.github.com/repos/${encodeURIComponent(createdRepo.owner.login)}/${encodeURIComponent(createdRepo.name)}`,
          {
            headers: {
              Authorization: `Bearer ${instToken}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "CEO-Server",
            },
          },
        );

        if (!verifyRes.ok) {
          throw new Error(`Installation token failed to access created repository with HTTP ${verifyRes.status}`);
        }

        const verifyDataRaw = await verifyRes.json();
        const verifiedRepo = parseStrictRepositoryPayload(verifyDataRaw);

        if (verifiedRepo.id !== createdRepo.id) {
          throw new Error(`Installation verified repository id '${verifiedRepo.id}' does not match created repository id '${createdRepo.id}'`);
        }
        if (verifiedRepo.owner.id !== createdRepo.owner.id) {
          throw new Error(`Installation verified repository owner id '${verifiedRepo.owner.id}' does not match created repository owner id '${createdRepo.owner.id}'`);
        }
        if (verifiedRepo.owner.login !== createdRepo.owner.login) {
          throw new Error("Installation verified repository owner login does not match created repository");
        }
        if (verifiedRepo.name !== createdRepo.name) {
          throw new Error("Installation verified repository name does not match created repository");
        }
        if (verifiedRepo.full_name !== createdRepo.full_name) {
          throw new Error("Installation verified repository full_name does not match created repository");
        }
        if (verifiedRepo.default_branch !== createdRepo.default_branch) {
          throw new Error(`Installation verified default_branch '${verifiedRepo.default_branch}' does not match created repository default_branch '${createdRepo.default_branch}'`);
        }
        if (!verifiedRepo.private || verifiedRepo.archived || verifiedRepo.disabled) {
          throw new Error("Installation verified repository must be private, not archived, and not disabled");
        }

        // Atomically bind in DB
        return this.store.createWorkspaceWithRepositoryBinding({
          userId: currentUserId,
          installationRowId: grant.installationRowId,
          githubRepositoryId: verifiedRepo.id,
          ownerAccountId: verifiedRepo.owner.id,
          ownerLogin: verifiedRepo.owner.login,
          repositoryName: verifiedRepo.name,
          fullName: verifiedRepo.full_name,
          branch: verifiedRepo.default_branch,
        });
      } catch (err) {
        // Partial-side-effect: NEVER delete repo, NEVER report workspace success / READY
        const detail = err instanceof Error ? err.message : String(err);
        if (safeRecoveryRepo) {
          throw new GitHubPartialCreationError(
            `Repository '${safeRecoveryRepo.full_name}' was created on GitHub, but workspace binding failed: ${detail}. Please import this repository.`,
            safeRecoveryRepo,
          );
        } else {
          throw new GitHubPartialCreationError(
            `An external repository may have been created on GitHub, but response payload was malformed and local workspace was not created: ${detail}. Local workspace was not created.`,
            undefined,
          );
        }
      }
    } finally {
      this.activeCreations.delete(currentUserId);
    }
  }
}
