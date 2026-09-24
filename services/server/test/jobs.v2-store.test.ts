import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  RedisJobStoreV2,
  V2StoreError,
  V2JobNotFoundError,
  V2JobAlreadyClaimedError,
  V2JobExpiredError,
  V2JobFinishedError,
  V2IdempotencyConflictError,
  V2AttemptLifecycleError,
  V2ReportConflictError,
} from "../src/jobs/v2-store.js";
import {
  JOBS_V2_SCHEMA_VERSION,
  businessDigestV2,
  jobKeyV2,
  attemptKeyV1,
  targetQueueKeyV1,
  jobAttemptsKeyV1,
  requestKeyV2,
  type JobRecordV2,
} from "../src/jobs/v2-schema.js";
import { type ExecutionReport } from "../src/jobs/execution-contract.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { createRedisRunnerFromClient, type RedisRunner } from "../src/jobs/redis-runner.js";

const URL = process.env.CEO_REDIS_URL;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeJobRecord(patch: Partial<JobRecordV2> = {}): JobRecordV2 {
  const now = Date.now();
  const input = {
    target_id: "tgt_00000000-0000-0000-0000-000000000001",
    prompt: "test prompt",
    acceptance: "test acceptance",
    resource_id: null,
    execution_timeout_seconds: 120,
    result_target: "none" as const,
  };
  const digest = businessDigestV2(input);
  return {
    schema_version: JOBS_V2_SCHEMA_VERSION,
    job_id: "job-00000000-0000-0000-0000-000000000001",
    request_id: "req-00000000-0000-0000-0000-000000000001",
    user_id: "usr_alice",
    workspace_id: "ws_default",
    target_id: input.target_id,
    prompt: input.prompt,
    acceptance: input.acceptance,
    resource_id: input.resource_id,
    execution_timeout_seconds: input.execution_timeout_seconds,
    result_target: input.result_target,
    request_digest: digest,
    status: "preparing",
    stream_entry_id: null,
    latest_attempt_id: null,
    created_at_ms: now,
    claim_deadline_ms: now + 3600 * 1000,
    ...patch,
  };
}

