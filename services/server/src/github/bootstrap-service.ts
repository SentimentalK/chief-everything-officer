import type { IdentityStore, GitHubRepositoryBindingRecord, WorkspaceBootstrapRecord } from "../identity/store.js";
import { IdentityStructureError } from "../identity/store.js";
import type { GitHubAppClient } from "./app-client.js";

export const BOOTSTRAP_MANIFEST_V1 = [
  {
    path: "README.md",
    content: `# Chief Everything Officer (CEO) Workspace

This repository contains your personal Chief Everything Officer (CEO) canonical workspace.
Content stored here is user-owned and tracked by Git.
`,
  },
  {
    path: "SYSTEM.md",
    content: `# System Directives

This file contains user-level directives and system context for your Chief Everything Officer workspace.
Domain policies are managed by the CEO runtime.
`,
  },
  {
    path: "JOURNAL.md",
    content: `# Journal

Chronological log of CEO operations and reflections.
`,
  },
] as const;

export type ProductProvisioningStatus =
  | "READY"
  | "PROVISIONING"
  | "RETRYABLE_FAILURE"
  | "MANUAL_RECOVERY";

export function deriveProductProvisioningStatus(state: WorkspaceBootstrapRecord["state"]): ProductProvisioningStatus {
  switch (state) {
    case "READY":
      return "READY";
    case "PENDING":
    case "APPLYING":
      return "PROVISIONING";
    case "RETRYABLE_FAILURE":
      return "RETRYABLE_FAILURE";
    case "MANUAL_RECOVERY":
      return "MANUAL_RECOVERY";
  }
}

export class WorkspaceBootstrapError extends Error {
  readonly code: string;
  readonly kind: "retryable" | "manual";
  readonly status: number;
  constructor(code: string, message: string, kind: "retryable" | "manual", status = 400) {
    super(message);
    this.name = "WorkspaceBootstrapError";
    this.code = code;
    this.kind = kind;
    this.status = status;
  }
}

export class RetryableBootstrapError extends WorkspaceBootstrapError {
  constructor(code: string, message: string, status = 500) {
    super(code, message, "retryable", status);
    this.name = "RetryableBootstrapError";
  }
}

export class ManualRecoveryBootstrapError extends WorkspaceBootstrapError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, "manual", status);
    this.name = "ManualRecoveryBootstrapError";
  }
}

const POSITIVE_SAFE_INT_REGEX = /^[1-9][0-9]*$/;

export interface SafeRepositoryMetadata {
  id: string;
  name: string;
  full_name: string;
  owner: {
    id: string;
    login: string;
    type?: string;
  };
  private: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  size?: number;
}

