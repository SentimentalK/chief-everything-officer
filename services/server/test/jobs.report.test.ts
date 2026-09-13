import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  RedisJobStore,
  createRedisRunnerFromClient,
  type RedisRunner,
} from "../src/jobs/redis-store.js";
import { JobError, JobService } from "../src/jobs/service.js";
import { jobKey, makeJobId, type PersistedJobRecord } from "../src/jobs/schema.js";
import { ASSIGNMENT_SCHEMA_VERSION } from "../src/jobs/assignment-schema.js";
import { type ExecutionReport } from "../src/jobs/report-schema.js";
import { registerJobTools } from "../src/jobs/tools.js";
import type { AuditStore, TraceRecordInput } from "../src/audit.js";

const URL = process.env.CEO_REDIS_URL;

const scopeA = { user_id: "usr_report_a", workspace_id: "ws_report_a" };
const scopeB = { user_id: "usr_report_b", workspace_id: "ws_report_b" };
const scopeAOtherWs = { user_id: "usr_report_a", workspace_id: "ws_report_other" };

const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const WRK2 = "wrk-f0e1d2c3-b4a5-9687-8574-635241302a11";
const ATT1 = "123e4567-e89b-12d3-a456-4266141740aa";
const ATT2 = "123e4567-e89b-12d3-a456-4266141740bb";
const TOKEN = "a".repeat(64);
const TOKEN2 = "b".repeat(64);
const RECEIPT = "c".repeat(64);
const RECEIPT2 = "d".repeat(64);

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function reportBody(patch: Record<string, unknown> = {}, reportPatch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker_id: WRK,
    attempt_id: ATT1,
    claim_token: TOKEN,
    report: {
      schema_version: 2,
      execution_status: "COMPLETED",
      business_outcome: "UNVERIFIED",
      task_dispatched: true,
      finished_at_ms: 1_789_255_887_000,
      duration_ms: 3172,
      executor: {
        type: "agy",
        version: "1.0.0",
      },
      receipt_sha256: RECEIPT,
      error: null,
      ...reportPatch,
    },
    ...patch,
  };
}

function executionReport(patch: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    schema_version: 2,
    execution_status: "COMPLETED",
    business_outcome: "UNVERIFIED",
    task_dispatched: true,
    finished_at_ms: 1_789_255_887_000,
    duration_ms: 3172,
    executor: {
      type: "agy",
      version: "1.0.0",
    },
    receipt_sha256: RECEIPT,
    error: null,
    ...patch,
  };
}

function submitBody(requestId: string, prompt = "report test prompt") {
  return {
    request_id: requestId,
    workspace_ref: "ceo-agent-runtime",
    prompt,
    acceptance: "report test acceptance",
    timeout_seconds: 120,
  };
}

