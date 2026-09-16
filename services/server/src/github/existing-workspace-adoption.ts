import type {
  AdoptExistingWorkspacePreview,
  AdoptExistingWorkspaceRepositoryInput,
  AdoptExistingWorkspaceResult,
  GitHubRepositoryBindingRecord,
  IdentityStore,
  WorkspaceBootstrapRecord,
} from "../identity/store.js";
import { IdentityConflictError, IdentityStructureError } from "../identity/store.js";
import type { GitHubAppClient } from "./app-client.js";
import { GitHubAppError } from "./app-client.js";
import {
  classifyGitHubResponseError,
  validateLiveRepositoryMetadata,
  WorkspaceBootstrapError,
  WorkspaceBootstrapService,
} from "./bootstrap-service.js";

export const ADOPTION_ANCHORS = ["README.md", "SYSTEM.md", "JOURNAL.md"] as const;

export class ExistingWorkspaceAdoptionError extends Error {
  readonly code: string;
  readonly action: "CREATE_ADOPTION" | "ALREADY_ADOPTED" | "CONFLICT";
  readonly exitCode: number;
  constructor(
    code: string,
    message: string,
    action: "CREATE_ADOPTION" | "ALREADY_ADOPTED" | "CONFLICT" = "CONFLICT",
    exitCode = 1,
  ) {
    super(message);
    this.name = "ExistingWorkspaceAdoptionError";
    this.code = code;
    this.action = action;
    this.exitCode = exitCode;
  }
}

export interface ExistingWorkspaceAdoptionCliInput {
  workspaceId: string;
  expectedOwnerUserId: string;
  installationId: string;
  githubRepositoryId: string;
  ownerAccountId: string;
  ownerLogin: string;
  repositoryName: string;
  branch: string;
  expectedExistingRemoteUrl: string;
  apply: boolean;
  expectExistingAnchors: boolean;
  expectNoRepoWrite: boolean;
}

export interface AnchorPreflightResult {
  path: string;
  status: "OK" | "MISSING" | "NON_REGULAR";
  detail: string | null;
  blobSha: string | null;
}

export interface GitSnapshot {
  headSha: string;
  anchors: Array<{ path: string; blobSha: string }>;
}

export interface ExistingWorkspaceAdoptionPlan {
  action: "CREATE_ADOPTION" | "ALREADY_ADOPTED" | "CONFLICT";
  reason: string | null;
  userId: string;
  workspaceId: string;
  remoteUrl: string | null;
  fullName: string;
  githubRepositoryId: string;
  ownerAccountId: string;
  branch: string;
  anchors: AnchorPreflightResult[] | null;
  preview: AdoptExistingWorkspacePreview;
}

export interface ExistingWorkspaceAdoptionApplyResult {
  action: "CREATE_ADOPTION" | "ALREADY_ADOPTED";
  db: AdoptExistingWorkspaceResult;
  bootstrap: WorkspaceBootstrapRecord;
  gitSnapshotBefore: GitSnapshot | null;
  gitSnapshotAfter: GitSnapshot | null;
}

export interface ExistingWorkspaceAdoptionServiceOptions {
  store: IdentityStore;
  appClient: GitHubAppClient;
  bootstrapService: WorkspaceBootstrapService;
  fetchFn?: typeof fetch;
}

export class ExistingWorkspaceAdoptionService {
  private readonly store: IdentityStore;
  private readonly appClient: GitHubAppClient;
  private readonly bootstrapService: WorkspaceBootstrapService;
  private readonly fetchFn: typeof fetch;

