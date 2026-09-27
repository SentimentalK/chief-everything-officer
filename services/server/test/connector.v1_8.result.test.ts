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
import { ResourceRetrievalService } from "../src/resource/retrieval.js";
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
  let retrievalService: ResourceRetrievalService;

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
    retrievalService = new ResourceRetrievalService(workspace);

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
      resourceExists: (_scope, resId) => Boolean(resId && resId.startsWith("res-")),
    });

    // 5. Express Router with identical parser configuration as server.ts
    const app = express();
    app.use((req, res, next) => {
      if (req.path.match(/^\/api\/connector\/jobs\/[^/]+\/result$/)) {
        return next();
      }
      express.json()(req, res, next);
    });
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
    const resultJson = await resultRes.json();
    expect(resultRes.status).toBe(200);
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
      operations: [
        {
          op: "upsert_content",
          content: "# V1.8 Redelivered Content\nDistinct content for redelivery.",
        },
      ],
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
    expect(conflictJson.error).toBe("STALE_RESULT_SUBMISSION");

    // 7b. Verify explicit_redelivery allows replacement with new commit
    const redeliverRes = await fetch(`${baseUrl}/${jobId}/result`, {
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
        delivery_mode: "explicit_redelivery",
      }),
    });
    const redeliverJson = await redeliverRes.json();
    expect(redeliverRes.status).toBe(200);
    expect(redeliverJson.ok).toBe(true);
    expect(redeliverJson.replayed).toBe(false);
    expect(redeliverJson.commit).not.toBe(resultJson.commit);

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
      payload_sha256: conflictDigest,
      resource_id: resourceId,
      commit: redeliverJson.commit,
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

  it("accepts large managed result payload (~1.5 MiB) on the result endpoint", async () => {
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Acquire large transcript",
        acceptance: "Should contain large body",
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

    // 1.5 MiB content string
    const largeContent = "a".repeat(1536 * 1024);
    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resourceId,
      summary: "Large 1.5 MiB transcript",
      operations: [
        {
          op: "upsert_content",
          content: largeContent,
        },
      ],
    };
    const payloadSha256 = computeCanonicalSha256(managedResult);

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
        payload_sha256: payloadSha256,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.commit).toBe("string");
  });

  it("rejects result request body exceeding 3 MiB limit with 413", async () => {
    const jobId = `job-${crypto.randomUUID()}`;
    // Construct a payload larger than 3 MiB
    const oversizedBody = JSON.stringify({
      attempt_id: `att-${crypto.randomUUID()}`,
      claim_token: "token",
      padding: "x".repeat(3145728 + 1024), // > 3 MiB
    });

    const res = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
  });

  it("enforces default 100 KiB limit on non-result routes (e.g. claim endpoint)", async () => {
    const jobId = `job-${crypto.randomUUID()}`;
    // 120 KiB body on /claim should exceed global 100 KiB limit
    const oversizedClaim = JSON.stringify({
      attempt_id: `att-${crypto.randomUUID()}`,
      claim_token: "token",
      padding: "x".repeat(120 * 1024),
    });

    const res = await fetch(`${baseUrl}/${jobId}/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: oversizedClaim,
    });
    expect(res.status).toBe(413);
  });

  it("applies upsert_content and merge_source_metadata, preserving display_name, topics, and canonical identity", async () => {
    // 1. Capture a fresh resource with deterministic_adapter metadata_method and explicit rename
    const captureRes = await resourceService.capture({
      source: {
        type: "url",
        url: "https://www.youtube.com/watch?v=aircAruvnKk",
      },
    });
    const resId = String((captureRes.resource as any).resource_id);

    // Apply explicit rename to simulate user/host semantic naming
    const baseSnap = await workspace.captureReadSnapshot();
    await resourceService.apply({
      resource_id: resId,
      base_commit: baseSnap.commit,
      summary: "Set semantic display name",
      operations: [
        { op: "rename", display_name: "3Blue1Brown Neural Networks" },
        { op: "patch_topics", set: ["machine_learning", "math"] },
      ],
    });

    // Verify initial metadata state
    const beforeGet = await retrievalService.get({ resource_id: resId, view: "metadata" });
    const beforeMeta = (beforeGet as any).metadata;
    expect(beforeMeta.display_name).toBe("3Blue1Brown Neural Networks");
    expect(beforeMeta.topics).toEqual(["machine_learning", "math"]);

    // 2. Submit a job with result_target = resource
    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Extract transcript",
        acceptance: "upsert_content",
        resource_id: resId,
        execution_timeout_seconds: 3600,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    // 3. Post managed result containing upsert_content AND merge_source_metadata
    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resId,
      summary: "Extracted transcript and source metadata",
      operations: [
        {
          op: "upsert_content",
          content: "# Neural Networks Transcript\nNeurons are functions.",
        },
        {
          op: "merge_source_metadata",
          title: "But what is a neural network? | Chapter 1, Deep learning",
          author: "3Blue1Brown",
          published_at: "2017-10-05T00:00:00Z",
          language: "zh",
        },
      ],
    };
    const payloadSha256 = computeCanonicalSha256(managedResult);

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
        payload_sha256: payloadSha256,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // 4. Assert metadata and content in Resource
    const afterGet = await retrievalService.get({ resource_id: resId, view: "metadata" });
    const afterMeta = (afterGet as any).metadata;
    // Source descriptive facts updated
    expect(afterMeta.title).toBe("But what is a neural network? | Chapter 1, Deep learning");
    expect(afterMeta.author).toBe("3Blue1Brown");
    expect(afterMeta.published_at).toBe("2017-10-05T00:00:00Z");
    expect(afterMeta.language).toBe("zh");
    expect(afterMeta.metadata_fetched_at).toBeTruthy();
    // Provenance transitioned properly (worker or mixed)
    expect(["worker", "mixed"]).toContain(afterMeta.metadata_method);

    // USER SEMANTIC FACTS PRESERVED
    expect(afterMeta.display_name).toBe("3Blue1Brown Neural Networks");
    expect(afterMeta.topics).toEqual(["machine_learning", "math"]);

    // Content verified
    const contentGet = await retrievalService.get({ resource_id: resId, view: "content" });
    expect((contentGet as any).content).toBe("# Neural Networks Transcript\nNeurons are functions.");
  });

  it("merge_source_metadata preserves existing fields when incoming fields are null or empty", async () => {
    const captureRes = await resourceService.capture({
      source: {
        type: "raw_text",
        text: "Document text",
        original_name: "doc.txt",
      },
    });
    const resId = String((captureRes.resource as any).resource_id);

    // Set initial title and author via meta
    const snap = await workspace.captureReadSnapshot();
    const docPath = `resources/${resId}/meta.md`;

    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resId,
        execution_timeout_seconds: 3600,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    // Post result with null title and valid author
    const managedResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resId,
      summary: "Partial metadata merge",
      operations: [
        {
          op: "upsert_content",
          content: "Content",
        },
        {
          op: "merge_source_metadata",
          title: null,
          author: "Preserved Author",
          language: "   ", // whitespace only should be ignored
        },
      ],
    };
    const payloadSha256 = computeCanonicalSha256(managedResult);

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
        payload_sha256: payloadSha256,
      }),
    });
    expect(res.status).toBe(200);

    const afterGet = await retrievalService.get({ resource_id: resId, view: "metadata" });
    const meta = (afterGet as any).metadata;
    expect(meta.author).toBe("Preserved Author");
    expect(meta.language).toBeNull(); // not set because it was whitespace
  });

  it("strictly rejects managed results containing disallowed operations like rename or patch_topics with VALIDATION_FAILED", async () => {
    const captureRes = await resourceService.capture({
      source: {
        type: "raw_text",
        text: "Document text",
        original_name: "doc.txt",
      },
    });
    const resId = String((captureRes.resource as any).resource_id);

    const submitRes = await coordinator.submit(
      { user_id: userId, workspace_id: workspaceId },
      {
        request_id: crypto.randomUUID(),
        target_id: targetId,
        prompt: "Prompt",
        acceptance: "Acceptance",
        resource_id: resId,
        execution_timeout_seconds: 3600,
        result_target: "resource",
      },
    );
    const jobId = submitRes.job.job_id;
    const attemptId = `att-${crypto.randomUUID()}`;
    const claimToken = crypto.randomBytes(32).toString("hex");
    await coordinator.claimJob(deviceId, jobId, attemptId, claimToken);
    await coordinator.startJob(deviceId, jobId, attemptId, claimToken);

    const invalidResult = {
      schema_version: 1,
      job_id: jobId,
      attempt_id: attemptId,
      resource_id: resId,
      summary: "Attempting disallowed rename operation",
      operations: [
        {
          op: "rename",
          display_name: "Malicious Name Override",
        },
      ],
    };
    const payloadSha256 = computeCanonicalSha256(invalidResult);

    const res = await fetch(`${baseUrl}/${jobId}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attempt_id: attemptId,
        claim_token: claimToken,
        result: invalidResult,
        payload_sha256: payloadSha256,
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_FAILED");
    expect(json.message).toContain("rename");
  });
});
