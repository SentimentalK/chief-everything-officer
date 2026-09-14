import express, { type Request, type Response, type Router } from "express";
import type { IdentityStore } from "../identity/store.js";
import type { UserSessionManager } from "./user-session.js";

export interface UserRouterOptions {
  store: IdentityStore;
  sessionManager: UserSessionManager;
}

export function createUserRouter(options: UserRouterOptions): Router {
  const { store, sessionManager } = options;
  const router = express.Router();
  router.use(express.json());

  // GET /api/user/session
  router.get("/session", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session) {
      res.status(200).json({ authenticated: false });
      return;
    }

    // Verify user is still active in DB
    if (!store.isUserActive(session.userId)) {
      sessionManager.destroySession(session.sessionId);
      sessionManager.clearCookie(res);
      res.status(200).json({ authenticated: false });
      return;
    }

    res.status(200).json({
      authenticated: true,
      user: {
        id: session.userId,
        provider: session.provider,
        provider_login: session.providerLogin ?? null,
      },
    });
  });

  // POST /api/user/session/logout
  router.post("/session/logout", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (session) {
      sessionManager.destroySession(session.sessionId);
    }
    sessionManager.clearCookie(res);
    res.status(200).json({ ok: true });
  });

  return router;
}
