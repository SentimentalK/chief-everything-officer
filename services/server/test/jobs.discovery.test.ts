import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { RedisJobStore, createRedisRunnerFromClient, type RedisRunner } from "../src/jobs/redis-store.js";
import { JobService } from "../src/jobs/service.js";
import {
  makeJobId,
  KEY_STREAM,
  jobKey,
  JOBS_SCHEMA_VERSION,
  DISCOVERY_PAGE_SIZE,
  type PersistedJobRecord,
  type JobAssignment,
} from "../src/jobs/schema.js";

// Real-Redis task discovery integration (CI-gated; MUST run serially with the
// other Redis-clearing test files so no test deletes another's keys mid-run).
const URL = process.env.CEO_REDIS_URL;

const scopeA = { user_id: "usr_a", workspace_id: "ws_a" };
const scopeB = { user_id: "usr_b", workspace_id: "ws_b" };

const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ATT1 = "123e4567-e89b-12d3-a456-4266141740aa";
const TOKEN = "a".repeat(64);

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

let reqCounter = 0;
function nextReq(): string {
  reqCounter += 1;
  const hex = reqCounter.toString(16).padStart(12, "0");
  return `123e4567-e89b-12d3-a456-${hex}`;
}

const submitBody = (workspaceRef = "tools") => ({
  request_id: nextReq(),
  workspace_ref: workspaceRef,
  prompt: "discovery prompt",
  acceptance: "discovery acceptance",
  timeout_seconds: 120,
});

