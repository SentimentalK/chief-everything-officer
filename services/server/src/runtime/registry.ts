import path from "node:path";
import type { IdentityStore, GitHubRepositoryBindingRecord, WorkspaceRecord } from "../identity/store.js";
import type { GitHubAppClient } from "../github/app-client.js";
import { CeoWorkspace } from "../workspace.js";
import { ResourceService, type SharedResourceDependencies } from "../resource/service.js";
import { GitHubAppGitCredentialProvider } from "./credentials.js";
import {
  type WorkspaceRuntime,
  type WorkspaceRuntimeDescriptor,
  type WorkspaceRuntimeConfig,
  type GitCredentialProvider,
  WorkspaceRuntimeResolutionError,
} from "./types.js";

const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]*$/;
const GITHUB_LOGIN_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const GITHUB_REPO_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export interface WorkspaceRuntimeRegistryOptions {
  store: IdentityStore;
  dataRoot: string;
  gitCommitter?: {
    name: string;
    email: string;
  };
  appClient?: GitHubAppClient;
  credentialProviderFactory?: (descriptor: WorkspaceRuntimeDescriptor) => GitCredentialProvider;
  sharedResourceDependencies?: SharedResourceDependencies;
  workspaceFactory?: (config: WorkspaceRuntimeConfig) => CeoWorkspace;
}

export class WorkspaceRuntimeRegistry {
  private readonly runtimes = new Map<string, Promise<WorkspaceRuntime>>();
  private readonly gitCommitter: { name: string; email: string };

  constructor(private readonly options: WorkspaceRuntimeRegistryOptions) {
    if (!options.dataRoot || options.dataRoot.trim().length === 0) {
      throw new Error("dataRoot must be a non-empty string");
    }
    this.gitCommitter = options.gitCommitter ?? {
      name: "CEO State MCP",
      email: "ceo-mcp@users.noreply.github.com",
    };
  }

