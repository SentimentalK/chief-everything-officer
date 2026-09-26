import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { RedisJobStoreV2, V2StoreError } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2, deriveHostJobState } from "../src/jobs/v2-service.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { type JobRecordV2, type AttemptRecordV1, type ResultTarget, KEY_STREAM_V2 } from "../src/jobs/v2-schema.js";

describe("Connector V1.5 Host Job Query & Stream Traversal", () => {
  const cleanupDirs: string[] = [];
  let identityStore: IdentityStore;
  let controlStore: ConnectorControlStore;
  let fakeRedis: ReturnType<typeof createFakeRedisRunner>;
  let v2Store: RedisJobStoreV2;
  let coordinator: JobCoordinatorV2;
  let dbPath: string;

  const userAliceId = "usr_alice";
  const userBobId = "usr_bob";
  const workspaceAId = "ws_alpha";
  const workspaceBId = "ws_beta";

  let targetA1: { id: string; alias: string };
  let targetA2: { id: string; alias: string };
  let targetB1: { id: string; alias: string };

  let mockNowMs = 1_000_000;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-v15-query-test-"));
    cleanupDirs.push(dir);
    dbPath = path.join(dir, "identity.sqlite");
    provisionEmptyControlPlaneDatabase(dbPath);

    identityStore = IdentityStore.open(dbPath);
    controlStore = new ConnectorControlStore(identityStore);

    fakeRedis = createFakeRedisRunner();
    v2Store = new RedisJobStoreV2(fakeRedis);

    mockNowMs = Date.now();
    coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
      nowMs: () => mockNowMs,
    });

    identityStore.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userAliceId);
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userBobId);

      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/alice/repo.git', 'main', 1000);").run(
        workspaceAId,
        userAliceId,
      );
      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/bob/repo.git', 'main', 1000);").run(
        workspaceBId,
        userBobId,
      );

      db.prepare("INSERT INTO workspace_memberships VALUES ('wm_1', ?, ?, 'owner', 1000);").run(
        workspaceAId,
        userAliceId,
      );
      db.prepare("INSERT INTO workspace_memberships VALUES ('wm_2', ?, ?, 'owner', 1000);").run(
        workspaceBId,
        userBobId,
      );
    });

    targetA1 = controlStore.createExecutionTarget({
      workspaceId: workspaceAId,
      alias: "target-a1",
      displayName: "Target A1",
      kind: "coding",
    });
    targetA2 = controlStore.createExecutionTarget({
      workspaceId: workspaceAId,
      alias: "target-a2",
      displayName: "Target A2",
      kind: "coding",
    });
    targetB1 = controlStore.createExecutionTarget({
      workspaceId: workspaceBId,
      alias: "target-b1",
      displayName: "Target B1",
      kind: "coding",
    });
  });

  afterEach(async () => {
    identityStore.close();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  describe("deriveHostJobState", () => {
    const baseJob: JobRecordV2 = {
      schema_version: 6,
      job_id: "job-11111111-1111-1111-1111-111111111111",
      request_id: "req-11111111-1111-1111-1111-111111111111",
      user_id: userAliceId,
      workspace_id: workspaceAId,
      target_id: "tgt_11111111-1111-1111-1111-111111111111",
      prompt: "prompt",
      acceptance: "acceptance",
      resource_id: null,
      execution_timeout_seconds: 3600,
      result_target: "none",
      request_digest: "digest",
      status: "queued",
      stream_entry_id: "1000-1",
      latest_attempt_id: null,
      created_at_ms: 1000,
      claim_deadline_ms: 2000,
    };

    it("derives queued when now < claim_deadline_ms", () => {
      const state = deriveHostJobState(baseJob, null, 1500);
      expect(state).toBe("queued");
    });

    it("derives expired when now >= claim_deadline_ms", () => {
      const state = deriveHostJobState(baseJob, null, 2500);
      expect(state).toBe("expired");
    });

    it("derives claimed and running for active jobs with valid attempt", () => {
      const activeJob: JobRecordV2 = { ...baseJob, status: "active", latest_attempt_id: "att-1" };
      const baseAttempt: AttemptRecordV1 = {
        schema_version: 1,
        attempt_id: "att-1",
        job_id: baseJob.job_id,
        user_id: userAliceId,
        workspace_id: workspaceAId,
        target_id: baseJob.target_id,
        device_id: "dev_11111111-1111-1111-1111-111111111111",
        target_binding_id: "dtb_11111111-1111-1111-1111-111111111111",
        claim_token_sha256: "0".repeat(64),
        phase: "claimed",
        claimed_at_ms: 1200,
        started_at_ms: null,
      };

      expect(deriveHostJobState(activeJob, baseAttempt, 1500)).toBe("claimed");
      expect(
        deriveHostJobState(
          activeJob,
          { ...baseAttempt, phase: "running", started_at_ms: 1300 },
          1500,
        ),
      ).toBe("running");
    });

    it("derives terminal for terminal job with terminal attempt", () => {
      const terminalJob: JobRecordV2 = { ...baseJob, status: "terminal", latest_attempt_id: "att-1" };
      const terminalAttempt: AttemptRecordV1 = {
        schema_version: 1,
        attempt_id: "att-1",
        job_id: baseJob.job_id,
        user_id: userAliceId,
        workspace_id: workspaceAId,
        target_id: baseJob.target_id,
        device_id: "dev_11111111-1111-1111-1111-111111111111",
        target_binding_id: "dtb_11111111-1111-1111-1111-111111111111",
        claim_token_sha256: "0".repeat(64),
        phase: "terminal",
        claimed_at_ms: 1200,
        started_at_ms: 1300,
      };

      expect(deriveHostJobState(terminalJob, terminalAttempt, 1500)).toBe("terminal");
    });

    it("fails closed on corrupt or inconsistent states", () => {
      // preparing
      expect(() => deriveHostJobState({ ...baseJob, status: "preparing" }, null, 1500)).toThrow(
        /CORRUPT_JOB_STATE/,
      );

      // active without attempt
      expect(() => deriveHostJobState({ ...baseJob, status: "active" }, null, 1500)).toThrow(
        /CORRUPT_JOB_STATE/,
      );

      // terminal without attempt
      expect(() => deriveHostJobState({ ...baseJob, status: "terminal" }, null, 1500)).toThrow(
        /CORRUPT_JOB_STATE/,
      );
    });
  });

  describe("listJobsForHost: two-phase stream tenant isolation", () => {
    it("skips foreign workspace stream entries without reading Job or failing on foreign malformed fields", async () => {
      // Alice submits a valid job in Workspace A
      const aliceSub = await coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceAId },
        {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Alice Task",
          acceptance: "Criteria",
          resource_id: null,
          execution_timeout_seconds: 3600,
          result_target: "none",
        },
      );

      // Inject a corrupt stream entry belonging to Workspace B (foreign)
      // It has missing schema_version, invalid job_id format, etc., but has valid workspace_id: workspaceBId
      await fakeRedis.xaddStream(KEY_STREAM_V2, {
        workspace_id: workspaceBId,
        corrupt_field: "invalid-data",
        schema_version: "invalid",
        job_id: "not-a-valid-job-uuid",
      });

      // Alice lists jobs for Workspace A.
      // The corrupt entry in Workspace B must be skipped immediately without crashing or loading Job.
      const res = await coordinator.listJobsForHost(
        { user_id: userAliceId, workspace_id: workspaceAId },
        { limit: 10 },
      );

      expect(res.jobs).toHaveLength(1);
      expect(res.jobs[0].job_id).toBe(aliceSub.job.job_id);
    });

    it("fails closed with CORRUPT_JOB_INDEX when stream entry workspace_id is missing or empty", async () => {
      // Inject entry without workspace_id
      await fakeRedis.xaddStream(KEY_STREAM_V2, {
        schema_version: "2",
        job_id: `job-${crypto.randomUUID()}`,
        // missing workspace_id
      });

      await expect(
        coordinator.listJobsForHost(
          { user_id: userAliceId, workspace_id: workspaceAId },
          { limit: 10 },
        ),
      ).rejects.toThrow(/CORRUPT_JOB_INDEX/);
    });

    it("fails closed with CORRUPT_JOB_INDEX when authenticated workspace entry points to missing Job", async () => {
      // Inject entry pointing to non-existent job in Workspace A
      await fakeRedis.xaddStream(KEY_STREAM_V2, {
        schema_version: "2",
        job_id: `job-${crypto.randomUUID()}`,
        user_id: userAliceId,
        workspace_id: workspaceAId,
        target_id: targetA1.id,
        created_at_ms: "1000",
      });

      await expect(
        coordinator.listJobsForHost(
          { user_id: userAliceId, workspace_id: workspaceAId },
          { limit: 10 },
        ),
      ).rejects.toThrow(/CORRUPT_JOB_INDEX/);
    });
  });

  describe("listJobsForHost: pagination and mid-batch cursor semantics", () => {
    it("handles limit reached mid-batch setting next_cursor to last scanned entry without skipping", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };

      // Submit 5 jobs in Workspace A
      const submittedJobIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        mockNowMs += 1000;
        const sub = await coordinator.submit(scopeA, {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: `Task ${i}`,
          acceptance: `Criteria ${i}`,
          resource_id: null,
          execution_timeout_seconds: 3600,
          result_target: "none",
        });
        submittedJobIds.push(sub.job.job_id);
      }

      // Reverse order (newest first):
      const expectedOrder = [...submittedJobIds].reverse();

      // Page 1: limit 2
      const page1 = await coordinator.listJobsForHost(scopeA, { limit: 2 });
      expect(page1.jobs).toHaveLength(2);
      expect(page1.jobs.map((j) => j.job_id)).toEqual(expectedOrder.slice(0, 2));
      expect(page1.next_cursor).toBeTruthy();

      // Page 2: limit 2 starting from page1.next_cursor
      const page2 = await coordinator.listJobsForHost(scopeA, {
        limit: 2,
        cursor: page1.next_cursor,
      });
      expect(page2.jobs).toHaveLength(2);
      expect(page2.jobs.map((j) => j.job_id)).toEqual(expectedOrder.slice(2, 4));
      expect(page2.next_cursor).toBeTruthy();

      // Page 3: limit 2 starting from page2.next_cursor (only 1 remaining)
      const page3 = await coordinator.listJobsForHost(scopeA, {
        limit: 2,
        cursor: page2.next_cursor,
      });
      expect(page3.jobs).toHaveLength(1);
      expect(page3.jobs.map((j) => j.job_id)).toEqual(expectedOrder.slice(4, 5));
      expect(page3.next_cursor).toBeNull();
    });

    it("paginates seamlessly across interleaved multi-tenant jobs in global stream", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };
      const scopeB = { user_id: userBobId, workspace_id: workspaceBId };

      const aliceJobs: string[] = [];
      const bobJobs: string[] = [];

      // Interleave submissions: A1, B1, A2, B2, A3, B3
      for (let i = 1; i <= 3; i++) {
        mockNowMs += 1000;
        const subA = await coordinator.submit(scopeA, {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: `Alice Task ${i}`,
          acceptance: "Criteria",
          resource_id: null,
          execution_timeout_seconds: 3600,
          result_target: "none",
        });
        aliceJobs.push(subA.job.job_id);

        mockNowMs += 1000;
        const subB = await coordinator.submit(scopeB, {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetB1.id,
          prompt: `Bob Task ${i}`,
          acceptance: "Criteria",
          resource_id: null,
          execution_timeout_seconds: 3600,
          result_target: "none",
        });
        bobJobs.push(subB.job.job_id);
      }

      // Alice paginates with limit 2
      const page1 = await coordinator.listJobsForHost(scopeA, { limit: 2 });
      expect(page1.jobs).toHaveLength(2);
      expect(page1.jobs[0].job_id).toBe(aliceJobs[2]); // A3
      expect(page1.jobs[1].job_id).toBe(aliceJobs[1]); // A2
      expect(page1.next_cursor).toBeTruthy();

      const page2 = await coordinator.listJobsForHost(scopeA, {
        limit: 2,
        cursor: page1.next_cursor,
      });
      expect(page2.jobs).toHaveLength(1);
      expect(page2.jobs[0].job_id).toBe(aliceJobs[0]); // A1
      expect(page2.next_cursor).toBeNull();
    });
  });

  describe("listJobsForHost: target and status filtering", () => {
    it("filters by target_id, rejecting targets from other workspaces", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };

      // Submit job to Target A1
      const sub1 = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Task for A1",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      // Submit job to Target A2
      const sub2 = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA2.id,
        prompt: "Task for A2",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      // Filter by Target A1
      const resA1 = await coordinator.listJobsForHost(scopeA, { target_id: targetA1.id });
      expect(resA1.jobs).toHaveLength(1);
      expect(resA1.jobs[0].job_id).toBe(sub1.job.job_id);

      // Filter by Target A2
      const resA2 = await coordinator.listJobsForHost(scopeA, { target_id: targetA2.id });
      expect(resA2.jobs).toHaveLength(1);
      expect(resA2.jobs[0].job_id).toBe(sub2.job.job_id);

      // Filtering with Target B1 (belongs to Workspace B) throws TargetNotFoundError
      await expect(
        coordinator.listJobsForHost(scopeA, { target_id: targetB1.id }),
      ).rejects.toThrow(/Execution target not found/);
    });

    it("filters by lifecycle state and execution status", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };

      // Submit queued job
      const subQueued = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Queued Task",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      // Submit and claim active job
      const subActive = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Active Task",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      const device = controlStore.createDevice({
        userId: userAliceId,
        displayName: "Dev1",
        platform: "linux",
      });
      const secret = "a".repeat(64);
      controlStore.createDeviceCredential({
        deviceId: device.id,
        secretDigest: crypto.createHash("sha256").update(secret).digest("hex"),
        expiresAtMs: Date.now() + 3600_000,
      });
      controlStore.upsertDeviceTargetBinding({ deviceId: device.id, targetId: targetA1.id });

      const attemptActive = `att-${crypto.randomUUID()}`;
      const tokenActive = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(device.id, subActive.job.job_id, attemptActive, tokenActive);
      await coordinator.startJob(device.id, subActive.job.job_id, attemptActive, tokenActive);

      // Filter by state: queued
      const listQueued = await coordinator.listJobsForHost(scopeA, { state: "queued" });
      expect(listQueued.jobs.some((j) => j.job_id === subQueued.job.job_id)).toBe(true);
      expect(listQueued.jobs.some((j) => j.job_id === subActive.job.job_id)).toBe(false);

      // Filter by state: running
      const listRunning = await coordinator.listJobsForHost(scopeA, { state: "running" });
      expect(listRunning.jobs.some((j) => j.job_id === subActive.job.job_id)).toBe(true);
      expect(listRunning.jobs.some((j) => j.job_id === subQueued.job.job_id)).toBe(false);
    });
  });

  describe("Target linkage integrity and host projections", () => {
    it("fails closed with CORRUPT_TARGET_STATE when target is missing from control store", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };

      const sub = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Task",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      // Delete target from control plane SQLite
      identityStore.withDb((db) => {
        db.prepare("DELETE FROM execution_targets WHERE id = ?;").run(targetA1.id);
      });

      await expect(coordinator.getJobForHost(scopeA, sub.job.job_id)).rejects.toThrow(
        /CORRUPT_TARGET_STATE/,
      );

      await expect(coordinator.listJobsForHost(scopeA, { limit: 10 })).rejects.toThrow(
        /CORRUPT_TARGET_STATE/,
      );
    });

    it("verifies expires_at lifecycle (non-null only for queued and expired)", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };

      const sub = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Lifecycle Task",
        acceptance: "Criteria",
        resource_id: null,
        execution_timeout_seconds: 3600,
        result_target: "none",
      });

      // 1. Queued: expires_at is non-null ISO string
      const queuedDetail = await coordinator.getJobForHost(scopeA, sub.job.job_id);
      expect(queuedDetail.state).toBe("queued");
      expect(queuedDetail.expires_at).toBeTruthy();
      expect(new Date(queuedDetail.expires_at!).getTime()).toBe(sub.job.claim_deadline_ms);

      // 2. Active / claimed: expires_at is null
      const device = controlStore.createDevice({
        userId: userAliceId,
        displayName: "Dev1",
        platform: "linux",
      });
      const secret = "a".repeat(64);
      controlStore.createDeviceCredential({
        deviceId: device.id,
        secretDigest: crypto.createHash("sha256").update(secret).digest("hex"),
        expiresAtMs: Date.now() + 3600_000,
      });
      controlStore.upsertDeviceTargetBinding({ deviceId: device.id, targetId: targetA1.id });

      const attemptId = `att-${crypto.randomUUID()}`;
      const claimToken = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(device.id, sub.job.job_id, attemptId, claimToken);

      const claimedDetail = await coordinator.getJobForHost(scopeA, sub.job.job_id);
      expect(claimedDetail.state).toBe("claimed");
      expect(claimedDetail.expires_at).toBeNull();

      // 3. Running: expires_at is null
      await coordinator.startJob(device.id, sub.job.job_id, attemptId, claimToken);
      const runningDetail = await coordinator.getJobForHost(scopeA, sub.job.job_id);
      expect(runningDetail.state).toBe("running");
      expect(runningDetail.expires_at).toBeNull();

      // 4. Terminal: expires_at is null
      await coordinator.reportJob(device.id, sub.job.job_id, attemptId, claimToken, {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 200,
        executor: { type: "test", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      });
      const terminalDetail = await coordinator.getJobForHost(scopeA, sub.job.job_id);
      expect(terminalDetail.state).toBe("terminal");
      expect(terminalDetail.expires_at).toBeNull();
    });

    it("enforces separation between lightweight summary and full detail", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };
      const reqId = `req-${crypto.randomUUID()}`;

      const sub = await coordinator.submit(scopeA, {
        request_id: reqId,
        target_id: targetA1.id,
        prompt: "Super secret prompt",
        acceptance: "Super secret acceptance",
        resource_id: null,
        execution_timeout_seconds: 120,
        result_target: "none",
      });

      // HostJobDetail includes request_id and execution_timeout_seconds
      const detail = await coordinator.getJobForHost(scopeA, sub.job.job_id, { include_task: true });
      expect(detail.request_id).toBe(reqId);
      expect(detail.execution_timeout_seconds).toBe(120);
      expect(detail.target_alias).toBe("target-a1");
      expect(detail.task?.prompt).toBe("Super secret prompt");

      // HostJobSummary from listJobsForHost does not expose task, execution, report, or result
      const list = await coordinator.listJobsForHost(scopeA, { limit: 10 });
      expect(list.jobs).toHaveLength(1);
      const summary = list.jobs[0];
      expect(summary.job_id).toBe(sub.job.job_id);
      expect(summary.request_id).toBe(reqId);
      expect(summary.target_alias).toBe("target-a1");
      expect(summary.state).toBe("queued");
      expect((summary as any).task).toBeUndefined();
      expect((summary as any).execution).toBeUndefined();
      expect((summary as any).report).toBeUndefined();
      expect((summary as any).result).toBeUndefined();
      expect((summary as any).execution_timeout_seconds).toBeUndefined();
    });

    it("projects complete report and result fields in HostJobDetail while HostJobSummary omits them", async () => {
      const scopeA = { user_id: userAliceId, workspace_id: workspaceAId };
      const sub = await coordinator.submit(scopeA, {
        request_id: `req-${crypto.randomUUID()}`,
        target_id: targetA1.id,
        prompt: "Task with full metadata",
        acceptance: "Criteria",
        resource_id: "res-22222222-2222-2222-2222-222222222222",
        execution_timeout_seconds: 3600,
        result_target: "resource",
      });

      const device = controlStore.createDevice({ userId: userAliceId, displayName: "Dev-Full", platform: "linux" });
      controlStore.createDeviceCredential({
        deviceId: device.id,
        secretDigest: crypto.createHash("sha256").update("d".repeat(64)).digest("hex"),
        expiresAtMs: Date.now() + 3600_000,
      });
      controlStore.upsertDeviceTargetBinding({ deviceId: device.id, targetId: targetA1.id });

      const attemptId = `att-${crypto.randomUUID()}`;
      const token = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(device.id, sub.job.job_id, attemptId, token);
      await coordinator.startJob(device.id, sub.job.job_id, attemptId, token);

      // In V1.8, result must exist before reportJob for result_target='resource'
      const attemptKey = `ceo:attempt:v1:${attemptId}`;
      const rawAttempt = JSON.parse((await fakeRedis.get(attemptKey))!);
      rawAttempt.result = {
        target: "resource",
        attempt_id: attemptId,
        payload_sha256: "4".repeat(64),
        resource_id: "res-22222222-2222-2222-2222-222222222222",
        commit: "fedcba987",
        received_at_ms: 1700000005000,
      };
      await fakeRedis.set(attemptKey, JSON.stringify(rawAttempt));

      await coordinator.reportJob(device.id, sub.job.job_id, attemptId, token, {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: 1700000000000,
        duration_ms: 450,
        executor: { type: "orca", version: "3.2.1" },
        receipt_sha256: "3".repeat(64),
        error: null,
      });

      // HostJobDetail
      const detail = await coordinator.getJobForHost(scopeA, sub.job.job_id);
      expect(detail.report).toEqual({
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at: new Date(1700000000000).toISOString(),
        duration_ms: 450,
        executor: { type: "orca", version: "3.2.1" },
        receipt_sha256: "3".repeat(64),
        error: null,
        received_at: expect.any(String),
      });
      expect(detail.result).toEqual({
        target: "resource",
        attempt_id: attemptId,
        payload_sha256: "4".repeat(64),
        resource_id: "res-22222222-2222-2222-2222-222222222222",
        commit: "fedcba987",
        received_at: new Date(1700000005000).toISOString(),
      });

      // HostJobSummary from listJobsForHost
      const list = await coordinator.listJobsForHost(scopeA, { limit: 10 });
      const summary = list.jobs.find((j) => j.job_id === sub.job.job_id)!;
      expect(summary.execution_status).toBe("COMPLETED");
      expect(summary.business_outcome).toBe("UNVERIFIED");
      expect((summary as any).report).toBeUndefined();
      expect((summary as any).result).toBeUndefined();
      expect((summary as any).execution).toBeUndefined();
    });
  });
});