describe("RedisJobStoreV2 (in-memory test runner)", () => {
  let runner: RedisRunner;
  let store: RedisJobStoreV2;

  beforeEach(() => {
    runner = createFakeRedisRunner();
    store = new RedisJobStoreV2(runner);
  });

  describe("Job Creation & Submission", () => {
    it("creates preparing -> XADD stream -> ZADD target queue -> queued Job", async () => {
      const job = makeJobRecord();
      const res = await store.createJob(job, job.request_id);

      expect(res.status).toBe("created");
      expect(res.job_id).toBe(job.job_id);
      expect(res.stream_entry_id).toBeDefined();

      const saved = await store.getJob(job.job_id);
      expect(saved).not.toBeNull();
      expect(saved?.status).toBe("queued");
      expect(saved?.stream_entry_id).toBe(res.stream_entry_id);
      expect(saved?.latest_attempt_id).toBeNull();

      // Check request key
      const reqJobId = await store.getRequestJobId(job.user_id, job.workspace_id, job.request_id);
      expect(reqJobId).toBe(job.job_id);

      // Check target queue
      const queued = await store.getQueuedJobIdsForTarget(job.target_id, 10);
      expect(queued).toHaveLength(1);
      expect(queued[0].job_id).toBe(job.job_id);
    });

    it("replays idempotently with matching request_digest across queued, active, terminal", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      // Replay in queued state
      const replay1 = await store.createJob(job, job.request_id);
      expect(replay1.status).toBe("replayed");
      expect(replay1.job_id).toBe(job.job_id);

      // Modify job to active state
      const activeJob = { ...job, status: "active" as const, latest_attempt_id: "att_00000000-0000-0000-0000-000000000001", stream_entry_id: "1-0" };
      await runner.set(jobKeyV2(job.job_id), JSON.stringify(activeJob));

      const replay2 = await store.createJob(job, job.request_id);
      expect(replay2.status).toBe("replayed");

      // Modify job to terminal state
      const termJob = { ...activeJob, status: "terminal" as const };
      await runner.set(jobKeyV2(job.job_id), JSON.stringify(termJob));

      const replay3 = await store.createJob(job, job.request_id);
      expect(replay3.status).toBe("replayed");
    });

    it("fails closed with IDEMPOTENCY_CONFLICT when digest changes", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const modifiedJob = { ...job, request_digest: sha256("different_digest") };
      await expect(store.createJob(modifiedJob, job.request_id)).rejects.toThrow(V2IdempotencyConflictError);
    });

    it("fails closed with JOB_ID_COLLISION if request key absent but job key exists", async () => {
      const job = makeJobRecord();
      // Pre-set job key without request key
      await runner.set(jobKeyV2(job.job_id), JSON.stringify({ existing: true }));

      await expect(store.createJob(job, job.request_id)).rejects.toThrow(/Job ID collision detected/);
    });

    it("fails closed on corrupt placeholder reference", async () => {
      const job = makeJobRecord();
      // Pre-set request key pointing to missing job
      await runner.set(requestKeyV2(job.user_id, job.workspace_id, job.request_id), job.job_id);

      await expect(store.createJob(job, job.request_id)).rejects.toThrow(/references a missing Job/);
    });

    it("fails closed if existing placeholder references preparing job (INCOMPLETE_SUBMISSION)", async () => {
      const job = makeJobRecord({ status: "preparing", stream_entry_id: null });
      await runner.set(requestKeyV2(job.user_id, job.workspace_id, job.request_id), job.job_id);
      await runner.set(jobKeyV2(job.job_id), JSON.stringify(job));

      await expect(store.createJob(job, job.request_id)).rejects.toThrow(/incomplete/);
    });
  });

  describe("Job Claiming", () => {
    it("claims queued job atomically and updates indices", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const token = "a".repeat(64);
      const tokenHash = sha256(token);

      const claimRes = await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: "dev_00000000-0000-0000-0000-000000000001",
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      expect(claimRes.status).toBe("claimed");
      expect(claimRes.attempt.attempt_id).toBe(attemptId);
      expect(claimRes.attempt.phase).toBe("claimed");
      expect(claimRes.attempt.started_at_ms).toBeNull();
      expect(claimRes.attempt.claimed_at_ms).toBeGreaterThan(0);

      // Job is now active and removed from target queue
      const updatedJob = await store.getJob(job.job_id);
      expect(updatedJob?.status).toBe("active");
      expect(updatedJob?.latest_attempt_id).toBe(attemptId);

      const queued = await store.getQueuedJobIdsForTarget(job.target_id, 10);
      expect(queued).toHaveLength(0);

      // Attempt index exists
      const savedAttempt = await store.getAttempt(attemptId);
      expect(savedAttempt).not.toBeNull();
      expect(savedAttempt?.claim_token_sha256).toBe(tokenHash);
    });

    it("replays claim for same attempt_id and token even if target queue key is gone", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const tokenHash = sha256("token1");

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: "dev_00000000-0000-0000-0000-000000000001",
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      // Target queue is empty (ZREM deleted it)
      // Retry claim with same credentials
      const replayRes = await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: "dev_00000000-0000-0000-0000-000000000001",
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: true,
      });

      expect(replayRes.status).toBe("replayed");
      expect(replayRes.attempt.attempt_id).toBe(attemptId);
    });

    it("rejects second device claim with V2JobAlreadyClaimedError", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: "dev_00000000-0000-0000-0000-000000000001",
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: "att_00000000-0000-0000-0000-000000000001",
        claim_token_sha256: sha256("token1"),
        is_replay_only: false,
      });

      // Device 2 tries to claim same job
      await expect(
        store.claimJob({
          job_id: job.job_id,
          expected_workspace_id: job.workspace_id,
          expected_target_id: job.target_id,
          device_id: "dev_00000000-0000-0000-0000-000000000002",
          target_binding_id: "dtb_00000000-0000-0000-0000-000000000002",
          attempt_id: "att_00000000-0000-0000-0000-000000000002",
          claim_token_sha256: sha256("token2"),
          is_replay_only: false,
        }),
      ).rejects.toThrow(V2JobAlreadyClaimedError);
    });

    it("rejects claim with V2JobExpiredError when deadline passed", async () => {
      const now = Date.now();
      const job = makeJobRecord({
        created_at_ms: now - 5000,
        claim_deadline_ms: now - 1000,
      });
      await store.createJob(job, job.request_id);

      await expect(
        store.claimJob({
          job_id: job.job_id,
          expected_workspace_id: job.workspace_id,
          expected_target_id: job.target_id,
          device_id: "dev_00000000-0000-0000-0000-000000000001",
          target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
          attempt_id: "att_00000000-0000-0000-0000-000000000001",
          claim_token_sha256: sha256("token1"),
          is_replay_only: false,
        }),
      ).rejects.toThrow(V2JobExpiredError);
    });
  });

  describe("Job Start & Report", () => {
    it("transitions claimed -> running and supports running replay", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const deviceId = "dev_00000000-0000-0000-0000-000000000001";
      const tokenHash = sha256("secret123");

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      const startRes = await store.startJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
      });

      expect(startRes.status).toBe("started");
      expect(startRes.attempt.phase).toBe("running");
      expect(startRes.attempt.started_at_ms).toBeGreaterThan(0);

      // Replay start
      const replayStart = await store.startJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
      });
      expect(replayStart.status).toBe("replayed");
    });

    it("allows pre-dispatch failure report directly from claimed phase", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const deviceId = "dev_00000000-0000-0000-0000-000000000001";
      const tokenHash = sha256("secret123");

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      const report: ExecutionReport = {
        schema_version: 2,
        execution_status: "FAILED",
        business_outcome: "NOT_STARTED",
        task_dispatched: false,
        finished_at_ms: Date.now(),
        duration_ms: 10,
        executor: { type: "local", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: { stage: "setup", code: "TARGET_UNAVAILABLE", message: "Path not found" },
      };

      const repRes = await store.reportJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
        report,
      });

      expect(repRes.status).toBe("reported");

      const attempt = await store.getAttempt(attemptId);
      expect(attempt?.phase).toBe("terminal");
      expect(attempt?.report?.business_outcome).toBe("NOT_STARTED");
      expect(attempt?.started_at_ms).toBeNull();

      const finalJob = await store.getJob(job.job_id);
      expect(finalJob?.status).toBe("terminal");
    });

    it("rejects dispatched report (task_dispatched: true) if not running", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const deviceId = "dev_00000000-0000-0000-0000-000000000001";
      const tokenHash = sha256("secret123");

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      // Still in claimed phase, report task_dispatched: true
      const report: ExecutionReport = {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 100,
        executor: { type: "local", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      };

      await expect(
        store.reportJob({
          job_id: job.job_id,
          attempt_id: attemptId,
          device_id: deviceId,
          claim_token_sha256: tokenHash,
          report,
        }),
      ).rejects.toThrow(/DISPATCHED_REPORT_REQUIRES_RUNNING/);
    });

    it("handles report replay and detects report conflict", async () => {
      const job = makeJobRecord();
      await store.createJob(job, job.request_id);

      const attemptId = "att_00000000-0000-0000-0000-000000000001";
      const deviceId = "dev_00000000-0000-0000-0000-000000000001";
      const tokenHash = sha256("secret123");

      await store.claimJob({
        job_id: job.job_id,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
        attempt_id: attemptId,
        claim_token_sha256: tokenHash,
        is_replay_only: false,
      });

      await store.startJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
      });

      const report: ExecutionReport = {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: 1711234567890,
        duration_ms: 100,
        executor: { type: "local", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      };

      const res1 = await store.reportJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
        report,
      });
      expect(res1.status).toBe("reported");

      // Replay same report
      const res2 = await store.reportJob({
        job_id: job.job_id,
        attempt_id: attemptId,
        device_id: deviceId,
        claim_token_sha256: tokenHash,
        report,
      });
      expect(res2.status).toBe("replayed");

      // Different report -> REPORT_CONFLICT
      const conflictingReport: ExecutionReport = {
        ...report,
        duration_ms: 9999,
      };
      await expect(
        store.reportJob({
          job_id: job.job_id,
          attempt_id: attemptId,
          device_id: deviceId,
          claim_token_sha256: tokenHash,
          report: conflictingReport,
        }),
      ).rejects.toThrow(V2ReportConflictError);
    });
  });
});

