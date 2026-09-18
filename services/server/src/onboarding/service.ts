import { OnboardingStore } from "./store.js";
import type { OnboardingFlow, OnboardingState } from "./types.js";
import { OnboardingError } from "./types.js";
import type { IdentityStore, UserGitHubInstallationItem } from "../identity/store.js";
import type { GitHubInstallationService } from "../github/installation-service.js";
import {
  type GitHubRepositoryService,
  GitHubPartialCreationError,
  GitHubWorkspaceProvisioningIncompleteError,
} from "../github/repository-service.js";
import type { WorkspaceBootstrapService, ProductProvisioningStatus } from "../github/bootstrap-service.js";
import type { GitHubAppClient } from "../github/app-client.js";

export interface OnboardingServiceOptions {
  store: OnboardingStore;
  identityStore: IdentityStore;
  installationService: GitHubInstallationService;
  repositoryService: GitHubRepositoryService;
  bootstrapService: WorkspaceBootstrapService;
  appClient: GitHubAppClient;
}

export class OnboardingService {
  private readonly store: OnboardingStore;
  private readonly identityStore: IdentityStore;
  private readonly installationService: GitHubInstallationService;
  private readonly repositoryService: GitHubRepositoryService;
  private readonly bootstrapService: WorkspaceBootstrapService;
  private readonly appClient: GitHubAppClient;

  constructor(options: OnboardingServiceOptions) {
    this.store = options.store;
    this.identityStore = options.identityStore;
    this.installationService = options.installationService;
    this.repositoryService = options.repositoryService;
    this.bootstrapService = options.bootstrapService;
    this.appClient = options.appClient;
  }

  get storeInstance(): OnboardingStore {
    return this.store;
  }

  get bootstrapServiceInstance(): WorkspaceBootstrapService {
    return this.bootstrapService;
  }

  getOrCreateActiveFlow(userId: string, providerSubject: string): OnboardingFlow {
    return this.store.getOrCreateActiveFlowInTx(userId, providerSubject);
  }

  submitRepositoryChoice(flowId: string, userId: string, repositoryName: string): OnboardingFlow {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }

