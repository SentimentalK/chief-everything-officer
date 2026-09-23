import express, { type Request, type Response, type Router } from "express";
import type { IdentityStore } from "../identity/store.js";
import type { UserSessionManager } from "./user-session.js";
import type { ConnectorControlStore } from "../connector/control-store.js";

export interface UserRouterOptions {
  store: IdentityStore;
  sessionManager: UserSessionManager;
  controlStore?: ConnectorControlStore;
}

export function createUserRouter(options: UserRouterOptions): Router {
  const { store, sessionManager, controlStore } = options;
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

  // GET /api/user/devices
  router.get("/devices", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!store.isUserActive(session.userId)) {
      sessionManager.destroySession(session.sessionId);
      sessionManager.clearCookie(res);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!controlStore) {
      res.status(503).json({ error: "connector_not_configured" });
      return;
    }

    const devices = controlStore.listDevicesForUser(session.userId, { includeRevoked: true });
    res.status(200).json({
      devices: devices.map((d) => ({
        id: d.id,
        display_name: d.display_name,
        platform: d.platform,
        created_at_ms: d.created_at_ms,
        revoked_at_ms: d.revoked_at_ms,
      })),
    });
  });

  // POST /api/user/devices/:device_id/revoke
  router.post("/devices/:device_id/revoke", (req: Request, res: Response) => {
    const session = sessionManager.getSession(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!store.isUserActive(session.userId)) {
      sessionManager.destroySession(session.sessionId);
      sessionManager.clearCookie(res);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!controlStore) {
      res.status(503).json({ error: "connector_not_configured" });
      return;
    }

    const deviceId = req.params.device_id;
    if (!deviceId || typeof deviceId !== "string") {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    const device = controlStore.getDevice(deviceId);
    if (!device || device.user_id !== session.userId) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    controlStore.revokeDevice(deviceId);
    res.status(200).json({ ok: true });
  });

  return router;
}
