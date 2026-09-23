import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import express, { type Request, type Response } from "express";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { DeviceEnrollmentStore } from "../src/connector/enrollment-store.js";
import { createConnectorRouter } from "../src/connector/router.js";
import { createUserRouter } from "../src/auth/user-router.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { createGitHubAuthRouter } from "../src/auth/github.js";
import { IdentityAccountProvisioner } from "../src/identity/provisioner.js";
import { createIdentityAuthMiddleware } from "../src/auth.js";
import { IdentityService } from "../src/identity/service.js";

const cleanupDirs: string[] = [];
let identityStore: IdentityStore;
let identityService: IdentityService;
let controlStore: ConnectorControlStore;
let enrollmentStore: DeviceEnrollmentStore;
let sessionManager: UserSessionManager;
let userProvisioner: IdentityAccountProvisioner;
let dbPath: string;

let userAId: string;
let userBId: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-e2e-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityService = IdentityService.open(dbPath);
  identityStore = identityService.storeInstance;
  controlStore = new ConnectorControlStore(identityStore);
  enrollmentStore = new DeviceEnrollmentStore();
  sessionManager = new UserSessionManager({ secureCookies: false });
  userProvisioner = new IdentityAccountProvisioner(identityStore);

  userAId = "usr_alice";
  userBId = "usr_bob";
  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userAId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userBId);
  });
});

