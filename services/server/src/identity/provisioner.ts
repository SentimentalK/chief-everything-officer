import {
  type WorkspaceIdentity,
  IdentityStore,
  IdentityConflictError,
  newId,
} from "./store.js";

export interface ExternalIdentityResult {
  userId: string;
  workspaceId: string;
  isNewBinding: boolean;
  provider: string;
  providerSubject: string;
  providerLogin?: string;
}

export interface AccountProvisioner {
  resolveOrBind(provider: string, providerSubject: string, providerLogin?: string): ExternalIdentityResult;
}

/**
 * V0 Singleton Provisioner: binds incoming external identities to the
 * single active CEO user/workspace running in this deployment.
 * Explicitly rejects conflicting re-bindings and enforces idempotency.
 */
export class SingletonAccountProvisioner implements AccountProvisioner {
  private readonly store: IdentityStore;
  private readonly workspaceIdentity: WorkspaceIdentity;

  constructor(store: IdentityStore, workspaceIdentity: WorkspaceIdentity) {
    this.store = store;
    this.workspaceIdentity = workspaceIdentity;
  }

  resolveOrBind(provider: string, providerSubject: string, providerLogin?: string): ExternalIdentityResult {
    // 1. Check if this external subject is already bound
    const existing = this.store.findExternalIdentity(provider, providerSubject);
    if (existing) {
      if (existing.user_id !== this.workspaceIdentity.user_id) {
        throw new IdentityConflictError(
          `External identity ${provider}:${providerSubject} is already bound to user '${existing.user_id}', not '${this.workspaceIdentity.user_id}'.`,
        );
      }
      if (!this.store.isUserActive(existing.user_id)) {
        throw new IdentityConflictError(
          `Bound user '${existing.user_id}' is disabled.`,
        );
      }
      return {
        userId: existing.user_id,
        workspaceId: this.workspaceIdentity.workspace_id,
        isNewBinding: false,
        provider,
        providerSubject,
        providerLogin: providerLogin ?? existing.provider_login ?? undefined,
      };
    }

    // 2. Check if the current user is already bound to a DIFFERENT subject for this provider
    const existingForUser = this.store.findExternalIdentityForUser(provider, this.workspaceIdentity.user_id);
    if (existingForUser && existingForUser.provider_subject !== providerSubject) {
      throw new IdentityConflictError(
        `User '${this.workspaceIdentity.user_id}' is already bound to a different ${provider} account (${existingForUser.provider_subject}).`,
      );
    }

    // 3. Verify user is active and owns workspace
    if (!this.store.isUserActive(this.workspaceIdentity.user_id)) {
      throw new IdentityConflictError(
        `User '${this.workspaceIdentity.user_id}' is disabled; cannot bind external identity.`,
      );
    }
    if (!this.store.isWorkspaceOwnedByUser(this.workspaceIdentity.workspace_id, this.workspaceIdentity.user_id)) {
      throw new IdentityConflictError(
        `Workspace '${this.workspaceIdentity.workspace_id}' is not owned by user '${this.workspaceIdentity.user_id}'.`,
      );
    }

    // 4. Create binding
    const extId = newId("ext");
    this.store.bindExternalIdentity({
      id: extId,
      provider,
      providerSubject,
      userId: this.workspaceIdentity.user_id,
      providerLogin,
    });

    return {
      userId: this.workspaceIdentity.user_id,
      workspaceId: this.workspaceIdentity.workspace_id,
      isNewBinding: true,
      provider,
      providerSubject,
      providerLogin,
    };
  }
}
