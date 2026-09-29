import {
  type AuthIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
} from "./store.js";

/**
 * Runtime identity layer. Encapsulates control-plane database access and
 * per-request workspace authorization. Requests are authenticated by their
 * owning authority (Host/MCP OAuth access token, product user session, or
 * Connector DeviceCredential) and authorized against the request-scoped
 * workspace derived from workspace membership.
 */
export type { AuthIdentity, WorkspaceIdentity };

/**
 * Raised when an authenticated identity cannot access the requested workspace.
 * HTTP maps this to 403.
 */
export class WorkspaceAccessDeniedError extends IdentityError {}
export class WorkspaceSelectionRequiredError extends IdentityError {}
export { IdentityDbUnavailable } from "./store.js";

export class IdentityService {
  private constructor(private readonly store: IdentityStore) {}

  /** The underlying IdentityStore instance. */
  get storeInstance(): IdentityStore {
    return this.store;
  }

  /**
   * Opens an existing identity database and validates its schema.
   * Does not assume or bind any deployment workspace.
   */
  static open(dbPath: string): IdentityService {
    return new IdentityService(IdentityStore.open(dbPath));
  }

  hasWorkspaceAccess(workspaceId: string, userId: string): boolean {
    return this.store.hasWorkspaceAccess(workspaceId, userId);
  }

  /**
   * Resolves the single accessible workspace for an authenticated user.
   * Deterministic rule:
   * - 0 memberships -> throws WorkspaceAccessDeniedError (403)
   * - 1 membership  -> selects and returns the WorkspaceIdentity for that workspace
   * - >1 memberships -> throws WorkspaceSelectionRequiredError (403/409)
   * Does not inspect is_admin, sessions, or GitHub identity.
   */
  resolveUserWorkspace(userId: string): WorkspaceIdentity {
    const memberships = this.store.listWorkspaceMembershipsForUser(userId);
    if (memberships.length === 0) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated user '${userId}' workspace access denied (no accessible workspaces).`,
      );
    }
    if (memberships.length > 1) {
      throw new WorkspaceSelectionRequiredError(
        `Authenticated user '${userId}' has multiple accessible workspaces (${memberships.length}). Workspace selection required.`,
      );
    }
    return {
      user_id: userId,
      workspace_id: memberships[0]!.workspace_id,
    };
  }

  close(): void {
    this.store.close();
  }
}