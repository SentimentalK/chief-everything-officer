import {
  type AuthIdentity,
  type CredentialIdentity,
  type WorkspaceIdentity,
  IdentityStore,
  IdentityError,
  sha256Hex,
} from "./store.js";

/**
 * Runtime identity layer. Encapsulates control-plane database access and
 * per-request credential checks. Each request keeps its own credential source
 * (digest for Bearer, id+user for cookies) while authorizing against
 * request-scoped workspaces.
 */
export type { AuthIdentity, CredentialIdentity, WorkspaceIdentity };

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

  /**
   * Authenticates a raw bearer token. Returns CredentialIdentity, or null when
   * the credential is unknown/revoked or the user is disabled.
   * Does NOT guess or attach any workspace.
   */
  authenticateApiKey(rawToken: string): CredentialIdentity | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return this.store.authenticateCredentialByDigest(sha256Hex(rawToken));
  }

  /**
   * Resolves the request-scoped workspace AuthIdentity for an authenticated credential.
   * Deterministic rule:
   * - 0 memberships -> throws WorkspaceAccessDeniedError (403)
   * - 1 membership  -> selects and returns AuthIdentity for that workspace
   * - >1 memberships -> throws WorkspaceSelectionRequiredError (403/409)
   */
  resolveRequestIdentity(credential: CredentialIdentity): AuthIdentity {
    const memberships = this.store.listWorkspaceMembershipsForUser(credential.user_id);
    if (memberships.length === 0) {
      throw new WorkspaceAccessDeniedError(
        `Authenticated user '${credential.user_id}' workspace access denied (no accessible workspaces).`,
      );
    }
    if (memberships.length > 1) {
      throw new WorkspaceSelectionRequiredError(
        `Authenticated user '${credential.user_id}' has multiple accessible workspaces (${memberships.length}). Workspace selection required.`,
      );
    }
    return {
      user_id: credential.user_id,
      api_key_id: credential.api_key_id,
      workspace_id: memberships[0]!.workspace_id,
    };
  }

  hasWorkspaceAccess(workspaceId: string, userId: string): boolean {
    return this.store.hasWorkspaceAccess(workspaceId, userId);
  }

  /**
   * Resolves the single accessible workspace for a user without an API-key credential.
   * 0 memberships -> WorkspaceAccessDeniedError
   * 1 membership  -> WorkspaceIdentity
   * >1 memberships -> WorkspaceSelectionRequiredError
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
