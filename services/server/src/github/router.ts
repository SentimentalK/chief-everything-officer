import express, { type Request, type Response, type Router } from "express";
import type { IdentityStore } from "../identity/store.js";
import type { UserSessionManager } from "../auth/user-session.js";
import {
  GitHubInstallationService,
  GitHubInstallationError,
  GitHubIdentityMismatchError,
  GitHubInstallationNotFoundError,
} from "./installation-service.js";

export interface GitHubAppAuthRouterOptions {
  installationService: GitHubInstallationService;
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
