import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { RedisJobStore, createRedisRunnerFromClient, type RedisRunner } from "../src/jobs/redis-store.js";
import { JobService } from "../src/jobs/service.js";
import { makeJobId, jobKey, JOBS_SCHEMA_VERSION, type PersistedJobRecord, type JobExecution } from "../src/jobs/schema.js";

// Real-Redis execution-lease integration. CI-gated exactly like
// jobs.redis.test.ts; these MUST run serially with other Redis-clearing tests.
const URL = process.env.CEO_REDIS_URL;

const scopeA = { user_id: "usr_a", workspace_id: "ws_a" };
const scopeB = { user_id: "usr_b", workspace_id: "ws_b" };

const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const WRK2 = "wrk-f0e1d2c3-b4a5-9687-8574-635241302a11";
const ATT1 = "123e4567-e89b-12d3-a456-4266141740aa";
const ATT2 = "123e4567-e89b-12d3-a456-4266141740bb";
const TOKEN = "a".repeat(64);
const TOKEN2 = "b".repeat(64);

function sha(token: string): string {
  // Same convention as the server: sha256 over the raw utf8 text.
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Service errors are thrown as JobError (code), matching submit/get. */
async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function baseRecord(
  scope: { user_id: string; workspace_id: string },
  patch: Partial<PersistedJobRecord> = {},
): PersistedJobRecord {
  const now = Date.now();
  return {
    schema_version: JOBS_SCHEMA_VERSION,
    job_id: makeJobId(),
    request_id: "123e4567-e89b-12d3-a456-4266141740cc",
    user_id: scope.user_id,
    workspace_id: scope.workspace_id,
    workspace_ref: "tools",
    resource_id: null,
    prompt: "lease test prompt",
    acceptance: "lease test acceptance",
    execution_timeout_seconds: 120,
    request_digest: "digest",
    status: "queued",
    stream_entry_id: "999-0",
    created_at_ms: now,
    claim_deadline_ms: now + 7 * 24 * 60 * 60 * 1000,
    ...patch,
  };
}

function claimedExecution(patch: Partial<JobExecution> = {}): JobExecution {
  const now = Date.now();
  return {
    worker_id: WRK,
    attempt_id: ATT1,
    lease_token_sha256: sha(TOKEN),
    phase: "claimed",
    claimed_at_ms: now,
    start_deadline_ms: now + 300_000,
    lease_expires_at_ms: now + 90_000,
    started_at_ms: null,
    execution_deadline_ms: null,
    ...patch,
  };
}

describe.skipIf(!URL)("worker execution leases (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStore;
  let serviceA: JobService;
  let serviceB: JobService;

  async function putJob(rec: PersistedJobRecord): Promise<void> {
    await client.set(jobKey(rec.job_id), JSON.stringify(rec));
  }
  async function getJob(jobId: string): Promise<PersistedJobRecord> {
    const raw = await client.get(jobKey(jobId));
    if (!raw) throw new Error(`job ${jobId} not present`);
    return JSON.parse(raw) as PersistedJobRecord;
  }
  async function serverNowMs(jobId: string): Promise<number> {
    const res = await store.inspect(scopeA, jobId);
    if (!res.ok) throw new Error("inspect failed reading time");
    return res.server_time_ms;
  }

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
      { opTimeoutMs: 2500 },
    );
    const waitForReady = (ms = 5000) =>
      new Promise<void>((resolve, reject) => {
        const s = Date.now();
        const tick = () => {
          if (runner.ready()) return resolve();
          if (Date.now() - s > ms) return reject(new Error("runner not ready"));
          setTimeout(tick, 20);
        };
        tick();
      });
    try {
      await waitForReady();
      store = new RedisJobStore(runner);
      serviceA = new JobService({ store }, () => true);
      serviceB = new JobService({ store }, () => true);
      await store.resetForTest();
    } catch (err) {
      await runner.dispose();
      throw err;
    }
  });

  afterAll(async () => {
    await runner?.dispose();
    if (client?.isOpen) await client.quit();
  });

  it("claims a valid queued job with no execution (claimed phase + deadline math)", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    const res = await serviceA.claim(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      lease_token: TOKEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replayed).toBe(false);
    expect(res.job?.job_id).toBe(job.job_id);
    expect(res.job?.prompt).toBe(job.prompt);
    const ex = res.execution;
    expect(ex.phase).toBe("claimed");
    expect(ex.worker_id).toBe(WRK);
    expect(ex.attempt_id).toBe(ATT1);
    expect(ex.started_at).toBeNull();
    expect(ex.execution_deadline).toBeNull();
    const stored = await getJob(job.job_id);
    expect(stored.execution?.phase).toBe("claimed");
    expect(stored.execution?.lease_token_sha256).toBe(sha(TOKEN));
    expect(stored.execution!.start_deadline_ms - stored.execution!.claimed_at_ms).toBe(300_000);
    expect(stored.execution!.lease_expires_at_ms - stored.execution!.claimed_at_ms).toBe(90_000);
    const insp = await store.inspect(scopeA, job.job_id);
    expect(insp.ok).toBe(true);
    if (insp.ok) expect(insp.state).toBe("claimed");
  });

  it("concurrent claims by different attempts: exactly one wins, loser gets JOB_ALREADY_CLAIMED", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    const calls = [
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK2, attempt_id: ATT2, workspace_ref: "tools", lease_token: TOKEN2 }),
    ];
    const results = await Promise.allSettled(calls);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const loser = rejected[0] as PromiseRejectedResult;
    expect((loser.reason as { code?: string }).code).toBe("JOB_ALREADY_CLAIMED");
  });

  it("same-attempt concurrent retry: one writes, others replay with identical execution", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      ),
    );
    const okResults = results as Array<{ ok: true; replayed: boolean; execution: { claimed_at: string; worker_id: string } }>;
    expect(okResults.filter((r) => !r.replayed).length).toBe(1);
    expect(new Set(okResults.map((r) => r.execution.claimed_at)).size).toBe(1);
    const stored = await getJob(job.job_id);
    expect(stored.execution?.worker_id).toBe(WRK);
    expect(stored.execution?.attempt_id).toBe(ATT1);
  });

  it("same attempt with different token/worker/workspace is a conflict and leaves the record unchanged", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    const first = await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    expect(first.ok).toBe(true);
    const before = await getJob(job.job_id);
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN2 }),
      "IDEMPOTENCY_CONFLICT",
    );
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK2, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "IDEMPOTENCY_CONFLICT",
    );
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "other", lease_token: TOKEN }),
      "IDEMPOTENCY_CONFLICT",
    );
    const after = await getJob(job.job_id);
    expect(after.execution).toEqual(before.execution);
  });

  it("first claim with mismatched workspace_ref is rejected", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "not-tools", lease_token: TOKEN }),
      "WORKSPACE_MISMATCH",
    );
    expect((await getJob(job.job_id)).execution).toBeUndefined();
  });

  it("rejects claim on an expired claim window (JOB_EXPIRED)", async () => {
    const job = baseRecord(scopeA, { claim_deadline_ms: 1_000_000 });
    await putJob(job);
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "JOB_EXPIRED",
    );
    expect((await getJob(job.job_id)).execution).toBeUndefined();
  });

  it("does not claim incomplete or corrupt records, and never overwrites them", async () => {
    const preparing = baseRecord(scopeA, { status: "preparing", stream_entry_id: null });
    await putJob(preparing);
    await rejectsCode(
      serviceA.claim(scopeA, preparing.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "QUEUE_UNAVAILABLE",
    );
    const pAfter = await getJob(preparing.job_id);
    expect(pAfter.status).toBe("preparing");
    expect(pAfter.execution).toBeUndefined();

    const corrupt = baseRecord(scopeA);
    await putJob({ ...corrupt, execution: { ...claimedExecution(), phase: "bogus" } as unknown as JobExecution });
    await rejectsCode(
      serviceA.claim(scopeA, corrupt.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "QUEUE_UNAVAILABLE",
    );
    expect((await getJob(corrupt.job_id)).execution?.phase).toBe("bogus");
  });

  it("identity isolation: another identity cannot claim or even see a job (JOB_NOT_FOUND)", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await rejectsCode(
      serviceB.claim(scopeB, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "JOB_NOT_FOUND",
    );
    await expect(serviceB.get(scopeB, { job_id: job.job_id })).rejects.toThrow(/not found/i);
    expect((await getJob(job.job_id)).execution).toBeUndefined();
  });

  it("start transitions claimed -> running and records execution deadline/lease", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const start = await serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.replayed).toBe(false);
    expect(start.execution.phase).toBe("running");
    const stored = await getJob(job.job_id);
    const run = stored.execution!;
    expect(run.phase).toBe("running");
    expect(run.started_at_ms).not.toBeNull();
    expect(run.execution_deadline_ms! - run.started_at_ms!).toBe(120_000);
    expect(run.lease_expires_at_ms - run.started_at_ms!).toBe(90_000);
  });

  it("repeat start is a replay and leaves started_at/deadlines untouched", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    await serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    const before = await getJob(job.job_id);
    const second = await serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    const after = await getJob(job.job_id);
    expect(after.execution).toEqual(before.execution);
  });

  it("start/heartbeat on an unclaimed job is JOB_NOT_CLAIMED", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await rejectsCode(serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN }), "JOB_NOT_CLAIMED");
    await rejectsCode(serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN }), "JOB_NOT_CLAIMED");
  });

  it("start/heartbeat with mismatched credentials is LEASE_MISMATCH", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    await rejectsCode(serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT2, lease_token: TOKEN }), "LEASE_MISMATCH");
    await rejectsCode(serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN2 }), "LEASE_MISMATCH");
  });

  it("claimed heartbeat renews the lease without exceeding the five-minute start window", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const h = await serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.execution.phase).toBe("claimed");
    const stored = await getJob(job.job_id);
    expect(stored.execution!.lease_expires_at_ms).toBeLessThanOrEqual(stored.execution!.start_deadline_ms);
    expect(stored.execution!.started_at_ms).toBeNull();
  });

  it("running heartbeat caps at the execution deadline (never exceeds)", async () => {
    const job = baseRecord(scopeA, { execution_timeout_seconds: 120 });
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const claimed = await getJob(job.job_id);
    const nearDeadline = Date.now() + 30_000;
    claimed.execution = {
      ...claimed.execution!,
      phase: "running",
      started_at_ms: Date.now(),
      execution_deadline_ms: nearDeadline,
      lease_expires_at_ms: Date.now() + 20_000,
    } as JobExecution;
    await putJob(claimed);
    const h = await serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    const stored = await getJob(job.job_id);
    expect(stored.execution!.lease_expires_at_ms).toBeLessThanOrEqual(stored.execution!.execution_deadline_ms!);
    expect(stored.execution!.lease_expires_at_ms).toBeGreaterThan(nearDeadline - 5_000);
  });

  it("rejects start/heartbeat when the lease has expired and forbids takeover", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const rec = await getJob(job.job_id);
    const svNow = await serverNowMs(job.job_id);
    rec.execution = { ...rec.execution!, lease_expires_at_ms: svNow - 1 } as JobExecution;
    await putJob(rec);

    await rejectsCode(serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN }), "LEASE_EXPIRED");
    await rejectsCode(serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN }), "LEASE_EXPIRED");
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN }),
      "LEASE_EXPIRED",
    );
    await rejectsCode(
      serviceA.claim(scopeA, job.job_id, { worker_id: WRK2, attempt_id: ATT2, workspace_ref: "tools", lease_token: TOKEN2 }),
      "JOB_ALREADY_CLAIMED",
    );
  });

  it("rejects heartbeat at exactly the lease deadline (now >= deadline)", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const svNow = await serverNowMs(job.job_id);
    const rec = await getJob(job.job_id);
    rec.execution = { ...rec.execution!, lease_expires_at_ms: svNow } as JobExecution;
    await putJob(rec);
    await rejectsCode(serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN }), "LEASE_EXPIRED");
  });

  it("derives queued/claimed/running/interrupted; running overrides the 7-day claim window", async () => {
    const now = Date.now();
    const q = baseRecord(scopeA);
    await putJob(q);
    const qv = await serviceA.get(scopeA, { job_id: q.job_id });
    expect(qv.ok && qv.view!.state).toBe("queued");

    const exp = baseRecord(scopeA, { claim_deadline_ms: now - 1000 });
    await putJob(exp);
    const ev = await serviceA.get(scopeA, { job_id: exp.job_id });
    expect(ev.ok && ev.view!.state).toBe("expired");

    const running = baseRecord(scopeA, { claim_deadline_ms: now - 1000 });
    running.execution = {
      ...claimedExecution(),
      phase: "running",
      started_at_ms: now,
      execution_deadline_ms: now + 60_000,
      lease_expires_at_ms: now + 60_000,
    } as JobExecution;
    await putJob(running);
    const rv = await serviceA.get(scopeA, { job_id: running.job_id });
    expect(rv.ok && rv.view!.state).toBe("running");
    expect(rv.ok && rv.view!.execution?.started_at).not.toBeNull();

    const inter = baseRecord(scopeA);
    inter.execution = {
      ...claimedExecution(),
      phase: "running",
      started_at_ms: now,
      execution_deadline_ms: now - 1,
      lease_expires_at_ms: now - 1,
    } as JobExecution;
    await putJob(inter);
    const iv = await serviceA.get(scopeA, { job_id: inter.job_id });
    expect(iv.ok && iv.view!.state).toBe("interrupted");
    expect(iv.ok && iv.view!.execution?.reason).not.toBeNull();
  });

  it("worker_submit replay reflects the current claimed/running/interrupted state and never re-queues", async () => {
    const reqRun = "123e4567-e89b-12d3-a456-4266141740dd";
    const s1 = await serviceA.submit(scopeA, { request_id: reqRun, workspace_ref: "tools", prompt: "replay running", acceptance: "a", timeout_seconds: 120 });
    expect(s1.ok).toBe(true);
    const jid = s1.view!.job_id;
    await serviceA.claim(scopeA, jid, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    await serviceA.start(scopeA, jid, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    const rp = await serviceA.submit(scopeA, { request_id: reqRun, workspace_ref: "tools", prompt: "replay running", acceptance: "a", timeout_seconds: 120 });
    expect(rp.ok).toBe(true);
    expect(rp.view!.replayed).toBe(true);
    expect(rp.view!.job_id).toBe(jid);
    expect(rp.view!.state).toBe("running");

    const reqInter = "123e4567-e89b-12d3-a456-4266141740ee";
    const s2 = await serviceA.submit(scopeA, { request_id: reqInter, workspace_ref: "tools", prompt: "replay interrupted", acceptance: "a", timeout_seconds: 120 });
    expect(s2.ok).toBe(true);
    const jid2 = s2.view!.job_id;
    await serviceA.claim(scopeA, jid2, { worker_id: WRK, attempt_id: ATT2, workspace_ref: "tools", lease_token: TOKEN2 });
    await serviceA.start(scopeA, jid2, { worker_id: WRK, attempt_id: ATT2, lease_token: TOKEN2 });
    const svNow = await serverNowMs(jid2);
    const rec2 = await getJob(jid2);
    rec2.execution = { ...rec2.execution!, execution_deadline_ms: svNow - 1, lease_expires_at_ms: svNow - 1 } as JobExecution;
    await putJob(rec2);
    const rp2 = await serviceA.submit(scopeA, { request_id: reqInter, workspace_ref: "tools", prompt: "replay interrupted", acceptance: "a", timeout_seconds: 120 });
    expect(rp2.ok).toBe(true);
    expect(rp2.view!.replayed).toBe(true);
    expect(rp2.view!.state).toBe("interrupted");
  });

  it("lease operations add no stream messages and outputs never expose the token", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    const before = await store.streamLength();
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    await serviceA.start(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    await serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    const gv = await serviceA.get(scopeA, { job_id: job.job_id });
    expect(await store.streamLength()).toBe(before);
    expect(JSON.stringify(gv.view)).not.toContain(TOKEN);
    expect(JSON.stringify(gv.view)).not.toContain(sha(TOKEN));
  });

  it("reloads the lease script after SCRIPT FLUSH and still inspects/heartbeats", async () => {
    const job = baseRecord(scopeA);
    await putJob(job);
    await serviceA.claim(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", lease_token: TOKEN });
    const cachedSha = store.getLeaseShaForTest();
    expect(cachedSha).toBeTruthy();
    await client.sendCommand(["SCRIPT", "FLUSH"]);
    const insp = await store.inspect(scopeA, job.job_id);
    expect(insp.ok).toBe(true);
    if (insp.ok) expect(insp.state).toBe("claimed");
    const h = await serviceA.heartbeat(scopeA, job.job_id, { worker_id: WRK, attempt_id: ATT1, lease_token: TOKEN });
    expect(h.ok).toBe(true);
    expect(store.getLeaseShaForTest()).toBeTruthy();
  });
});
