import express, { type Request, type Response, type Router } from "express";
import { type IdentityStore, IdentityConflictError } from "../identity/store.js";
import type { UserSessionManager } from "../auth/user-session.js";
import {
  GitHubInstallationService,
  GitHubInstallationError,
  GitHubIdentityMismatchError,
  GitHubInstallationNotFoundError,
} from "./installation-service.js";
import {
  type GitHubRepositoryService,
  GitHubRepositoryError,
  GitHubAppPermissionUpgradeRequiredError,
  GitHubPartialCreationError,
} from "./repository-service.js";
import {
  type WorkspaceBootstrapService,
  WorkspaceBootstrapError,
} from "./bootstrap-service.js";

export interface GitHubAppAuthRouterOptions {
  installationService: GitHubInstallationService;
  repositoryService?: GitHubRepositoryService;
  sessionManager: UserSessionManager;
  store: IdentityStore;
}

export function createGitHubAppAuthRouter(options: GitHubAppAuthRouterOptions): Router {
  const { installationService, sessionManager, store } = options;
  const router = express.Router();

  // GET /auth/github-app/install
  router.get("/install", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      res.redirect(302, "/login?error=unauthenticated");
      return;
    }

    if (session.provider !== "github" || !session.providerSubject) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(403).json({ error: "github_identity_required" });
        return;
      }
      res.redirect(302, "/login?error=github_identity_required");
      return;
    }

    const redirectUrl = installationService.createInstallRedirect(
      session.userId,
      session.providerSubject,
    );
    res.redirect(302, redirectUrl);
  });

  // GET /auth/github-app/setup
  router.get("/setup", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      res.redirect(302, "/login?error=unauthenticated");
      return;
    }

    const state = typeof req.query.state === "string" ? req.query.state : null;
    const installationId =
      typeof req.query.installation_id === "string"
        ? req.query.installation_id
        : null;

    if (!state || !installationId) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(400).json({ error: "missing_state_or_installation_id" });
        return;
      }
      res.redirect(302, "/settings/installations?error=missing_state_or_installation_id");
      return;
    }

    try {
      const authUrl = installationService.startSetupOAuth({
        state,
        installationId,
        userId: session.userId,
      });
      res.redirect(302, authUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = error instanceof GitHubInstallationError ? error.status : 400;
      if (req.headers.accept?.includes("application/json")) {
        res.status(status).json({ error: msg });
        return;
      }
      res.redirect(302, `/settings/installations?error=${encodeURIComponent(msg)}`);
    }
  });

  // GET /auth/github-app/callback
  router.get("/callback", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      res.redirect(302, "/login?error=unauthenticated");
      return;
    }

    if (session.provider !== "github" || !session.providerSubject) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(403).json({ error: "github_identity_required" });
        return;
      }
      res.redirect(302, "/login?error=github_identity_required");
      return;
    }

    if (req.query.error) {
      const errorMsg = String(req.query.error_description || req.query.error);
      if (req.headers.accept?.includes("application/json")) {
        res.status(400).json({ error: errorMsg });
        return;
      }
      res.redirect(302, `/settings/installations?error=${encodeURIComponent(errorMsg)}`);
      return;
    }

    const state = typeof req.query.state === "string" ? req.query.state : null;
    const code = typeof req.query.code === "string" ? req.query.code : null;

    if (!state || !code) {
      if (req.headers.accept?.includes("application/json")) {
        res.status(400).json({ error: "missing_code_or_state" });
        return;
      }
      res.redirect(302, "/settings/installations?error=missing_code_or_state");
      return;
    }

    try {
      await installationService.handleOAuthCallback({
        state,
        code,
        currentUserId: session.userId,
        currentProviderSubject: session.providerSubject,
      });
      if (req.headers.accept?.includes("application/json")) {
        res.status(200).json({ success: true });
        return;
      }
      res.redirect(302, "/settings/installations?installed=true");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof GitHubIdentityMismatchError ||
        error instanceof GitHubInstallationNotFoundError
          ? 403
          : error instanceof GitHubInstallationError
          ? error.status
          : 500;

      if (req.headers.accept?.includes("application/json")) {
        res.status(status).json({ error: msg });
        return;
      }
      res.redirect(302, `/settings/installations?error=${encodeURIComponent(msg)}`);
    }
  });

  // GET /auth/github-app/repository/callback
  if (options.repositoryService) {
    const repoService = options.repositoryService;
    router.get("/repository/callback", async (req: Request, res: Response) => {
      const session = sessionManager.getSession(req);
      if (!session || !store.isUserActive(session.userId)) {
        if (req.headers.accept?.includes("application/json")) {
          res.status(401).json({ error: "unauthenticated" });
          return;
        }
        res.redirect(302, "/login?error=unauthenticated");
        return;
      }

      if (session.provider !== "github" || !session.providerSubject) {
        if (req.headers.accept?.includes("application/json")) {
          res.status(403).json({ error: "github_identity_required" });
          return;
        }
        res.redirect(302, "/login?error=github_identity_required");
        return;
      }

      if (req.query.error) {
        const errorMsg = String(req.query.error_description || req.query.error);
        if (req.headers.accept?.includes("application/json")) {
          res.status(400).json({ error: errorMsg });
          return;
        }
        res.redirect(302, `/settings/workspaces/new?error=${encodeURIComponent(errorMsg)}`);
        return;
      }

      const state = typeof req.query.state === "string" ? req.query.state : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;

      if (!state || !code) {
        if (req.headers.accept?.includes("application/json")) {
          res.status(400).json({ error: "missing_code_or_state" });
          return;
        }
        res.redirect(302, "/settings/workspaces/new?error=missing_code_or_state");
        return;
      }

      try {
        const result = await repoService.handleOAuthCallback({
          state,
          code,
          currentSessionId: session.sessionId,
          currentUserId: session.userId,
          currentProviderSubject: session.providerSubject,
        });
        if (req.headers.accept?.includes("application/json")) {
          res.status(200).json(result);
          return;
        }
        res.redirect(302, `/settings/workspaces/new?grant=${encodeURIComponent(result.grant)}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const status = error instanceof GitHubRepositoryError ? error.status : 500;
        if (req.headers.accept?.includes("application/json")) {
          res.status(status).json({ error: msg });
          return;
        }
        res.redirect(302, `/settings/workspaces/new?error=${encodeURIComponent(msg)}`);
      }
    });
  }

  return router;
}

export interface GitHubInstallationsApiRouterOptions {
  installationService: GitHubInstallationService;
  sessionManager: UserSessionManager;
  store: IdentityStore;
}

export function createGitHubInstallationsApiRouter(
  options: GitHubInstallationsApiRouterOptions,
): Router {
  const { installationService, sessionManager, store } = options;
  const router = express.Router();

  // GET /api/github/installations
  router.get("/", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const installations = installationService.listUserInstallations(session.userId);
    res.status(200).json({ installations });
  });

  return router;
}

export interface GitHubRepositoryAuthorizationsRouterOptions {
  repositoryService: GitHubRepositoryService;
  sessionManager: UserSessionManager;
  store: IdentityStore;
}

export function createGitHubRepositoryAuthorizationsRouter(
  options: GitHubRepositoryAuthorizationsRouterOptions,
): Router {
  const { repositoryService, sessionManager, store } = options;
  const router = express.Router();

  // Support JSON and urlencoded body if mounted independently
  router.use(express.json());
  router.use(express.urlencoded({ extended: false }));

  // POST /api/github/repository-authorizations
  router.post("/", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (session.provider !== "github" || !session.providerSubject) {
      res.status(403).json({ error: "github_identity_required" });
      return;
    }

    const installationId =
      typeof req.body?.installation_id === "string"
        ? req.body.installation_id
        : typeof req.body?.installationId === "string"
        ? req.body.installationId
        : typeof req.query?.installation_id === "string"
        ? req.query.installation_id
        : typeof req.query?.installationId === "string"
        ? req.query.installationId
        : null;

    if (!installationId) {
      res.status(400).json({ error: "missing_installation_id" });
      return;
    }

    try {
      const { authorizationUrl, state } = repositoryService.createAuthorizationRedirect({
        sessionId: session.sessionId,
        userId: session.userId,
        providerSubject: session.providerSubject,
        installationId,
      });

      if (req.headers.accept?.includes("application/json") || req.is("application/json")) {
        res.status(200).json({ authorization_url: authorizationUrl, state });
        return;
      }
      res.redirect(302, authorizationUrl);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = error instanceof GitHubRepositoryError ? error.status : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/github/repository-authorizations/:grant/repositories
  router.get("/:grant/repositories", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (session.provider !== "github" || !session.providerSubject) {
      res.status(403).json({ error: "github_identity_required" });
      return;
    }

    const grant = typeof req.params.grant === "string" ? req.params.grant : "";
    if (!grant) {
      res.status(400).json({ error: "missing_grant" });
      return;
    }

    try {
      const result = await repositoryService.listRepositories(
        grant,
        session.sessionId,
        session.userId,
        session.providerSubject,
      );
      res.status(200).json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = error instanceof GitHubRepositoryError ? error.status : 500;
      res.status(status).json({ error: msg });
    }
  });

  // POST /api/github/repository-authorizations/:grant/workspace
  router.post("/:grant/workspace", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (session.provider !== "github" || !session.providerSubject) {
      res.status(403).json({ error: "github_identity_required" });
      return;
    }

    const grant = typeof req.params.grant === "string" ? req.params.grant : "";
    if (!grant) {
      res.status(400).json({ error: "missing_grant" });
      return;
    }

    const mode = req.body?.mode;

    try {
      if (mode === "import") {
        const repositoryId =
          typeof req.body?.repository_id === "string"
            ? req.body.repository_id
            : typeof req.body?.repositoryId === "string"
            ? req.body.repositoryId
            : null;

        if (!repositoryId) {
          res.status(400).json({ error: "missing_repository_id" });
          return;
        }

        const result = await repositoryService.importRepository(
          grant,
          session.sessionId,
          session.userId,
          session.providerSubject,
          repositoryId,
        );
        res.status(201).json(result);
        return;
      }

      if (mode === "create") {
        const name = typeof req.body?.name === "string" ? req.body.name : null;
        if (!name) {
          res.status(400).json({ error: "missing_name" });
          return;
        }
        const description =
          typeof req.body?.description === "string" ? req.body.description : undefined;

        const result = await repositoryService.createRepository(
          grant,
          session.sessionId,
          session.userId,
          session.providerSubject,
          { name, description },
        );
        res.status(201).json(result);
        return;
      }

      res.status(400).json({ error: "invalid_mode", message: "mode must be 'import' or 'create'" });
    } catch (error) {
      if (error instanceof GitHubPartialCreationError) {
        res.status(500).json({
          error: "PARTIAL_REPOSITORY_CREATION_FAILURE",
          message: error.message,
          ...(error.repository ? { repository: error.repository } : {}),
        });
        return;
      }

      if (error instanceof GitHubAppPermissionUpgradeRequiredError) {
        res.status(403).json({
          error: "GITHUB_APP_PERMISSION_UPGRADE_REQUIRED",
          message: error.message,
        });
        return;
      }

      if (error instanceof IdentityConflictError) {
        res.status(409).json({
          error: "conflict",
          message: error.message,
        });
        return;
      }

      const msg = error instanceof Error ? error.message : String(error);
      const status = error instanceof GitHubRepositoryError ? error.status : 500;
      res.status(status).json({ error: msg });
    }
  });

  return router;
}

export interface WorkspaceProvisioningRouterOptions {
  bootstrapService: WorkspaceBootstrapService;
  sessionManager: UserSessionManager;
  store: IdentityStore;
}

export function createWorkspaceProvisioningRouter(
  options: WorkspaceProvisioningRouterOptions,
): Router {
  const { bootstrapService, sessionManager, store } = options;
  const router = express.Router();

  // GET /api/workspaces/:workspace_id/provisioning
  router.get("/:workspace_id/provisioning", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const rawWorkspaceId = req.params.workspace_id ?? req.params.workspaceId;
    const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
    if (!workspaceId) {
      res.status(400).json({ error: "missing_workspace_id" });
      return;
    }

    const workspace = store.findWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace_not_found", message: `Workspace '${workspaceId}' not found` });
      return;
    }

    if (!store.hasWorkspaceAccess(workspaceId, session.userId)) {
      res.status(403).json({ error: "forbidden", message: "User is not the owner of this workspace" });
      return;
    }

    try {
      const result = await bootstrapService.getProvisioningStatus(workspaceId);
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WorkspaceBootstrapError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/workspaces/:workspace_id/bootstrap/retry
  router.post("/:workspace_id/bootstrap/retry", async (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session || !store.isUserActive(session.userId)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const rawWorkspaceId = req.params.workspace_id ?? req.params.workspaceId;
    const workspaceId = typeof rawWorkspaceId === "string" ? rawWorkspaceId.trim() : "";
    if (!workspaceId) {
      res.status(400).json({ error: "missing_workspace_id" });
      return;
    }

    const workspace = store.findWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace_not_found", message: `Workspace '${workspaceId}' not found` });
      return;
    }

    if (!store.hasWorkspaceAccess(workspaceId, session.userId)) {
      res.status(403).json({ error: "forbidden", message: "User is not the owner of this workspace" });
      return;
    }

    try {
      const result = await bootstrapService.bootstrapWorkspace(workspaceId);
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WorkspaceBootstrapError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
