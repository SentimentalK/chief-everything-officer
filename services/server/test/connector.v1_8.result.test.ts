import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { RedisJobStoreV2 } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2 } from "../src/jobs/v2-service.js";
import { createConnectorJobsRouter } from "../src/jobs/v2-router.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import { fixture } from "./helpers.js";
import { computeCanonicalSha256 } from "../src/jobs/canonical.js";

const cleanupDirs: string[] = [];

describe("Connector V1.8 Result Endpoint & Execution Loop", () => {
  let identityStore: IdentityStore;
  let controlStore: ConnectorControlStore;
  let v2Store: RedisJobStoreV2;
  let coordinator: JobCoordinatorV2;
  let workspace: CeoWorkspace;
  let resourceService: ResourceService;

  let userId: string;
  let workspaceId: string;
  let deviceId: string;
  let deviceToken: string;
  let targetId: string;
  let resourceId: string;

  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-v1_8-test-"));
    cleanupDirs.push(dir);

    // 1. Identity & Control Store
    const dbPath = path.join(dir, "identity.sqlite");
    provisionEmptyControlPlaneDatabase(dbPath);
    identityStore = IdentityStore.open(dbPath);
    controlStore = new ConnectorControlStore(identityStore);

    userId = "usr_alice";
    workspaceId = "ws_primary";
    identityStore.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userId);
      db.prepare(
        "INSERT INTO workspaces VALUES (?, ?, 'https://github.com/acme/main-repo.git', 'main', 1000);",
      ).run(workspaceId, userId);
      db.prepare(
        "INSERT INTO workspace_memberships VALUES ('wsm_alice', ?, ?, 'owner', 1000);",
      ).run(workspaceId, userId);
    });

    // 2. Git Workspace & ResourceService
    const fix = await fixture();
    cleanupDirs.push(fix.root);
    workspace = new CeoWorkspace(fix.config);
    await workspace.initialize();
    resourceService = new ResourceService(workspace);

    // Capture an initial resource to apply results to
    const captureRes = await resourceService.capture({
      source: {
        type: "raw_text",
        text: "Initial text content",
        original_name: "initial.txt",
      },
    });
    resourceId = String((captureRes.resource as any).resource_id);

    // 3. Execution Target & Device
    const target = controlStore.createExecutionTarget({
      workspaceId,
      alias: "target-main",
      displayName: "Target Main",
      kind: "coding",
    });
    targetId = target.id;

    const device = controlStore.createDevice({
      userId,
      displayName: "Test Device",
      platform: "linux",
    });
    deviceId = device.id;
    const secret = crypto.randomBytes(32).toString("hex");
    const cred = controlStore.createDeviceCredential({
      deviceId: device.id,
      secretDigest: crypto.createHash("sha256").update(secret).digest("hex"),
      expiresAtMs: Date.now() + 86400_000,
    });
    deviceToken = `ceo_dev1.${cred.id}.${secret}`;
    controlStore.upsertDeviceTargetBinding({ deviceId: device.id, targetId });

    // 4. Fake Redis & Coordinator
    const fakeRedis = createFakeRedisRunner();
    v2Store = new RedisJobStoreV2(fakeRedis);

    coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
      resourceService,
      resourceExists: (_scope, resId) => resId === resourceId,
    });

    // 5. Express Router
    const app = express();
    app.use(express.json());
    app.use(
      "/api/connector/jobs",
      createConnectorJobsRouter(coordinator, controlStore, identityStore),
    );

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/api/connector/jobs`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(
      cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  it("submits managed result, writes atomic workspace transaction, and permits completion report", async () => {
    // 1. Submit a job with result_target = 'resource'
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Update resource content",
        acceptance: "Should contain new body",
        resource_id: resourceId,
        execution_timeout_seconds: 120,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;

    // 2. Claim & Start the job
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    // 3. Verify premature completion report is rejected with 409 RESULT_REQUIRED
    const prematureReportRes = await fetch(`${baseUrl}/${jobId}/report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        report: {
          schema_version: 2,
          execution_status: "COMPLETED",
          business_outcome: "UNVERIFIED",
          task_dispatched: true,
          finished_at_ms: Date.now(),
          duration_ms: 500,
          executor: { type: "orca", version: "1.0.0" },
          receipt_sha256: "a".repeat(64),
          error: null,
        },
      }),
    });
    expect(prematureReportRes.status).toBe(409);
    const prematureJson = await prematureReportRes.json();
    expect(prematureJson.error).toBe("RESULT_REQUIRED");

    // 4. Construct valid ManagedResultEnvelope
    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resourceId,
      summary: "Updated body content via V1.8 managed result",
      operations: [
        {
          op: "upsert_content",
          content: "# V1.8 Success\nNew resolved body content written by agent.",
        },
      ],
    };
    const payloadSha256 = computeCanonicalSha256(managedResult);

    // 5. Submit result via HTTP endpoint
    const resultRes = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: managedResult,
        payload_sha256: payloadSha256,
      }),
    });
    expect(resultRes.status).toBe(200);
    const resultJson = await resultRes.json();
    expect(resultJson.ok).toBe(true);
    expect(resultJson.replayed).toBe(false);
    expect(resultJson.resource_id).toBe(resourceId);
    expect(typeof resultJson.commit).toBe("string");

    // 6. Verify idempotent replay with identical payload
    const replayRes = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: managedResult,
        payload_sha256: payloadSha256,
      }),
    });
    expect(replayRes.status).toBe(200);
    const replayJson = await replayRes.json();
    expect(replayJson.ok).toBe(true);
    expect(replayJson.replayed).toBe(true);
    expect(replayJson.commit).toBe(resultJson.commit);

    // 7. Verify conflict rejection with different payload for same attempt
    const conflictResult = {
      ...managedResult,
      summary: "Conflicting summary",
    };
    const conflictDigest = computeCanonicalSha256(conflictResult);
    const conflictRes = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: conflictResult,
        payload_sha256: conflictDigest,
      }),
    });
    expect(conflictRes.status).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.error).toBe("RESULT_CONFLICT");

    // 8. Deliver final completion report now that result is ACKed
    const reportRes = await fetch(`${baseUrl}/${jobId}/report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        report: {
          schema_version: 2,
          execution_status: "COMPLETED",
          business_outcome: "UNVERIFIED",
          task_dispatched: true,
          finished_at_ms: Date.now(),
          duration_ms: 1200,
          executor: { type: "orca", version: "1.0.0" },
          receipt_sha256: "b".repeat(64),
          error: null,
        },
      }),
    });
    expect(reportRes.status).toBe(200);

    // 9. Host query exposes complete result metadata
    const hostJob = await coordinator.getJobForHost({ user_id: userId, workspace_id: workspaceId }, jobId);
    expect(hostJob.state).toBe("terminal");
    expect(hostJob.execution_status).toBe("COMPLETED");
    expect(hostJob.result).toEqual({
      target: "resource",
      attempt_id: attemptId,
      payload_sha256: payloadSha256,
      resource_id: resourceId,
      commit: resultJson.commit,
      received_at: expect.any(String),
    });
  });

  it("rejects result with mismatched payload_sha256", async () => {
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resourceId,
        execution_timeout_seconds: 120,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resourceId,
      summary: "Summary",
      operations: [{ op: "rename", display_name: "Renamed" }],
    };

    const res = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: managedResult,
        payload_sha256: "f".repeat(64), // Deliberate mismatch
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.message).toContain("payload_sha256 does not match canonical JCS digest");
  });

  it("rejects result containing forbidden self-asserted provenance", async () => {
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resourceId,
        execution_timeout_seconds: 120,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resourceId,
      summary: "Summary",
      operations: [
        {
          op: "upsert_content",
          provenance: "host_exact", // Forbidden! Agent cannot self-assert host_exact
          content: "Attacked content",
        },
      ],
    };
    const digest = computeCanonicalSha256(managedResult);

    const res = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: managedResult,
        payload_sha256: digest,
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.message).toContain("Forbidden provenance");
  });

  it("rejects result containing attach_source_asset", async () => {
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resourceId,
        execution_timeout_seconds: 120,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resourceId,
      summary: "Summary",
      operations: [
        {
          op: "attach_source_asset",
          filename: "test.bin",
        },
      ],
    };
    const digest = computeCanonicalSha256(managedResult);

    const res = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: managedResult,
        payload_sha256: digest,
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.message).toContain("attach_source_asset is unsupported in managed results");
  });

  it("accepts failure report for result_target=resource even without a result", async () => {
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resourceId,
        execution_timeout_seconds: 120,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    const reportRes = await fetch(`${baseUrl}/${jobId}/report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        report: {
          schema_version: 2,
          execution_status: "FAILED",
          business_outcome: "FAILED",
          task_dispatched: true,
          finished_at_ms: Date.now(),
          duration_ms: 800,
          executor: { type: "orca", version: "1.0.0" },
          receipt_sha256: "c".repeat(64),
          error: {
            stage: "result_collection",
            code: "RESULT_MISSING",
            message: "managed-result.json was not found",
          },
        },
      }),
    });
    expect(reportRes.status).toBe(200);

    const hostJob = await coordinator.getJobForHost({ user_id: userId, workspace_id: workspaceId }, jobId);
    expect(hostJob.state).toBe("terminal");
    expect(hostJob.execution_status).toBe("FAILED");
    expect(hostJob.business_outcome).toBe("FAILED");
    expect(hostJob.result).toBeNull();
  });
});
