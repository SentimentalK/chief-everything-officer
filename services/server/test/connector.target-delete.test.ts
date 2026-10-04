import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import {
  ConnectorControlStore,
  ConnectorNotFoundError,
} from "../src/connector/control-store.js";
import { RedisJobStoreV2, V2TargetDeleteFencedError } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2, TargetNotFoundError } from "../src/jobs/v2-service.js";
import {
  TargetDeleteBlockedError,
  TargetDeleteCoordinator,
  TargetDeleteInProgressError,
  TARGET_DELETE_STREAM_SCAN_BATCH,
} from "../src/jobs/target-delete.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import {
  serializeJobRecordV2,
  jobKeyV2,
  targetDeleteFenceKeyV1,
  parseDeleteFenceStartedMs,
  JOBS_V2_SCHEMA_VERSION,
  JOB_CLAIM_TTL_MS_V2,
  TARGET_DELETE_FENCE_TTL_MS,
  KEY_STREAM_V2,
} from "../src/jobs/v2-schema.js";
import type { RedisRunner } from "../src/jobs/redis-runner.js";

const cleanupDirs: string[] = [];
let identityStore: IdentityStore;
let controlStore: ConnectorControlStore;
let runner: RedisRunner & {
  zadd(key: string, score: number, member: string): Promise<number>;
};
let v2Store: RedisJobStoreV2;
let coordinator: JobCoordinatorV2;
let deleteCoordinator: TargetDeleteCoordinator;

let userAliceId: string;
let userBobId: string;
let workspaceId: string;
let bobWorkspaceId: string;

let target: { id: string; alias: string };
let aliceDeviceId: string;
let bobDeviceId: string;

let requestSeq = 0;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-target-delete-test-"));
  cleanupDirs.push(dir);
  const dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityStore = IdentityStore.open(dbPath);
  controlStore = new ConnectorControlStore(identityStore);

  userAliceId = "usr_alice";
  userBobId = "usr_bob";
  workspaceId = "ws_primary";
  bobWorkspaceId = "ws_bob";

  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userAliceId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userBobId);

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/acme/main-repo.git', 'main', 1000);").run(
      workspaceId,
      userAliceId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_alice', ?, ?, 'owner', 1000);").run(
      workspaceId,
      userAliceId,
    );

    db.prepare(
      "INSERT INTO github_installations VALUES ('ghi_row_1', '999', 'app_1', '111', 'acme', 'User', 'all', NULL, 1000, 1000);",
    ).run();
    db.prepare(
      "INSERT INTO github_repository_bindings VALUES ('grb_1', ?, '12345', 'ghi_row_1', '111', 'acme', 'main-repo', 'acme/main-repo', 'main', 1000, 1000, NULL);",
    ).run(workspaceId);

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/bob/repo.git', 'main', 1000);").run(
      bobWorkspaceId,
      userBobId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_bob', ?, ?, 'owner', 1000);").run(
      bobWorkspaceId,
      userBobId,
    );
  });

  target = controlStore.createExecutionTarget({
    workspaceId,
    alias: "project-alpha",
    displayName: "Project Alpha",
    kind: "coding",
    repositoryProvider: "github",
    repositoryExternalId: "12345",
    repositoryFullName: "acme/main-repo",
  });

  // Alice's primary device (bound to the project target)
  const aliceDev = controlStore.createDevice({
    userId: userAliceId,
    displayName: "Alice Device",
    platform: "linux",
  });
  aliceDeviceId = aliceDev.id;
  const aliceSecret = "a".repeat(64);
  const aliceSecretDigest = crypto.createHash("sha256").update(aliceSecret, "utf8").digest("hex");
  controlStore.createDeviceCredential({
    deviceId: aliceDeviceId,
    secretDigest: aliceSecretDigest,
    expiresAtMs: Date.now() + 3600 * 1000,
  });
  controlStore.upsertDeviceTargetBinding({ deviceId: aliceDeviceId, targetId: target.id });

  // Bob's device (NOT a member of the primary workspace)
  const bobDev = controlStore.createDevice({
    userId: userBobId,
    displayName: "Bob Device",
    platform: "darwin",
  });
  bobDeviceId = bobDev.id;
  const bobSecret = "b".repeat(64);
  const bobSecretDigest = crypto.createHash("sha256").update(bobSecret, "utf8").digest("hex");
  controlStore.createDeviceCredential({
    deviceId: bobDeviceId,
    secretDigest: bobSecretDigest,
    expiresAtMs: Date.now() + 3600 * 1000,
  });

  // Secondary bound device (Alice's other machine) to verify cascade behavior
  const secondDev = controlStore.createDevice({
    userId: userAliceId,
    displayName: "Alice Laptop",
    platform: "macos",
  });
  controlStore.upsertDeviceTargetBinding({ deviceId: secondDev.id, targetId: target.id });

  runner = createFakeRedisRunner();
  v2Store = new RedisJobStoreV2(runner);
  coordinator = new JobCoordinatorV2({
    store: v2Store,
    controlStore,
    identityStore,
  });
  deleteCoordinator = new TargetDeleteCoordinator({
    controlStore,
    jobStore: v2Store,
    identityStore,
  });
});