export function validateLiveRepositoryMetadata(
  raw: unknown,
  binding: GitHubRepositoryBindingRecord,
): SafeRepositoryMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository payload must be a JSON object", 400);
  }

  const obj = raw as Record<string, unknown>;

  // repo id: positive safe integer
  let repoId: string;
  if (typeof obj.id === "number") {
    if (!Number.isSafeInteger(obj.id) || obj.id <= 0) {
      throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository id must be a positive safe integer", 400);
    }
    repoId = String(obj.id);
  } else if (typeof obj.id === "string") {
    if (!POSITIVE_SAFE_INT_REGEX.test(obj.id) || !Number.isSafeInteger(Number(obj.id))) {
      throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository id must be a positive safe integer string", 400);
    }
    repoId = obj.id;
  } else {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository id must be a positive safe integer", 400);
  }

  if (repoId !== binding.github_repository_id) {
    throw new ManualRecoveryBootstrapError(
      "REPOSITORY_IDENTITY_MISMATCH",
      `Repository ID mismatch: expected ${binding.github_repository_id}, got ${repoId}`,
      400,
    );
  }

  // name: non-empty string, exact trim
  if (typeof obj.name !== "string" || obj.name.trim().length === 0 || obj.name.trim() !== obj.name) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository name must be a non-empty string", 400);
  }
  const name = obj.name;

  // full_name: non-empty string, exact trim
  if (typeof obj.full_name !== "string" || obj.full_name.trim().length === 0 || obj.full_name.trim() !== obj.full_name) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository full_name must be a non-empty string", 400);
  }
  const fullName = obj.full_name;

  // owner
  if (!obj.owner || typeof obj.owner !== "object" || Array.isArray(obj.owner)) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository owner must be an object", 400);
  }
  const ownerObj = obj.owner as Record<string, unknown>;

  let ownerId: string;
  if (typeof ownerObj.id === "number") {
    if (!Number.isSafeInteger(ownerObj.id) || ownerObj.id <= 0) {
      throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository owner id must be a positive safe integer", 400);
    }
    ownerId = String(ownerObj.id);
  } else if (typeof ownerObj.id === "string") {
    if (!POSITIVE_SAFE_INT_REGEX.test(ownerObj.id) || !Number.isSafeInteger(Number(ownerObj.id))) {
      throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository owner id must be a positive safe integer string", 400);
    }
    ownerId = ownerObj.id;
  } else {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository owner id must be a positive safe integer", 400);
  }

  if (ownerId !== binding.owner_account_id) {
    throw new ManualRecoveryBootstrapError(
      "REPOSITORY_IDENTITY_MISMATCH",
      `Repository owner account ID mismatch: expected ${binding.owner_account_id}, got ${ownerId}`,
      400,
    );
  }

  if (typeof ownerObj.login !== "string" || ownerObj.login.trim().length === 0 || ownerObj.login.trim() !== ownerObj.login) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository owner login must be a non-empty string", 400);
  }
  const ownerLogin = ownerObj.login;

  if (fullName !== `${ownerLogin}/${name}`) {
    throw new ManualRecoveryBootstrapError(
      "MALFORMED_REPOSITORY_PAYLOAD",
      `Repository full_name '${fullName}' does not match expected '${ownerLogin}/${name}'`,
      400,
    );
  }

  // private: boolean strictly true
  if (typeof obj.private !== "boolean") {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository private must be a boolean", 400);
  }
  if (obj.private !== true) {
    throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", "Bound repository is not private", 400);
  }

  // archived: boolean strictly false
  if (typeof obj.archived !== "boolean") {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository archived must be a boolean", 400);
  }
  if (obj.archived !== false) {
    throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", "Bound repository is archived", 400);
  }

  // disabled: boolean strictly false
  if (typeof obj.disabled !== "boolean") {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository disabled must be a boolean", 400);
  }
  if (obj.disabled !== false) {
    throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", "Bound repository is disabled", 400);
  }

  // default_branch: non-empty string, no NUL
  if (
    typeof obj.default_branch !== "string" ||
    obj.default_branch.trim().length === 0 ||
    obj.default_branch.includes("\0")
  ) {
    throw new ManualRecoveryBootstrapError("MALFORMED_REPOSITORY_PAYLOAD", "Repository default_branch must be a non-empty string without NUL", 400);
  }
  const defaultBranch = obj.default_branch.trim();

  let size: number | undefined;
  if (typeof obj.size === "number") {
    size = obj.size;
  }

  return {
    id: repoId,
    name,
    full_name: fullName,
    owner: {
      id: ownerId,
      login: ownerLogin,
      type: typeof ownerObj.type === "string" ? ownerObj.type : undefined,
    },
    private: true,
    archived: false,
    disabled: false,
    default_branch: defaultBranch,
    size,
  };
}