  async get(workspaceId: string): Promise<WorkspaceRuntime> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new WorkspaceRuntimeResolutionError("WORKSPACE_NOT_FOUND", "workspaceId must be a non-empty string.");
    }

    const trimmedId = workspaceId.trim();
    const existing = this.runtimes.get(trimmedId);
    if (existing) {
      return await existing;
    }

    const initPromise = this.initRuntime(trimmedId);
    this.runtimes.set(trimmedId, initPromise);

    try {
      return await initPromise;
    } catch (error) {
      if (this.runtimes.get(trimmedId) === initPromise) {
        this.runtimes.delete(trimmedId);
      }
      throw error;
    }
  }

  private async initRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
    const { descriptor, binding, workspace: workspaceRecord } = this.resolveRuntimeRecord(workspaceId);

    const workspaceDir = path.join(this.options.dataRoot, "workspaces", workspaceId);
    const repoDir = path.join(workspaceDir, "repo");
    const txnDir = path.join(workspaceDir, "txns");
    const stateDir = path.join(workspaceDir, "state");
    const remoteUrl = `https://github.com/${descriptor.fullName}.git`;

    let credentialProvider: GitCredentialProvider;
    if (this.options.credentialProviderFactory) {
      credentialProvider = this.options.credentialProviderFactory(descriptor);
    } else if (this.options.appClient) {
      credentialProvider = new GitHubAppGitCredentialProvider(
        this.options.appClient,
        descriptor.installationId,
        binding.github_repository_id,
      );
    } else {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_WORKSPACE_STATE",
        "GitHub App is not configured on this server to authenticate workspace repository.",
      );
    }

    const ownerIdentity = this.options.store.findExternalIdentityByUser("github", workspaceRecord.owner_user_id);
    let gitAuthorName = this.gitCommitter.name;
    let gitAuthorEmail = this.gitCommitter.email;
    if (
      ownerIdentity &&
      ownerIdentity.provider_login &&
      ownerIdentity.provider_login.trim().length > 0 &&
      ownerIdentity.provider_email &&
      ownerIdentity.provider_email.trim().length > 0
    ) {
      gitAuthorName = ownerIdentity.provider_login.trim();
      gitAuthorEmail = ownerIdentity.provider_email.trim();
    }

    const runtimeConfig: WorkspaceRuntimeConfig = {
      workspaceId,
      dataRoot: workspaceDir,
      repoDir,
      txnDir,
      stateDir,
      remoteUrl,
      branch: descriptor.branch,
      gitAuthorName,
      gitAuthorEmail,
      gitCommitterName: this.gitCommitter.name,
      gitCommitterEmail: this.gitCommitter.email,
      credentialProvider,
    };

    const workspace = this.options.workspaceFactory
      ? this.options.workspaceFactory(runtimeConfig)
      : new CeoWorkspace(runtimeConfig);

    await workspace.initialize();

    const resourceService = new ResourceService(
      workspace,
      this.options.sharedResourceDependencies ?? {},
    );

    return {
      workspaceId,
      descriptor,
      binding,
      workspace,
      resourceService,
      paths: {
        workspaceDir,
        repoDir,
        txnDir,
        stateDir,
      },
    };
  }

  private resolveRuntimeRecord(workspaceId: string): {
    descriptor: WorkspaceRuntimeDescriptor;
    binding: GitHubRepositoryBindingRecord;
    workspace: WorkspaceRecord;
  } {
    // 1. Workspace
    const workspace = this.options.store.findWorkspaceById(workspaceId);
    if (!workspace) {
      throw new WorkspaceRuntimeResolutionError(
        "WORKSPACE_NOT_FOUND",
        `Workspace '${workspaceId}' does not exist in control plane.`,
      );
    }

    // 2. Repository Binding
    const binding = this.options.store.findRepositoryBindingByWorkspaceId(workspaceId);
    if (!binding) {
      throw new WorkspaceRuntimeResolutionError(
        "REPOSITORY_BINDING_NOT_FOUND",
        `No GitHub repository binding found for workspace '${workspaceId}'.`,
      );
    }

    // 3. Workspace Bootstrap
    const bootstrap = this.options.store.findWorkspaceBootstrapByWorkspaceId(workspaceId);
    if (!bootstrap) {
      throw new WorkspaceRuntimeResolutionError(
        "BOOTSTRAP_NOT_FOUND",
        `No bootstrap record found for workspace '${workspaceId}'.`,
      );
    }
    if (bootstrap.state !== "READY") {
      throw new WorkspaceRuntimeResolutionError(
        "BOOTSTRAP_NOT_READY",
        `Workspace '${workspaceId}' bootstrap is in state '${bootstrap.state}', expected 'READY'.`,
      );
    }

    // 4. GitHub Installation
    const installation = this.options.store.findGitHubInstallationByRowId(binding.github_installation_row_id);
    if (!installation) {
      throw new WorkspaceRuntimeResolutionError(
        "INSTALLATION_NOT_FOUND",
        `GitHub installation row '${binding.github_installation_row_id}' for workspace '${workspaceId}' does not exist.`,
      );
    }
    if (installation.suspended_at_ms != null) {
      throw new WorkspaceRuntimeResolutionError(
        "INSTALLATION_SUSPENDED",
        `GitHub installation '${installation.github_installation_id}' for workspace '${workspaceId}' is suspended.`,
      );
    }

    // 5. Validate IDs
    if (!POSITIVE_DECIMAL_REGEX.test(binding.github_repository_id)) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Invalid github_repository_id '${binding.github_repository_id}'; expected positive decimal string.`,
      );
    }
    if (!POSITIVE_DECIMAL_REGEX.test(installation.github_installation_id)) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Invalid github_installation_id '${installation.github_installation_id}'; expected positive decimal string.`,
      );
    }

    // 6. Validate Owner, Repo, and Full Name
    const ownerLogin = binding.owner_login.trim();
    const repositoryName = binding.repository_name.trim();
    const fullName = binding.full_name.trim();

    if (!GITHUB_LOGIN_REGEX.test(ownerLogin)) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Invalid repository owner_login '${binding.owner_login}'.`,
      );
    }
    if (!GITHUB_REPO_NAME_REGEX.test(repositoryName) || repositoryName === "." || repositoryName === "..") {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Invalid repository_name '${binding.repository_name}'.`,
      );
    }

    // Strict fullName validation: exactly owner/repo, no scheme, query, fragment, backslash
    const expectedFullName = `${ownerLogin}/${repositoryName}`;
    if (fullName !== expectedFullName) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Repository full_name '${fullName}' does not match expected '${expectedFullName}'.`,
      );
    }
    if (
      fullName.includes("\\") ||
      fullName.includes("?") ||
      fullName.includes("#") ||
      fullName.includes("://")
    ) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Repository full_name '${fullName}' contains illegal characters or path traversal.`,
      );
    }

    // 7. Validate Branch
    const branch = binding.branch.trim();
    if (branch.length === 0 || branch.includes("\0") || branch.includes("\r") || branch.includes("\n")) {
      throw new WorkspaceRuntimeResolutionError(
        "INVALID_REPOSITORY_DATA",
        `Invalid repository branch '${binding.branch}'; must be non-empty without control characters.`,
      );
    }

    // 8. Repository Access Scope Restriction
    if (binding.access_scope_verified_at_ms == null) {
      throw new WorkspaceRuntimeResolutionError(
        "REPOSITORY_SCOPE_NOT_VERIFIED",
        `Workspace '${workspaceId}' repository access restriction has not been verified.`,
      );
    }

    return {
      descriptor: {
        workspaceId,
        repositoryId: binding.github_repository_id,
        installationId: installation.github_installation_id,
        ownerLogin,
        repositoryName,
        fullName,
        branch,
      },
      binding,
      workspace,
    };
  }
}
