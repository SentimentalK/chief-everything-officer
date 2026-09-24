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
  });
});