describe.skipIf(!URL)("worker execution reports (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStore;
  let service: JobService;

  async function waitReady(ms = 5000): Promise<void> {
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (runner.ready()) return resolve();
        if (Date.now() - started > ms) return reject(new Error("runner not ready"));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  async function submitClaim(
    scope = scopeA,
    requestId = cryptoRandom(),
    start = false,
  ): Promise<string> {
    const sub = await service.submit(scope, submitBody(requestId));
    expect(sub.ok).toBe(true);
    const jobId = sub.view!.job_id;
    const claim = await service.claim(scope, jobId, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "ceo-agent-runtime",
      claim_token: TOKEN,
    });
    expect(claim.ok).toBe(true);
    if (start) {
      const started = await service.start(scope, jobId, {
        worker_id: WRK,
        attempt_id: ATT1,
        claim_token: TOKEN,
      });
      expect(started.ok).toBe(true);
    }
    return jobId;
  }

  function cryptoRandom(): string {
    return "123e4567-e89b-12d3-a456-42661417" + Math.floor(Math.random() * 10000).toString().padStart(4, "0");
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

    try {
      await waitReady();
      store = new RedisJobStore(runner);
      service = new JobService({ store }, () => true);
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

  it("1. running → reported: persist exact report, keep assignment, expose terminal state", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170001", true);
    const rawBefore = JSON.parse((await client.get(jobKey(jobId)))!) as PersistedJobRecord;
    expect(rawBefore.execution?.phase).toBe("running");
    expect(rawBefore.report).toBeUndefined();

    const reported = await service.report(scopeA, jobId, reportBody());
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.replayed).toBe(false);
    expect(reported.report_received).toBe(true);
    expect(reported.state).toBe("completed");
    expect(reported.job_id).toBe(jobId);
    expect(reported.attempt_id).toBe(ATT1);
    expect(reported.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = await service.get(scopeA, { job_id: jobId });
    expect(got.ok).toBe(true);
    expect(got.view?.state).toBe("completed");
    expect(got.view?.execution?.phase).toBe("running");
    expect(got.view?.execution?.worker_id).toBe(WRK);
    expect(got.view?.execution?.attempt_id).toBe(ATT1);
    expect(got.view?.execution?.started_at).toBeTruthy();
    expect(got.view?.report).toEqual({
      schema_version: 2,
      execution_status: "COMPLETED",
      business_outcome: "UNVERIFIED",
      task_dispatched: true,
      finished_at_ms: 1_789_255_887_000,
      duration_ms: 3172,
      executor: {
        type: "agy",
        version: "1.0.0",
      },
      receipt_sha256: RECEIPT,
      error: null,
      received_at: reported.received_at,
    });

    const raw = JSON.parse((await client.get(jobKey(jobId)))!) as PersistedJobRecord;
    expect(raw.execution).toMatchObject({
      worker_id: WRK,
      attempt_id: ATT1,
      phase: "running",
      claimed_at_ms: rawBefore.execution!.claimed_at_ms,
      started_at_ms: rawBefore.execution!.started_at_ms,
    });
    expect(raw.report).toEqual({
      schema_version: 2,
      execution_status: "COMPLETED",
      business_outcome: "UNVERIFIED",
      task_dispatched: true,
      finished_at_ms: 1_789_255_887_000,
      duration_ms: 3172,
      executor: {
        type: "agy",
        version: "1.0.0",
      },
      receipt_sha256: RECEIPT,
      error: null,
      received_at_ms: raw.report!.received_at_ms,
    });
    expect(raw.prompt).toBe(rawBefore.prompt);
    expect(raw.stream_entry_id).toBe(rawBefore.stream_entry_id);
    expect(JSON.stringify(got.view)).not.toContain(TOKEN);
    expect(JSON.stringify(got.view)).not.toContain(sha(TOKEN));
    expect(JSON.stringify(got.view)).not.toContain("claim_token");
  });

  it("2. claimed → reported without start, including a past claim deadline", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170002", false);
    const now = Date.now();
    const raw = JSON.parse((await client.get(jobKey(jobId)))!) as PersistedJobRecord;
    raw.created_at_ms = now - 8 * 24 * 60 * 60 * 1000;
    raw.claim_deadline_ms = now - 24 * 60 * 60 * 1000;
    await client.set(jobKey(jobId), JSON.stringify(raw));

    const reported = await service.report(scopeA, jobId, reportBody());
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.state).toBe("completed");

    const stored = JSON.parse((await client.get(jobKey(jobId)))!) as PersistedJobRecord;
    expect(stored.execution?.phase).toBe("claimed");
    expect(stored.execution?.started_at_ms).toBeNull();

    const got = await service.get(scopeA, { job_id: jobId });
    expect(got.view?.state).toBe("completed");
    expect(got.view?.execution?.phase).toBe("claimed");
    expect(got.view?.execution?.started_at).toBeNull();
  });

  it("3. identical retry preserves reception time; changed report conflicts and leaves the job unchanged", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170003", true);
    const first = await service.report(scopeA, jobId, reportBody());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await service.report(scopeA, jobId, reportBody());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.received_at).toBe(first.received_at);

    const snapshot = await client.get(jobKey(jobId));
    await expect(service.report(scopeA, jobId, reportBody({
      report: executionReport({
        execution_status: "FAILED",
        business_outcome: "FAILED",
        error: { stage: "task", code: "FAILED", message: "fail" },
      }),
    }))).rejects.toMatchObject({
      code: "REPORT_CONFLICT",
      message: "A different execution report was already accepted.",
    });

    await expect(service.report(scopeA, jobId, reportBody({
      report: executionReport({ duration_ms: 9999 }),
    }))).rejects.toMatchObject({ code: "REPORT_CONFLICT" });

    await expect(service.report(scopeA, jobId, reportBody({
      report: executionReport({ executor: { type: "agy", version: "2.0.0" } }),
    }))).rejects.toMatchObject({ code: "REPORT_CONFLICT" });

    expect(await client.get(jobKey(jobId))).toBe(snapshot);

    const got = await service.get(scopeA, { job_id: jobId });
    expect(got.view?.state).toBe("completed");
    expect(got.view?.report?.execution_status).toBe("COMPLETED");
    expect(got.view?.report?.received_at).toBe(first.received_at);
  });

  it("4. concurrent identical reports: one accept + replay; concurrent different reports: one accept + conflict", async () => {
    const sameJob = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170004", true);
    const identical = await Promise.all([
      service.report(scopeA, sameJob, reportBody()),
      service.report(scopeA, sameJob, reportBody()),
    ]);
    const okIdentical = identical.filter((r) => r.ok);
    expect(okIdentical).toHaveLength(2);
    const firsts = okIdentical.filter((r) => r.ok && !r.replayed);
    const replays = okIdentical.filter((r) => r.ok && r.replayed);
    expect(firsts).toHaveLength(1);
    expect(replays).toHaveLength(1);
    expect(replays[0] && replays[0].ok && replays[0].received_at).toBe(
      firsts[0] && firsts[0].ok ? firsts[0].received_at : "",
    );

    const diffJob = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170014", true);
    const different = await Promise.allSettled([
      service.report(scopeA, diffJob, reportBody()),
      service.report(scopeA, diffJob, reportBody({
        report: executionReport({ receipt_sha256: RECEIPT2 }),
      })),
    ]);
    const fulfilled = different
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<JobService["report"]>>> => r.status === "fulfilled")
      .map((r) => r.value);
    const rejected = different.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const accepted = fulfilled.filter((r) => r.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as JobError).code).toBe("REPORT_CONFLICT");
    const stored = JSON.parse((await client.get(jobKey(diffJob)))!) as PersistedJobRecord;
    expect(stored.report?.receipt_sha256).toBe(accepted[0] && accepted[0].ok ? (
      (await service.get(scopeA, { job_id: diffJob })).view?.report?.receipt_sha256
    ) : undefined);
  });

  it("5. ownership and assignment credentials cannot report or read another identity's job", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170005", true);
    const snapshot = await client.get(jobKey(jobId));

    await expect(service.report(scopeB, jobId, reportBody())).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(service.report(scopeAOtherWs, jobId, reportBody())).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(service.get(scopeB, { job_id: jobId })).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });

    await expect(service.report(scopeA, jobId, reportBody({ worker_id: WRK2 }))).rejects.toMatchObject({
      code: "ASSIGNMENT_MISMATCH",
    });
    await expect(service.report(scopeA, jobId, reportBody({ attempt_id: ATT2 }))).rejects.toMatchObject({
      code: "ASSIGNMENT_MISMATCH",
    });
    await expect(service.report(scopeA, jobId, reportBody({ claim_token: TOKEN2 }))).rejects.toMatchObject({
      code: "ASSIGNMENT_MISMATCH",
    });
    expect(await client.get(jobKey(jobId))).toBe(snapshot);

    const unclaimed = await service.submit(scopeA, submitBody("123e4567-e89b-12d3-a456-426614170015"));
    expect(unclaimed.ok).toBe(true);
    await expect(service.report(scopeA, unclaimed.view!.job_id, reportBody())).rejects.toMatchObject({
      code: "JOB_NOT_CLAIMED",
    });
  });

  it("6. post-report: pending excludes, submit replay shows terminal state, claim/start cannot reopen", async () => {
    const requestId = "123e4567-e89b-12d3-a456-426614170006";
    const jobId = await submitClaim(scopeA, requestId, true);
    const reported = await service.report(scopeA, jobId, reportBody());
    expect(reported.ok).toBe(true);

    const pending = await service.pending(scopeA, { workspace_ref: "ceo-agent-runtime", after: "0-0" });
    expect(pending.jobs.some((j) => j.job_id === jobId)).toBe(false);

    const replaySubmit = await service.submit(scopeA, submitBody(requestId));
    expect(replaySubmit.ok).toBe(true);
    expect(replaySubmit.view?.job_id).toBe(jobId);
    expect(replaySubmit.view?.state).toBe("completed");
    expect(replaySubmit.view?.report?.execution_status).toBe("COMPLETED");

    await expect(service.claim(scopeA, jobId, {
      worker_id: WRK,
      attempt_id: ATT1,
      workspace_ref: "ceo-agent-runtime",
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "JOB_FINISHED" });

    await expect(service.start(scopeA, jobId, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "JOB_FINISHED" });

    await expect(service.claim(scopeA, jobId, {
      worker_id: WRK,
      attempt_id: ATT2,
      workspace_ref: "ceo-agent-runtime",
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "JOB_ALREADY_CLAIMED" });

    await expect(service.start(scopeA, jobId, {
      worker_id: WRK2,
      attempt_id: ATT1,
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "ASSIGNMENT_MISMATCH" });

    const again = await service.report(scopeA, jobId, reportBody());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replayed).toBe(true);
  });

  it("7. explicit null or malformed stored report fails without overwrite", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170007", true);
    const raw = JSON.parse((await client.get(jobKey(jobId)))!) as PersistedJobRecord;

    await client.set(jobKey(jobId), JSON.stringify({ ...raw, report: null }));
    const nullSnap = await client.get(jobKey(jobId));
    await expect(service.report(scopeA, jobId, reportBody())).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      details: { reason: "CORRUPT_RECORD" },
    });
    expect(await client.get(jobKey(jobId))).toBe(nullSnap);

    await client.set(jobKey(jobId), JSON.stringify({
      ...raw,
      report: { schema_version: 1, execution_status: "COMPLETED" },
    }));
    const badSnap = await client.get(jobKey(jobId));
    await expect(service.get(scopeA, { job_id: jobId })).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      details: { reason: "CORRUPT_RECORD" },
    });
    expect(await client.get(jobKey(jobId))).toBe(badSnap);

    const noExecId = makeJobId();
    const planted: PersistedJobRecord = {
      schema_version: ASSIGNMENT_SCHEMA_VERSION,
      job_id: noExecId,
      request_id: "123e4567-e89b-12d3-a456-426614170017",
      user_id: scopeA.user_id,
      workspace_id: scopeA.workspace_id,
      workspace_ref: "ceo-agent-runtime",
      resource_id: null,
      prompt: "corrupt report without assignment",
      acceptance: "n/a",
      execution_timeout_seconds: 120,
      result_target: "none",
      request_digest: "digest",
      status: "queued",
      stream_entry_id: "1-0",
      created_at_ms: Date.now(),
      claim_deadline_ms: Date.now() + 1000,
      report: {
        schema_version: 1,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        finished_at_ms: 1,
        receipt_sha256: RECEIPT,
        error: null,
        received_at_ms: Date.now(),
      },
    };
    await client.set(jobKey(noExecId), JSON.stringify(planted));
    const plantedSnap = await client.get(jobKey(noExecId));
    await expect(service.report(scopeA, noExecId, reportBody())).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      details: { reason: "CORRUPT_RECORD" },
    });
    expect(await client.get(jobKey(noExecId))).toBe(plantedSnap);
  });

  it("8. lost acknowledgement: real report commits, discarded ack, resend replays", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170008", true);
    const committed = await store.reportAssignment(scopeA, jobId, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token_sha256: sha(TOKEN),
      report: executionReport(),
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.replayed).toBe(false);
    const receivedAtMs = committed.record.report!.received_at_ms;

    const resent = await service.report(scopeA, jobId, reportBody());
    expect(resent.ok).toBe(true);
    if (!resent.ok) return;
    expect(resent.replayed).toBe(true);
    expect(resent.received_at).toBe(new Date(receivedAtMs).toISOString());
  });

  it("9. SCRIPT FLUSH then report through the same cached store instance", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170009", true);
    const warm = await store.inspectAssignment(scopeA, jobId);
    expect(warm.ok).toBe(true);
    expect(store.getAssignmentShaForTest()).not.toBeNull();

    await client.scriptFlush();

    const reported = await service.report(scopeA, jobId, reportBody());
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.replayed).toBe(false);
    expect(reported.state).toBe("completed");
  });

  it("10. start/report race: report persists either order; start cannot erase or reopen", async () => {
    const reportFirst = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170010", false);
    const reportThenStart = await Promise.allSettled([
      service.report(scopeA, reportFirst, reportBody()),
      service.start(scopeA, reportFirst, { worker_id: WRK, attempt_id: ATT1, claim_token: TOKEN }),
    ]);
    const reportWins = reportThenStart.filter((r) => r.status === "fulfilled");
    expect(reportWins.length).toBeGreaterThanOrEqual(1);
    const afterFirst = await service.get(scopeA, { job_id: reportFirst });
    expect(afterFirst.view?.state).toBe("completed");
    expect(afterFirst.view?.report?.execution_status).toBe("COMPLETED");
    await expect(service.start(scopeA, reportFirst, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "JOB_FINISHED" });

    const startFirst = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170020", false);
    const startThenReport = await Promise.all([
      service.start(scopeA, startFirst, { worker_id: WRK, attempt_id: ATT1, claim_token: TOKEN }),
      service.report(scopeA, startFirst, reportBody()),
    ]);
    expect(startThenReport[1]!.ok).toBe(true);
    const afterSecond = await service.get(scopeA, { job_id: startFirst });
    expect(afterSecond.view?.state).toBe("completed");
    expect(afterSecond.view?.report?.receipt_sha256).toBe(RECEIPT);
    expect(afterSecond.view?.execution?.phase === "claimed" || afterSecond.view?.execution?.phase === "running").toBe(true);

    await expect(service.start(scopeA, startFirst, {
      worker_id: WRK,
      attempt_id: ATT1,
      claim_token: TOKEN,
    })).rejects.toMatchObject({ code: "JOB_FINISHED" });
  });

  it("worker_get MCP output includes the report and audit omits the error-message sentinel", async () => {
    const SENTINEL = "REPORT_AUDIT_SENTINEL_DO_NOT_COPY";
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170011", true);
    const reported = await service.report(scopeA, jobId, reportBody({
      report: executionReport({
        execution_status: "FAILED",
        business_outcome: "FAILED",
        error: { stage: "task", code: "STDIN_WRITE_FAILED", message: SENTINEL },
      }),
    }));
    expect(reported.ok).toBe(true);

    const traces: TraceRecordInput[] = [];
    const auditStore: AuditStore = {
      recordTrace: (t: TraceRecordInput) => {
        traces.push(t);
      },
    } as AuditStore;

    const server = new McpServer({ name: "ceo-report-mcp", version: "test" });
    registerJobTools(server, {
      service,
      scope: scopeA,
      auditStore,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "client", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const listed = await mcp.listTools();
    const getTool = listed.tools.find((t) => t.name === "worker_get");
    expect(getTool?.description).toContain("Reported terminal states describe the Worker's execution report");
    expect(getTool?.description).toContain("COMPLETED does not establish independent business verification");

    const res = await mcp.callTool({ name: "worker_get", arguments: { job_id: jobId } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      ok: boolean;
      state: string;
      report: { execution_status: string; error: { message: string } | null };
    };
    expect(out.ok).toBe(true);
    expect(out.state).toBe("failed");
    expect(out.report.execution_status).toBe("FAILED");
    expect(out.report.error?.message).toBe(SENTINEL);

    expect(traces.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(traces);
    expect(dumped).not.toContain(SENTINEL);
    expect(dumped).not.toContain(TOKEN);

    await mcp.close();
    await server.close();
  });

  it("unreported jobs expose report: null and keep assignment-derived state", async () => {
    const jobId = await submitClaim(scopeA, "123e4567-e89b-12d3-a456-426614170012", true);
    const got = await service.get(scopeA, { job_id: jobId });
    expect(got.view?.state).toBe("running");
    expect(got.view?.report).toBeNull();
  });
});