  constructor(options: ExistingWorkspaceAdoptionServiceOptions) {
    this.store = options.store;
    this.appClient = options.appClient;
    this.bootstrapService = options.bootstrapService;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  resolveStoreInput(cli: ExistingWorkspaceAdoptionCliInput): AdoptExistingWorkspaceRepositoryInput {
    const installation = this.resolveInstallationRow(cli.installationId);
    return {
      workspaceId: cli.workspaceId,
      expectedOwnerUserId: cli.expectedOwnerUserId,
      githubInstallationRowId: installation.id,
      githubRepositoryId: cli.githubRepositoryId,
      ownerAccountId: cli.ownerAccountId,
      ownerLogin: cli.ownerLogin,
      repositoryName: cli.repositoryName,
      fullName: `${cli.ownerLogin}/${cli.repositoryName}`,
      branch: cli.branch,
      expectedExistingRemoteUrl: cli.expectedExistingRemoteUrl,
    };
  }

  async plan(cli: ExistingWorkspaceAdoptionCliInput): Promise<ExistingWorkspaceAdoptionPlan> {
    const input = this.resolveStoreInput(cli);
    const preview = this.store.previewAdoptExistingWorkspaceRepository(input);
    const live = await this.liveGitHubPreflight(cli, input);

    let anchors: AnchorPreflightResult[] | null = null;
    if (cli.expectExistingAnchors) {
      anchors = live.anchors;
      const failed = anchors.find((a) => a.status !== "OK");
      if (failed) {
        throw new ExistingWorkspaceAdoptionError(
          "EXISTING_ANCHOR_MISSING",
          `Required existing anchor '${failed.path}' is ${failed.status === "MISSING" ? "missing" : "not a regular file"}${failed.detail ? ` (${failed.detail})` : ""}.`,
        );
      }
    }

    return {
      action: preview.action,
      reason: preview.reason,
      userId: cli.expectedOwnerUserId,
      workspaceId: cli.workspaceId,
      remoteUrl: preview.workspace?.remote_url ?? null,
      fullName: `${cli.ownerLogin}/${cli.repositoryName}`,
      githubRepositoryId: cli.githubRepositoryId,
      ownerAccountId: cli.ownerAccountId,
      branch: cli.branch,
      anchors,
      preview,
    };
  }

  async apply(cli: ExistingWorkspaceAdoptionCliInput): Promise<ExistingWorkspaceAdoptionApplyResult> {
    if (!cli.apply) {
      throw new ExistingWorkspaceAdoptionError(
        "APPLY_REQUIRED",
        "Refusing to mutate: pass --apply to perform existing-workspace adoption.",
      );
    }

    const input = this.resolveStoreInput(cli);
    const live = await this.liveGitHubPreflight(cli, input);

    if (cli.expectExistingAnchors) {
      const failed = live.anchors.find((a) => a.status !== "OK");
      if (failed) {
        throw new ExistingWorkspaceAdoptionError(
          "EXISTING_ANCHOR_MISSING",
          `Required existing anchor '${failed.path}' is ${failed.status === "MISSING" ? "missing" : "not a regular file"}${failed.detail ? ` (${failed.detail})` : ""}.`,
        );
      }
    }

    const snapshotBefore = cli.expectNoRepoWrite ? live.snapshot : null;
    if (cli.expectNoRepoWrite) {
      const failed = live.anchors.find((a) => a.status !== "OK");
      if (failed) {
        throw new ExistingWorkspaceAdoptionError(
          "EXISTING_ANCHOR_MISSING",
          `--expect-no-repo-write requires readable regular-file identities for README.md, SYSTEM.md, and JOURNAL.md.`,
        );
      }
    }

    let dbResult: AdoptExistingWorkspaceResult;
    try {
      dbResult = this.store.adoptExistingWorkspaceRepository(input);
    } catch (error) {
      if (error instanceof IdentityStructureError || error instanceof IdentityConflictError) {
        throw new ExistingWorkspaceAdoptionError("ADOPTION_REJECTED", error.message, "CONFLICT");
      }
      throw error;
    }

    if (dbResult.outcome === "ALREADY_ADOPTED") {
      if (dbResult.bootstrap.state === "READY") {
        return {
          action: "ALREADY_ADOPTED",
          db: dbResult,
          bootstrap: dbResult.bootstrap,
          gitSnapshotBefore: snapshotBefore,
          gitSnapshotAfter: snapshotBefore,
        };
      }
      if (dbResult.bootstrap.state === "RETRYABLE_FAILURE" || dbResult.bootstrap.state === "MANUAL_RECOVERY") {
        throw new ExistingWorkspaceAdoptionError(
          dbResult.bootstrap.last_error_code ?? "BOOTSTRAP_FAILED",
          `Workspace is already adopted; bootstrap remains ${dbResult.bootstrap.state} and was not reset.`,
          "ALREADY_ADOPTED",
        );
      }
    }

    const provisioned = await this.bootstrapService.bootstrapWorkspace(cli.workspaceId);
    const bootstrap = provisioned.bootstrap;

    if (bootstrap.state !== "READY") {
      throw new ExistingWorkspaceAdoptionError(
        bootstrap.last_error_code ?? "BOOTSTRAP_FAILED",
        `Bootstrap did not reach READY (state=${bootstrap.state}${bootstrap.last_error_message ? `: ${bootstrap.last_error_message}` : ""}). Workspace, binding, and bootstrap failure state were preserved.`,
        "CONFLICT",
      );
    }

    let snapshotAfter: GitSnapshot | null = null;
    if (cli.expectNoRepoWrite) {
      snapshotAfter = await this.readGitSnapshot(cli, live.token, live.ownerLogin, live.repositoryName);
      if (!snapshotBefore || snapshotAfter.headSha !== snapshotBefore.headSha) {
        throw new ExistingWorkspaceAdoptionError(
          "UNEXPECTED_GIT_WRITE",
          `LifeOS HEAD changed during adoption (before=${snapshotBefore?.headSha ?? "unknown"}, after=${snapshotAfter.headSha}). STOP and investigate; do not force-reset.`,
        );
      }
      for (const before of snapshotBefore.anchors) {
        const after = snapshotAfter.anchors.find((a) => a.path === before.path);
        if (!after || after.blobSha !== before.blobSha) {
          throw new ExistingWorkspaceAdoptionError(
            "UNEXPECTED_GIT_WRITE",
            `Anchor '${before.path}' blob identity changed during adoption. STOP and investigate; do not force-reset.`,
          );
        }
      }
    }

    return {
      action: dbResult.outcome === "ALREADY_ADOPTED" ? "ALREADY_ADOPTED" : "CREATE_ADOPTION",
      db: dbResult,
      bootstrap,
      gitSnapshotBefore: snapshotBefore,
      gitSnapshotAfter: snapshotAfter,
    };
  }

  private resolveInstallationRow(installationId: string): { id: string; github_installation_id: string } {
    const byGithub = this.store.findGitHubInstallationById(installationId);
    if (byGithub) return byGithub;
    const byRow = this.store.findGitHubInstallationByRowId(installationId);
    if (byRow) return byRow;
    throw new ExistingWorkspaceAdoptionError(
      "INSTALLATION_NOT_FOUND",
      `GitHub installation '${installationId}' was not found in the identity database.`,
    );
  }

  private async liveGitHubPreflight(
    cli: ExistingWorkspaceAdoptionCliInput,
    input: AdoptExistingWorkspaceRepositoryInput,
  ): Promise<{
    token: string;
    ownerLogin: string;
    repositoryName: string;
    anchors: AnchorPreflightResult[];
    snapshot: GitSnapshot;
  }> {
    const installation = this.store.findGitHubInstallationByRowId(input.githubInstallationRowId);
    if (!installation) {
      throw new ExistingWorkspaceAdoptionError(
        "INSTALLATION_NOT_FOUND",
        `GitHub installation row '${input.githubInstallationRowId}' was not found.`,
      );
    }

    const assoc = this.store.findGitHubInstallationUser(installation.id, cli.expectedOwnerUserId);
    if (!assoc) {
      throw new ExistingWorkspaceAdoptionError(
        "INSTALLATION_NOT_ASSOCIATED",
        `Expected owner '${cli.expectedOwnerUserId}' is not associated with installation '${installation.github_installation_id}'.`,
      );
    }

    let instDetails: { id: number; permissions?: Record<string, string>; suspended_at?: unknown };
    try {
      instDetails = await this.appClient.getInstallation(installation.github_installation_id);
    } catch (error) {
      throw mapGitHubAppError(error, "installation preflight");
    }
    if (instDetails.suspended_at) {
      throw new ExistingWorkspaceAdoptionError(
        "INSTALLATION_SUSPENDED",
        "GitHub App installation is suspended.",
      );
    }
    if (instDetails.permissions?.contents !== "write") {
      throw new ExistingWorkspaceAdoptionError(
        "CONTENTS_WRITE_REQUIRED",
        "GitHub App installation does not have Contents: write.",
      );
    }

    let token: string;
    try {
      token = await this.appClient.getInstallationToken(installation.github_installation_id);
    } catch (error) {
      throw mapGitHubAppError(error, "installation token");
    }

    const syntheticBinding: GitHubRepositoryBindingRecord = {
      id: "grb_preflight",
      workspace_id: cli.workspaceId,
      github_repository_id: cli.githubRepositoryId,
      github_installation_row_id: installation.id,
      owner_account_id: cli.ownerAccountId,
      owner_login: cli.ownerLogin,
      repository_name: cli.repositoryName,
      full_name: `${cli.ownerLogin}/${cli.repositoryName}`,
      branch: cli.branch,
      created_at_ms: 0,
      updated_at_ms: 0,
    };

    const repoRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(cli.ownerLogin)}/${encodeURIComponent(cli.repositoryName)}`,
      {
        headers: githubHeaders(token),
      },
    );
    if (!repoRes.ok) {
      throw mapGitHubHttp(repoRes, "repository preflight");
    }
    const repoData = await repoRes.json();
    let liveMeta;
    try {
      liveMeta = validateLiveRepositoryMetadata(repoData, syntheticBinding);
    } catch (error) {
      if (error instanceof WorkspaceBootstrapError) {
        throw new ExistingWorkspaceAdoptionError(error.code, error.message);
      }
      throw error;
    }

    if (liveMeta.owner.login !== cli.ownerLogin || liveMeta.name !== cli.repositoryName) {
      throw new ExistingWorkspaceAdoptionError(
        "REPOSITORY_METADATA_MISMATCH",
        `Live repository ${liveMeta.full_name} does not match operator names ${cli.ownerLogin}/${cli.repositoryName}. IDs matched; pass current GitHub names.`,
      );
    }

    const refRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(liveMeta.owner.login)}/${encodeURIComponent(liveMeta.name)}/git/ref/heads/${encodeURIComponent(cli.branch)}`,
      { headers: githubHeaders(token) },
    );
    if (refRes.status === 404) {
      throw new ExistingWorkspaceAdoptionError(
        "BRANCH_UNAVAILABLE",
        `Branch '${cli.branch}' does not exist or is not readable.`,
      );
    }
    if (!refRes.ok) {
      throw mapGitHubHttp(refRes, "branch ref preflight");
    }
    const refData = (await refRes.json()) as { object?: { sha?: string } };
    const headSha = refData.object?.sha;
    if (!headSha) {
      throw new ExistingWorkspaceAdoptionError("BRANCH_UNAVAILABLE", `Branch '${cli.branch}' did not return a commit SHA.`);
    }

