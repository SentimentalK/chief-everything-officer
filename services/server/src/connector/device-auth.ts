import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ConnectorControlStore } from "./control-store.js";
import { IdentityDbUnavailable, type IdentityStore } from "../identity/store.js";

export const DEVICE_CREDENTIAL_PREFIX = "ceo_dev1.";
export const CREDENTIAL_ID_RE = /^dcr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DeviceAuthIdentity {
  user_id: string;
  device_id: string;
  credential_id: string;
}

declare global {
  namespace Express {
    interface Locals {
      deviceIdentity?: DeviceAuthIdentity;
    }
  }
}

export function parseDeviceBearerToken(raw: string): { credentialId: string; secret: string } | null {
  if (!raw.startsWith(DEVICE_CREDENTIAL_PREFIX)) {
    return null;
  }
  const rest = raw.slice(DEVICE_CREDENTIAL_PREFIX.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const credentialId = rest.slice(0, dotIndex);
  const secret = rest.slice(dotIndex + 1);

  if (!CREDENTIAL_ID_RE.test(credentialId) || secret.length === 0) {
    return null;
  }

  return { credentialId, secret };
}

export function createDeviceAuthMiddleware(
  controlStore: ConnectorControlStore,
  identityStore: IdentityStore,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1]) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const parsed = parseDeviceBearerToken(match[1].trim());
    if (!parsed) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const now = Date.now();
      const credential = controlStore.getDeviceCredential(parsed.credentialId);
      if (!credential || credential.revoked_at_ms !== null || credential.expires_at_ms <= now) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const device = controlStore.getDevice(credential.device_id);
      if (!device || device.revoked_at_ms !== null) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      if (!identityStore.isUserActive(device.user_id)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const computedDigest = crypto.createHash("sha256").update(parsed.secret, "utf8").digest();
      const storedDigest = Buffer.from(credential.secret_digest, "hex");

      if (
        computedDigest.length !== storedDigest.length ||
        !crypto.timingSafeEqual(computedDigest, storedDigest)
      ) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      res.locals.deviceIdentity = {
        user_id: device.user_id,
        device_id: device.id,
        credential_id: credential.id,
      };

      next();
    } catch (error) {
      if (error instanceof IdentityDbUnavailable) {
        res.status(503).json({ error: "identity_unavailable" });
        return;
      }
      res.status(401).json({ error: "unauthorized" });
    }
  };
}
