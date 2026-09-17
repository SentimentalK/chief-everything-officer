import type { GitHubRepositoryBindingRecord } from "../identity/store.js";
import type { CeoWorkspace } from "../workspace.js";
import type { ResourceService } from "../resource/service.js";
import type { GitExecutionConfig, WorkspaceConfig } from "../git.js";

export interface WorkspaceRuntimeDescriptor {
  workspaceId: string;
  repositoryId: string;
  installationId: string;
  ownerLogin: string;
  repositoryName: string;
  fullName: string;
  branch: string;
}

export interface WorkspaceRuntimeConfig extends WorkspaceConfig {
  workspaceId: string;
}

export interface WorkspaceRuntime {
  workspaceId: string;
  descriptor: WorkspaceRuntimeDescriptor;
  binding: GitHubRepositoryBindingRecord;
  workspace: CeoWorkspace;
  resourceService: ResourceService;
  paths: {
    workspaceDir: string;
    repoDir: string;
    txnDir: string;
    stateDir: string;
  };
}

export interface GitCredential {
  username: string;
  token: string;
}

export interface GitCredentialProvider {
  getCredential(): Promise<GitCredential>;
}

export class WorkspaceRuntimeResolutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceRuntimeResolutionError";
    this.code = code;
  }
}