    const { anchors, snapshot } = await this.readAnchorsAndSnapshot(
      token,
      liveMeta.owner.login,
      liveMeta.name,
      headSha,
    );

    return {
      token,
      ownerLogin: liveMeta.owner.login,
      repositoryName: liveMeta.name,
      anchors,
      snapshot,
    };
  }

  private async readGitSnapshot(
    cli: ExistingWorkspaceAdoptionCliInput,
    token: string,
    ownerLogin: string,
    repositoryName: string,
  ): Promise<GitSnapshot> {
    const refRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repositoryName)}/git/ref/heads/${encodeURIComponent(cli.branch)}`,
      { headers: githubHeaders(token) },
    );
    if (!refRes.ok) {
      throw mapGitHubHttp(refRes, "post-adoption branch ref");
    }
    const refData = (await refRes.json()) as { object?: { sha?: string } };
    const headSha = refData.object?.sha;
    if (!headSha) {
      throw new ExistingWorkspaceAdoptionError("UNEXPECTED_GIT_WRITE", "Post-adoption branch ref did not return a commit SHA.");
    }
    const { snapshot } = await this.readAnchorsAndSnapshot(token, ownerLogin, repositoryName, headSha);
    return snapshot;
  }

  private async readAnchorsAndSnapshot(
    token: string,
    ownerLogin: string,
    repositoryName: string,
    headSha: string,
  ): Promise<{ anchors: AnchorPreflightResult[]; snapshot: GitSnapshot }> {
    const commitRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repositoryName)}/git/commits/${encodeURIComponent(headSha)}`,
      { headers: githubHeaders(token) },
    );
    if (!commitRes.ok) {
      throw mapGitHubHttp(commitRes, "commit preflight");
    }
    const commitData = (await commitRes.json()) as { tree?: { sha?: string } };
    const treeSha = commitData.tree?.sha;
    if (!treeSha) {
      throw new ExistingWorkspaceAdoptionError("BRANCH_UNAVAILABLE", "Head commit did not return a tree SHA.");
    }

    const treeRes = await this.fetchFn(
      `https://api.github.com/repos/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repositoryName)}/git/trees/${encodeURIComponent(treeSha)}`,
      { headers: githubHeaders(token) },
    );
    if (!treeRes.ok) {
      throw mapGitHubHttp(treeRes, "tree preflight");
    }
    const treeData = (await treeRes.json()) as {
      tree?: Array<{ path: string; mode: string; type: string; sha: string }>;
    };
    const items = new Map((treeData.tree ?? []).map((item) => [item.path, item]));

    const anchors: AnchorPreflightResult[] = ADOPTION_ANCHORS.map((path) => {
      const existing = items.get(path);
      if (!existing) {
        return { path, status: "MISSING", detail: null, blobSha: null };
      }
      const isRegularBlob =
        existing.type === "blob" && (existing.mode === "100644" || existing.mode === "100755");
      if (!isRegularBlob) {
        return {
          path,
          status: "NON_REGULAR",
          detail: `type=${existing.type} mode=${existing.mode}`,
          blobSha: null,
        };
      }
      return { path, status: "OK", detail: null, blobSha: existing.sha };
    });

    return {
      anchors,
      snapshot: {
        headSha,
        anchors: anchors
          .filter((a): a is AnchorPreflightResult & { blobSha: string } => a.status === "OK" && a.blobSha != null)
          .map((a) => ({ path: a.path, blobSha: a.blobSha })),
      },
    };
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "CEO-Server",
  };
}

