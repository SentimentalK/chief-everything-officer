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
import { createDeviceAuthMiddleware } from "../src/connector/device-auth.js";

const cleanupDirs: string[] = [];
let identityStore: IdentityStore;
let controlStore: ConnectorControlStore;
let dbPath: string;

let testUserId: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-device-auth-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityStore = IdentityStore.open(dbPath);
  controlStore = new ConnectorControlStore(identityStore);

  testUserId = "usr_alice";
  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(testUserId);
  });
});

afterEach(async () => {
  identityStore?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function createTestApp() {
  const app = express();
  const authMiddleware = createDeviceAuthMiddleware(controlStore, identityStore);

  app.get("/test/protected", authMiddleware, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, deviceIdentity: res.locals.deviceIdentity });
  });

  return app;
}

async function sendRequest(app: express.Express, authHeader?: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const headers: Record<string, string> = {};
    if (authHeader) headers["Authorization"] = authHeader;

    const res = await fetch(`http://127.0.0.1:${port}/test/protected`, { headers });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe("createDeviceAuthMiddleware", () => {
  it("authenticates valid device credential and populates locals.deviceIdentity", async () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "Valid Device",
      platform: "linux",
    });

    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      expiresAtMs: Date.now() + 1000000,
    });

    const token = `ceo_dev1.${cred.id}.${secret}`;
    const app = createTestApp();

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deviceIdentity).toEqual({
      user_id: testUserId,
      device_id: dev.id,
      credential_id: cred.id,
    });
  });

  it("rejects missing or malformed authorization header with 401", async () => {
    const app = createTestApp();

    // Missing header
    const resNoAuth = await sendRequest(app);
    expect(resNoAuth.status).toBe(401);

    // Basic scheme
    const resBasic = await sendRequest(app, "Basic dXNlcjpwYXNz");
    expect(resBasic.status).toBe(401);

    // Bearer but malformed token (not ceo_dev1.id.secret)
    const resMalformed1 = await sendRequest(app, "Bearer not_a_device_token");
    expect(resMalformed1.status).toBe(401);

    const resMalformed2 = await sendRequest(app, "Bearer ceo_dev1.only_two_parts");
    expect(resMalformed2.status).toBe(401);

    const resWrongPrefix = await sendRequest(app, "Bearer ceo_key1.dcr_123.secret");
    expect(resWrongPrefix.status).toBe(401);
  });

  it("rejects unknown credential ID with 401", async () => {
    const app = createTestApp();
    const token = "ceo_dev1.dcr_00000000-0000-0000-0000-000000000000.somesecret";
    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects wrong secret with 401", async () => {
    const correctSecret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(correctSecret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "My PC",
      platform: "linux",
    });
    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      expiresAtMs: Date.now() + 1000000,
    });

    const app = createTestApp();
    const wrongSecret = crypto.randomBytes(32).toString("base64url");
    const token = `ceo_dev1.${cred.id}.${wrongSecret}`;

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects revoked credential with 401", async () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "My PC",
      platform: "linux",
    });
    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      expiresAtMs: Date.now() + 1000000,
    });

    controlStore.revokeDeviceCredential(cred.id);

    const app = createTestApp();
    const token = `ceo_dev1.${cred.id}.${secret}`;

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects expired credential with 401", async () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "My PC",
      platform: "linux",
    });
    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      issuedAtMs: 1000,
      expiresAtMs: 2000, // expired in the past
    });

    const app = createTestApp();
    const token = `ceo_dev1.${cred.id}.${secret}`;

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects revoked device with 401", async () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "My PC",
      platform: "linux",
    });
    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      expiresAtMs: Date.now() + 1000000,
    });

    controlStore.revokeDevice(dev.id);

    const app = createTestApp();
    const token = `ceo_dev1.${cred.id}.${secret}`;

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects disabled user with 401", async () => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const secretDigest = crypto.createHash("sha256").update(secret, "utf8").digest("hex");

    const dev = controlStore.createDevice({
      userId: testUserId,
      displayName: "My PC",
      platform: "linux",
    });
    const cred = controlStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest,
      expiresAtMs: Date.now() + 1000000,
    });

    // Disable user in DB
    identityStore.withDb((db) => {
      db.prepare("UPDATE users SET disabled_at = 9999999 WHERE id = ?;").run(testUserId);
    });

    const app = createTestApp();
    const token = `ceo_dev1.${cred.id}.${secret}`;

    const res = await sendRequest(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
