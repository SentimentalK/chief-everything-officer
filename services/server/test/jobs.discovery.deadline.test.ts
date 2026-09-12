import { describe, expect, it, vi } from "vitest";
import { JobService, type JobAuthScope } from "../src/jobs/service.js";
import type { RedisJobStore } from "../src/jobs/redis-store.js";
import {
  JOBS_SCHEMA_VERSION,
  type PersistedJobRecord,
} from "../src/jobs/schema.js";
import type { AssignmentScriptResult } from "../src/jobs/assignment-schema.js";

// Deterministic unit tests for the discovery page deadline (section 6). They
// drive the REAL JobService.pending() over a fake store whose per-record I/O
// advances an injected monotonic clock by a fixed amount, so the cumulative
// budget logic is exercised without a wall-clock race. No Redis is used.

const scope: JobAuthScope = { user_id: "usr_a", workspace_id: "ws_a" };
const wsRef = "tools";

/** Fake monotonic clock in ms. */
interface FakeClock {
  now(): number;
  t: number;
}
function makeClock(): FakeClock {
  return {
    t: 0,
    now() {
      return this.t;
    },
  };
}

function makeQueued(jobId: string, streamEntryId: string): PersistedJobRecord {
  return {
    schema_version: JOBS_SCHEMA_VERSION,
    job_id: jobId,
    request_id: "123e4567-e89b-12d3-a456-000000000001",
    user_id: scope.user_id,
    workspace_id: scope.workspace_id,
    workspace_ref: wsRef,
    resource_id: null,
    prompt: "p",
    acceptance: "a",
    execution_timeout_seconds: 120,
    request_digest: "digest",
    status: "queued",
    stream_entry_id: streamEntryId,
    created_at_ms: 0,
    claim_deadline_ms: Date.now() + 604_800_000,
  };
}

interface FakeSource {
  entries: Array<{ id: string; record: PersistedJobRecord }>;
  /** ms added to the fake clock each time inspectAssignment() runs (simulated I/O). */
  inspectCostMs: number;
  /** Optional real delay (ms) injected into inspectAssignment() to outlive the deadline. */
  inspectDelayMs?: number;
  reads: number;
  inspects: number;
  clock: FakeClock;
}

/**
 * A store that stands in for the parts of RedisJobStore pending() touches:
 * readiness, XRANGE, and the assignment inspect. Each inspect advances the injected
 * clock by `inspectCostMs` (or, when `inspectDelayMs` is set, really sleeps so
 * the outer wall-clock deadline can fire mid-command).
 */
function fakeStore(src: FakeSource): RedisJobStore {
  const records = new Map(src.entries.map((e) => [e.record.job_id, e.record]));
  return {
    isReady: () => true,
    async readStreamEntries(_after: string, count: number) {
      src.reads += 1;
      return src.entries.slice(0, count).map((e) => ({
        id: e.id,
        fields: {
          schema_version: "1",
          job_id: e.record.job_id,
          user_id: scope.user_id,
          workspace_id: scope.workspace_id,
        },
      }));
    },
    async inspectAssignment(_s: JobAuthScope, jobId: string): Promise<AssignmentScriptResult> {
      src.inspects += 1;
      if (src.inspectDelayMs) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, src.inspectDelayMs);
        await promise;
        clearTimeout(timer);
      }
      src.clock.t += src.inspectCostMs;
      const record = records.get(jobId);
      if (!record) {
        return { ok: false, code: "JOB_NOT_FOUND", reason: null };
      }
      return {
        ok: true,
        record,
        server_time_ms: Date.now(),
        state: "queued",
        replayed: false,
      };
    },
  } as unknown as RedisJobStore;
}

function serviceOver(
  src: FakeSource,
  opts: { budgetMs?: number; nowMs?: () => number },
): JobService {
  const store = fakeStore(src);
  return new JobService({ store }, () => true, {
    discoveryBudgetMs: opts.budgetMs ?? 5000,
    nowMs: opts.nowMs ?? (() => src.clock.now()),
  });
}

function makeEntries(n: number): FakeSource["entries"] {
  const out: FakeSource["entries"] = [];
  for (let i = 1; i <= n; i++) {
    const jobId = `job-123e4567-e89b-12d3-a456-${String(i).padStart(12, "0")}`;
    out.push({ id: `${1000 + i}-1`, record: makeQueued(jobId, `${1000 + i}-1`) });
  }
  return out;
}

