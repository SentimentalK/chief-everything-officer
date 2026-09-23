import crypto from "node:crypto";
import express, { type Request, type Response, type Router, type RequestHandler } from "express";
import type { ConnectorControlStore } from "./control-store.js";
import {
  DeviceEnrollmentStore,
  normalizeDeviceUserCode,
  DEVICE_CREDENTIAL_TTL_MS,
  DeviceEnrollmentCapacityError,
  DeviceEnrollmentValidationError,
} from "./enrollment-store.js";
import { createDeviceAuthMiddleware } from "./device-auth.js";
import type { IdentityStore } from "../identity/store.js";
import type { UserSessionManager } from "../auth/user-session.js";

export interface ConnectorRouterOptions {
  controlStore: ConnectorControlStore;
  enrollmentStore: DeviceEnrollmentStore;
  identityStore: IdentityStore;
  sessionManager: UserSessionManager;
  publicOrigin: string;
  hostGuard?: RequestHandler;
  originGuard?: RequestHandler;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - CEO Connector</title>
  <style>
    :root {
      color-scheme: dark;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0a0a0a;
      color: #ededed;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
      box-sizing: border-box;
    }
    .card {
      background: #141414;
      border: 1px solid #262626;
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      padding: 2rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    .header h1 {
      margin: 0 0 0.5rem;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .header p {
      margin: 0 0 1.5rem;
      color: #a1a1a1;
      font-size: 0.875rem;
    }
    .device-box {
      background: #1a1a1a;
      border: 1px solid #333333;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }
    .device-name {
      font-weight: 600;
      font-size: 1rem;
      margin-bottom: 0.25rem;
    }
    .device-meta {
      color: #888888;
      font-size: 0.8rem;
    }
    .info-box {
      background: #1e1e1e;
      border-left: 3px solid #3b82f6;
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      color: #cccccc;
      margin-bottom: 1.5rem;
      line-height: 1.4;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
    }
    button {
      flex: 1;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s ease;
    }
    .btn-approve {
      background-color: #ededed;
      color: #000000;
    }
    .btn-approve:hover { background-color: #ffffff; }
    .btn-deny {
      background-color: #262626;
      color: #ededed;
      border: 1px solid #404040;
    }
    .btn-deny:hover { background-color: #333333; }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .status-success { background: #064e3b; color: #34d399; }
    .status-error { background: #7f1d1d; color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    ${bodyContent}
  </div>
</body>
</html>`;
}

export function createConnectorRouter(options: ConnectorRouterOptions): Router {
  const { controlStore, enrollmentStore, identityStore, sessionManager, publicOrigin, hostGuard, originGuard } = options;
  if (!publicOrigin || typeof publicOrigin !== "string" || publicOrigin.trim().length === 0) {
    throw new Error("ConnectorRouter requires an authoritative non-empty publicOrigin.");
  }
  const router = express.Router();
  if (hostGuard) {
    router.use(hostGuard);
  }
  if (originGuard) {
    router.use(originGuard);
  }

  const baseUrl = publicOrigin.trim().replace(/\/+$/, "");

  // ---------------------------------------------------------------------------
  // 1. Native API: Begin Enrollment
  // ---------------------------------------------------------------------------
  router.post(
    "/api/connector/enrollments",
    express.json({ limit: "16kb" }),
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");

      const body = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "invalid_request", message: "Request body must be an object." });
        return;
      }

      try {
        const { displayName, platform, credentialSecretDigest } = {
          displayName: String(body.display_name || ""),
          platform: String(body.platform || ""),
          credentialSecretDigest: String(body.credential_secret_sha256 || ""),
        };

        const { enrollment, deviceCode, userCode } = enrollmentStore.createEnrollment({
          displayName,
          platform,
          credentialSecretDigest,
        });

        const verificationUri = `${baseUrl}/connector/enroll`;
        const verificationUriComplete = `${baseUrl}/connector/enroll?user_code=${encodeURIComponent(userCode)}`;

        res.status(200).json({
          device_code: deviceCode,
          user_code: userCode,
          device_id: enrollment.reserved_device_id,
          credential_id: enrollment.reserved_credential_id,
          verification_uri: verificationUri,
          verification_uri_complete: verificationUriComplete,
          expires_in: Math.floor((enrollment.expires_at_ms - enrollment.created_at_ms) / 1000),
          interval: 2,
        });
      } catch (err) {
        if (err instanceof DeviceEnrollmentCapacityError) {
          res.status(503).json({ error: "enrollment_capacity_exceeded", message: err.message });
          return;
        }
        if (err instanceof DeviceEnrollmentValidationError) {
          res.status(400).json({ error: "invalid_request", message: err.message });
          return;
        }
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 2. Native API: Poll Enrollment Token
  // ---------------------------------------------------------------------------
  router.post(
    "/api/connector/enrollments/token",
    express.json({ limit: "16kb" }),
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");

      const body = req.body;
      if (!body || typeof body !== "object" || typeof body.device_code !== "string" || body.device_code.length === 0) {
        res.status(400).json({ error: "invalid_request", message: "device_code is required." });
        return;
      }

      const deviceCode = body.device_code.trim();
      const digest = crypto.createHash("sha256").update(deviceCode, "utf8").digest("hex");

      const enrollment = enrollmentStore.lookupByDeviceCodeDigest(digest);
      if (!enrollment) {
        res.status(400).json({ error: "enrollment_not_found" });
        return;
      }

      if (Date.now() > enrollment.expires_at_ms) {
        res.status(400).json({ error: "expired_token" });
        return;
      }

      const pollRes = enrollmentStore.checkAndRecordPoll(enrollment.enrollment_id);
      if (pollRes.slowDown) {
        res.status(400).json({ error: "slow_down" });
        return;
      }

      if (enrollment.state === "pending") {
        res.status(400).json({ error: "authorization_pending" });
        return;
      }

      if (enrollment.state === "denied") {
        res.status(400).json({ error: "access_denied" });
        return;
      }

      if (enrollment.state === "approved") {
        try {
          const issuedAtMs = Date.now();
          const expiresAtMs = issuedAtMs + DEVICE_CREDENTIAL_TTL_MS;
          const finalRes = controlStore.finalizeDeviceEnrollment({
            deviceId: enrollment.reserved_device_id,
            credentialId: enrollment.reserved_credential_id,
            userId: enrollment.approved_user_id!,
            displayName: enrollment.display_name,
            platform: enrollment.platform,
            secretDigest: enrollment.credential_secret_digest,
            issuedAtMs,
            expiresAtMs,
          });

          enrollmentStore.markConsumed(enrollment.enrollment_id);

          res.status(200).json({
            device: {
              id: finalRes.device.id,
              display_name: finalRes.device.display_name,
              platform: finalRes.device.platform,
            },
            credential: {
              id: finalRes.credential.id,
              expires_at_ms: finalRes.credential.expires_at_ms,
            },
            replayed: finalRes.replayed,
          });
          return;
        } catch {
          res.status(500).json({ error: "internal_error" });
          return;
        }
      }

      if (enrollment.state === "consumed") {
        const device = controlStore.getDevice(enrollment.reserved_device_id);
        const credential = controlStore.getDeviceCredential(enrollment.reserved_credential_id);

        if (!device || !credential) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }

        res.status(200).json({
          device: {
            id: device.id,
            display_name: device.display_name,
            platform: device.platform,
          },
          credential: {
            id: credential.id,
            expires_at_ms: credential.expires_at_ms,
          },
          replayed: true,
        });
        return;
      }

      res.status(400).json({ error: "invalid_grant" });
    },
  );

  // ---------------------------------------------------------------------------
  // 3. Native API: Device Identity Verification (Device-Auth)
  // ---------------------------------------------------------------------------
  router.get(
    "/api/connector/identity",
    createDeviceAuthMiddleware(controlStore, identityStore),
    (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const auth = res.locals.deviceIdentity!;

      const device = controlStore.getDevice(auth.device_id);
      const credential = controlStore.getDeviceCredential(auth.credential_id);

      if (!device || !credential) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      res.status(200).json({
        user_id: auth.user_id,
        device: {
          id: device.id,
          display_name: device.display_name,
          platform: device.platform,
        },
        credential: {
          id: credential.id,
          expires_at_ms: credential.expires_at_ms,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // 4. Native API: Self Revoke (Device-Auth)
  // ---------------------------------------------------------------------------
  router.post(
    "/api/connector/device/revoke",
    createDeviceAuthMiddleware(controlStore, identityStore),
    (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const auth = res.locals.deviceIdentity!;

      controlStore.revokeDevice(auth.device_id);
      res.status(200).json({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // 5. Browser UI: Enrollment Approval Page
  // ---------------------------------------------------------------------------
  router.get("/connector/enroll", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    const rawCode = req.query.user_code;
    if (!rawCode || typeof rawCode !== "string") {
      res.status(400).send(renderHtml("Error", `
        <div class="header">
          <h1>Missing User Code</h1>
          <p>Please provide a valid enrollment user_code parameter.</p>
        </div>
      `));
      return;
    }

    let userCode: string;
    try {
      userCode = normalizeDeviceUserCode(rawCode);
    } catch {
      res.status(400).send(renderHtml("Invalid Code", `
        <div class="header">
          <h1>Invalid User Code</h1>
          <p>The code provided is not in the correct format.</p>
        </div>
      `));
      return;
    }

    const session = sessionManager.getSession(req);
    if (!session || !identityStore.isUserActive(session.userId)) {
      res.redirect(302, `/auth/github?connector_enrollment=${encodeURIComponent(userCode)}`);
      return;
    }

    const enrollment = enrollmentStore.findByUserCode(userCode);
    if (!enrollment) {
      res.status(404).send(renderHtml("Enrollment Not Found", `
        <div class="header">
          <h1>Enrollment Expired or Not Found</h1>
          <p>This enrollment session has expired or does not exist. Please run <code>ceo-connector login</code> again.</p>
        </div>
      `));
      return;
    }

    if (enrollment.state === "denied") {
      res.status(200).send(renderHtml("Authorization Denied", `
        <div class="header">
          <span class="status-badge status-error">DENIED</span>
          <h1>Authorization Request Cancelled</h1>
          <p>This device authorization request was cancelled.</p>
        </div>
      `));
      return;
    }

    if (enrollment.state === "approved" || enrollment.state === "consumed") {
      if (enrollment.approved_user_id === session.userId) {
        res.status(200).send(renderHtml("Device Authorized", `
          <div class="header">
            <span class="status-badge status-success">AUTHORIZED</span>
            <h1>Device Already Authorized</h1>
            <p>You have already approved this device. You may return to your terminal.</p>
          </div>
        `));
        return;
      }
      res.status(403).send(renderHtml("Conflict", `
        <div class="header">
          <h1>Authorization Conflict</h1>
          <p>This device enrollment was claimed by another account.</p>
        </div>
      `));
      return;
    }

    // Pending: generate consent nonce
    const consentNonce = crypto.randomBytes(32).toString("base64url");
    const nonceDigest = crypto.createHash("sha256").update(consentNonce, "utf8").digest("hex");
    enrollmentStore.setConsentNonce(enrollment.enrollment_id, nonceDigest);

    const html = renderHtml("Authorize Device", `
      <div class="header">
        <h1>Authorize this device?</h1>
        <p>A local machine is requesting permission to connect to your account.</p>
      </div>

      <div class="device-box">
        <div class="device-name">${escapeHtml(enrollment.display_name)}</div>
        <div class="device-meta">Platform: ${escapeHtml(enrollment.platform)}</div>
      </div>

      <div class="info-box">
        This device will be able to run CEO tasks for execution targets you explicitly register.
      </div>

      <form method="POST" action="/connector/enroll/decision">
        <input type="hidden" name="user_code" value="${escapeHtml(enrollment.user_code)}" />
        <input type="hidden" name="consent_nonce" value="${escapeHtml(consentNonce)}" />
        <div class="actions">
          <button type="submit" name="decision" value="deny" class="btn-deny">Cancel</button>
          <button type="submit" name="decision" value="approve" class="btn-approve">Authorize Device</button>
        </div>
      </form>
    `);

    res.status(200).send(html);
  });

  // ---------------------------------------------------------------------------
  // 6. Browser UI: Decision Submission
  // ---------------------------------------------------------------------------
  router.post(
    "/connector/enroll/decision",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      const session = sessionManager.getSession(req);
      if (!session || !identityStore.isUserActive(session.userId)) {
        res.status(401).send(renderHtml("Unauthorized", `
          <div class="header">
            <h1>Session Expired</h1>
            <p>Please log in again to authorize devices.</p>
          </div>
        `));
        return;
      }

      const body = req.body || {};
      const rawUserCode = body.user_code;
      const consentNonce = body.consent_nonce;
      const decision = body.decision;

      if (!rawUserCode || typeof rawUserCode !== "string" || !consentNonce || typeof consentNonce !== "string") {
        res.status(400).send(renderHtml("Error", `
          <div class="header">
            <h1>Invalid Submission</h1>
            <p>Missing user_code or consent_nonce.</p>
          </div>
        `));
        return;
      }

      let userCode: string;
      try {
        userCode = normalizeDeviceUserCode(rawUserCode);
      } catch {
        res.status(400).send(renderHtml("Error", "<p>Invalid user code format.</p>"));
        return;
      }

      const enrollment = enrollmentStore.findByUserCode(userCode);
      if (!enrollment) {
        res.status(404).send(renderHtml("Expired", `
          <div class="header">
            <h1>Enrollment Expired</h1>
            <p>This request has expired or does not exist.</p>
          </div>
        `));
        return;
      }

      if (enrollment.state !== "pending") {
        if (enrollment.state === "approved" && enrollment.approved_user_id === session.userId) {
          res.status(200).send(renderHtml("Device Authorized", `
            <div class="header">
              <span class="status-badge status-success">AUTHORIZED</span>
              <h1>Device Already Authorized</h1>
              <p>You can return to your terminal.</p>
            </div>
          `));
          return;
        }
        res.status(400).send(renderHtml("Error", "<p>Enrollment is no longer pending.</p>"));
        return;
      }

      // Verify consent nonce constant-time
      if (!enrollment.consent_nonce_digest) {
        res.status(400).send(renderHtml("Error", "<p>Missing consent nonce challenge.</p>"));
        return;
      }

      const suppliedDigest = crypto.createHash("sha256").update(consentNonce, "utf8").digest();
      const storedDigest = Buffer.from(enrollment.consent_nonce_digest, "hex");

      if (suppliedDigest.length !== storedDigest.length || !crypto.timingSafeEqual(suppliedDigest, storedDigest)) {
        res.status(400).send(renderHtml("Security Warning", "<p>Consent nonce verification failed. Please try again.</p>"));
        return;
      }

      if (decision !== "approve" && decision !== "deny") {
        res.status(400).send(renderHtml("Invalid Decision", "<p>Invalid decision parameter; must be &#39;approve&#39; or &#39;deny&#39;.</p>"));
        return;
      }

      if (decision === "approve") {
        enrollmentStore.approve(enrollment.enrollment_id, session.userId);

        res.status(200).send(renderHtml("Device Authorized", `
          <div class="header">
            <span class="status-badge status-success">AUTHORIZED</span>
            <h1>Device Authorized</h1>
            <p>Device <strong>${escapeHtml(enrollment.display_name)}</strong> has been authorized.</p>
            <p>You can now close this browser tab and return to your terminal.</p>
          </div>
        `));
      } else {
        enrollmentStore.deny(enrollment.enrollment_id);

        res.status(200).send(renderHtml("Authorization Denied", `
          <div class="header">
            <span class="status-badge status-error">CANCELLED</span>
            <h1>Authorization Denied</h1>
            <p>The authorization request was cancelled.</p>
          </div>
        `));
      }
    },
  );

  return router;
}