describe.skipIf(!URL)("RedisJobStoreV2 (real Redis integration, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStoreV2;

  beforeAll(async () => {
    client = createClient({ url: URL, socket: { reconnectStrategy: false } });
    client.on("error", () => void 0);
    await client.connect();

    runner = createRedisRunnerFromClient(
      () =>
        createClient({
          url: URL,
          socket: { reconnectStrategy: false },
          disableOfflineQueue: true,
        }),
    );
    store = new RedisJobStoreV2(runner);
  });

  afterAll(async () => {
    await runner.dispose();
    await client.destroy();
  });

  beforeEach(async () => {
    await client.flushAll();
  });

  it("executes real Lua V2_CREATE_JOB_SCRIPT and validates stream entry", async () => {
    const job = makeJobRecord();
    const res = await store.createJob(job, job.request_id);

    expect(res.status).toBe("created");
    expect(res.job_id).toBe(job.job_id);

    const saved = await store.getJob(job.job_id);
    expect(saved?.status).toBe("queued");
    expect(saved?.stream_entry_id).toMatch(/^\d+-\d+$/);
  });

  it("handles concurrent atomic claims race between two devices (only one wins)", async () => {
    const job = makeJobRecord();
    await store.createJob(job, job.request_id);

    const claim1 = store.claimJob({
      job_id: job.job_id,
      expected_workspace_id: job.workspace_id,
      expected_target_id: job.target_id,
      device_id: "dev_00000000-0000-0000-0000-000000000001",
      target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
      attempt_id: "att_00000000-0000-0000-0000-000000000001",
      claim_token_sha256: sha256("token1"),
      is_replay_only: false,
    });

    const claim2 = store.claimJob({
      job_id: job.job_id,
      expected_workspace_id: job.workspace_id,
      expected_target_id: job.target_id,
      device_id: "dev_00000000-0000-0000-0000-000000000002",
      target_binding_id: "dtb_00000000-0000-0000-0000-000000000002",
      attempt_id: "att_00000000-0000-0000-0000-000000000002",
      claim_token_sha256: sha256("token2"),
      is_replay_only: false,
    });

    const results = await Promise.allSettled([claim1, claim2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(V2JobAlreadyClaimedError);
  });

  it("handles empty target ZSET replay tolerance when last item is removed", async () => {
    const job = makeJobRecord();
    await store.createJob(job, job.request_id);

    const attemptId = "att_00000000-0000-0000-0000-000000000001";
    const tokenHash = sha256("token1");

    await store.claimJob({
      job_id: job.job_id,
      expected_workspace_id: job.workspace_id,
      expected_target_id: job.target_id,
      device_id: "dev_00000000-0000-0000-0000-000000000001",
      target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
      attempt_id: attemptId,
      claim_token_sha256: tokenHash,
      is_replay_only: false,
    });

    // Redis removes the ZSET when empty
    const tqType = await client.type(targetQueueKeyV1(job.target_id));
    expect(tqType).toBe("none");

    // Replay against empty ZSET succeeds
    const replayRes = await store.claimJob({
      job_id: job.job_id,
      expected_workspace_id: job.workspace_id,
      expected_target_id: job.target_id,
      device_id: "dev_00000000-0000-0000-0000-000000000001",
      target_binding_id: "dtb_00000000-0000-0000-0000-000000000001",
      attempt_id: attemptId,
      claim_token_sha256: tokenHash,
      is_replay_only: true,
    });

    expect(replayRes.status).toBe("replayed");
  });

  it("handles concurrent submit with two different candidate job IDs under real Redis", async () => {
    const jobA = makeJobRecord({ job_id: "job-00000000-0000-0000-0000-00000000000a" });
    const jobB = makeJobRecord({ job_id: "job-00000000-0000-0000-0000-00000000000b" });
    // Same request_id, same user, same workspace, same digest
    expect(jobA.request_id).toBe(jobB.request_id);
    expect(jobA.request_digest).toBe(jobB.request_digest);

    const [resA, resB] = await Promise.all([
      store.createJob(jobA, jobA.request_id),
      store.createJob(jobB, jobB.request_id),
    ]);

    expect(resA.job_id).toBe(resB.job_id);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual(["created", "replayed"]);

    // Exactly 1 job exists, matching the winner ID
    const winnerId = resA.job_id;
    const loserId = winnerId === jobA.job_id ? jobB.job_id : jobA.job_id;

    const winnerJob = await store.getJob(winnerId);
    expect(winnerJob).not.toBeNull();
    expect(winnerJob?.status).toBe("queued");

    const loserJob = await store.getJob(loserId);
    expect(loserJob).toBeNull();

    // Stream has 1 entry, Target queue has 1 member
    const streamLen = await client.xLen(KEY_STREAM_V2);
    expect(streamLen).toBe(1);

    const tqMembers = await client.zRange(targetQueueKeyV1(jobA.target_id), 0, -1);
    expect(tqMembers).toEqual([winnerId]);
  });

  it("recovers from NOSCRIPT when script cache is flushed under real Redis", async () => {
    const job = makeJobRecord();
    await store.createJob(job, job.request_id);

    // Flush script cache in Redis
    await client.scriptFlush();

    // Next operation succeeds transparently by reloading script
    const replayRes = await store.createJob(job, job.request_id);
    expect(replayRes.status).toBe("replayed");
    expect(replayRes.job_id).toBe(job.job_id);
  });
});