describe.skipIf(!URL)("worker task discovery (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStore;
  let serviceA: JobService;
  let serviceB: JobService;

  async function addRawEntry(fields: Record<string, string>): Promise<void> {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(k, v);
    await client.sendCommand(["XADD", KEY_STREAM, "*", ...parts]);
  }
  async function getRawJob(jobId: string): Promise<PersistedJobRecord> {
    const raw = await client.get(jobKey(jobId));
    if (!raw) throw new Error(`missing job ${jobId}`);
    return JSON.parse(raw) as PersistedJobRecord;
  }
  async function setJob(rec: PersistedJobRecord): Promise<void> {
    await client.set(jobKey(rec.job_id), JSON.stringify(rec));
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

  it("discovers a newly submitted v2 job through the v1 stream envelope", async () => {
    await store.resetForTest();
    const sub = await serviceA.submit(scopeA, submitBody());
    expect(sub.ok).toBe(true);
    const jobId = sub.view!.job_id;

    // Assert JobRecord version is 2
    const rec = await getRawJob(jobId);
    expect(rec.schema_version).toBe(2);

    // Assert Stream envelope version is "1"
    const streamEntries = await store.readStreamEntries("0-0", 10);
    const entry = streamEntries.find((e) => e.fields.job_id === jobId);
    expect(entry).toBeDefined();
    expect(entry!.fields.schema_version).toBe("1");

    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    expect(res.ok).toBe(true);
    expect(res.jobs.length).toBe(1);
    expect(res.jobs[0]!.job_id).toBe(jobId);
    expect(res.jobs[0]!.workspace_ref).toBe("tools");
    expect(res.has_more).toBe(false);
  });

  it("does not leak cross-workspace or cross-user jobs", async () => {
    await store.resetForTest();
    const aJob = await serviceA.submit(scopeA, submitBody());
    const bJob = await serviceB.submit(scopeB, submitBody());
    expect(aJob.ok && bJob.ok).toBe(true);
    // A different workspace_ref filters A's own job out.
    const otherWs = await serviceA.pending(scopeA, { workspace_ref: "development", after: "0-0" });
    expect(otherWs.jobs).toEqual([]);
    // A (tools) only sees A's own tools job, never B's.
    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    const ids = res.jobs.map((j) => j.job_id);
    expect(ids).toContain(aJob.view!.job_id);
    expect(ids).not.toContain(bJob.view!.job_id);
  });

  it("excludes claimed/running/expired executions from candidates", async () => {
    await store.resetForTest();
    const q = await serviceA.submit(scopeA, submitBody()); // queued
    const claimed = await serviceA.submit(scopeA, submitBody());
    await serviceA.claim(scopeA, claimed.view!.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", claim_token: TOKEN });
    const running = await serviceA.submit(scopeA, submitBody());
    await serviceA.claim(scopeA, running.view!.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", claim_token: TOKEN });
    await serviceA.start(scopeA, running.view!.job_id, { worker_id: WRK, attempt_id: ATT1, claim_token: TOKEN });

    // Expired (no execution, past 7-day claim window)
    const expired = await serviceA.submit(scopeA, submitBody());
    const exRec = await getRawJob(expired.view!.job_id);
    const now = Date.now();
    exRec.created_at_ms = now - 100_000;
    exRec.claim_deadline_ms = now - 50_000;
    await setJob(exRec);

    const gotExpired = await serviceA.get(scopeA, { job_id: expired.view!.job_id });
    expect(gotExpired.ok).toBe(true);
    expect(gotExpired.view?.state).toBe("expired");

    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    const ids = res.jobs.map((j) => j.job_id);
    expect(ids).toEqual([q.view!.job_id]);
    expect(ids).not.toContain(claimed.view!.job_id);
    expect(ids).not.toContain(running.view!.job_id);
    expect(ids).not.toContain(expired.view!.job_id);
  });

  it("execution:null is not treated as a queued candidate", async () => {
    await store.resetForTest();
    const good = await serviceA.submit(scopeA, submitBody());
    const bad = await serviceA.submit(scopeA, submitBody());
    const rec = await getRawJob(bad.view!.job_id);
    rec.execution = null as unknown as JobAssignment;
    await setJob(rec);
    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    const ids = res.jobs.map((j) => j.job_id);
    expect(ids).toEqual([good.view!.job_id]);
    expect(ids).not.toContain(bad.view!.job_id);
    // The corrupt record is left untouched (not overwritten, not re-queued).
    const after = await getRawJob(bad.view!.job_id);
    expect("execution" in after && after.execution === null).toBe(true);
  });

  it("pages through more than 25 entries without gaps or duplicates", async () => {
    await store.resetForTest();
    const total = 60;
    const subs = [];
    for (let i = 0; i < total; i++) subs.push(await serviceA.submit(scopeA, submitBody()));
    const expected = subs.map((s) => s.view!.job_id).sort();

    const collected: string[] = [];
    let after = "0-0";
    for (let page = 0; page < 10; page++) {
      const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after });
      collected.push(...res.jobs.map((j) => j.job_id));
      after = res.next_cursor;
      expect(res.jobs.length).toBeLessThanOrEqual(DISCOVERY_PAGE_SIZE);
      if (!res.has_more) break;
    }
    expect(new Set(collected).size).toBe(total);
    expect(collected.sort()).toEqual(expected);
    expect(new Set(collected).size).toBe(total);
  });

  it("when the first page is entirely another identity it returns empty, advances, and has_more=true", async () => {
    await store.resetForTest();
    for (let i = 0; i < DISCOVERY_PAGE_SIZE; i++) {
      const r = await serviceB.submit(scopeB, submitBody());
      expect(r.ok).toBe(true);
    }
    const first = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    expect(first.jobs).toEqual([]);
    expect(first.has_more).toBe(true);
    // Cursor moved past the B-only window; a second page finds nothing.
    const second = await serviceA.pending(scopeA, { workspace_ref: "tools", after: first.next_cursor });
    expect(second.jobs).toEqual([]);
    expect(second.has_more).toBe(false);
  });

  it("skips corrupt/incomplete entries yet still returns later valid tasks", async () => {
    await store.resetForTest();
    // A corrupt entry first (malformed job id), then an incomplete (owned but
    // no committed record), then a fully valid A job.
    await addRawEntry({ schema_version: "1", job_id: "not-a-real-job", user_id: scopeA.user_id, workspace_id: scopeA.workspace_id });
    const badJob = makeJobId();
    await addRawEntry({ schema_version: "1", job_id: badJob, user_id: scopeA.user_id, workspace_id: scopeA.workspace_id });
    // badJob record exists but is 'preparing' -> incomplete (not a candidate).
    await setJob({
      schema_version: JOBS_SCHEMA_VERSION,
      job_id: badJob,
      request_id: "123e4567-e89b-12d3-a456-4266bad0000000",
      user_id: scopeA.user_id,
      workspace_id: scopeA.workspace_id,
      workspace_ref: "tools",
      resource_id: null,
      prompt: "x",
      acceptance: "x",
      execution_timeout_seconds: 120,
      request_digest: "d",
      status: "preparing",
      stream_entry_id: null,
      created_at_ms: Date.now(),
      claim_deadline_ms: Date.now() + 604_800_000,
    });
    const good = await serviceA.submit(scopeA, submitBody());
    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    const ids = res.jobs.map((j) => j.job_id);
    expect(ids).toEqual([good.view!.job_id]);
  });

  it("an unreachable backend fails the whole page with QUEUE_UNAVAILABLE", async () => {
    // Independent JobService over a refused-port runner: never ready.
    const deadRunner = createRedisRunnerFromClient(
      () =>
        createClient({
          url: "redis://127.0.0.1:1",
          socket: { reconnectStrategy: false },
          disableOfflineQueue: true,
        }),
      { opTimeoutMs: 100 },
    );
    const deadService = new JobService({ store: new RedisJobStore(deadRunner) }, () => true);
    try {
      await expect(deadService.pending(scopeA, { workspace_ref: "tools", after: "0-0" })).rejects.toMatchObject({
        code: "QUEUE_UNAVAILABLE",
      });
    } finally {
      await deadRunner.dispose();
    }
  });

  it("two clients discovering the same job: claim still allows exactly one", async () => {
    await store.resetForTest();
    const sub = await serviceA.submit(scopeA, submitBody());
    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    expect(res.jobs.map((j) => j.job_id)).toEqual([sub.view!.job_id]);
    const results = await Promise.allSettled([
      serviceA.claim(scopeA, sub.view!.job_id, { worker_id: WRK, attempt_id: ATT1, workspace_ref: "tools", claim_token: TOKEN }),
      serviceA.claim(scopeA, sub.view!.job_id, {
        worker_id: WRK,
        attempt_id: "123e4567-e89b-12d3-a456-4266141740bb",
        workspace_ref: "tools",
        claim_token: "b".repeat(64),
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason as { code?: string }).toMatchObject({ code: "JOB_ALREADY_CLAIMED" });
  });

  it("discovery does not mutate JobRecord, stream, or dedupe state", async () => {
    await store.resetForTest();
    const sub = await serviceA.submit(scopeA, submitBody());
    const beforeJob = await getRawJob(sub.view!.job_id);
    const beforeLen = await store.streamLength();
    const beforePh = await store.getPlaceholder(scopeA, beforeJob.request_id);
    const res = await serviceA.pending(scopeA, { workspace_ref: "tools", after: "0-0" });
    expect(res.jobs.map((j) => j.job_id)).toEqual([sub.view!.job_id]);
    const afterJob = await getRawJob(sub.view!.job_id);
    const afterLen = await store.streamLength();
    const afterPh = await store.getPlaceholder(scopeA, beforeJob.request_id);
    expect(afterJob).toEqual(beforeJob);
    expect(afterLen).toBe(beforeLen);
    expect(afterPh).toEqual(beforePh);
  });
});