afterEach(async () => {
  identityStore?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function nextRequestId(): string {
  requestSeq++;
  return `req-${crypto.randomUUID()}-${requestSeq}`.slice(0, 40);
}

interface SubmitOptions {
  targetId?: string;
  workspace?: string;
  userId?: string;
}

async function submitJob(opts: SubmitOptions = {}) {
  requestSeq++;
  return coordinator.submit(
    { user_id: opts.userId ?? userAliceId, workspace_id: opts.workspace ?? workspaceId },
    {
      request_id: `req-${requestSeq.toString().padStart(8, "0")}-0000-0000-0000-000000000000`,
      target_id: opts.targetId ?? target.id,
      prompt: "do the thing",
      acceptance: "done",
      resource_id: null,
      execution_timeout_seconds: 120,
      result_target: "none",
    },
  );
}

async function claim(jobId: string, attemptSeq: number) {
  const attemptId = `att-00000000-0000-0000-0000-${attemptSeq.toString().padStart(12, "0")}`;
  const claimToken = crypto.randomBytes(32).toString("hex");
  const res = await coordinator.claimJob(aliceDeviceId, jobId, attemptId, claimToken);
  return { res, attemptId, claimToken };
}

/** Creates a fully TERMINAL historical job (operator cancel) on the shared target. */
async function createTerminalJob(attemptSeq: number) {
  const { job } = await submitJob();
  const { attemptId, claimToken } = await claim(job.job_id, attemptSeq);
  const cancelRes = await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
  expect(cancelRes.action).toBe("cancelled");
  return { jobId: job.job_id, attemptId, claimToken };
}

/** Places a durable 'preparing' job record + stream entry directly in the store.
 *
 * In production a durable 'preparing' record is unreachable: the create Lua
 * script transitions preparing -> queued atomically. This fixture exercises
 * the coordinator's defensive non-terminal classification branch for that
 * exotic/corrupt state.
 */
async function writePreparingJob(targetId: string): Promise<string> {
  const now = Date.now();
  const jobId = `job-${crypto.randomUUID()}`;
  const record: Record<string, unknown> = {
    schema_version: JOBS_V2_SCHEMA_VERSION,
    job_id: jobId,
    request_id: `req-${crypto.randomUUID()}`,
    user_id: userAliceId,
    workspace_id: workspaceId,
    target_id: targetId,
    prompt: "preparing job",
    acceptance: "done",
    resource_id: null,
    execution_timeout_seconds: 120,
    result_target: "none",
    request_digest: "d".repeat(64),
    status: "preparing",
    stream_entry_id: null,
    latest_attempt_id: null,
    created_at_ms: now,
    claim_deadline_ms: now + JOB_CLAIM_TTL_MS_V2,
    cancel: null,
  };
  // Manually attach a stream entry so the delete quiescence scan can discover
  // the record (the normal submit path cannot produce this shape). The record
  // itself stays schema-valid: stream_entry_id remains null for 'preparing'.
  await runner.xaddStream(KEY_STREAM_V2, {
    schema_version: 2,
    job_id: jobId,
    user_id: userAliceId,
    workspace_id: workspaceId,
    target_id: targetId,
    created_at_ms: now,
  });
  await runner.set(jobKeyV2(jobId), JSON.stringify(record));
  return jobId;
}

/** Rewrites a job record as terminal-with-cancel (test cleanup helper). */
async function forceTerminal(jobId: string): Promise<void> {
  const job = await v2Store.getJob(jobId);
  if (!job) return;
  job.status = "terminal";
  job.cancel = {
    cancelled_at_ms: Date.now(),
    requested_by_device_id: aliceDeviceId,
    reason: "test cleanup",
  };
  // Durable terminal records must carry their stream entry id; the fixture's
  // manual entry id is already embedded for discoverable preparing fixtures.
  if (job.stream_entry_id === null) {
    job.stream_entry_id = "1-1";
  }
  await runner.set(jobKeyV2(jobId), serializeJobRecordV2(job));
}

async function deleteTarget(
  targetId = target.id,
  actorUserId = userAliceId,
  deviceId = aliceDeviceId,
) {
  return deleteCoordinator.deleteTargetForDevice({
    deviceId,
    targetId,
    actorUserId,
  });
}

describe("Workspace-level Project Delete (PROJECT-039)", () => {
  it("masks foreign/nonexistent targets as not-found; owner may delete", async () => {
    await expect(
      deleteCoordinator.deleteTargetForDevice({
        deviceId: bobDeviceId,
        targetId: target.id,
        actorUserId: userBobId,
      }),
    ).rejects.toThrow(ConnectorNotFoundError);

    await expect(
      deleteCoordinator.deleteTargetForDevice({
        deviceId: aliceDeviceId,
        targetId: "tgt_does-not-exist",
        actorUserId: userAliceId,
      }),
    ).rejects.toThrow(ConnectorNotFoundError);

    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");
  });

  it("A: deletes a quiescent target; bindings and workspace default cascade away", async () => {
    await createTerminalJob(1);

    controlStore.setDefaultAgentRuntimeTarget({
      workspaceId,
      targetId: target.id,
      actorUserId: userAliceId,
    });

    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");
    expect(res.terminal_job_count).toBe(1);

    expect(controlStore.getExecutionTarget(target.id)).toBeNull();
    // device_target_bindings cascaded away for BOTH devices
    expect(controlStore.listBindingsForDevice(aliceDeviceId, { includeDisabled: true })).toHaveLength(0);
    // workspace_execution_defaults cascaded away
    expect(controlStore.getDefaultAgentRuntimeTarget(workspaceId)).toBeNull();
    // resolution degrades to not_configured, never a ghost routing row
    expect(controlStore.resolveDefaultAgentRuntimeTarget(workspaceId).status).toBe("not_configured");
  });

  it("B: historical terminal Job/Attempt records remain queryable with old target_id", async () => {
    const { jobId } = await createTerminalJob(1);

    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");

    // Job record still present in the Job store with historical target_id
    const job = await v2Store.getJob(jobId);
    expect(job).not.toBeNull();
    expect(job!.target_id).toBe(target.id);
    expect(job!.status).toBe("terminal");
    expect(job!.cancel).not.toBeNull();

    // Attempt record retained with its historical target_id
    const attempt = await v2Store.getAttempt(job!.latest_attempt_id!);
    expect(attempt).not.toBeNull();
    expect(attempt!.target_id).toBe(target.id);

    // Host read model still resolves the historical job after deletion
    const detail = await coordinator.getJobForHost(
      { user_id: userAliceId, workspace_id: workspaceId },
      jobId,
    );
    expect(detail.job_id).toBe(jobId);
    expect(detail.target_id).toBe(target.id);
    expect(detail.state).toBe("terminal");
    // alias degrades to the historical target_id, never fabricated metadata
    expect(detail.target_alias).toBe(target.id);

    // Filtered listing by the deleted target id keeps returning history
    const listing = await coordinator.listJobsForHost(
      { user_id: userAliceId, workspace_id: workspaceId },
      { target_id: target.id },
    );
    expect(listing.jobs.map((j) => j.job_id)).toContain(jobId);
  });

  it("C: every non-terminal state (preparing/queued/claimed/running) blocks deletion", async () => {
    // queued
    {
      const { job } = await submitJob();
      const err = await deleteTarget().catch((e) => e);
      expect(err).toBeInstanceOf(TargetDeleteBlockedError);
      expect((err as TargetDeleteBlockedError).evidence.queued).toHaveLength(1);
      expect(controlStore.getExecutionTarget(target.id)).not.toBeNull();
      expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();
      await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    }
    // claimed
    {
      const { job } = await submitJob();
      await claim(job.job_id, 21);
      const err = await deleteTarget().catch((e) => e);
      expect(err).toBeInstanceOf(TargetDeleteBlockedError);
      expect((err as TargetDeleteBlockedError).evidence.claimed).toHaveLength(1);
      await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    }
    // running
    {
      const { job } = await submitJob();
      const { res: claimRes, attemptId, claimToken } = await claim(job.job_id, 31);
      await coordinator.startJob(aliceDeviceId, job.job_id, attemptId, claimToken);
      expect(claimRes.attempt.phase).toBe("claimed");
      const err = await deleteTarget().catch((e) => e);
      expect(err).toBeInstanceOf(TargetDeleteBlockedError);
      expect((err as TargetDeleteBlockedError).evidence.running).toHaveLength(1);
      await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    }
    // preparing (durable record placed directly)
    {
      const jobId = await writePreparingJob(target.id);
      const err = await deleteTarget().catch((e) => e);
      expect(err).toBeInstanceOf(TargetDeleteBlockedError);
      expect((err as TargetDeleteBlockedError).evidence.preparing).toHaveLength(1);
      await forceTerminal(jobId);
    }

    // After all jobs are terminalized the target becomes deletable.
    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");
    expect(controlStore.getExecutionTarget(target.id)).toBeNull();
  });

  it("D: while the delete fence is active, submission is rejected and claim does not proceed", async () => {
    const { job } = await submitJob();

    const token = "fence-token-d";
    const acquired = await v2Store.acquireTargetDeleteFence(target.id, token);
    expect(acquired).toBe(true);

    // New submission rejected with the typed fenced error
    await expect(submitJob()).rejects.toThrow(V2TargetDeleteFencedError);

    // Claim does not proceed (attempt is NOT created)
    await expect(
      coordinator.claimJob(
        aliceDeviceId,
        job.job_id,
        "att-00000000-0000-0000-0000-000000000041",
        crypto.randomBytes(32).toString("hex"),
      ),
    ).rejects.toThrow(V2TargetDeleteFencedError);
    const attempt = await v2Store.getAttempt("att-00000000-0000-0000-0000-000000000041");
    expect(attempt).toBeNull();

    // Fence release restores normal behavior
    await v2Store.releaseTargetDeleteFence(target.id, token);
    const { job: job2 } = await submitJob();
    expect(job2.status).toBe("queued");
  });

  it("E: a submission/claim racing the delete window cannot create or claim executable work", async () => {
    // Scenario 1: a queued job exists; the delete's quiescence check rejects
    // it and unfences. A claim that raced the fence must NOT proceed while
    // fenced, and must be able to proceed only after the unfence.
    {
      const { job } = await submitJob();
      const token = "fence-token-e1";
      await v2Store.acquireTargetDeleteFence(target.id, token);

      // The in-flight claim (eligibility may have passed pre-fence) is
      // blocked by the fence inside the atomic claim script.
      await expect(
        coordinator.claimJob(
          aliceDeviceId,
          job.job_id,
          "att-00000000-0000-0000-0000-0000000000e1",
          crypto.randomBytes(32).toString("hex"),
        ),
      ).rejects.toThrow(V2TargetDeleteFencedError);
      expect(await v2Store.getAttempt("att-00000000-0000-0000-0000-0000000000e1")).toBeNull();

      // Fence released (simulating the end of a delete attempt), the delete
      // itself deterministically aborts on the non-terminal job and rolls
      // the fence back.
      await v2Store.releaseTargetDeleteFence(target.id, token);
      const err = await deleteTarget().catch((e) => e);
      expect(err).toBeInstanceOf(TargetDeleteBlockedError);
      expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();
      expect(controlStore.getExecutionTarget(target.id)).not.toBeNull();

      // Now the claim proceeds normally: no work was lost or corrupted.
      const { res: claimRes } = await claim(job.job_id, 9001);
      expect(claimRes.replayed).toBe(false);
      await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    }

    // Scenario 2: quiescence accepted under the fence; a concurrent
    // submission must not create a queued job for the target; after the
    // authoritative physical delete the target row is gone.
    {
      const token = "fence-token-e2";
      await v2Store.acquireTargetDeleteFence(target.id, token);

      await expect(submitJob()).rejects.toThrow(V2TargetDeleteFencedError);

      const quiescence = await deleteCoordinator.verifyTargetQuiescence(target.id, token);
      expect(quiescence.quiescent).toBe(true);

      const deleted = controlStore.deleteExecutionTargetRow(target.id);
      expect(deleted).toBe(true);
      await v2Store.releaseTargetDeleteFence(target.id, token);
      expect(controlStore.getExecutionTarget(target.id)).toBeNull();
    }
  });

  it("F: concurrent duplicate deletes are deterministic; no resurrection", async () => {
    const results = await Promise.allSettled([
      deleteTarget(),
      deleteTarget(),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof deleteTarget>>> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const deletedCount = fulfilled.filter((r) => r.value.outcome === "deleted").length;
    const alreadyGone = fulfilled.filter((r) => r.value.outcome === "already_deleted").length;
    const inProgress = rejected.filter(
      (r) => r.reason instanceof TargetDeleteInProgressError,
    ).length;

    // Exactly one physically deletes; the other is either already-gone or a
    // deterministic in-progress conflict. Never two deletions, never a crash
    // outside the typed deterministic outcomes.
    expect(deletedCount).toBeLessThanOrEqual(1);
    expect(deletedCount + alreadyGone + inProgress).toBe(2);
    expect(deletedCount + alreadyGone).toBeGreaterThanOrEqual(1);

    expect(controlStore.getExecutionTarget(target.id)).toBeNull();

    // Repeating after completion is masked as not-found (same as bind/unbind):
    // a sequential replay of the delete endpoint gets the deterministic
    // 404-already-gone outcome. No resurrection in any case.
    await expect(deleteTarget()).rejects.toThrow(ConnectorNotFoundError);
    expect(controlStore.getExecutionTarget(target.id)).toBeNull();
  });

  it("G: failure between fence and physical delete unfences; target stays usable (no tombstone)", async () => {
    let failDelete = true;
    const failingControlStore = {
      getExecutionTarget: (id: string) => controlStore.getExecutionTarget(id),
      deleteExecutionTargetRow: (id: string) => {
        if (failDelete) throw new Error("simulated sqlite failure after fence");
        return controlStore.deleteExecutionTargetRow(id);
      },
    };

    const failingCoordinator = new TargetDeleteCoordinator({
      controlStore: failingControlStore as unknown as ConnectorControlStore,
      jobStore: v2Store,
      identityStore,
    });

    await expect(
      failingCoordinator.deleteTargetForDevice({
        deviceId: aliceDeviceId,
        targetId: target.id,
        actorUserId: userAliceId,
      }),
    ).rejects.toThrow("simulated sqlite failure after fence");

    // Row intact and ENABLED; fence rolled back.
    const row = controlStore.getExecutionTarget(target.id);
    expect(row).not.toBeNull();
    expect(row!.disabled_at_ms).toBeNull();
    expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();

    // The target is fully usable again: submission works.
    const { job } = await submitJob();
    expect(job.status).toBe("queued");

    // Retry after the injected failure is repaired: delete succeeds.
    failDelete = false;
    await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    const res = await failingCoordinator.deleteTargetForDevice({
      deviceId: aliceDeviceId,
      targetId: target.id,
      actorUserId: userAliceId,
    });
    expect(res.outcome).toBe("deleted");
    expect(controlStore.getExecutionTarget(target.id)).toBeNull();
  });

  it("G2: a stale fence from a crashed delete is taken over by a retrying delete", async () => {
    // Simulate a crashed delete: fence with an old started_ms, no operation.
    const staleValue = `${Date.now() - (TARGET_DELETE_FENCE_TTL_MS + 5000)}:crashed-token`;
    await runner.set(targetDeleteFenceKeyV1(target.id), staleValue);

    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");
    expect(controlStore.getExecutionTarget(target.id)).toBeNull();
    expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();
  });

  it("H: an actively touched fence stays authoritative to create/claim beyond the 60s freshness window (regression)", async () => {
    const fenceKey = targetDeleteFenceKeyV1(target.id);
    const token = "fence-token-h";
    // A queued job exists for the whole window and must stay unclaimable.
    const { job } = await submitJob();
    expect(await v2Store.acquireTargetDeleteFence(target.id, token)).toBe(true);

    for (let cycle = 0; cycle < 3; cycle++) {
      // Simulate the wall clock advancing 70s since the last refresh (the
      // embedded started_ms ages past the original TTL between scan batches).
      await runner.set(fenceKey, `${Date.now() - (TARGET_DELETE_FENCE_TTL_MS + 10_000)}:${token}`);

      // The owner's periodic touch must re-anchor BOTH the embedded
      // started_ms and the TTL for the same owner token.
      expect(await v2Store.touchTargetDeleteFence(target.id, token)).toBe(true);
      const value = await v2Store.getTargetDeleteFence(target.id);
      expect(value).not.toBeNull();
      expect(value!.endsWith(`:${token}`)).toBe(true);
      expect(Date.now() - parseDeleteFenceStartedMs(value!)).toBeLessThan(TARGET_DELETE_FENCE_TTL_MS);

      // Far beyond the original 60s window, create AND claim stay fenced...
      await expect(submitJob()).rejects.toThrow(V2TargetDeleteFencedError);
      await expect(
        coordinator.claimJob(
          aliceDeviceId,
          job.job_id,
          `att-00000000-0000-0000-0000-${(cycle + 1).toString().padStart(12, "0")}`,
          crypto.randomBytes(32).toString("hex"),
        ),
      ).rejects.toThrow(V2TargetDeleteFencedError);
      expect(await v2Store.getAttempt(`att-00000000-0000-0000-0000-${(cycle + 1).toString().padStart(12, "0")}`)).toBeNull();
    }

    // ...until the delete releases the fence.
    expect(await v2Store.releaseTargetDeleteFence(target.id, token)).toBe(true);
    const { res: claimRes } = await claim(job.job_id, 42);
    expect(claimRes.replayed).toBe(false);
    const { job: job2 } = await submitJob();
    expect(job2.status).toBe("queued");
    await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
    await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job2.job_id);
  });

  it("H2: coordinator quiescence spanning beyond the 60s window keeps the fence authoritative until the delete releases", async () => {
    // >2 scan batches of foreign-target stream entries force the coordinator's
    // periodic between-batch touches.
    for (let i = 0; i < TARGET_DELETE_STREAM_SCAN_BATCH * 2 + 7; i++) {
      await runner.xaddStream(KEY_STREAM_V2, {
        schema_version: 2,
        job_id: `job-${crypto.randomUUID()}`,
        user_id: userAliceId,
        workspace_id: workspaceId,
        target_id: "tgt_ffffffff-ffff-ffff-ffff-ffffffffffff",
        created_at_ms: Date.now(),
      });
    }

    const fenceKey = targetDeleteFenceKeyV1(target.id);
    const token = "fence-token-h2";
    expect(await v2Store.acquireTargetDeleteFence(target.id, token)).toBe(true);

    // Simulate a slow scan: each batch boundary lands >60s after the previous
    // refresh, so the embedded started_ms is already stale when the next
    // batch is read. Only the coordinator's touch between batches can keep
    // the fence authoritative.
    const realScan = v2Store.scanJobStream.bind(v2Store);
    (v2Store as unknown as { scanJobStream: unknown }).scanJobStream = async (
      afterExclusive: string | null,
      count: number,
    ) => {
      await runner.set(fenceKey, `${Date.now() - (TARGET_DELETE_FENCE_TTL_MS + 10_000)}:${token}`);
      return realScan(afterExclusive, count);
    };

    const quiescence = await deleteCoordinator.verifyTargetQuiescence(target.id, token);
    expect(quiescence.quiescent).toBe(true);

    // The touches re-anchored the fence to the current clock on every batch:
    // still authoritative for create far beyond the original 60s window.
    const value = await v2Store.getTargetDeleteFence(target.id);
    expect(value).not.toBeNull();
    expect(value!.endsWith(`:${token}`)).toBe(true);
    expect(Date.now() - parseDeleteFenceStartedMs(value!)).toBeLessThan(TARGET_DELETE_FENCE_TTL_MS);
    await expect(submitJob()).rejects.toThrow(V2TargetDeleteFencedError);

    // The delete completes (physical row removal under the fence) and
    // releases; the fence key is gone.
    expect(controlStore.deleteExecutionTargetRow(target.id)).toBe(true);
    expect(await v2Store.releaseTargetDeleteFence(target.id, token)).toBe(true);
    expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();
  });

  it("H3: an old owner's touch cannot refresh or overwrite a fence taken over by a newer owner", async () => {
    const fenceKey = targetDeleteFenceKeyV1(target.id);
    const oldToken = "fence-token-old";
    expect(await v2Store.acquireTargetDeleteFence(target.id, oldToken)).toBe(true);

    // The fence goes stale (old owner crashed mid-delete); a newer delete
    // takes it over with a fresh started_ms + new token.
    await runner.set(fenceKey, `${Date.now() - (TARGET_DELETE_FENCE_TTL_MS + 5_000)}:${oldToken}`);
    const newToken = "fence-token-new";
    expect(await v2Store.takeoverStaleTargetDeleteFence(target.id, newToken)).toBe(true);
    const takenOver = await v2Store.getTargetDeleteFence(target.id);
    expect(takenOver).not.toBeNull();
    expect(takenOver!.endsWith(`:${newToken}`)).toBe(true);

    // The OLD owner's touch must be refused without mutating the new
    // owner's fence (no overwrite, no timestamp refresh).
    expect(await v2Store.touchTargetDeleteFence(target.id, oldToken)).toBe(false);
    expect(await v2Store.getTargetDeleteFence(target.id)).toBe(takenOver);

    // The OLD owner cannot release the newer owner's fence either (CAS by
    // owner token).
    expect(await v2Store.releaseTargetDeleteFence(target.id, oldToken)).toBe(false);

    // The NEW owner's touch refreshes both freshness and TTL in place.
    expect(await v2Store.touchTargetDeleteFence(target.id, newToken)).toBe(true);
    const refreshed = await v2Store.getTargetDeleteFence(target.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.endsWith(`:${newToken}`)).toBe(true);
    expect(Date.now() - parseDeleteFenceStartedMs(refreshed!)).toBeLessThan(TARGET_DELETE_FENCE_TTL_MS);
    await expect(submitJob()).rejects.toThrow(V2TargetDeleteFencedError);

    // Release by the true owner unblocks submissions.
    expect(await v2Store.releaseTargetDeleteFence(target.id, newToken)).toBe(true);
    const { job } = await submitJob();
    expect(job.status).toBe("queued");
    await coordinator.cancelJobForDevice(aliceDeviceId, userAliceId, job.job_id);
  });

  it("H4: touch on a missing fence is a false no-op", async () => {
    expect(await v2Store.touchTargetDeleteFence(target.id, "any-token")).toBe(false);
    expect(await v2Store.getTargetDeleteFence(target.id)).toBeNull();
  });

  it("J: re-adding the same repository after deletion creates a NEW target id", async () => {
    const oldId = target.id;
    await deleteTarget();
    expect(controlStore.getExecutionTarget(oldId)).toBeNull();

    const readd = controlStore.registerExecutionTargetForDevice({
      deviceId: aliceDeviceId,
      workspaceId,
      alias: "project-alpha",
      displayName: "Project Alpha",
      kind: "coding",
      repositorySource: "remote_url",
      repositoryProvider: "github",
      repositoryFullName: "acme/main-repo",
    });

    expect(readd.targetCreated).toBe(true);
    expect(readd.target.id).not.toBe(oldId);
    expect(readd.target.id).toMatch(/^tgt_[0-9a-f-]{36}$/);
    expect(readd.target.repository_full_name).toBe("acme/main-repo");
    expect(controlStore.getExecutionTarget(oldId)).toBeNull();

    // The new target is a fully independent, usable row.
    const { job } = await coordinator.submit(
      { user_id: userAliceId, workspace_id: workspaceId },
      {
        request_id: nextRequestId(),
        target_id: readd.target.id,
        prompt: "fresh target works",
        acceptance: "done",
        resource_id: null,
        execution_timeout_seconds: 120,
        result_target: "none",
      },
    );
    expect(job.status).toBe("queued");
  });

  it("K: repository-first identity resolution is unchanged for undeleted targets", async () => {
    // Same repository identity in the same workspace REUSES the active target
    // regardless of alias (identity is repository-first, names are
    // presentation) — unchanged accepted behavior.
    const otherDevice = controlStore.createDevice({
      userId: userAliceId,
      displayName: "Another Rig",
      platform: "linux",
    });
    const res = controlStore.registerExecutionTargetForDevice({
      deviceId: otherDevice.id,
      workspaceId,
      alias: "different-alias",
      displayName: "Different Alias",
      kind: "coding",
      repositorySource: "remote_url",
      repositoryProvider: "github",
      repositoryFullName: "acme/main-repo",
    });
    expect(res.targetCreated).toBe(false);
    expect(res.target.id).toBe(target.id);
  });

  it("submitting to a deleted target surfaces TargetNotFoundError", async () => {
    await deleteTarget();
    requestSeq++;
    await expect(
      coordinator.submit(
        { user_id: userAliceId, workspace_id: workspaceId },
        {
          request_id: `req-${requestSeq.toString().padStart(8, "0")}-0000-0000-0000-000000000000`,
          target_id: target.id,
          prompt: "x",
          acceptance: "y",
          resource_id: null,
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      ),
    ).rejects.toThrow(TargetNotFoundError);
  });

  it("claims of an expired-unclaimed job fail closed after target deletion (no resurrection)", async () => {
    // Expired-unclaimed job: queued past its claim deadline (provably
    // unexecutable). It does not block deletion but its record survives.
    const now = Date.now();
    const jobId = `job-${crypto.randomUUID()}`;
    const record: Record<string, unknown> = {
      schema_version: JOBS_V2_SCHEMA_VERSION,
      job_id: jobId,
      request_id: `req-${crypto.randomUUID()}`,
      user_id: userAliceId,
      workspace_id: workspaceId,
      target_id: target.id,
      prompt: "expired job",
      acceptance: "done",
      resource_id: null,
      execution_timeout_seconds: 120,
      result_target: "none",
      request_digest: "d".repeat(64),
      status: "queued",
      stream_entry_id: null,
      latest_attempt_id: null,
      created_at_ms: now - 1000,
      claim_deadline_ms: now - 1,
      cancel: null,
    };
    const entryId = await runner.xaddStream(KEY_STREAM_V2, {
      schema_version: 2,
      job_id: jobId,
      user_id: userAliceId,
      workspace_id: workspaceId,
      target_id: target.id,
      created_at_ms: now - 1000,
    });
    record.stream_entry_id = entryId;
    await runner.set(jobKeyV2(jobId), serializeJobRecordV2(record));

    // Delete succeeds: the expired job is pruned from the queue (dead entry)
    // but the historical record remains.
    const res = await deleteTarget();
    expect(res.outcome).toBe("deleted");
    expect(await v2Store.getJob(jobId)).not.toBeNull();
    expect(await v2Store.getQueuedJobIdsForTarget(target.id, 10)).toHaveLength(0);

    // A late claim fails closed: eligibility resolution requires an existing
    // target (cascaded away) and can never resurrect executable work.
    await expect(
      coordinator.claimJob(
        aliceDeviceId,
        jobId,
        "att-00000000-0000-0000-0000-000000000061",
        crypto.randomBytes(32).toString("hex"),
      ),
    ).rejects.toThrow();
  });
});
