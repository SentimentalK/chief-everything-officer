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
import { type ExecutionReport } from "../src/jobs/execution-contract.js";

const cleanupDirs: string[] = [];
let identityStore: IdentityStore;
let controlStore: ConnectorControlStore;
let v2Store: RedisJobStoreV2;
let coordinator: JobCoordinatorV2;
let dbPath: string;

let userAliceId: string;
let userBobId: string;
let userCharlieId: string;
let workspaceId: string;
let bobWorkspaceId: string;

let targetA: { id: string; alias: string };
let targetB: { id: string; alias: string };

let aliceDevToken: string;
let aliceDeviceId: string;
let bobDevToken: string;
let bobDeviceId: string;

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-jobs-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityStore = IdentityStore.open(dbPath);
  controlStore = new ConnectorControlStore(identityStore);

  userAliceId = "usr_alice";
  userBobId = "usr_bob";
  userCharlieId = "usr_charlie";
  workspaceId = "ws_primary";
  bobWorkspaceId = "ws_bob";

  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userAliceId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userBobId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userCharlieId);

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/acme/main-repo.git', 'main', 1000);").run(
      workspaceId,
      userAliceId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_alice', ?, ?, 'owner', 1000);").run(
      workspaceId,
      userAliceId,
    );

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/bob/repo.git', 'main', 1000);").run(
      bobWorkspaceId,
      userBobId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_bob', ?, ?, 'owner', 1000);").run(
      bobWorkspaceId,
      userBobId,
    );
  });

  // Create targets
  targetA = controlStore.createExecutionTarget({
    workspaceId,
    alias: "target-a",
    displayName: "Target A",
    kind: "general_automation",
  });
  targetB = controlStore.createExecutionTarget({
    workspaceId: bobWorkspaceId,
    alias: "target-b",
    displayName: "Target B",
    kind: "general_automation",
  });

  // Setup Device & Credentials for Alice
  const aliceDev = controlStore.createDevice({
    userId: userAliceId,
    displayName: "Alice Device",
    platform: "linux",
  });
  aliceDeviceId = aliceDev.id;
  const aliceSecret = "a".repeat(64);
  const aliceSecretDigest = crypto.createHash("sha256").update(aliceSecret, "utf8").digest("hex");
  const aliceCred = controlStore.createDeviceCredential({
    deviceId: aliceDeviceId,
    secretDigest: aliceSecretDigest,
    expiresAtMs: Date.now() + 3600 * 1000,
  });
  aliceDevToken = `ceo_dev1.${aliceCred.id}.${aliceSecret}`;

  // Setup Device & Credentials for Bob
  const bobDev = controlStore.createDevice({
    userId: userBobId,
    displayName: "Bob Device",
    platform: "darwin",
  });
  bobDeviceId = bobDev.id;
  const bobSecret = "b".repeat(64);
  const bobSecretDigest = crypto.createHash("sha256").update(bobSecret, "utf8").digest("hex");
  const bobCred = controlStore.createDeviceCredential({
    deviceId: bobDeviceId,
    secretDigest: bobSecretDigest,
    expiresAtMs: Date.now() + 3600 * 1000,
  });
  bobDevToken = `ceo_dev1.${bobCred.id}.${bobSecret}`;

  // Bind Alice's device to Target A
  controlStore.upsertDeviceTargetBinding({
    deviceId: aliceDeviceId,
    targetId: targetA.id,
  });

  // Bind Bob's device to Target B
  controlStore.upsertDeviceTargetBinding({
    deviceId: bobDeviceId,
    targetId: targetB.id,
  });

  // Setup V2 Store & Coordinator
  const runner = createFakeRedisRunner();
  v2Store = new RedisJobStoreV2(runner);
  coordinator = new JobCoordinatorV2({
    store: v2Store,
    controlStore,
    identityStore,
  });

  // Setup Express App
  const app = express();
  app.use(express.json());
  app.use("/api/connector/jobs", createConnectorJobsRouter(coordinator, controlStore, identityStore));

  server = app.listen(0);
  const port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  server?.close();
  identityStore?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Connector Jobs Protocol (/api/connector/jobs)", () => {
  describe("Authentication Guard", () => {
    it("returns 401 unauthorized when Authorization header is missing or invalid", async () => {
      const res1 = await fetch(`${baseUrl}/api/connector/jobs/pending`);
      expect(res1.status).toBe(401);

      const res2 = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
        headers: { Authorization: "Bearer invalid_token" },
      });
      expect(res2.status).toBe(401);
    });

    it("allows request with valid device credential", async () => {
      const res = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toEqual([]);
    });
  });

  describe("Pending Candidate Discovery", () => {
    it("discovers queued jobs only for targets bound to this device", async () => {
      // Alice submits a job to Target A
      const jobA = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000001",
          target_id: targetA.id,
          prompt: "run job on target a",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      // Bob submits a job to Target B
      const jobB = await coordinator.submit(
        { user_id: userBobId, workspace_id: bobWorkspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000002",
          target_id: targetB.id,
          prompt: "run job on target b",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      // Alice's device is bound only to Target A -> discovers only Job A
      const resAlice = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      expect(resAlice.status).toBe(200);
      const aliceData = await resAlice.json();
      expect(aliceData.jobs).toHaveLength(1);
      expect(aliceData.jobs[0].job_id).toBe(jobA.job.job_id);
      expect(aliceData.jobs[0].target_id).toBe(targetA.id);
      expect(aliceData.jobs[0].prompt).toBeUndefined(); // Shallow projection!

      // Bob's device is bound only to Target B -> discovers only Job B
      const resBob = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
        headers: { Authorization: `Bearer ${bobDevToken}` },
      });
      expect(resBob.status).toBe(200);
      const bobData = await resBob.json();
      expect(bobData.jobs).toHaveLength(1);
      expect(bobData.jobs[0].job_id).toBe(jobB.job.job_id);
      expect(bobData.jobs[0].target_id).toBe(targetB.id);
    });

    it("scans all eligible targets without arbitrary truncation", async () => {
      // Create additional targets beyond initial
      const extraTargets = [];
      for (let i = 1; i <= 5; i++) {
        const t = controlStore.createExecutionTarget({
          workspaceId,
          alias: `extra-target-${i}`,
          displayName: `Extra Target ${i}`,
          kind: "general_automation",
        });
        controlStore.upsertDeviceTargetBinding({
          deviceId: aliceDeviceId,
          targetId: t.id,
        });
        extraTargets.push(t);
      }

      // Submit job only to the last extra target
      const lastTarget = extraTargets[extraTargets.length - 1];
      const job = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000003",
          target_id: lastTarget.id,
          prompt: "run job on last extra target",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const res = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      const data = await res.json();
      expect(data.jobs.some((j: any) => j.job_id === job.job.job_id)).toBe(true);
    });
  });

  describe("Job Claiming & Replay Boundaries", () => {
    it("returns 404 JOB_NOT_FOUND when device tries to claim job belonging to an ineligible target", async () => {
      // Bob submits job on Target B (Bob's device is bound, Alice's is not)
      const jobB = await coordinator.submit(
        { user_id: userBobId, workspace_id: bobWorkspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000010",
          target_id: targetB.id,
          prompt: "target b job",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      // Alice's device attempts to claim Job B
      const res = await fetch(`${baseUrl}/api/connector/jobs/${jobB.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: "att_00000000-0000-0000-0000-000000000001",
          claim_token: "c".repeat(64),
        }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("JOB_NOT_FOUND");
    });

    it("successfully claims job on eligible target and returns full prompt payload", async () => {
      const jobA = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000011",
          target_id: targetA.id,
          prompt: "secret task prompt",
          acceptance: "strict acceptance",
          resource_id: null,
          execution_timeout_seconds: 3600,
          result_target: "none",
        },
      );

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const claimToken = "d".repeat(64);

      const res = await fetch(`${baseUrl}/api/connector/jobs/${jobA.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: attemptId,
          claim_token: claimToken,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.replayed).toBe(false);
      expect(data.attempt.attempt_id).toBe(attemptId);
      expect(data.attempt.phase).toBe("claimed");
      expect(data.job.prompt).toBe("secret task prompt");
      expect(data.job.acceptance).toBe("strict acceptance");
    });

    it("LOST CLAIM RESPONSE + UNBIND: replay succeeds even after device is unbound", async () => {
      const jobA = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000012",
          target_id: targetA.id,
          prompt: "task prompt",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const attemptId = "att_00000000-0000-0000-0000-000000000002";
      const claimToken = "e".repeat(64);

      // Claim succeeds
      const res1 = await fetch(`${baseUrl}/api/connector/jobs/${jobA.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });
      expect(res1.status).toBe(200);

      // Admin disables DeviceTargetBinding
      controlStore.disableDeviceTargetBinding(aliceDeviceId, targetA.id);

      // Verify device is no longer currently eligible
      const resElig = controlStore.resolveEligibleBinding(aliceDeviceId, targetA.id);
      expect(resElig.eligible).toBe(false);

      // Device retries claim with same attempt_id and token
      const resRetry = await fetch(`${baseUrl}/api/connector/jobs/${jobA.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });

      expect(resRetry.status).toBe(200);
      const retryData = await resRetry.json();
      expect(retryData.ok).toBe(true);
      expect(retryData.replayed).toBe(true);
      expect(retryData.attempt.attempt_id).toBe(attemptId);
    });

    it("LOST CLAIM RESPONSE + TARGET DISABLE: replay succeeds even after target is disabled", async () => {
      const jobA = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000013",
          target_id: targetA.id,
          prompt: "task prompt",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const attemptId = "att_00000000-0000-0000-0000-000000000003";
      const claimToken = "f".repeat(64);

      // Claim succeeds
      const res1 = await fetch(`${baseUrl}/api/connector/jobs/${jobA.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });
      expect(res1.status).toBe(200);

      // Admin disables Target A
      controlStore.disableExecutionTarget(targetA.id);

      // Device retries claim with same attempt_id and token
      const resRetry = await fetch(`${baseUrl}/api/connector/jobs/${jobA.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });

      expect(resRetry.status).toBe(200);
      const retryData = await resRetry.json();
      expect(retryData.ok).toBe(true);
      expect(retryData.replayed).toBe(true);
    });

    it("rejects cross-attempt start and report linkage", async () => {
      // Create Job 1 & Job 2 on Target A
      const job1 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000021",
          target_id: targetA.id,
          prompt: "job 1",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );
      const job2 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000022",
          target_id: targetA.id,
          prompt: "job 2",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const att1 = "att_00000000-0000-0000-0000-000000000021";
      const token1 = "1".repeat(64);
      const att2 = "att_00000000-0000-0000-0000-000000000022";
      const token2 = "2".repeat(64);

      await coordinator.claimJob(aliceDeviceId, job1.job.job_id, att1, token1);
      await coordinator.claimJob(aliceDeviceId, job2.job.job_id, att2, token2);

      // Call start on Job 1 with Attempt 2 credentials
      const resStart = await fetch(`${baseUrl}/api/connector/jobs/${job1.job.job_id}/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: att2, claim_token: token2 }),
      });
      expect(resStart.status).toBe(409);

      // Call report on Job 1 with Attempt 2 credentials
      const resReport = await fetch(`${baseUrl}/api/connector/jobs/${job1.job.job_id}/report`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: att2,
          claim_token: token2,
          report: {
            schema_version: 2,
            execution_status: "COMPLETED",
            business_outcome: "UNVERIFIED",
            task_dispatched: true,
            finished_at_ms: Date.now(),
            duration_ms: 100,
            executor: { type: "local", version: "1.0.0" },
            receipt_sha256: "0".repeat(64),
            error: null,
          },
        }),
      });
      expect(resReport.status).toBe(409);
    });
  });

  describe("Job Start & Report Lifecycle", () => {
    it("coordinates full lifecycle: submit -> pending -> claim -> start -> report", async () => {
      const job = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000030",
          target_id: targetA.id,
          prompt: "lifecycle test prompt",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const attemptId = "att_00000000-0000-0000-0000-000000000030";
      const claimToken = "3".repeat(64);

      // Claim
      const claimRes = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });
      expect(claimRes.status).toBe(200);

      // Start
      const startRes = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });
      expect(startRes.status).toBe(200);
      const startData = await startRes.json();
      expect(startData.ok).toBe(true);

      // Report
      const report: ExecutionReport = {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 50,
        executor: { type: "local", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      };

      const repRes = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}/report`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: attemptId,
          claim_token: claimToken,
          report,
        }),
      });
      expect(repRes.status).toBe(200);
      const repData = await repRes.json();
      expect(repData.ok).toBe(true);
      expect(repData.replayed).toBe(false);

      // Replay report
      const repReplay = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}/report`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: attemptId,
          claim_token: claimToken,
          report,
        }),
      });
      expect(repReplay.status).toBe(200);
      const replayData = await repReplay.json();
      expect(replayData.replayed).toBe(true);
    });
  });

  describe("Submission Invariants & Multi-User Decoupling", () => {
    it("submitting to active Target with 0 device bindings succeeds", async () => {
      const unboundTarget = controlStore.createExecutionTarget({
        workspaceId,
        alias: "unbound-target",
        displayName: "Unbound Target",
        kind: "general_automation",
      });

      // No device is bound to unboundTarget
      const res = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000040",
          target_id: unboundTarget.id,
          prompt: "waiting for runner",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      expect(res.status).toBe("created");
      expect(res.job.status).toBe("queued");
    });

    it("rejects submission when target is disabled", async () => {
      const disabledTarget = controlStore.createExecutionTarget({
        workspaceId,
        alias: "disabled-target",
        displayName: "Disabled Target",
        kind: "general_automation",
      });
      controlStore.disableExecutionTarget(disabledTarget.id);

      await expect(
        coordinator.submit(
          { user_id: userAliceId, workspace_id: workspaceId },
          {
            request_id: "req-00000000-0000-0000-0000-000000000041",
            target_id: disabledTarget.id,
            prompt: "fail",
            acceptance: "ok",
            resource_id: null,
            execution_timeout_seconds: 120,
            result_target: "none",
          },
        ),
      ).rejects.toThrow(/disabled/);
    });

    it("rejects submission when user has no workspace membership", async () => {
      // Charlie has no membership in workspaceId
      await expect(
        coordinator.submit(
          { user_id: userCharlieId, workspace_id: workspaceId },
          {
            request_id: "req-00000000-0000-0000-0000-000000000042",
            target_id: targetA.id,
            prompt: "fail",
            acceptance: "ok",
            resource_id: null,
            execution_timeout_seconds: 120,
            result_target: "none",
          },
        ),
      ).rejects.toThrow(/not a member/);
    });

    it("structural invariant: Job.user_id != Device.user_id executes cleanly", async () => {
      // Alice submits job on workspaceId Target A
      const job = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000050",
          target_id: targetA.id,
          prompt: "collab task",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      // Simulate that the job's submitter is a partner user ("usr_submitter_partner")
      const modifiedJob = { ...job.job, user_id: "usr_submitter_partner" };
      const runner = (v2Store as any).redis;
      await runner.set(`ceo:job:v2:${job.job.job_id}`, JSON.stringify(modifiedJob));

      const attemptId = "att_00000000-0000-0000-0000-000000000050";
      const claimToken = "9".repeat(64);

      // Alice's device claims the job
      const claimRes = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attempt_id: attemptId, claim_token: claimToken }),
      });

      expect(claimRes.status).toBe(200);
      const claimData = await claimRes.json();
      expect(claimData.ok).toBe(true);
      expect(claimData.attempt.attempt_id).toBe(attemptId);

      // Attempt preserves submitter ("usr_submitter_partner") while device belongs to Alice
      const savedAttempt = await v2Store.getAttempt(attemptId);
      expect(savedAttempt?.user_id).toBe("usr_submitter_partner");
      expect(savedAttempt?.device_id).toBe(aliceDeviceId);
    });

    it("handles concurrent submit with same request_id returning exactly one Job", async () => {
      const requestId = "req-00000000-0000-0000-0000-000000000060";
      const payload = {
        request_id: requestId,
        target_id: targetA.id,
        prompt: "concurrent prompt",
        acceptance: "acceptance ok",
        resource_id: null,
        execution_timeout_seconds: 120,
        result_target: "none" as const,
      };

      const [res1, res2] = await Promise.all([
        coordinator.submit({ user_id: userAliceId, workspace_id: workspaceId }, payload),
        coordinator.submit({ user_id: userAliceId, workspace_id: workspaceId }, payload),
      ]);

      expect(res1.job.job_id).toBe(res2.job.job_id);
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual(["created", "replayed"]);

      // Verify Redis state: exactly 1 request mapping, 1 job, 1 stream entry, 1 target queue member
      const runner = (v2Store as any).redis;
      const reqVal = await runner.get(`ceo:request:v2:${userAliceId}:${workspaceId}:${requestId}`);
      expect(reqVal).toBe(res1.job.job_id);

      const streamLen = await runner.xlen("ceo:jobs:v2");
      expect(streamLen).toBe(1);

      const targetJobs = await v2Store.getQueuedJobIdsForTarget(targetA.id, 10);
      expect(targetJobs).toHaveLength(1);
      expect(targetJobs[0]?.job_id).toBe(res1.job.job_id);
    });

    it("enforces independent 7-day claim deadline regardless of execution timeout", async () => {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

      // Timeout 60s
      const job60 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000061",
          target_id: targetA.id,
          prompt: "task 60s",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 60,
          result_target: "none",
        },
      );
      expect(job60.job.claim_deadline_ms - job60.job.created_at_ms).toBe(SEVEN_DAYS_MS);

      // Timeout 7200s
      const job7200 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000062",
          target_id: targetA.id,
          prompt: "task 7200s",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 7200,
          result_target: "none",
        },
      );
      expect(job7200.job.claim_deadline_ms - job7200.job.created_at_ms).toBe(SEVEN_DAYS_MS);
    });

    it("allows claim for 2-day-old job but rejects and prunes expired 7-day job", async () => {
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      // Submit job 1 (simulate created 2 days ago)
      const j1 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000063",
          target_id: targetA.id,
          prompt: "2 day old task",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );
      const runner = (v2Store as any).redis;
      const j1Record = {
        ...j1.job,
        created_at_ms: twoDaysAgo,
        claim_deadline_ms: twoDaysAgo + 7 * 24 * 60 * 60 * 1000,
      };
      await runner.set(`ceo:job:v2:${j1.job.job_id}`, JSON.stringify(j1Record));

      // Submit job 2 (simulate created 8 days ago - expired)
      const j2 = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000064",
          target_id: targetA.id,
          prompt: "8 day old task",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );
      const j2Record = {
        ...j2.job,
        created_at_ms: eightDaysAgo,
        claim_deadline_ms: eightDaysAgo + 7 * 24 * 60 * 60 * 1000,
      };
      await runner.set(`ceo:job:v2:${j2.job.job_id}`, JSON.stringify(j2Record));

      // Pending jobs for Alice: should include j1 but prune and exclude j2
      const pending = await coordinator.getPendingJobs(aliceDeviceId, 20);
      const pendingIds = pending.map((p) => p.job_id);
      expect(pendingIds).toContain(j1.job.job_id);
      expect(pendingIds).not.toContain(j2.job.job_id);

      // Attempting to claim j2 returns 410 JOB_EXPIRED
      const claimRes = await fetch(`${baseUrl}/api/connector/jobs/${j2.job.job_id}/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attempt_id: "att_00000000-0000-0000-0000-000000000064",
          claim_token: "a".repeat(64),
        }),
      });
      expect(claimRes.status).toBe(410);
      const claimData = await claimRes.json();
      expect(claimData.error).toBe("JOB_EXPIRED");
    });

    it("validates target queue association and prunes foreign target jobs from queue", async () => {
      // Bob submits job for Target B in bobWorkspaceId
      const jobB = await coordinator.submit(
        { user_id: userBobId, workspace_id: bobWorkspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000070",
          target_id: targetB.id,
          prompt: "task on target B",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      // Simulate corruption: Target B job is injected into Target A's queue
      const runner = (v2Store as any).redis;
      await (runner as any).zadd(`ceo:target:v1:${targetA.id}:jobs`, Date.now(), jobB.job.job_id);

      // Alice's device is only eligible for Target A
      const pendingAlice = await coordinator.getPendingJobs(aliceDeviceId, 20);
      const pendingIds = pendingAlice.map((p) => p.job_id);

      // Must NOT return jobB
      expect(pendingIds).not.toContain(jobB.job.job_id);

      // Incorrect Target A queue entry is pruned
      const targetAQueueAfter = await v2Store.getQueuedJobIdsForTarget(targetA.id, 10);
      expect(targetAQueueAfter.map((r) => r.job_id)).not.toContain(jobB.job.job_id);

      // Job B record remains intact
      const intactJobB = await v2Store.getJob(jobB.job.job_id);
      expect(intactJobB).not.toBeNull();
      expect(intactJobB?.target_id).toBe(targetB.id);
      expect(intactJobB?.status).toBe("queued");
    });
  });

  describe("Device Read Surfaces (GET list & detail)", () => {
    async function submitJobForAlice(requestId: string, prompt: string) {
      return coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: requestId,
          target_id: targetA.id,
          prompt,
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );
    }

    it("lists device-visible jobs newest first and supports state/target/limit filters", async () => {
      const job1 = await submitJobForAlice(
        "req-00000000-0000-0000-0000-000000000080",
        "first job",
      );
      const job2 = await submitJobForAlice(
        "req-00000000-0000-0000-0000-000000000081",
        "second job",
      );

      const res = await fetch(`${baseUrl}/api/connector/jobs`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      const ids: string[] = data.jobs.map((j: any) => j.job_id);
      expect(ids).toContain(job1.job.job_id);
      expect(ids).toContain(job2.job.job_id);
      // Newest first
      expect(data.jobs[0].job_id).toBe(job2.job.job_id);
      expect(data.jobs[0].target_alias).toBe("target-a");
      expect(data.jobs[0].state).toBe("queued");

      // State filter: both jobs are queued
      const queuedRes = await fetch(`${baseUrl}/api/connector/jobs?state=queued`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      const queuedData = await queuedRes.json();
      expect(queuedData.jobs.length).toBe(2);

      // Target filter
      const targetRes = await fetch(
        `${baseUrl}/api/connector/jobs?target_id=${targetA.id}`,
        { headers: { Authorization: `Bearer ${aliceDevToken}` } },
      );
      const targetData = await targetRes.json();
      expect(targetData.jobs.length).toBe(2);

      // Limit
      const limitRes = await fetch(`${baseUrl}/api/connector/jobs?limit=1`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      const limitData = await limitRes.json();
      expect(limitData.jobs.length).toBe(1);

      // Terminal state filter returns none (no terminal jobs yet)
      const terminalRes = await fetch(`${baseUrl}/api/connector/jobs?state=terminal`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      const terminalData = await terminalRes.json();
      expect(terminalData.jobs.length).toBe(0);
    });

    it("returns 400 for invalid state filter and 401 without auth", async () => {
      const bad = await fetch(`${baseUrl}/api/connector/jobs?state=bogus`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      expect(bad.status).toBe(400);

      const unauth = await fetch(`${baseUrl}/api/connector/jobs`);
      expect(unauth.status).toBe(401);
    });

    it("hides jobs on targets the device has never been bound to", async () => {
      // Bob submits a job to Target B (Bob's workspace); Alice must not see it.
      const jobB = await coordinator.submit(
        { user_id: userBobId, workspace_id: bobWorkspaceId },
        {
          request_id: "req-00000000-0000-0000-0000-000000000090",
          target_id: targetB.id,
          prompt: "bob-only job",
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );

      const res = await fetch(`${baseUrl}/api/connector/jobs`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      const data = await res.json();
      const ids: string[] = data.jobs.map((j: any) => j.job_id);
      expect(ids).not.toContain(jobB.job.job_id);

      const detail = await fetch(
        `${baseUrl}/api/connector/jobs/${jobB.job.job_id}`,
        { headers: { Authorization: `Bearer ${aliceDevToken}` } },
      );
      expect(detail.status).toBe(404);
    });

    it("returns job detail without task by default and with include_task=true", async () => {
      const job = await submitJobForAlice(
        "req-00000000-0000-0000-0000-000000000091",
        "detail prompt body",
      );

      const noTask = await fetch(`${baseUrl}/api/connector/jobs/${job.job.job_id}`, {
        headers: { Authorization: `Bearer ${aliceDevToken}` },
      });
      expect(noTask.status).toBe(200);
      const noTaskData = await noTask.json();
      expect(noTaskData.job_id).toBe(job.job.job_id);
      expect(noTaskData.state).toBe("queued");
      expect(noTaskData.task).toBeUndefined();

      const withTask = await fetch(
        `${baseUrl}/api/connector/jobs/${job.job.job_id}?include_task=true`,
        { headers: { Authorization: `Bearer ${aliceDevToken}` } },
      );
      expect(withTask.status).toBe(200);
      const withTaskData = await withTask.json();
      expect(withTaskData.task).toBeDefined();
      expect(withTaskData.task.prompt).toBe("detail prompt body");
      expect(withTaskData.task.acceptance).toBe("ok");
      expect(withTaskData.execution_timeout_seconds).toBe(120);
    });

    it("returns 404 for unknown job detail", async () => {
      const res = await fetch(
        `${baseUrl}/api/connector/jobs/job-00000000-0000-0000-0000-000000000099`,
        { headers: { Authorization: `Bearer ${aliceDevToken}` } },
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("JOB_NOT_FOUND");
    });
  });

  describe("Job Cancel (Wave 2B operator control)", () => {
    async function submitJobForAlice(requestId: string, prompt = "cancel-me") {
      return coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: requestId,
          target_id: targetA.id,
          prompt,
          acceptance: "ok",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      );
    }

    async function cancelViaApi(jobId: string, token = aliceDevToken) {
      return fetch(`${baseUrl}/api/connector/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    }

    it("cancels a queued job immediately: terminal/CANCELLED with no attempt created", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a1");
      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toMatchObject({
        job_id: job.job_id,
        previous_state: "queued",
        state: "terminal",
        execution_status: "CANCELLED",
        business_outcome: "NOT_STARTED",
        action: "cancelled",
        attempt_id: null,
      });
      expect(typeof body.message).toBe("string");

      // No attempt was created and the durable record reflects it.
      const stored = await v2Store.getJob(job.job_id);
      expect(stored?.status).toBe("terminal");
      expect(stored?.latest_attempt_id).toBeNull();
      expect(stored?.cancel?.requested_by_device_id).toBe(aliceDeviceId);

      // Read models reflect the cancelled terminal state.
      const detail = await coordinator.getJobForDevice(aliceDeviceId, userAliceId, job.job_id);
      expect(detail.state).toBe("terminal");
      expect(detail.execution_status).toBe("CANCELLED");
      expect(detail.business_outcome).toBe("NOT_STARTED");
      expect(detail.execution).toBeNull();
      expect(detail.report).toBeNull();
    });

    it("replays queued cancel idempotently", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a2");
      const res1 = await cancelViaApi(job.job_id);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.action).toBe("cancelled");

      const res2 = await cancelViaApi(job.job_id);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2).toMatchObject({
        previous_state: "terminal",
        state: "terminal",
        execution_status: "CANCELLED",
        action: "already_cancelled",
        attempt_id: null,
      });
    });

    it("cancels a running job: current attempt terminalized authoritatively (stale runner convergence)", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a3");
      const attemptId = "att_00000000-0000-0000-0000-0000000000a3";
      const claimToken = "a".repeat(64);
      await coordinator.claimJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      await coordinator.startJob(aliceDeviceId, job.job_id, attemptId, claimToken);

      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        job_id: job.job_id,
        previous_state: "running",
        state: "terminal",
        execution_status: "CANCELLED",
        action: "cancelled",
        attempt_id: attemptId,
      });

      // No second attempt was created; the original attempt carries the
      // authoritative operator-cancelled report (stale-runner convergence
      // does not require the original device to come back online).
      const stored = await v2Store.getJob(job.job_id);
      expect(stored?.status).toBe("terminal");
      expect(stored?.latest_attempt_id).toBe(attemptId);
      const attempt = await v2Store.getAttempt(attemptId);
      expect(attempt?.phase).toBe("terminal");
      expect(attempt?.report?.execution_status).toBe("CANCELLED");
      expect(attempt?.report?.task_dispatched).toBe(true);
      expect(attempt?.report?.error?.code).toBe("OPERATOR_CANCELLED");

      const detail = await coordinator.getJobForDevice(aliceDeviceId, userAliceId, job.job_id);
      expect(detail.state).toBe("terminal");
      expect(detail.execution_status).toBe("CANCELLED");
      expect(detail.report?.execution_status).toBe("CANCELLED");
    });

    it("cancels a claimed (not started) job without dispatch metadata", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a4");
      const attemptId = "att_00000000-0000-0000-0000-0000000000a4";
      const claimToken = "b".repeat(64);
      await coordinator.claimJob(aliceDeviceId, job.job_id, attemptId, claimToken);

      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        previous_state: "claimed",
        state: "terminal",
        execution_status: "CANCELLED",
        business_outcome: "NOT_STARTED",
        action: "cancelled",
        attempt_id: attemptId,
      });

      const attempt = await v2Store.getAttempt(attemptId);
      expect(attempt?.phase).toBe("terminal");
      expect(attempt?.report?.task_dispatched).toBe(false);
      expect(attempt?.report?.business_outcome).toBe("NOT_STARTED");
    });

    it("replays cancel on an already-cancelled running job idempotently", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a5");
      const attemptId = "att_00000000-0000-0000-0000-0000000000a5";
      const claimToken = "c".repeat(64);
      await coordinator.claimJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      await coordinator.startJob(aliceDeviceId, job.job_id, attemptId, claimToken);

      const res1 = await cancelViaApi(job.job_id);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.action).toBe("cancelled");

      const res2 = await cancelViaApi(job.job_id);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2).toMatchObject({
        previous_state: "terminal",
        state: "terminal",
        execution_status: "CANCELLED",
        action: "already_cancelled",
        attempt_id: attemptId,
      });
    });

    it("does not rewrite COMPLETED history into CANCELLED", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a6");
      const attemptId = "att_00000000-0000-0000-0000-0000000000a6";
      const claimToken = "d".repeat(64);
      await coordinator.claimJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      await coordinator.startJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      await coordinator.reportJob(aliceDeviceId, job.job_id, attemptId, claimToken, {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 120,
        executor: { type: "local", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      });

      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        previous_state: "terminal",
        state: "terminal",
        execution_status: "COMPLETED",
        action: "already_terminal",
        attempt_id: attemptId,
      });
      expect(body.message).toMatch(/not rewritten/i);

      const detail = await coordinator.getJobForDevice(aliceDeviceId, userAliceId, job.job_id);
      expect(detail.state).toBe("terminal");
      expect(detail.execution_status).toBe("COMPLETED");
    });

    it("deterministic late-report race precedence: operator cancel wins, late COMPLETED report is rejected", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a7");
      const attemptId = "att_00000000-0000-0000-0000-0000000000a7";
      const claimToken = "e".repeat(64);
      await coordinator.claimJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      await coordinator.startJob(aliceDeviceId, job.job_id, attemptId, claimToken);

      // Operator cancel lands first (authoritative terminalization).
      const cancelRes = await cancelViaApi(job.job_id);
      expect(cancelRes.status).toBe(200);
      expect((await cancelRes.json()).action).toBe("cancelled");

      // The live runner's late COMPLETED report must not overwrite it.
      const reportRes = await fetch(`${baseUrl}/api/connector/jobs/${job.job_id}/report`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aliceDevToken}`,
          "Content-Type": "application/json",
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
            executor: { type: "local", version: "1.0.0" },
            receipt_sha256: "0".repeat(64),
            error: null,
          },
        }),
      });
      expect(reportRes.status).toBe(409);

      const detail = await coordinator.getJobForDevice(aliceDeviceId, userAliceId, job.job_id);
      expect(detail.state).toBe("terminal");
      expect(detail.execution_status).toBe("CANCELLED");
    });

    it("cancels an expired (unclaimed) job to terminal CANCELLED", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a8");
      const runner = (v2Store as any).redis;
      const expired = {
        ...job,
        created_at_ms: job.created_at_ms - 8 * 24 * 60 * 60 * 1000,
        claim_deadline_ms: job.claim_deadline_ms - 8 * 24 * 60 * 60 * 1000,
      };
      await runner.set(`ceo:job:v2:${job.job_id}`, JSON.stringify(expired));

      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        previous_state: "expired",
        state: "terminal",
        execution_status: "CANCELLED",
        action: "cancelled",
        attempt_id: null,
      });
    });

    it("does not leak inaccessible jobs and validates input", async () => {
      // Bob's device cannot see Alice's job on Target A: 404, same as missing.
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000a9");
      const bobRes = await cancelViaApi(job.job_id, bobDevToken);
      expect(bobRes.status).toBe(404);
      expect(await bobRes.json()).toEqual({ error: "JOB_NOT_FOUND" });

      // Job remains untouched.
      const detail = await coordinator.getJobForDevice(aliceDeviceId, userAliceId, job.job_id);
      expect(detail.state).toBe("queued");

      // Invalid job id format -> 400.
      const badRes = await cancelViaApi("not-a-job-id");
      expect(badRes.status).toBe(400);

      // Unknown job -> 404.
      const unknownRes = await cancelViaApi(
        "job-00000000-0000-0000-0000-0000000000ff",
      );
      expect(unknownRes.status).toBe(404);
    });

    it("cancelling a job removes it from pending discovery", async () => {
      const { job } = await submitJobForAlice("req-00000000-0000-0000-0000-0000000000b1");
      expect((await coordinator.getPendingJobs(aliceDeviceId, 20)).map((p) => p.job_id)).toContain(
        job.job_id,
      );

      const res = await cancelViaApi(job.job_id);
      expect(res.status).toBe(200);

      expect((await coordinator.getPendingJobs(aliceDeviceId, 20)).map((p) => p.job_id)).not.toContain(
        job.job_id,
      );
      const terminalList = await coordinator.listJobsForDevice(aliceDeviceId, userAliceId, {
        state: "terminal",
      });
      expect(terminalList.jobs.map((j) => j.job_id)).toContain(job.job_id);
      const cancelledJob = terminalList.jobs.find((j) => j.job_id === job.job_id);
      expect(cancelledJob?.execution_status).toBe("CANCELLED");
    });
  });
});