function mapGitHubAppError(error: unknown, context: string): ExistingWorkspaceAdoptionError {
  const status = error instanceof GitHubAppError ? error.status : (error as { status?: number } | undefined)?.status;
  if (status === 404 || status === 401 || status === 403) {
    return new ExistingWorkspaceAdoptionError(
      "INSTALLATION_UNAVAILABLE",
      `GitHub installation inaccessible during ${context} (HTTP ${status}).`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ExistingWorkspaceAdoptionError("GITHUB_PREFLIGHT_FAILED", `GitHub ${context} failed: ${message}`);
}

function mapGitHubHttp(res: Response, context: string): ExistingWorkspaceAdoptionError {
  const classified = classifyGitHubResponseError(res, context);
  return new ExistingWorkspaceAdoptionError(classified.code, classified.message);
}

export function formatAdoptionPlan(plan: ExistingWorkspaceAdoptionPlan): string {
  const anchorLines =
    plan.anchors == null
      ? ["Existing anchors:", "(not requested)"]
      : [
          "Existing anchors:",
          ...plan.anchors.map((a) => `${a.path}  ${a.status}`),
        ];
  return [
    "Migration target",
    "",
    "User:",
    plan.userId,
    "",
    "Workspace:",
    plan.workspaceId,
    "",
    "Current remote:",
    plan.remoteUrl ?? "(workspace not found)",
    "",
    "Repository:",
    plan.fullName,
    "",
    "Repository ID:",
    plan.githubRepositoryId,
    "",
    "Owner account ID:",
    plan.ownerAccountId,
    "",
    "Branch:",
    plan.branch,
    "",
    ...anchorLines,
    "",
    "Action:",
    plan.action,
    ...(plan.reason ? ["", "Reason:", plan.reason] : []),
    "",
  ].join("\n");
}

export function parseMigrateExistingWorkspaceArgs(argv: string[]): ExistingWorkspaceAdoptionCliInput {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      throw new ExistingWorkspaceAdoptionError("INVALID_ARGS", `Unexpected argument '${token}'.`);
    }
    const name = token.slice(2);
    if (
      name === "apply" ||
      name === "expect-existing-anchors" ||
      name === "expect-no-repo-write"
    ) {
      flags.add(name);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      throw new ExistingWorkspaceAdoptionError("INVALID_ARGS", `Flag --${name} requires a value.`);
    }
    values.set(name, next);
    i++;
  }

  const required = [
    "workspace-id",
    "expected-user-id",
    "installation-id",
    "repo-id",
    "owner-account-id",
    "owner",
    "repo",
    "branch",
    "expected-remote",
  ] as const;
  for (const key of required) {
    if (!values.get(key)?.length) {
      throw new ExistingWorkspaceAdoptionError("INVALID_ARGS", `Missing required flag --${key}.`);
    }
  }

  return {
    workspaceId: values.get("workspace-id")!,
    expectedOwnerUserId: values.get("expected-user-id")!,
    installationId: values.get("installation-id")!,
    githubRepositoryId: values.get("repo-id")!,
    ownerAccountId: values.get("owner-account-id")!,
    ownerLogin: values.get("owner")!,
    repositoryName: values.get("repo")!,
    branch: values.get("branch")!,
    expectedExistingRemoteUrl: values.get("expected-remote")!,
    apply: flags.has("apply"),
    expectExistingAnchors: flags.has("expect-existing-anchors"),
    expectNoRepoWrite: flags.has("expect-no-repo-write"),
  };
}