export function classifyGitHubResponseError(
  res: Response,
  context: string,
): WorkspaceBootstrapError {
  if (res.status === 401 || res.status === 403) {
    return new ManualRecoveryBootstrapError(
      "REPOSITORY_UNAVAILABLE",
      `GitHub access revoked or forbidden during ${context} (HTTP ${res.status})`,
      403,
    );
  }
  if (res.status === 404) {
    return new ManualRecoveryBootstrapError(
      "REPOSITORY_UNAVAILABLE",
      `GitHub object or repository not found during ${context} (HTTP 404)`,
      404,
    );
  }
  if (res.status === 429) {
    return new RetryableBootstrapError("GITHUB_RATE_LIMITED", `GitHub rate limit exceeded during ${context}`, 429);
  }
  if (res.status >= 500) {
    return new RetryableBootstrapError("GITHUB_5XX", `GitHub server error during ${context} (HTTP ${res.status})`, 502);
  }
  return new RetryableBootstrapError("NETWORK_ERROR", `Failed during ${context} (HTTP ${res.status})`, 500);
}

export interface WorkspaceBootstrapServiceOptions {
  appClient: GitHubAppClient;
  store: IdentityStore;
  fetchFn?: typeof fetch;
}

export interface WorkspaceProvisioningResult {
  workspace: {
    id: string;
    owner_user_id: string;
    remote_url: string;
    branch: string;
    created_at: number;
  };
  binding: GitHubRepositoryBindingRecord;
  bootstrap: WorkspaceBootstrapRecord;
  status: ProductProvisioningStatus;
}

export class WorkspaceBootstrapService {
  private readonly appClient: GitHubAppClient;
  private readonly store: IdentityStore;
  private readonly fetchFn: typeof fetch;
  private readonly activeBootstraps = new Set<string>();

  constructor(options: WorkspaceBootstrapServiceOptions) {
    this.appClient = options.appClient;
    this.store = options.store;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getProvisioningStatus(workspaceId: string): Promise<WorkspaceProvisioningResult> {
    const workspace = this.store.findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new ManualRecoveryBootstrapError("WORKSPACE_NOT_FOUND", `Workspace '${workspaceId}' not found`, 404);
    }
    const binding = this.store.findRepositoryBindingByWorkspaceId(workspaceId);
    if (!binding) {
      throw new ManualRecoveryBootstrapError("INVALID_BINDING", `Workspace '${workspaceId}' has no repository binding`, 404);
    }
    const bootstrap = this.store.findWorkspaceBootstrapByWorkspaceId(workspaceId);
    if (!bootstrap) {
      throw new ManualRecoveryBootstrapError("INVALID_BINDING", `Workspace '${workspaceId}' has no bootstrap record`, 404);
    }

    return {
      workspace,
      binding,
      bootstrap,
      status: deriveProductProvisioningStatus(bootstrap.state),
    };
  }