describe("worker discovery page deadline (real pending(), injected clock)", () => {
  it("returns a normal page when the whole page finishes within budget", async () => {
    const clock = makeClock();
    const src: FakeSource = { entries: makeEntries(3), inspectCostMs: 100, reads: 0, inspects: 0, clock };
    const svc = serviceOver(src, { budgetMs: 10_000 });
    const res = await svc.pending(scope, { workspace_ref: wsRef, after: "0-0" });
    expect(res.ok).toBe(true);
    expect(res.jobs).toHaveLength(3);
    expect(res.jobs.map((j) => j.job_id)).toEqual(src.entries.map((e) => e.record.job_id));
    expect(res.has_more).toBe(false);
  });

  it("fails when each inspect is under the single-op timeout but cumulative work exceeds the page budget", async () => {
    const clock = makeClock();
    const src: FakeSource = { entries: makeEntries(5), inspectCostMs: 400, reads: 0, inspects: 0, clock };
    // budget 1000ms fake; three inspects reach t=1200 > deadline.
    const svc = serviceOver(src, { budgetMs: 1000 });
    await expect(svc.pending(scope, { workspace_ref: wsRef, after: "0-0" })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    // The abort happened after the third inspect; no further inspects ran.
    expect(src.inspects).toBe(3);
    expect(src.reads).toBe(1);
  });

  it("fails when the last completed inspect lands exactly on the deadline", async () => {
    const clock = makeClock();
    const src: FakeSource = { entries: makeEntries(4), inspectCostMs: 500, reads: 0, inspects: 0, clock };
    const svc = serviceOver(src, { budgetMs: 1000 });
    // inspect 1 -> t=500 (<1000 ok), inspect 2 -> t=1000 (>=1000 -> reject).
    await expect(svc.pending(scope, { workspace_ref: wsRef, after: "0-0" })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    expect(src.inspects).toBe(2);
  });

  it("fails when a completed inspect returns after the deadline has passed", async () => {
    const clock = makeClock();
    const src: FakeSource = { entries: makeEntries(4), inspectCostMs: 600, reads: 0, inspects: 0, clock };
    const svc = serviceOver(src, { budgetMs: 1000 });
    // inspect 1 -> t=600 ok; inspect 2 -> t=1200 past deadline -> reject.
    await expect(svc.pending(scope, { workspace_ref: wsRef, after: "0-0" })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    expect(src.inspects).toBe(2);
  });

  it("does not read entries scheduled after the deadline was reached", async () => {
    const clock = makeClock();
    const src: FakeSource = { entries: makeEntries(20), inspectCostMs: 400, reads: 0, inspects: 0, clock };
    const svc = serviceOver(src, { budgetMs: 1000 });
    await expect(svc.pending(scope, { workspace_ref: wsRef, after: "0-0" })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
    });
    // Only 3 of 20 entries were inspected before the deadline aborted the page.
    expect(src.inspects).toBe(3);
  });
});

describe("worker discovery outer deadline (in-flight command overshoots)", () => {
  it("caps wall time via the outer deadline and never inspects after a late success", async () => {
    vi.useFakeTimers();
    try {
      const clock = makeClock();
      // Each inspect really sleeps 300ms (a single in-flight Redis command),
      // while the page budget is 25ms, so the outer deadline fires mid-command.
      const src: FakeSource = {
        entries: makeEntries(5),
        inspectCostMs: 0,
        inspectDelayMs: 300,
        reads: 0,
        inspects: 0,
        clock,
      };
      const svc = serviceOver(src, { budgetMs: 25 });

      // Attach rejection handling synchronously so the pending page's rejection
      // (fired by the outer fake-timer deadline) is never observed unhandled.
      const outcome = svc
        .pending(scope, { workspace_ref: wsRef, after: "0-0" })
        .then(
          (v) => ({ fulfilled: true as const, v }),
          (e) => ({ fulfilled: false as const, e }),
        );

      // Fire the outer 25ms deadline while the first inspect is still in flight.
      await vi.advanceTimersByTimeAsync(25);
      const first = await outcome;
      expect(first.fulfilled).toBe(false);
      if (!first.fulfilled) {
        expect((first.e as { code: string }).code).toBe("QUEUE_UNAVAILABLE");
      }

      // Let the in-flight inspect resolve afterwards: the page must stay failed
      // and no second entry may ever be inspected.
      await vi.advanceTimersByTimeAsync(300);
      expect(src.inspects).toBe(1);
      expect(src.reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