    const trimmed = (repositoryName || "").trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.length > 100) {
      throw new OnboardingError("Invalid repository name: alphanumeric, dash, dot, and underscore up to 100 characters", "INVALID_REPOSITORY_NAME", 400);
    }

    return this.store.updateFlow(flowId, {
      desired_repository_name: trimmed,
      state: "AWAITING_GITHUB_ACCESS",
      last_error_code: null,
      last_error_message: null,
    });
  }

  async resolveInstallationState(
    flowId: string,
    userId: string,
  ): Promise<{ status: "NEED_INSTALL" } | { status: "READY"; installation: UserGitHubInstallationItem }> {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }

    const candidates = this.installationService.listUserInstallations(userId);
    const liveCandidates: UserGitHubInstallationItem[] = [];

    for (const candidate of candidates) {
      try {
        const live = await this.appClient.getInstallation(candidate.github_installation_id);
        // Deep verification: assert live payload matches DB row
        const account = live.account as { id?: unknown; type?: string } | undefined;
        const idMatches = String(live.id) === candidate.github_installation_id;
        const appMatches = String(live.app_id) === candidate.github_app_id;
        const accountIdMatches = String(account?.id) === candidate.account_id;
        const accountTypeMatches = account?.type === candidate.account_type;
        const notSuspended = live.suspended_at == null && candidate.suspended_at_ms == null;

        if (idMatches && appMatches && accountIdMatches && accountTypeMatches && notSuspended) {
          liveCandidates.push(candidate);
        }
      } catch {
        // 404 or other network error: candidate is not live
      }
    }

    if (liveCandidates.length === 0) {
      return { status: "NEED_INSTALL" };
    }

    if (liveCandidates.length > 1) {
      throw new OnboardingError(
        "Multiple live GitHub App installations found; installation selection required",
        "INSTALLATION_SELECTION_REQUIRED",
        400,
      );
    }

    const chosen = liveCandidates[0]!;
    this.store.updateFlow(flowId, {
      installation_row_id: chosen.id,
      last_error_code: null,
      last_error_message: null,
    });

    return { status: "READY", installation: chosen };
  }

  async provisionWorkspace(
    flowId: string,
    session: { sessionId: string; userId: string; providerSubject: string },
    grantId: string,
  ): Promise<{ success: boolean; workspaceId?: string; error?: string }> {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== session.userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }

    // Invariant: once workspace_id is set, NEVER call createRepository again!
    if (flow.workspace_id) {
      throw new OnboardingError("Workspace already created for this onboarding flow", "WORKSPACE_ALREADY_EXISTS", 409);
    }

    // If partial creation happened earlier, recover via import
    if (flow.repository_id) {
      return this.recoverPartialCreation(flowId, session, grantId);
    }

    this.store.updateFlow(flowId, { state: "PROVISIONING" });

    try {
      const repoName = flow.desired_repository_name || "ceo-data";
      const created = await this.repositoryService.createRepository(
        grantId,
        session.sessionId,
        session.userId,
        session.providerSubject,
        { name: repoName },
      );

      this.store.updateFlow(flowId, {
        workspace_id: created.workspace.id,
        repository_id: created.binding.github_repository_id,
        state: "READY_TO_RESUME",
        last_error_code: null,
        last_error_message: null,
      });

      return { success: true, workspaceId: created.workspace.id };
    } catch (error: any) {
      if (error instanceof GitHubWorkspaceProvisioningIncompleteError) {
        // Workspace and Binding were created; bootstrap encountered an issue
        this.store.updateFlow(flowId, {
          workspace_id: error.workspaceId,
          repository_id: error.repository?.id ?? null,
          state: "RECOVERY_REQUIRED",
          last_error_code: "BOOTSTRAP_RETRYABLE",
          last_error_message: error.message,
        });
        return { success: false, workspaceId: error.workspaceId, error: "BOOTSTRAP_RETRYABLE" };
      }

      if (error instanceof GitHubPartialCreationError) {
        // GitHub repo was created, but local Workspace/Binding failed
        this.store.updateFlow(flowId, {
          repository_id: error.repository?.id ?? null,
          state: "RECOVERY_REQUIRED",
          last_error_code: "PARTIAL_REPOSITORY_CREATION",
          last_error_message: error.message,
        });
        return { success: false, error: "PARTIAL_REPOSITORY_CREATION" };
      }

      const msg = error?.message || String(error);
      const isConflict = error?.status === 422 || /already exists/i.test(msg) || /conflict/i.test(msg);
      if (isConflict) {
        this.store.updateFlow(flowId, {
          state: "AWAITING_REPOSITORY_CHOICE",
          last_error_code: "REPOSITORY_NAME_CONFLICT",
          last_error_message: `Repository name '${flow.desired_repository_name}' already exists on GitHub. Please choose another name.`,
        });
        return { success: false, error: "REPOSITORY_NAME_CONFLICT" };
      }

      this.store.updateFlow(flowId, {
        state: "RECOVERY_REQUIRED",
        last_error_code: "PROVISIONING_FAILED",
        last_error_message: msg,
      });
      throw error;
    }
  }

  async recoverPartialCreation(
    flowId: string,
    session: { sessionId: string; userId: string; providerSubject: string },
    grantId: string,
  ): Promise<{ success: boolean; workspaceId?: string }> {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== session.userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }
    if (!flow.repository_id) {
      throw new OnboardingError("No partial repository to recover", "NO_PARTIAL_REPOSITORY", 400);
    }

    const imported = await this.repositoryService.importRepository(
      grantId,
      session.sessionId,
      session.userId,
      session.providerSubject,
      flow.repository_id,
    );

    this.store.updateFlow(flowId, {
      workspace_id: imported.workspace.id,
      state: "READY_TO_RESUME",
      last_error_code: null,
      last_error_message: null,
    });

    return { success: true, workspaceId: imported.workspace.id };
  }

  async retryBootstrap(flowId: string, userId: string): Promise<ProductProvisioningStatus> {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }
    if (!flow.workspace_id) {
      throw new OnboardingError("No workspace to bootstrap", "NO_WORKSPACE", 400);
    }

    const result = await this.bootstrapService.bootstrapWorkspace(flow.workspace_id);
    if (result.status === "READY") {
      this.store.updateFlow(flowId, {
        state: "READY_TO_RESUME",
        last_error_code: null,
        last_error_message: null,
      });
    }
    return result.status;
  }

  async deriveProvisioningStatus(
    flowId: string,
    userId: string,
  ): Promise<{ flow: OnboardingFlow; bootstrapStatus: ProductProvisioningStatus | null }> {
    const flow = this.store.getFlow(flowId);
    if (!flow || flow.user_id !== userId) {
      throw new OnboardingError("Onboarding flow not found", "FLOW_NOT_FOUND", 404);
    }

    if (!flow.workspace_id) {
      return { flow, bootstrapStatus: null };
    }

    const statusObj = await this.bootstrapService.getProvisioningStatus(flow.workspace_id);
    if (statusObj.status === "READY" && flow.state !== "READY_TO_RESUME" && flow.state !== "COMPLETED") {
      const updated = this.store.updateFlow(flowId, {
        state: "READY_TO_RESUME",
        last_error_code: null,
        last_error_message: null,
      });
      return { flow: updated, bootstrapStatus: statusObj.status };
    }

    return { flow, bootstrapStatus: statusObj.status };
  }
}