  async bootstrapWorkspace(workspaceId: string): Promise<WorkspaceProvisioningResult> {
    // 1. Single-pod in-memory guard
    if (this.activeBootstraps.has(workspaceId)) {
      const existing = await this.getProvisioningStatus(workspaceId);
      return existing;
    }
    this.activeBootstraps.add(workspaceId);

    try {
      // 2. Check if already READY (idempotent reconciliation)
      const existing = await this.getProvisioningStatus(workspaceId);
      if (existing.bootstrap.state === "READY") {
        return existing;
      }

      const { workspace, binding } = existing;

      // 3. Begin attempt first (increments attempt_count, transitions state -> APPLYING, sets opaque attemptId)
      const { attemptId } = this.store.beginWorkspaceBootstrapAttempt(workspaceId);

      let finalBootstrap: WorkspaceBootstrapRecord;
      try {
        // Pre-flight verification of control plane durable records inside try/catch with attempt CAS
        const ownerMembership = this.store.getOwnerMembershipForWorkspace(workspaceId);
        if (!ownerMembership) {
          throw new ManualRecoveryBootstrapError("INVALID_BINDING", `Workspace '${workspaceId}' has no owner membership`, 400);
        }
        if (!this.store.isUserActive(ownerMembership.user_id)) {
          throw new ManualRecoveryBootstrapError("INVALID_BINDING", "Workspace owner user is disabled", 403);
        }
        const instRow = this.store.findGitHubInstallationByRowId(binding.github_installation_row_id);
        if (!instRow) {
          throw new ManualRecoveryBootstrapError("INSTALLATION_UNAVAILABLE", "Installation row not found in control-plane", 404);
        }
        const instUser = this.store.findGitHubInstallationUser(instRow.id, ownerMembership.user_id);
        if (!instUser) {
          throw new ManualRecoveryBootstrapError("INSTALLATION_UNAVAILABLE", "User is not associated with installation", 403);
        }

        finalBootstrap = await this.executeBootstrapAttempt(
          workspaceId,
          attemptId,
          binding,
          instRow.github_installation_id,
        );
      } catch (err) {
        if (err instanceof WorkspaceBootstrapError) {
          if (err.kind === "manual") {
            finalBootstrap = this.store.markWorkspaceBootstrapManualRecovery(workspaceId, attemptId, {
              code: err.code,
              message: err.message,
            });
          } else {
            finalBootstrap = this.store.markWorkspaceBootstrapRetryableFailure(workspaceId, attemptId, {
              code: err.code,
              message: err.message,
            });
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          finalBootstrap = this.store.markWorkspaceBootstrapRetryableFailure(workspaceId, attemptId, {
            code: "NETWORK_ERROR",
            message: msg,
          });
        }
      }

      return {
        workspace,
        binding,
        bootstrap: finalBootstrap,
        status: deriveProductProvisioningStatus(finalBootstrap.state),
      };
    } finally {
      this.activeBootstraps.delete(workspaceId);
    }
  }

  private async executeBootstrapAttempt(
    workspaceId: string,
    attemptId: string,
    binding: GitHubRepositoryBindingRecord,
    githubInstallationId: string,
  ): Promise<WorkspaceBootstrapRecord> {
    // 1. Live installation capability check: Contents: write
    let instDetails;
    try {
      instDetails = await this.appClient.getInstallation(githubInstallationId);
    } catch (err) {
      const status = (err as any)?.status;
      if (status === 404 || status === 401 || status === 403) {
        throw new ManualRecoveryBootstrapError("INSTALLATION_UNAVAILABLE", `GitHub installation unavailable (HTTP ${status})`, 403);
      }
      if (status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", err instanceof Error ? err.message : String(err), 503);
    }

    if (instDetails.suspended_at) {
      throw new ManualRecoveryBootstrapError("INSTALLATION_UNAVAILABLE", "GitHub App installation is suspended", 403);
    }
    if (instDetails.permissions?.contents !== "write") {
      throw new ManualRecoveryBootstrapError(
        "CONTENTS_WRITE_REQUIRED",
        "GitHub App requires Contents: write permission",
        403,
      );
    }

    // 2. Mint or reuse installation access token
    let token: string;
    try {
      token = await this.appClient.getInstallationToken(githubInstallationId);
    } catch (err) {
      const status = (err as any)?.status;
      if (status === 404 || status === 401 || status === 403) {
        throw new ManualRecoveryBootstrapError("INSTALLATION_UNAVAILABLE", `Failed to obtain installation token (HTTP ${status})`, 403);
      }
      if (status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${status}`, 502);
      }
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", err instanceof Error ? err.message : String(err), 500);
    }

    // 3. Live repository check with strict validation
    const repoRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(binding.owner_login)}/${encodeURIComponent(binding.repository_name)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!repoRes.ok) {
      throw classifyGitHubResponseError(repoRes, "repository preflight check");
    }

    const repoData = await repoRes.json();
    const liveRepoMeta = validateLiveRepositoryMetadata(repoData, binding);

    const liveOwner = liveRepoMeta.owner.login;
    const liveRepoName = liveRepoMeta.name;
    const branch = binding.branch;

    // 4. Resolve branch ref / live head
    const refRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(liveOwner)}/${encodeURIComponent(liveRepoName)}/git/ref/heads/${encodeURIComponent(branch)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (refRes.status === 404) {
      // Bound branch ref not found: inspect whether repo is genuinely empty vs missing branch in populated repo
      return this.handleMissingBoundBranch(
        workspaceId,
        attemptId,
        liveOwner,
        liveRepoName,
        branch,
        token,
        binding,
        liveRepoMeta,
      );
    }

    if (!refRes.ok) {
      throw classifyGitHubResponseError(refRes, "branch ref resolution");
    }

    const refData = (await refRes.json()) as { object?: { sha?: string } };
    const headCommitSha = refData.object?.sha;
    if (!headCommitSha) {
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", "Branch ref did not return commit SHA", 500);
    }

    // 5. Reconcile from existing branch head
    return this.reconcileFromBranchHead(
      workspaceId,
      attemptId,
      liveOwner,
      liveRepoName,
      branch,
      headCommitSha,
      headCommitSha,
      token,
      binding,
    );
  }

  private async handleMissingBoundBranch(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    token: string,
    binding: GitHubRepositoryBindingRecord,
    repoMeta: SafeRepositoryMetadata,
  ): Promise<WorkspaceBootstrapRecord> {
    const branchesRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    let branchesList: Array<{ name: string }> = [];
    if (branchesRes.status === 409) {
      // GitHub standard empty repo signal: 409 Conflict "Git Repository is empty"
      branchesList = [];
    } else if (!branchesRes.ok) {
      throw classifyGitHubResponseError(branchesRes, "branches inspection");
    } else {
      const parsed = await branchesRes.json();
      if (!Array.isArray(parsed)) {
        throw new ManualRecoveryBootstrapError(
          "MALFORMED_REPOSITORY_PAYLOAD",
          "Branches listing payload is not an array",
          400,
        );
      }
      branchesList = parsed;
    }

    // Case 1: Race - bound branch was created concurrently
    if (branchesList.some((b) => b.name === branch)) {
      throw new RetryableBootstrapError("STALE_REMOTE", `Bound branch '${branch}' was created concurrently`, 409);
    }

    // Case 2: Populated repo with other branches, but bound branch is missing
    if (branchesList.length > 0) {
      throw new ManualRecoveryBootstrapError(
        "BRANCH_UNAVAILABLE",
        `Bound branch '${branch}' does not exist in populated repository`,
        400,
      );
    }

    // Case 3: Ambiguous - no branches listed, but repository reports non-zero size
    if (typeof repoMeta.size === "number" && repoMeta.size > 0) {
      throw new ManualRecoveryBootstrapError(
        "BRANCH_UNAVAILABLE",
        `Repository reports non-zero size (${repoMeta.size} KB) but has no active branches`,
        400,
      );
    }

    // Repo is confirmed eligible for empty-repository initialization
    return this.bootstrapEmptyRepository(
      workspaceId,
      attemptId,
      owner,
      repo,
      branch,
      token,
      binding,
    );
  }

  private async bootstrapEmptyRepository(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    token: string,
    binding: GitHubRepositoryBindingRecord,
  ): Promise<WorkspaceBootstrapRecord> {
    const firstAnchor = BOOTSTRAP_MANIFEST_V1.find((a) => a.path === "README.md") ?? BOOTSTRAP_MANIFEST_V1[0];

    const contentsRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(firstAnchor.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          message: "chore: initialize CEO workspace",
          content: Buffer.from(firstAnchor.content, "utf-8").toString("base64"),
          branch,
        }),
      },
    );

    if (!contentsRes.ok) {
      if (contentsRes.status === 409 || contentsRes.status === 422) {
        throw new RetryableBootstrapError(
          "STALE_REMOTE",
          "Repository initialized or branch created concurrently during contents initialization",
          409,
        );
      }
      throw classifyGitHubResponseError(contentsRes, "empty repository contents initialization");
    }

    const contentsData = (await contentsRes.json()) as { commit?: { sha?: string } };
    const initialCommitSha = contentsData.commit?.sha ?? null;

    // Re-enter normal reconciliation from live branch head/tree to add any remaining missing anchors
    // baseCommitSha is null because this workspace started from an empty repository
    return this.reconcileFromBranchHead(
      workspaceId,
      attemptId,
      owner,
      repo,
      branch,
      initialCommitSha,
      null,
      token,
      binding,
    );
  }

  private async reconcileFromBranchHead(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    initialHeadSha: string | null,
    baseCommitSha: string | null,
    token: string,
    binding: GitHubRepositoryBindingRecord,
  ): Promise<WorkspaceBootstrapRecord> {
    let headCommitSha = initialHeadSha;
    if (!headCommitSha) {
      const refRes = await this.fetchFn(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "CEO-Server",
          },
        },
      );
      if (!refRes.ok) {
        throw classifyGitHubResponseError(refRes, "branch ref read during reconciliation");
      }
      const refData = (await refRes.json()) as { object?: { sha?: string } };
      headCommitSha = refData.object?.sha ?? null;
      if (!headCommitSha) {
        throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", "Branch ref did not return commit SHA", 500);
      }
    }

    // Read head commit to get root tree SHA
    const commitRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(headCommitSha)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!commitRes.ok) {
      throw classifyGitHubResponseError(commitRes, "head commit read during reconciliation");
    }

    const commitData = (await commitRes.json()) as { tree?: { sha?: string } };
    const currentTreeSha = commitData.tree?.sha;
    if (!currentTreeSha) {
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", "Commit did not return tree SHA", 500);
    }

    // Read tree contents to detect anchors and conflicting objects
    const treeRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(currentTreeSha)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!treeRes.ok) {
      throw classifyGitHubResponseError(treeRes, "head tree read during reconciliation");
    }

    const treeData = (await treeRes.json()) as {
      tree?: Array<{ path: string; mode: string; type: string; sha: string }>;
    };
    const treeItems = treeData.tree ?? [];

    const existingMap = new Map<string, { path: string; mode: string; type: string; sha: string }>();
    for (const item of treeItems) {
      existingMap.set(item.path, item);
    }

    const missingAnchors: Array<(typeof BOOTSTRAP_MANIFEST_V1)[number]> = [];

    for (const anchor of BOOTSTRAP_MANIFEST_V1) {
      const existing = existingMap.get(anchor.path);
      if (!existing) {
        missingAnchors.push(anchor);
        continue;
      }

      // Check if existing object is a regular blob
      const isRegularBlob =
        existing.type === "blob" && (existing.mode === "100644" || existing.mode === "100755");
      if (!isRegularBlob) {
        throw new ManualRecoveryBootstrapError(
          "BRANCH_CONFLICT_OBJECT",
          `Required manifest path '${anchor.path}' conflicts with existing non-regular object (type: ${existing.type}, mode: ${existing.mode})`,
          409,
        );
      }
      // If regular blob is present, preserve it and treat anchor as satisfied
    }

    // Idempotency: If all canonical anchors are present as regular files, verify and mark ready
    if (missingAnchors.length === 0) {
      return this.verifyLiveStateAndMarkReady(
        workspaceId,
        attemptId,
        owner,
        repo,
        branch,
        baseCommitSha,
        token,
        binding,
      );
    }

    // Additive mutation: create tree with base_tree = currentTreeSha and only missing file entries
    const createTreeRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          base_tree: currentTreeSha,
          tree: missingAnchors.map((m) => ({
            path: m.path,
            mode: "100644",
            type: "blob",
            content: m.content,
          })),
        }),
      },
    );

    if (!createTreeRes.ok) {
      if (createTreeRes.status === 409 || createTreeRes.status === 422) {
        throw new RetryableBootstrapError("STALE_REMOTE", "Git tree creation conflict", 409);
      }
      throw classifyGitHubResponseError(createTreeRes, "Git tree creation");
    }

    const createdTree = (await createTreeRes.json()) as { sha: string };

    // Create commit with parent = headCommitSha
    const createCommitRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          message: "chore: bootstrap CEO workspace canonical anchors",
          tree: createdTree.sha,
          parents: [headCommitSha],
        }),
      },
    );

    if (!createCommitRes.ok) {
      if (createCommitRes.status === 409 || createCommitRes.status === 422) {
        throw new RetryableBootstrapError("STALE_REMOTE", "Git commit creation conflict", 409);
      }
      throw classifyGitHubResponseError(createCommitRes, "Git commit creation");
    }

    const createdCommit = (await createCommitRes.json()) as { sha: string };

    // Update branch ref with force = false
    const updateRefRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          sha: createdCommit.sha,
          force: false,
        }),
      },
    );

    if (!updateRefRes.ok) {
      if (updateRefRes.status === 409 || updateRefRes.status === 422) {
        throw new RetryableBootstrapError("STALE_REMOTE", "Remote branch moved concurrently during bootstrap", 409);
      }
      throw classifyGitHubResponseError(updateRefRes, "Git ref update");
    }

    // Post-write live verification
    return this.verifyLiveStateAndMarkReady(
      workspaceId,
      attemptId,
      owner,
      repo,
      branch,
      baseCommitSha,
      token,
      binding,
    );
  }

  private async verifyLiveStateAndMarkReady(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    baseCommitSha: string | null,
    token: string,
    binding: GitHubRepositoryBindingRecord,
  ): Promise<WorkspaceBootstrapRecord> {
    // 1. Re-fetch and strictly validate live repository metadata (fail closed if identity/access changed)
    const repoRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!repoRes.ok) {
      throw classifyGitHubResponseError(repoRes, "post-write repository verification");
    }

    const repoData = await repoRes.json();
    validateLiveRepositoryMetadata(repoData, binding);

    // 2. Re-fetch branch ref
    const refRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!refRes.ok) {
      throw classifyGitHubResponseError(refRes, "post-write branch ref verification");
    }

    const refData = (await refRes.json()) as { object?: { sha?: string } };
    const verifiedHeadSha = refData.object?.sha;
    if (!verifiedHeadSha) {
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        "Verified branch ref did not return commit SHA",
        500,
      );
    }

    // 3. Re-fetch commit
    const commitRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(verifiedHeadSha)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!commitRes.ok) {
      throw classifyGitHubResponseError(commitRes, "post-write commit verification");
    }

    const commitData = (await commitRes.json()) as { tree?: { sha?: string } };
    const treeSha = commitData.tree?.sha;
    if (!treeSha) {
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        "Verified commit did not return tree SHA",
        500,
      );
    }

    // 4. Re-fetch tree and verify anchors
    const treeRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "CEO-Server",
        },
      },
    );

    if (!treeRes.ok) {
      throw classifyGitHubResponseError(treeRes, "post-write tree verification");
    }

    const treeData = (await treeRes.json()) as {
      tree?: Array<{ path: string; mode: string; type: string }>;
    };
    const items = treeData.tree ?? [];
    const itemMap = new Map<string, { path: string; mode: string; type: string }>();
    for (const it of items) {
      itemMap.set(it.path, it);
    }

    for (const anchor of BOOTSTRAP_MANIFEST_V1) {
      const it = itemMap.get(anchor.path);
      if (!it) {
        throw new RetryableBootstrapError(
          "POST_WRITE_VERIFICATION_FAILED",
          `Required anchor path '${anchor.path}' missing from verified tree`,
          500,
        );
      }
      const isRegularBlob = it.type === "blob" && (it.mode === "100644" || it.mode === "100755");
      if (!isRegularBlob) {
        throw new ManualRecoveryBootstrapError(
          "BRANCH_CONFLICT_OBJECT",
          `Required anchor path '${anchor.path}' is not a regular blob in verified tree`,
          409,
        );
      }
    }

    // All verified: record READY state in database
    return this.store.markWorkspaceBootstrapReady(workspaceId, attemptId, {
      readyCommitSha: verifiedHeadSha,
      baseCommitSha,
    });
  }
}
