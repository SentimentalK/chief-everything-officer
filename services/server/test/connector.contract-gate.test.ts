import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { DeviceEnrollmentStore } from "../src/connector/enrollment-store.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { createConnectorRouter } from "../src/connector/router.js";
import { RedisJobStoreV2 } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2 } from "../src/jobs/v2-service.js";
import { createConnectorJobsRouter } from "../src/jobs/v2-router.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { type ExecutionReport } from "../src/jobs/execution-contract.js";

const cleanupDirs: string[] = [];
let identityStore: IdentityStore;
let controlStore: ConnectorControlStore;
let enrollmentStore: DeviceEnrollmentStore;
let sessionManager: UserSessionManager;
let v2Store: RedisJobStoreV2;
let coordinator: JobCoordinatorV2;
let dbPath: string;

let testUserId: string;
let testWorkspaceId: string;
let testTargetId: string;
let testDeviceId: string;
let testSecret: string;
let testCredId: string;
let authHeader: { Authorization: string };

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-contract-gate-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityStore = IdentityStore.open(dbPath);
  controlStore = new ConnectorControlStore(identityStore);
  enrollmentStore = new DeviceEnrollmentStore(identityStore);
  sessionManager = new UserSessionManager({
    cookieSecret: "test-secret-at-least-32-chars-long!",
  });

  testUserId = "usr_contract_gate";
  testWorkspaceId = "ws_contract_gate";

  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(testUserId);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/owner/repo.git', 'main', 1000);").run(
      testWorkspaceId,
      testUserId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_gate', ?, ?, 'owner', 1000);").run(
      testWorkspaceId,
      testUserId,
    );
  });

  const target = controlStore.createExecutionTarget({
    workspaceId: testWorkspaceId,
    alias: "gate-target",
    displayName: "Gate Target",
    kind: "coding",
    repositoryProvider: "github",
    repositoryExternalId: "repo_12345",
    repositoryFullName: "owner/repo",
  });
  testTargetId = target.id;

  const device = controlStore.createDevice({
    userId: testUserId,
    displayName: "Gate Device",
    platform: "linux-x86_64",
  });
  testDeviceId = device.id;

  testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const secretDigest = crypto.createHash("sha256").update(testSecret, "utf8").digest("hex");
  const cred = controlStore.createDeviceCredential({
    deviceId: testDeviceId,
    secretDigest,
    expiresAtMs: Date.now() + 3600 * 1000,
  });
  testCredId = cred.id;

  authHeader = {
    Authorization: `Bearer ceo_dev1.${testCredId}.${testSecret}`,
  };

  controlStore.upsertDeviceTargetBinding({
    deviceId: testDeviceId,
    targetId: testTargetId,
  });

  const runner = createFakeRedisRunner();
  v2Store = new RedisJobStoreV2(runner);
  coordinator = new JobCoordinatorV2({
    store: v2Store,
    controlStore,
    identityStore,
  });

  const app = express();
  app.use(express.json());
  app.use(
    createConnectorRouter({
      controlStore,
      enrollmentStore,
      identityStore,
      sessionManager,
      publicOrigin: "http://127.0.0.1:3000",
    }),
  );
  app.use(
    "/api/connector/jobs",
    createConnectorJobsRouter(coordinator, controlStore, identityStore),
  );

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Cross-Component Native Server Contract Gate", () => {
  it("live server matches wire contracts expected by connector", async () => {
    // 1. GET /api/connector/identity
    const identRes = await fetch(`${baseUrl}/api/connector/identity`, {
      headers: authHeader,
    });
    expect(identRes.status).toBe(200);
    const ident = (await identRes.json()) as any;
    expect(ident).toMatchObject({
      user_id: testUserId,
      device: {
        id: testDeviceId,
        display_name: "Gate Device",
        platform: "linux-x86_64",
      },
      credential: {
        id: testCredId,
      },
    });
    expect(typeof ident.credential.expires_at_ms).toBe("number");

    // 2. GET /api/connector/targets
    const targetsRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: authHeader,
    });
    expect(targetsRes.status).toBe(200);
    const targetsBody = (await targetsRes.json()) as any;
    expect(Array.isArray(targetsBody.targets)).toBe(true);
    expect(targetsBody.targets.length).toBe(1);
    const targetItem = targetsBody.targets[0];
    expect(targetItem.target).toMatchObject({
      id: testTargetId,
      workspace_id: testWorkspaceId,
      alias: "gate-target",
      display_name: "Gate Target",
      kind: "coding",
      disabled: false,
    });
    expect(targetItem.target.repository).toMatchObject({
      provider: "github",
      external_id: "repo_12345",
      full_name: "owner/repo",
    });
    expect(targetItem.this_device_binding.enabled).toBe(true);
    expect(targetItem.active_binding_count).toBe(1);

    // Create a job for testing coordinator endpoints
    const submitResult = await coordinator.submit(
      { user_id: testUserId, workspace_id: testWorkspaceId },
      {
        request_id: "req-00000000-0000-0000-0000-000000000001",
        target_id: testTargetId,
        prompt: "Gate prompt",
        acceptance: "Gate acceptance",
        resource_id: null,
        execution_timeout_seconds: 600,
        result_target: "none",
      },
    );
    const jobId = submitResult.job.job_id;

    // 3. GET /api/connector/jobs/pending
    const pendingRes = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
      headers: authHeader,
    });
    expect(pendingRes.status).toBe(200);
    const pendingBody = (await pendingRes.json()) as any;
    expect(Array.isArray(pendingBody.jobs)).toBe(true);
    expect(pendingBody.jobs.length).toBe(1);
    const pendingJob = pendingBody.jobs[0];
    expect(pendingJob).toMatchObject({
      job_id: jobId,
      workspace_id: testWorkspaceId,
      target_id: testTargetId,
    });
    expect(typeof pendingJob.created_at).toBe("string");

    // 4. POST /api/connector/jobs/:job_id/claim
    const attemptId = "att-11111111-2222-3333-4444-555555555555";
    const claimToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const claimRes = await fetch(`${baseUrl}/api/connector/jobs/${jobId}/claim`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
      }),
    });
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as any;
    expect(claimBody).toMatchObject({
      ok: true,
      replayed: false,
      attempt: {
        attempt_id: attemptId,
        phase: "claimed",
        started_at: null,
      },
      job: {
        job_id: jobId,
        workspace_id: testWorkspaceId,
        target_id: testTargetId,
        prompt: "Gate prompt",
        acceptance: "Gate acceptance",
        timeout_seconds: 600,
        result_target: "none",
      },
    });
    expect(typeof claimBody.server_time).toBe("string");
    expect(typeof claimBody.attempt.claimed_at).toBe("string");

    // 5. POST /api/connector/jobs/:job_id/start
    const startRes = await fetch(`${baseUrl}/api/connector/jobs/${jobId}/start`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
      }),
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;
    expect(startBody).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(typeof startBody.server_time).toBe("string");

    // 6. POST /api/connector/jobs/:job_id/report
    const reportPayload: ExecutionReport = {
      schema_version: 2,
      execution_status: "COMPLETED",
      business_outcome: "UNVERIFIED",
      task_dispatched: true,
      finished_at_ms: Date.now(),
      duration_ms: 500,
      executor: {
        type: "agent",
        version: "1.0.0",
      },
      receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      error: null,
    };

    const reportRes = await fetch(`${baseUrl}/api/connector/jobs/${jobId}/report`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        report: reportPayload,
      }),
    });
    expect(reportRes.status).toBe(200);
    const reportBody = (await reportRes.json()) as any;
    expect(reportBody).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(typeof reportBody.server_time).toBe("string");

    // 7. Golden fixture structural parity check
    const fixturePath = path.resolve(__dirname, "../../../connector/tests/fixtures/server_contract_fixtures.json");
    const goldenFixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

    // Check key sets match exactly
    expect(Object.keys(ident).sort()).toEqual(Object.keys(goldenFixture.identity).sort());
    expect(Object.keys(targetItem.target).sort()).toEqual(Object.keys(goldenFixture.targets.targets[0].target).sort());
    expect(Object.keys(pendingJob).sort()).toEqual(Object.keys(goldenFixture.pending.jobs[0]).sort());
    expect(Object.keys(claimBody).sort()).toEqual(Object.keys(goldenFixture.claim).sort());
    expect(Object.keys(claimBody.job).sort()).toEqual(Object.keys(goldenFixture.claim.job).sort());
    expect(Object.keys(startBody).sort()).toEqual(Object.keys(goldenFixture.start).sort());
    expect(Object.keys(reportBody).sort()).toEqual(Object.keys(goldenFixture.report).sort());
  });
});
