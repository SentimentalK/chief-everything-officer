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

      // 3. Pre-flight verification of control plane durable records
      const { workspace, binding } = existing;
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

      // 4. Begin attempt (increments attempt_count, transitions state -> APPLYING, sets opaque attemptId)
      const { attemptId } = this.store.beginWorkspaceBootstrapAttempt(workspaceId);

      let finalBootstrap: WorkspaceBootstrapRecord;
      try {
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
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", err instanceof Error ? err.message : String(err), 500);
    }

    // 3. Live repository check
    const owner = binding.owner_login;
    const repo = binding.repository_name;
    const branch = binding.branch;

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
      if (repoRes.status === 404 || repoRes.status === 401 || repoRes.status === 403) {
        throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", `Repository not accessible (HTTP ${repoRes.status})`, 404);
      }
      if (repoRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (repoRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${repoRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `HTTP ${repoRes.status}`, 500);
    }

    const repoData = (await repoRes.json()) as Record<string, unknown>;
    if (String(repoData.id) !== binding.github_repository_id) {
      throw new ManualRecoveryBootstrapError(
        "REPOSITORY_IDENTITY_MISMATCH",
        `Repository ID mismatch: expected ${binding.github_repository_id}, got ${repoData.id}`,
        400,
      );
    }
    if (!repoData.private) {
      throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", "Bound repository is not private", 400);
    }
    if (repoData.archived || repoData.disabled) {
      throw new ManualRecoveryBootstrapError("REPOSITORY_UNAVAILABLE", "Bound repository is archived or disabled", 400);
    }

    // 4. Resolve branch ref / live head
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

    if (refRes.status === 404) {
      // Empty repository or branch ref does not exist yet: create root tree, initial commit, and create ref
      return this.bootstrapEmptyRepository(workspaceId, attemptId, owner, repo, branch, token);
    }

    if (!refRes.ok) {
      if (refRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (refRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${refRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to resolve branch ref HTTP ${refRes.status}`, 500);
    }

    const refData = (await refRes.json()) as { object: { sha: string } };
    const headCommitSha = refData.object?.sha;
    if (!headCommitSha) {
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", "Branch ref did not return commit SHA", 500);
    }

    // 5. Read head commit to get root tree SHA
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
      if (commitRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (commitRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${commitRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to read commit HTTP ${commitRes.status}`, 500);
    }

    const commitData = (await commitRes.json()) as { tree: { sha: string } };
    const currentTreeSha = commitData.tree?.sha;
    if (!currentTreeSha) {
      throw new RetryableBootstrapError("TEMPORARY_GITHUB_ERROR", "Commit did not return tree SHA", 500);
    }

    // 6. Read tree contents to detect anchors and conflicting objects
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
      if (treeRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (treeRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${treeRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to read tree HTTP ${treeRes.status}`, 500);
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

    // 7. Idempotency: If all 3 canonical anchors are present as regular files, make no commit!
    if (missingAnchors.length === 0) {
      return this.store.markWorkspaceBootstrapReady(workspaceId, attemptId, {
        readyCommitSha: headCommitSha,
        baseCommitSha: headCommitSha,
      });
    }

    // 8. Additive mutation: create tree with base_tree = currentTreeSha and only missing file entries
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
      if (createTreeRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (createTreeRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${createTreeRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to create Git tree HTTP ${createTreeRes.status}`, 500);
    }

    const createdTree = (await createTreeRes.json()) as { sha: string };

    // 9. Create commit with parent = headCommitSha
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
      if (createCommitRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (createCommitRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${createCommitRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to create Git commit HTTP ${createCommitRes.status}`, 500);
    }

    const createdCommit = (await createCommitRes.json()) as { sha: string };

    // 10. Update branch ref with force = false
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
      if (updateRefRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (updateRefRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${updateRefRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to update ref HTTP ${updateRefRes.status}`, 500);
    }

    // 11. Post-write live verification
    return this.verifyLiveStateAndMarkReady(workspaceId, attemptId, owner, repo, branch, headCommitSha, token);
  }

  private async bootstrapEmptyRepository(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    token: string,
  ): Promise<WorkspaceBootstrapRecord> {
    // 1. Create root tree containing all 3 canonical manifest files
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
          tree: BOOTSTRAP_MANIFEST_V1.map((m) => ({
            path: m.path,
            mode: "100644",
            type: "blob",
            content: m.content,
          })),
        }),
      },
    );

    if (!createTreeRes.ok) {
      if (createTreeRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (createTreeRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${createTreeRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to create root Git tree HTTP ${createTreeRes.status}`, 500);
    }

    const createdTree = (await createTreeRes.json()) as { sha: string };

    // 2. Create root commit (parents: [])
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
          message: "chore: initialize CEO workspace",
          tree: createdTree.sha,
          parents: [],
        }),
      },
    );

    if (!createCommitRes.ok) {
      if (createCommitRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (createCommitRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${createCommitRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to create root Git commit HTTP ${createCommitRes.status}`, 500);
    }

    const createdCommit = (await createCommitRes.json()) as { sha: string };

    // 3. Create refs/heads/<branch>
    const createRefRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "CEO-Server",
        },
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: createdCommit.sha,
        }),
      },
    );

    if (!createRefRes.ok) {
      if (createRefRes.status === 422 || createRefRes.status === 409) {
        throw new RetryableBootstrapError("STALE_REMOTE", "Branch ref created concurrently in empty repository", 409);
      }
      if (createRefRes.status === 429) {
        throw new RetryableBootstrapError("GITHUB_RATE_LIMITED", "GitHub rate limit exceeded", 429);
      }
      if (createRefRes.status >= 500) {
        throw new RetryableBootstrapError("GITHUB_5XX", `GitHub server error HTTP ${createRefRes.status}`, 502);
      }
      throw new RetryableBootstrapError("NETWORK_ERROR", `Failed to create branch ref HTTP ${createRefRes.status}`, 500);
    }

    // 4. Post-write live verification
    return this.verifyLiveStateAndMarkReady(workspaceId, attemptId, owner, repo, branch, null, token);
  }

  private async verifyLiveStateAndMarkReady(
    workspaceId: string,
    attemptId: string,
    owner: string,
    repo: string,
    branch: string,
    baseCommitSha: string | null,
    token: string,
  ): Promise<WorkspaceBootstrapRecord> {
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
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        `Failed to re-fetch branch ref during verification HTTP ${refRes.status}`,
        500,
      );
    }

    const refData = (await refRes.json()) as { object: { sha: string } };
    const verifiedHeadSha = refData.object?.sha;
    if (!verifiedHeadSha) {
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        "Verified branch ref did not return commit SHA",
        500,
      );
    }

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
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        `Failed to read verified commit HTTP ${commitRes.status}`,
        500,
      );
    }

    const commitData = (await commitRes.json()) as { tree: { sha: string } };
    const treeSha = commitData.tree?.sha;
    if (!treeSha) {
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        "Verified commit did not return tree SHA",
        500,
      );
    }

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
      throw new RetryableBootstrapError(
        "POST_WRITE_VERIFICATION_FAILED",
        `Failed to read verified tree HTTP ${treeRes.status}`,
        500,
      );
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