afterEach(async () => {
  identityService?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function createTestServer() {
  const app = express();
  app.use(express.json());

  // Mount User Router
  app.use(
    "/api/user",
    createUserRouter({
      store: identityStore,
      sessionManager,
      controlStore,
    }),
  );

  // Mount Connector Router
  app.use(
    createConnectorRouter({
      controlStore,
      enrollmentStore,
      identityStore,
      sessionManager,
      publicOrigin: "http://127.0.0.1:3000",
    }),
  );

  // Mount Mock GitHub Auth Router
  app.use(
    "/auth/github",
    createGitHubAuthRouter({
      clientId: "test_client",
      clientSecret: "test_secret",
      callbackUrl: "http://127.0.0.1:3000/auth/github/callback",
      provisioner: userProvisioner,
      sessionManager,
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes("access_token")) {
          return new Response(JSON.stringify({ access_token: "mock_gh_token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/user/emails")) {
          return new Response(JSON.stringify([{ email: "alice@example.com", primary: true, verified: true }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/user")) {
          return new Response(JSON.stringify({ id: 123456, login: "alice-gh" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    }),
  );

  // Legacy Worker endpoint mock with identity auth to test surface isolation
  app.get(
    "/api/worker/jobs/poll",
    createIdentityAuthMiddleware(identityService),
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    },
  );

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    close: () => server.close(),
  };
}

describe("CEO Connector V1.2 - E2E Trusted Device Enrollment", () => {
  it("completes full enrollment flow with polling, replay, identity verification, and self-revocation", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      // 1. Generate local client secret
      const localSecret = crypto.randomBytes(32).toString("base64url");
      const localSecretDigest = crypto.createHash("sha256").update(localSecret, "utf8").digest("hex");

      // 2. Client calls POST /api/connector/enrollments
      const enrollRes = await fetch(`${baseUrl}/api/connector/enrollments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: "Alienware Aurora",
          platform: "linux",
          credential_secret_sha256: localSecretDigest,
        }),
      });

      expect(enrollRes.status).toBe(200);
      const enrollData = (await enrollRes.json()) as any;
      expect(enrollData.device_code).toBeTruthy();
      expect(enrollData.user_code).toBeTruthy();
      expect(enrollData.device_id).toMatch(/^dev_/);
      expect(enrollData.credential_id).toMatch(/^dcr_/);
      expect(enrollData.verification_uri).toBe("http://127.0.0.1:3000/connector/enroll");
      expect(enrollData.verification_uri_complete).toContain(encodeURIComponent(enrollData.user_code));
      expect(enrollData.interval).toBe(2);

      // Client can already assemble credential
      const expectedToken = `ceo_dev1.${enrollData.credential_id}.${localSecret}`;

      // 3. Client polls while pending -> authorization_pending
      const pollPendingRes = await fetch(`${baseUrl}/api/connector/enrollments/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: enrollData.device_code }),
      });
      expect(pollPendingRes.status).toBe(400);
      const pollPendingData = (await pollPendingRes.json()) as any;
      expect(pollPendingData.error).toBe("authorization_pending");

      // 4. Browser visits /connector/enroll without session -> redirected to /auth/github
      const browserUnauth = await fetch(`${baseUrl}/connector/enroll?user_code=${enrollData.user_code}`, {
        redirect: "manual",
      });
      expect(browserUnauth.status).toBe(302);
      expect(browserUnauth.headers.get("location")).toBe(
        `/auth/github?connector_enrollment=${encodeURIComponent(enrollData.user_code)}`,
      );

      // 5. User logs in (simulate active session for User A)
      const sessionA = sessionManager.createSession({
        userId: userAId,
        provider: "github",
        providerSubject: "123456",
        providerLogin: "alice-gh",
      });
      const cookieHeader = `ceo_user_session=${sessionA.sessionId}`;

      // 6. Browser visits /connector/enroll with active session -> 200 HTML with consent form
      const browserPageRes = await fetch(`${baseUrl}/connector/enroll?user_code=${enrollData.user_code}`, {
        headers: { Cookie: cookieHeader },
      });
      expect(browserPageRes.status).toBe(200);
      const pageHtml = await browserPageRes.text();
      expect(pageHtml).toContain("Alienware Aurora");
      expect(pageHtml).toContain("linux");
      expect(pageHtml).toContain("name=\"consent_nonce\"");

      // Extract consent_nonce from form HTML
      const nonceMatch = pageHtml.match(/name="consent_nonce" value="([^"]+)"/);
      expect(nonceMatch).toBeTruthy();
      const consentNonce = nonceMatch![1]!;

      // 7. User approves via POST /connector/enroll/decision
      const approveRes = await fetch(`${baseUrl}/connector/enroll/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader,
        },
        body: new URLSearchParams({
          user_code: enrollData.user_code,
          consent_nonce: consentNonce,
          decision: "approve",
        }).toString(),
      });
      expect(approveRes.status).toBe(200);
      const approveHtml = await approveRes.text();
      expect(approveHtml).toContain("Device Authorized");

      // Reset last_poll_at_ms to avoid 2s rate limit in fast test
      const enrObj = enrollmentStore.findByUserCode(enrollData.user_code);
      if (enrObj) enrObj.last_poll_at_ms = 0;

      // 8. Client polls again -> 200 OK with device and credential metadata
      const pollApprovedRes = await fetch(`${baseUrl}/api/connector/enrollments/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: enrollData.device_code }),
      });
      expect(pollApprovedRes.status).toBe(200);
      const approvedData = (await pollApprovedRes.json()) as any;
      expect(approvedData.device.id).toBe(enrollData.device_id);
      expect(approvedData.device.display_name).toBe("Alienware Aurora");
      expect(approvedData.credential.id).toBe(enrollData.credential_id);
      expect(approvedData.replayed).toBe(false);

      // Reset last_poll_at_ms again for replay step
      if (enrObj) enrObj.last_poll_at_ms = 0;

      // 9. Client polls AGAIN -> 200 OK with replayed: true (idempotent replay)
      const pollReplayRes = await fetch(`${baseUrl}/api/connector/enrollments/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: enrollData.device_code }),
      });
      expect(pollReplayRes.status).toBe(200);
      const replayData = (await pollReplayRes.json()) as any;
      expect(replayData.device.id).toBe(enrollData.device_id);
      expect(replayData.credential.id).toBe(enrollData.credential_id);
      expect(replayData.replayed).toBe(true);

      // 10. Device verifies identity with Bearer token
      const identRes = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${expectedToken}` },
      });
      expect(identRes.status).toBe(200);
      const identData = (await identRes.json()) as any;
      expect(identData.user_id).toBe(userAId);
      expect(identData.device.id).toBe(enrollData.device_id);
      expect(identData.credential.id).toBe(enrollData.credential_id);

      // 11. Device performs self-revocation
      const revokeRes = await fetch(`${baseUrl}/api/connector/device/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${expectedToken}` },
      });
      expect(revokeRes.status).toBe(200);
      expect((await revokeRes.json()) as any).toEqual({ ok: true });

      // 12. Subsequent identity check fails with 401
      const identAfterRevoke = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${expectedToken}` },
      });
      expect(identAfterRevoke.status).toBe(401);
    } finally {
      close();
    }
  });

  it("handles user denial flow", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      const localSecret = crypto.randomBytes(32).toString("base64url");
      const localSecretDigest = crypto.createHash("sha256").update(localSecret, "utf8").digest("hex");

      const enrollRes = await fetch(`${baseUrl}/api/connector/enrollments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: "Untrusted Box",
          platform: "linux",
          credential_secret_sha256: localSecretDigest,
        }),
      });
      const enrollData = (await enrollRes.json()) as any;

      const session = sessionManager.createSession({
        userId: userAId,
        provider: "github",
        providerSubject: "123456",
        providerLogin: "alice-gh",
      });
      const cookieHeader = `ceo_user_session=${session.sessionId}`;

      const pageRes = await fetch(`${baseUrl}/connector/enroll?user_code=${enrollData.user_code}`, {
        headers: { Cookie: cookieHeader },
      });
      const pageHtml = await pageRes.text();
      const nonceMatch = pageHtml.match(/name="consent_nonce" value="([^"]+)"/);
      const consentNonce = nonceMatch![1]!;

      // User denies
      const denyRes = await fetch(`${baseUrl}/connector/enroll/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader,
        },
        body: new URLSearchParams({
          user_code: enrollData.user_code,
          consent_nonce: consentNonce,
          decision: "deny",
        }).toString(),
      });
      expect(denyRes.status).toBe(200);
      expect(await denyRes.text()).toContain("Authorization Denied");

      // Poll returns access_denied
      const pollRes = await fetch(`${baseUrl}/api/connector/enrollments/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: enrollData.device_code }),
      });
      expect(pollRes.status).toBe(400);
      expect((await pollRes.json()) as any).toEqual({ error: "access_denied" });
    } finally {
      close();
    }
  });

  it("manages devices via browser session and isolates unauthorized revocation", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      // Create a device for User A and User B
      const devA = controlStore.createDevice({
        userId: userAId,
        displayName: "Alice Workstation",
        platform: "linux",
      });

      const devB = controlStore.createDevice({
        userId: userBId,
        displayName: "Bob Laptop",
        platform: "macos",
      });

      const sessionA = sessionManager.createSession({
        userId: userAId,
        provider: "github",
        providerSubject: "123456",
        providerLogin: "alice-gh",
      });
      const cookieHeaderA = `ceo_user_session=${sessionA.sessionId}`;

      // User A lists devices -> only sees User A's devices
      const listRes = await fetch(`${baseUrl}/api/user/devices`, {
        headers: { Cookie: cookieHeaderA },
      });
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as any;
      expect(listData.devices).toHaveLength(1);
      expect(listData.devices[0].id).toBe(devA.id);
      expect(listData.devices[0].display_name).toBe("Alice Workstation");
      // Does not expose secret_digest
      expect(listData.devices[0].secret_digest).toBeUndefined();

      // User A attempts to revoke User B's device -> 404
      const revokeOtherRes = await fetch(`${baseUrl}/api/user/devices/${devB.id}/revoke`, {
        method: "POST",
        headers: { Cookie: cookieHeaderA },
      });
      expect(revokeOtherRes.status).toBe(404);

      // User A revokes own device -> 200
      const revokeOwnRes = await fetch(`${baseUrl}/api/user/devices/${devA.id}/revoke`, {
        method: "POST",
        headers: { Cookie: cookieHeaderA },
      });
      expect(revokeOwnRes.status).toBe(200);
      expect(await revokeOwnRes.json()).toEqual({ ok: true });

      // After revocation, list includes revoked device with revoked_at_ms set
      const listAfterRes = await fetch(`${baseUrl}/api/user/devices`, {
        headers: { Cookie: cookieHeaderA },
      });
      const listAfterData = (await listAfterRes.json()) as any;
      expect(listAfterData.devices).toHaveLength(1);
      expect(listAfterData.devices[0].revoked_at_ms).toBeTypeOf("number");

      // Bob's device is unaffected
      const devBFetched = controlStore.getDevice(devB.id);
      expect(devBFetched?.revoked_at_ms).toBeNull();
    } finally {
      close();
    }
  });

  it("enforces continuation exclusivity on /auth/github and resumes after login", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      // 1. Ambiguous continuation (connector_enrollment + oauth_request) -> 400
      const ambigRes = await fetch(
        `${baseUrl}/auth/github?connector_enrollment=ABCD-EFGH&oauth_request=oar_123`,
        { redirect: "manual" },
      );
      expect(ambigRes.status).toBe(400);
      expect((await ambigRes.json()) as any).toEqual({ error: "ambiguous_auth_continuation" });

      // 2. Ambiguous continuation (connector_enrollment + next) -> 400
      const ambigNextRes = await fetch(
        `${baseUrl}/auth/github?connector_enrollment=ABCD-EFGH&next=/audit`,
        { redirect: "manual" },
      );
      expect(ambigNextRes.status).toBe(400);
      expect((await ambigNextRes.json()) as any).toEqual({ error: "ambiguous_auth_continuation" });

      // 3. Invalid connector_enrollment -> 400
      const invalidRes = await fetch(
        `${baseUrl}/auth/github?connector_enrollment=invalid!!`,
        { redirect: "manual" },
      );
      expect(invalidRes.status).toBe(400);
      expect((await invalidRes.json()) as any).toEqual({ error: "invalid_connector_enrollment" });

      // 4. Valid connector_enrollment initiates GitHub OAuth redirect with state
      const initRes = await fetch(
        `${baseUrl}/auth/github?connector_enrollment=ABCD-EFGH`,
        { redirect: "manual" },
      );
      expect(initRes.status).toBe(302);
      const loc = initRes.headers.get("location")!;
      const state = new URL(loc).searchParams.get("state")!;

      // 5. GitHub callback redirects to /connector/enroll?user_code=ABCD-EFGH
      const cbRes = await fetch(
        `${baseUrl}/auth/github/callback?code=mock_code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toBe("/connector/enroll?user_code=ABCD-EFGH");
      // Session cookie was issued
      expect(cbRes.headers.get("set-cookie")).toContain("ceo_user_session=");
    } finally {
      close();
    }
  });

  it("enforces strict surface isolation between device credentials and legacy surfaces", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      const secret = crypto.randomBytes(32).toString("base64url");
      const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

      const dev = controlStore.createDevice({
        userId: userAId,
        displayName: "Isolated Device",
        platform: "linux",
      });
      const cred = controlStore.createDeviceCredential({
        deviceId: dev.id,
        secretDigest,
        expiresAtMs: Date.now() + 1000000,
      });

      const deviceToken = `ceo_dev1.${cred.id}.${secret}`;

      // 1. Device credential cannot access legacy Worker jobs endpoint (/api/worker/jobs/poll)
      const legacyRes = await fetch(`${baseUrl}/api/worker/jobs/poll`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      });
      expect(legacyRes.status).toBe(401);

      // 2. Legacy API key or host OAuth token cannot access /api/connector/identity
      const fakeLegacyToken = "ceo_key1.some_legacy_key";
      const connRes = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${fakeLegacyToken}` },
      });
      expect(connRes.status).toBe(401);
    } finally {
      close();
    }
  });

  it("guarantees independent revocation across multiple devices", async () => {
    const { baseUrl, close } = createTestServer();
    try {
      const secret1 = crypto.randomBytes(32).toString("base64url");
      const secretDigest1 = crypto.createHash("sha256").update(secret1, "utf8").digest("hex");

      const secret2 = crypto.randomBytes(32).toString("base64url");
      const secretDigest2 = crypto.createHash("sha256").update(secret2, "utf8").digest("hex");

      const dev1 = controlStore.createDevice({
        userId: userAId,
        displayName: "Device One",
        platform: "linux",
      });
      const cred1 = controlStore.createDeviceCredential({
        deviceId: dev1.id,
        secretDigest: secretDigest1,
        expiresAtMs: Date.now() + 1000000,
      });
      const token1 = `ceo_dev1.${cred1.id}.${secret1}`;

      const dev2 = controlStore.createDevice({
        userId: userAId,
        displayName: "Device Two",
        platform: "macos",
      });
      const cred2 = controlStore.createDeviceCredential({
        deviceId: dev2.id,
        secretDigest: secretDigest2,
        expiresAtMs: Date.now() + 1000000,
      });
      const token2 = `ceo_dev1.${cred2.id}.${secret2}`;

      // Both initially authenticate
      const res1Init = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      expect(res1Init.status).toBe(200);

      const res2Init = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      expect(res2Init.status).toBe(200);

      // Revoke Device 1
      controlStore.revokeDevice(dev1.id);

      // Device 1 fails with 401
      const res1After = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      expect(res1After.status).toBe(401);

      // Device 2 remains completely functional
      const res2After = await fetch(`${baseUrl}/api/connector/identity`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      expect(res2After.status).toBe(200);
      const data2 = (await res2After.json()) as any;
      expect(data2.device.id).toBe(dev2.id);
    } finally {
      close();
    }
  });
});
