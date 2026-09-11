import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  RedisJobStore,
  createRedisRunnerFromClient,
  type RedisRunner,
} from "../src/jobs/redis-store.js";
import {
  makeJobId,
  jobKey,
  requestKey,
  KEY_STREAM,
  type RequestPlaceholder,
} from "../src/jobs/schema.js";
import {
  ASSIGNMENT_SCHEMA_VERSION,
  type AssignmentJobRecord,
} from "../src/jobs/assignment-schema.js";

const URL = process.env.CEO_REDIS_URL;

const scopeA = { user_id: "usr_assign_a", workspace_id: "ws_assign_a" };
const scopeB = { user_id: "usr_assign_b", workspace_id: "ws_assign_b" };
const scopeA_otherWs = { user_id: "usr_assign_a", workspace_id: "ws_assign_other" };

const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const WRK2 = "wrk-f0e1d2c3-b4a5-9687-8574-635241302a11";
const ATT1 = "123e4567-e89b-12d3-a456-4266141740aa";
const ATT2 = "123e4567-e89b-12d3-a456-4266141740bb";
const TOKEN_SHA = sha("valid-claim-token-1");
const TOKEN_SHA2 = sha("valid-claim-token-2");

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function baseRecordV2(
  scope: { user_id: string; workspace_id: string },
  patch: Partial<AssignmentJobRecord> = {},
): AssignmentJobRecord {
  const now = Date.now();
  return {
    schema_version: ASSIGNMENT_SCHEMA_VERSION,
    job_id: makeJobId(),
    request_id: "123e4567-e89b-12d3-a456-4266141740cc",
    user_id: scope.user_id,
    workspace_id: scope.workspace_id,
    workspace_ref: "tools",
    resource_id: null,
    prompt: "assignment test prompt",
    acceptance: "assignment test acceptance",
    execution_timeout_seconds: 120,
    request_digest: "digest-12345",
    status: "queued",
    stream_entry_id: "999-0",
    created_at_ms: now,
    claim_deadline_ms: now + 7 * 24 * 60 * 60 * 1000,
    ...patch,
  };
}

describe("assignment script error sanitization (offline mock)", () => {
  const MARKER = "TEST_PRIVATE_ASSIGNMENT_PAYLOAD";

  const cases: Array<{ name: string; response: string }> = [
    {
      name: "corrupt non-JSON containing sensitive marker",
      response: `invalid-json-${MARKER}`,
    },
    {
      name: "valid JSON with missing required fields and marker in record",
      response: JSON.stringify({
        ok: true,
        record: { secret_payload: MARKER },
      }),
    },
  ];

  for (const tc of cases) {
    it(`sanitizes error message and details for: ${tc.name}`, async () => {
      const fakeRunner: RedisRunner = {
        ready: () => true,
        get: async () => null,
        set: async () => {},
        xaddStream: async () => "1-0",
        xlen: async () => 0,
        xrange: async () => [],
        scriptLoad: async () => "fake_sha_123",
        evalsha: async () => tc.response,
        scriptExists: async () => true,
        flush: async () => {},
      };
      const store = new RedisJobStore(fakeRunner);

      let caughtError: unknown = null;
      try {
        await store.inspectAssignment(scopeA, "job-123");
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const err = caughtError as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      expect(err.code).toBe("QUEUE_UNAVAILABLE");
      expect(err.message).toBe("Invalid assignment script response.");
      expect(err.message).not.toContain(MARKER);
      expect(JSON.stringify(err.details ?? {})).not.toContain(MARKER);
    });
  }
});

describe.skipIf(!URL)("persistent job assignment storage (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStore;

  async function putJob(rec: Record<string, unknown>): Promise<void> {
    const key = jobKey(String(rec.job_id));
    await client.set(key, JSON.stringify(rec));
  }

  async function getRawJob(jobId: string): Promise<string | null> {
    return client.get(jobKey(jobId));
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

  it("1. initial claim: sets phase=claimed, attribution from Redis, started_at=null, no lease fields", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    const res = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.replayed).toBe(false);
    expect(res.state).toBe("claimed");
    expect(res.record.schema_version).toBe(2);
    expect(res.record.execution).toBeDefined();

    const ex = res.record.execution!;
    expect(ex.phase).toBe("claimed");
    expect(ex.worker_id).toBe(WRK);
    expect(ex.attempt_id).toBe(ATT1);
    expect(ex.claim_token_sha256).toBe(TOKEN_SHA);
    expect(ex.claimed_at_ms).toBe(res.server_time_ms);
    expect(ex.started_at_ms).toBeNull();

    // Verify absence of legacy lease fields
    expect((ex as Record<string, unknown>).lease_token_sha256).toBeUndefined();
    expect((ex as Record<string, unknown>).lease_expires_at_ms).toBeUndefined();
    expect((ex as Record<string, unknown>).start_deadline_ms).toBeUndefined();
    expect((ex as Record<string, unknown>).execution_deadline_ms).toBeUndefined();

    // Verify persisted record in Redis
    const raw = await getRawJob(job.job_id);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.execution.phase).toBe("claimed");
    expect(parsed.execution.started_at_ms).toBeNull();
    expect(parsed.execution.lease_token_sha256).toBeUndefined();

    // Verify inspectAssignment returns claimed state
    const insp = await store.inspectAssignment(scopeA, job.job_id);
    expect(insp.ok).toBe(true);
    if (insp.ok) {
      expect(insp.state).toBe("claimed");
      expect(insp.record.execution?.phase).toBe("claimed");
    }
  });

  it("2. concurrent claims by different workers: exactly one succeeds, others get JOB_ALREADY_CLAIMED", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    const calls = [
      store.claimAssignment(scopeA, job.job_id, {
        worker_id: WRK,
        attempt_id: ATT1,
        workspace_ref: "tools",
        claim_token_sha256: TOKEN_SHA,
      }),
      store.claimAssignment(scopeA, job.job_id, {
        worker_id: WRK2,
        attempt_id: ATT2,
        workspace_ref: "tools",
        claim_token_sha256: TOKEN_SHA2,
      }),
    ];

    const results = await Promise.all(calls);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect((failures[0] as { ok: false; code: string }).code).toBe("JOB_ALREADY_CLAIMED");

    // Winning attribution retained
    const raw = await getRawJob(job.job_id);
    const parsed = JSON.parse(raw!);
    const winner = successes[0] as { ok: true; record: AssignmentJobRecord };
    expect(parsed.execution.attempt_id).toBe(winner.record.execution?.attempt_id);
  });

  it("3. identical claim retry (concurrent & sequential): exactly one replayed=false, others replayed=true", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    const initial = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.replayed).toBe(false);

    const rawBeforeReplay = await getRawJob(job.job_id);

    // Sequential replay
    const seqReplay = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(seqReplay.ok).toBe(true);
    if (seqReplay.ok) {
      expect(seqReplay.replayed).toBe(true);
      expect(seqReplay.record.execution?.claimed_at_ms).toBe(initial.record.execution?.claimed_at_ms);
      expect(seqReplay.record.execution?.worker_id).toBe(WRK);
    }

    // Concurrent replays
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.claimAssignment(scopeA, job.job_id, {
          worker_id: WRK,
          attempt_id: ATT1,
          workspace_ref: "tools",
          claim_token_sha256: TOKEN_SHA,
        }),
      ),
    );

    for (const res of concurrent) {
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.replayed).toBe(true);
        expect(res.record.execution?.claimed_at_ms).toBe(initial.record.execution?.claimed_at_ms);
      }
    }

    // Redis raw bytes unchanged on replay
    const rawAfterReplay = await getRawJob(job.job_id);
    expect(rawAfterReplay).toBe(rawBeforeReplay);
  });

  it("4. same attempt with modified worker/token/alias yields IDEMPOTENCY_CONFLICT with byte-for-byte unchanged Redis key", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    const first = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(first.ok).toBe(true);

    const rawBefore = await getRawJob(job.job_id);

    // Conflict 1: different worker
    const diffWorker = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK2,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(diffWorker.ok).toBe(false);
    if (!diffWorker.ok) expect(diffWorker.code).toBe("IDEMPOTENCY_CONFLICT");

    // Conflict 2: different token sha
    const diffToken = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA2,
    });
    expect(diffToken.ok).toBe(false);
    if (!diffToken.ok) expect(diffToken.code).toBe("IDEMPOTENCY_CONFLICT");

    // Conflict 3: different workspace_ref
    const diffRef = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "other_ref",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(diffRef.ok).toBe(false);
    if (!diffRef.ok) expect(diffRef.code).toBe("IDEMPOTENCY_CONFLICT");

    // Ensure Redis raw JSON string is completely identical
    const rawAfter = await getRawJob(job.job_id);
    expect(rawAfter).toBe(rawBefore);
  });

  it("5. auth & scope isolation: other user or different workspace gets uniform JOB_NOT_FOUND", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    // Cross-user inspect, claim, start
    const inspB = await store.inspectAssignment(scopeB, job.job_id);
    expect(inspB.ok).toBe(false);
    if (!inspB.ok) expect(inspB.code).toBe("JOB_NOT_FOUND");

    const claimB = await store.claimAssignment(scopeB, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimB.ok).toBe(false);
    if (!claimB.ok) expect(claimB.code).toBe("JOB_NOT_FOUND");

    const startB = await store.startAssignment(scopeB, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startB.ok).toBe(false);
    if (!startB.ok) expect(startB.code).toBe("JOB_NOT_FOUND");

    // Cross-workspace (same user, different workspace)
    const inspWs = await store.inspectAssignment(scopeA_otherWs, job.job_id);
    expect(inspWs.ok).toBe(false);
    if (!inspWs.ok) expect(inspWs.code).toBe("JOB_NOT_FOUND");

    const claimWs = await store.claimAssignment(scopeA_otherWs, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimWs.ok).toBe(false);
    if (!claimWs.ok) expect(claimWs.code).toBe("JOB_NOT_FOUND");

    const startWs = await store.startAssignment(scopeA_otherWs, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startWs.ok).toBe(false);
    if (!startWs.ok) expect(startWs.code).toBe("JOB_NOT_FOUND");
  });

  it("6. claimed records with historical timestamps never expire or get interrupted", async () => {
    const now = Date.now();
    const oldClaimedAt = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    const oldClaimDeadline = now - 23 * 24 * 60 * 60 * 1000; // deadline expired 23 days ago

    const historicalJob: AssignmentJobRecord = baseRecordV2(scopeA, {
      created_at_ms: oldClaimedAt - 1000,
      claim_deadline_ms: oldClaimDeadline,
      execution: {
        worker_id: WRK,
        attempt_id: ATT1,
        claim_token_sha256: TOKEN_SHA,
        phase: "claimed",
        claimed_at_ms: oldClaimedAt,
        started_at_ms: null,
      },
    });
    await putJob(historicalJob);

    // Inspect still returns claimed (not expired, not interrupted)
    const insp = await store.inspectAssignment(scopeA, historicalJob.job_id);
    expect(insp.ok).toBe(true);
    if (insp.ok) {
      expect(insp.state).toBe("claimed");
      expect(insp.record.execution?.claimed_at_ms).toBe(oldClaimedAt);
    }

    // Replay claim still succeeds with replayed: true despite passing 7-day claim deadline
    const rep = await store.claimAssignment(scopeA, historicalJob.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(rep.ok).toBe(true);
    if (rep.ok) {
      expect(rep.replayed).toBe(true);
      expect(rep.state).toBe("claimed");
      expect(rep.record.execution?.claimed_at_ms).toBe(oldClaimedAt);
    }
  });

  it("7. start and start replay: first sets running, replay preserves started_at; claim replay does not downgrade running", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    const claimRes = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimRes.ok).toBe(true);

    // First start
    const startRes = await store.startAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startRes.ok).toBe(true);
    if (!startRes.ok) return;

    expect(startRes.replayed).toBe(false);
    expect(startRes.state).toBe("running");
    expect(startRes.record.execution?.phase).toBe("running");
    const startedAt = startRes.record.execution?.started_at_ms;
    expect(typeof startedAt).toBe("number");
    expect(startedAt).toBeGreaterThanOrEqual(startRes.record.execution!.claimed_at_ms);

    const rawAfterStart = await getRawJob(job.job_id);

    // Start replay
    const startReplay = await store.startAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startReplay.ok).toBe(true);
    if (startReplay.ok) {
      expect(startReplay.replayed).toBe(true);
      expect(startReplay.state).toBe("running");
      expect(startReplay.record.execution?.started_at_ms).toBe(startedAt);
    }
    const rawAfterStartReplay = await getRawJob(job.job_id);
    expect(rawAfterStartReplay).toBe(rawAfterStart);

    // Claim replay on running job: returns running, does not downgrade phase to claimed
    const claimReplay = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimReplay.ok).toBe(true);
    if (claimReplay.ok) {
      expect(claimReplay.replayed).toBe(true);
      expect(claimReplay.state).toBe("running");
      expect(claimReplay.record.execution?.phase).toBe("running");
      expect(claimReplay.record.execution?.started_at_ms).toBe(startedAt);
    }
    const rawAfterClaimReplay = await getRawJob(job.job_id);
    expect(rawAfterClaimReplay).toBe(rawAfterStart);
  });

  it("8. corrupt, unsupported schema_version, and incomplete records return expected errors without modifying key", async () => {
    // 8.1 Unsupported schema version (version 1)
    const v1Job = {
      ...baseRecordV2(scopeA),
      schema_version: 1,
    };
    await putJob(v1Job);
    const rawV1Before = await getRawJob(v1Job.job_id);

    const v1Inspect = await store.inspectAssignment(scopeA, v1Job.job_id);
    expect(v1Inspect.ok).toBe(false);
    if (!v1Inspect.ok) {
      expect(v1Inspect.code).toBe("QUEUE_UNAVAILABLE");
      expect(v1Inspect.reason).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }

    const v1Claim = await store.claimAssignment(scopeA, v1Job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(v1Claim.ok).toBe(false);
    if (!v1Claim.ok) {
      expect(v1Claim.code).toBe("QUEUE_UNAVAILABLE");
      expect(v1Claim.reason).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }
    expect(await getRawJob(v1Job.job_id)).toBe(rawV1Before);

    // 8.2 Incomplete submission (status='preparing')
    const prepJob = baseRecordV2(scopeA, { status: "preparing", stream_entry_id: null });
    await putJob(prepJob);
    const rawPrepBefore = await getRawJob(prepJob.job_id);

    const prepClaim = await store.claimAssignment(scopeA, prepJob.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(prepClaim.ok).toBe(false);
    if (!prepClaim.ok) {
      expect(prepClaim.code).toBe("QUEUE_UNAVAILABLE");
      expect(prepClaim.reason).toBe("INCOMPLETE_SUBMISSION");
    }
    expect(await getRawJob(prepJob.job_id)).toBe(rawPrepBefore);

    // 8.3 Corrupt record: contains legacy lease fields in execution
    const mixedJob = {
      ...baseRecordV2(scopeA),
      execution: {
        worker_id: WRK,
        attempt_id: ATT1,
        claim_token_sha256: TOKEN_SHA,
        phase: "claimed",
        claimed_at_ms: Date.now(),
        started_at_ms: null,
        lease_expires_at_ms: Date.now() + 90000, // Legacy lease field!
      },
    };
    await putJob(mixedJob);
    const rawMixedBefore = await getRawJob(mixedJob.job_id);

    const mixedInsp = await store.inspectAssignment(scopeA, mixedJob.job_id);
    expect(mixedInsp.ok).toBe(false);
    if (!mixedInsp.ok) {
      expect(mixedInsp.code).toBe("QUEUE_UNAVAILABLE");
      expect(mixedInsp.reason).toBe("CORRUPT_RECORD");
    }
    expect(await getRawJob(mixedJob.job_id)).toBe(rawMixedBefore);

    // 8.4 Start on unclaimed job -> JOB_NOT_CLAIMED
    const unclaimedJob = baseRecordV2(scopeA);
    await putJob(unclaimedJob);
    const startUnclaimed = await store.startAssignment(scopeA, unclaimedJob.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startUnclaimed.ok).toBe(false);
    if (!startUnclaimed.ok) expect(startUnclaimed.code).toBe("JOB_NOT_CLAIMED");

    // 8.5 Start with mismatched credentials -> ASSIGNMENT_MISMATCH
    const claimedJob = baseRecordV2(scopeA);
    await putJob(claimedJob);
    await store.claimAssignment(scopeA, claimedJob.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    const startMismatch = await store.startAssignment(scopeA, claimedJob.job_id, {
      worker_id: WRK2, // wrong worker
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startMismatch.ok).toBe(false);
    if (!startMismatch.ok) expect(startMismatch.code).toBe("ASSIGNMENT_MISMATCH");

    // 8.6 Clock regression: claimed_at_ms in the future -> CLOCK_REGRESSION
    const futureClaimedJob: AssignmentJobRecord = baseRecordV2(scopeA, {
      execution: {
        worker_id: WRK,
        attempt_id: ATT1,
        claim_token_sha256: TOKEN_SHA,
        phase: "claimed",
        claimed_at_ms: Date.now() + 10_000_000, // far future
        started_at_ms: null,
      },
    });
    await putJob(futureClaimedJob);
    const clockReg = await store.startAssignment(scopeA, futureClaimedJob.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(clockReg.ok).toBe(false);
    if (!clockReg.ok) {
      expect(clockReg.code).toBe("QUEUE_UNAVAILABLE");
      expect(clockReg.reason).toBe("CLOCK_REGRESSION");
    }
  });

  it("9. SCRIPT FLUSH triggers NOSCRIPT transparent reload and subsequent success", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    // Warm up assignment script
    const insp1 = await store.inspectAssignment(scopeA, job.job_id);
    expect(insp1.ok).toBe(true);
    const cachedSha = store.getAssignmentShaForTest();
    expect(cachedSha).not.toBeNull();

    // Flush script cache in Redis
    await client.scriptFlush();

    // Next call should recover transparently
    const claimRes = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimRes.ok).toBe(true);
    if (claimRes.ok) {
      expect(claimRes.state).toBe("claimed");
      expect(claimRes.replayed).toBe(false);
    }
  });

  it("10. network drop recovery: discarding first response and retrying returns replayed=true with identical record", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    // Initial claim succeeds in Redis
    const firstClaim = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(firstClaim.ok).toBe(true);
    if (!firstClaim.ok) return;

    // Simulate caller retrying after missing the response
    const retryClaim = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(retryClaim.ok).toBe(true);
    if (retryClaim.ok) {
      expect(retryClaim.replayed).toBe(true);
      expect(retryClaim.record.execution?.attempt_id).toBe(ATT1);
      expect(retryClaim.record.execution?.claimed_at_ms).toBe(firstClaim.record.execution?.claimed_at_ms);
    }
  });

  it("11. dedupe placeholder and stream entries remain completely untouched across claims and starts", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);

    // Plant request placeholder
    const reqK = requestKey(scopeA.user_id, scopeA.workspace_id, job.request_id);
    const placeholder: RequestPlaceholder = {
      job_id: job.job_id,
      request_digest: job.request_digest,
    };
    await client.set(reqK, JSON.stringify(placeholder));

    // Plant stream entry
    await client.xAdd(KEY_STREAM, "*", {
      job_id: job.job_id,
      user_id: scopeA.user_id,
      workspace_id: scopeA.workspace_id,
    });

    const streamLenBefore = await client.xLen(KEY_STREAM);
    const rawPlaceholderBefore = await client.get(reqK);

    // Perform claim
    const claimRes = await store.claimAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "tools",
      claim_token_sha256: TOKEN_SHA,
    });
    expect(claimRes.ok).toBe(true);

    // Perform start
    const startRes = await store.startAssignment(scopeA, job.job_id, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: TOKEN_SHA,
    });
    expect(startRes.ok).toBe(true);

    // Verify placeholder is unchanged
    const rawPlaceholderAfter = await client.get(reqK);
    expect(rawPlaceholderAfter).toBe(rawPlaceholderBefore);

    // Verify stream length is unchanged (no new entries, no deletions)
    const streamLenAfter = await client.xLen(KEY_STREAM);
    expect(streamLenAfter).toBe(streamLenBefore);
  });

  it("12. table-driven: rejects invalid claim/start arguments with INVALID_ARGUMENT without altering Redis", async () => {
    const job = baseRecordV2(scopeA);
    await putJob(job);
    const rawBefore = await getRawJob(job.job_id);

    const invalidArgs = [
      { name: "worker is 'abc'", worker: "abc", attempt: ATT1 },
      {
        name: "worker uuid contains invalid chars",
        worker: "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5g",
        attempt: ATT1,
      },
      {
        name: "worker uuid segment length wrong",
        worker: "wrk-0a1b2c3-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
        attempt: ATT1,
      },
      { name: "attempt is 'abc'", worker: WRK, attempt: "abc" },
      {
        name: "attempt uuid uses uppercase hex",
        worker: WRK,
        attempt: "123E4567-E89B-12D3-A456-4266141740AA",
      },
    ];

    for (const tc of invalidArgs) {
      // Test claimAssignment input validation
      const claimRes = await store.claimAssignment(scopeA, job.job_id, {
        worker_id: tc.worker,
        attempt_id: tc.attempt,
        workspace_ref: "tools",
        claim_token_sha256: TOKEN_SHA,
      });
      expect(claimRes.ok, `claim with ${tc.name} must fail`).toBe(false);
      if (!claimRes.ok) {
        expect(claimRes.code).toBe("QUEUE_UNAVAILABLE");
        expect(claimRes.reason).toBe("INVALID_ARGUMENT");
      }

      // Test startAssignment input validation
      const startRes = await store.startAssignment(scopeA, job.job_id, {
        worker_id: tc.worker,
        attempt_id: tc.attempt,
        claim_token_sha256: TOKEN_SHA,
      });
      expect(startRes.ok, `start with ${tc.name} must fail`).toBe(false);
      if (!startRes.ok) {
        expect(startRes.code).toBe("QUEUE_UNAVAILABLE");
        expect(startRes.reason).toBe("INVALID_ARGUMENT");
      }

      // Assert Redis JSON bytes completely identical
      expect(await getRawJob(job.job_id)).toBe(rawBefore);
    }
  });

  it("13. table-driven: rejects corrupt existing execution IDs with CORRUPT_RECORD without overwriting", async () => {
    const invalidExecutions = [
      { name: "worker is 'abc'", worker: "abc", attempt: ATT1 },
      {
        name: "worker uuid contains invalid chars",
        worker: "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5g",
        attempt: ATT1,
      },
      { name: "attempt is 'abc'", worker: WRK, attempt: "abc" },
      {
        name: "attempt uuid uses uppercase hex",
        worker: WRK,
        attempt: "123E4567-E89B-12D3-A456-4266141740AA",
      },
    ];

    for (const tc of invalidExecutions) {
      const corruptJob = {
        ...baseRecordV2(scopeA),
        execution: {
          worker_id: tc.worker,
          attempt_id: tc.attempt,
          claim_token_sha256: TOKEN_SHA,
          phase: "claimed",
          claimed_at_ms: Date.now(),
          started_at_ms: null,
        },
      };
      await putJob(corruptJob);
      const rawBefore = await getRawJob(corruptJob.job_id);

      // Inspect fails as CORRUPT_RECORD
      const insp = await store.inspectAssignment(scopeA, corruptJob.job_id);
      expect(insp.ok).toBe(false);
      if (!insp.ok) {
        expect(insp.code).toBe("QUEUE_UNAVAILABLE");
        expect(insp.reason).toBe("CORRUPT_RECORD");
      }

      // Claim fails as CORRUPT_RECORD and does NOT overwrite or treat as unclaimed
      const claimRes = await store.claimAssignment(scopeA, corruptJob.job_id, {
        worker_id: WRK,
        attempt_id: ATT1,
        workspace_ref: "tools",
        claim_token_sha256: TOKEN_SHA,
      });
      expect(claimRes.ok).toBe(false);
      if (!claimRes.ok) {
        expect(claimRes.code).toBe("QUEUE_UNAVAILABLE");
        expect(claimRes.reason).toBe("CORRUPT_RECORD");
      }

      // Original JSON unchanged
      expect(await getRawJob(corruptJob.job_id)).toBe(rawBefore);
    }
  });

  it("14. table-driven: rejects invalid timestamps across all four fields as CORRUPT_RECORD without altering Redis", async () => {
    const badValues = [-1, 1.5, 9007199254740992];
    const now = 1700000000000;

    for (const bad of badValues) {
      // 1. bad created_at_ms
      const badCreated = baseRecordV2(scopeA, {
        created_at_ms: bad,
        claim_deadline_ms: now + 100000,
      });
      await putJob(badCreated);
      const rawCreatedBefore = await getRawJob(badCreated.job_id);
      const resCreated = await store.inspectAssignment(scopeA, badCreated.job_id);
      expect(resCreated.ok).toBe(false);
      if (!resCreated.ok) {
        expect(resCreated.code).toBe("QUEUE_UNAVAILABLE");
        expect(resCreated.reason).toBe("CORRUPT_RECORD");
      }
      expect(await getRawJob(badCreated.job_id)).toBe(rawCreatedBefore);

      // 2. bad claim_deadline_ms
      const badDeadline = baseRecordV2(scopeA, {
        created_at_ms: now,
        claim_deadline_ms: bad,
      });
      await putJob(badDeadline);
      const rawDeadlineBefore = await getRawJob(badDeadline.job_id);
      const resDeadline = await store.inspectAssignment(scopeA, badDeadline.job_id);
      expect(resDeadline.ok).toBe(false);
      if (!resDeadline.ok) {
        expect(resDeadline.code).toBe("QUEUE_UNAVAILABLE");
        expect(resDeadline.reason).toBe("CORRUPT_RECORD");
      }
      expect(await getRawJob(badDeadline.job_id)).toBe(rawDeadlineBefore);

      // 3. bad execution.claimed_at_ms
      const badClaimed = baseRecordV2(scopeA, {
        created_at_ms: now,
        claim_deadline_ms: now + 100000,
        execution: {
          worker_id: WRK,
          attempt_id: ATT1,
          claim_token_sha256: TOKEN_SHA,
          phase: "claimed",
          claimed_at_ms: bad,
          started_at_ms: null,
        },
      });
      await putJob(badClaimed);
      const rawClaimedBefore = await getRawJob(badClaimed.job_id);
      const resClaimed = await store.inspectAssignment(scopeA, badClaimed.job_id);
      expect(resClaimed.ok).toBe(false);
      if (!resClaimed.ok) {
        expect(resClaimed.code).toBe("QUEUE_UNAVAILABLE");
        expect(resClaimed.reason).toBe("CORRUPT_RECORD");
      }
      expect(await getRawJob(badClaimed.job_id)).toBe(rawClaimedBefore);

      // 4. bad execution.started_at_ms (on running execution)
      const badStarted = baseRecordV2(scopeA, {
        created_at_ms: now,
        claim_deadline_ms: now + 100000,
        execution: {
          worker_id: WRK,
          attempt_id: ATT1,
          claim_token_sha256: TOKEN_SHA,
          phase: "running",
          claimed_at_ms: now,
          started_at_ms: bad,
        },
      });
      await putJob(badStarted);
      const rawStartedBefore = await getRawJob(badStarted.job_id);
      const resStarted = await store.inspectAssignment(scopeA, badStarted.job_id);
      expect(resStarted.ok).toBe(false);
      if (!resStarted.ok) {
        expect(resStarted.code).toBe("QUEUE_UNAVAILABLE");
        expect(resStarted.reason).toBe("CORRUPT_RECORD");
      }
      expect(await getRawJob(badStarted.job_id)).toBe(rawStartedBefore);
    }
  });
});
