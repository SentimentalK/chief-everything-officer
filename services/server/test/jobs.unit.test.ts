import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  parseSubmit,
  parseJobGet,
  businessDigest,
  CLAIM_TTL_MS,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
} from "../src/jobs/schema.js";
import {
  EXECUTION_STATUSES,
  MAX_REPORT_ERROR_MESSAGE_BYTES,
  parseReport,
} from "../src/jobs/report-schema.js";
import {
  isNoScriptError,
  createRedisRunnerFromClient,
  StoreError,
} from "../src/jobs/redis-store.js";
import { registerJobTools, sanitizeRequestId, sanitizeJobId } from "../src/jobs/tools.js";
import { JobService, JobError } from "../src/jobs/service.js";
import type { AuditStore, TraceRecordInput } from "../src/audit.js";

const uuid = "123e4567-e89b-12d3-a456-426614174000";
const wsRef = "ceo-agent-runtime";

function valid(patch: Record<string, unknown> = {}) {
  return {
    request_id: uuid,
    workspace_ref: wsRef,
    prompt: "process the url and return the subtitles",
    acceptance: "non-empty subtitles returned or a reason",
    ...patch,
  };
}

describe("worker submit schema", () => {
  it("defaults timeout to 1800, resource_id to null, and result_target to none", () => {
    const r = parseSubmit(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.execution_timeout_seconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(r.value.resource_id).toBeNull();
    expect(r.value.result_target).toBe("none");
  });

  it("normalizes explicit result_target: 'none' correctly", () => {
    const r = parseSubmit(valid({ result_target: "none" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result_target).toBe("none");
  });

  it("accepts valid result_target: 'resource' when resource_id is provided", () => {
    const r = parseSubmit(valid({ result_target: "resource", resource_id: "res-00000000-0000-0000-0000-000000000001" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result_target).toBe("resource");
    expect(r.value.resource_id).toBe("res-00000000-0000-0000-0000-000000000001");
  });

  it("rejects result_target: 'resource' when resource_id is missing", () => {
    const r = parseSubmit(valid({ result_target: "resource" }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.issue).toContain("resource_id is required when result_target is 'resource'");
  });

  it("rejects legacy delivery field", () => {
    expect(parseSubmit(valid({ delivery: { type: "none" } })).ok).toBe(false);
    expect(parseSubmit(valid({ delivery: { type: "agent", instructions: "send" } })).ok).toBe(false);
  });

  it("rejects unknown result_target or extra keys", () => {
    expect(parseSubmit(valid({ result_target: "email" })).ok).toBe(false);
    expect(parseSubmit(valid({ result_target: "none", extra: 1 })).ok).toBe(false);
  });

  it("rejects unknown fields (e.g. forged identity)", () => {
    const r = parseSubmit({ ...valid(), user_id: "usr_x", workspace_id: "ws_y" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toBe("INVALID_INPUT");
  });

  it("rejects a non-UUID request_id", () => {
    const r = parseSubmit(valid({ request_id: "not-a-uuid" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue).toMatch(/UUID/);
  });

  it("rejects whitespace-only prompt / acceptance", () => {
    expect(parseSubmit(valid({ prompt: "   " })).ok).toBe(false);
    expect(parseSubmit(valid({ acceptance: " \n " })).ok).toBe(false);
  });

  it("rejects out-of-range timeout (no clamping)", () => {
    expect(parseSubmit(valid({ timeout_seconds: MIN_TIMEOUT_SECONDS - 1 })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: MAX_TIMEOUT_SECONDS + 1 })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: MAX_TIMEOUT_SECONDS })).ok).toBe(true);
    expect(parseSubmit(valid({ timeout_seconds: MIN_TIMEOUT_SECONDS })).ok).toBe(true);
  });

  it("rejects oversized prompt (UTF-8 bytes > 64KiB) and acceptance > 8KiB", () => {
    expect(parseSubmit(valid({ prompt: "a".repeat(64 * 1024 + 1) })).ok).toBe(false);
    expect(parseSubmit(valid({ acceptance: "b".repeat(8 * 1024 + 1) })).ok).toBe(false);
  });

  it("rejects a malformed resource_id and float timeout", () => {
    expect(parseSubmit(valid({ resource_id: "res-nope" })).ok).toBe(false);
    expect(parseSubmit(valid({ timeout_seconds: 900.5 })).ok).toBe(false);
  });
});

describe("worker get schema", () => {
  it("accepts a job-<uuid>", () => {
    const r = parseJobGet({ job_id: `job-${uuid}` });
    expect(r.ok).toBe(true);
  });
  it("rejects obvious bad shape / unknown fields", () => {
    expect(parseJobGet({ job_id: "nope" }).ok).toBe(false);
    expect(parseJobGet({ job_id: `job-${uuid}`, extra: 1 }).ok).toBe(false);
  });
});

describe("worker execution report schema", () => {
  const token = "a".repeat(64);
  const receipt = "b".repeat(64);
  const wrk = "wrk-123e4567-e89b-12d3-a456-426614174000";
  const attempt = uuid;

  function body(patch: Record<string, unknown> = {}, reportPatch: Record<string, unknown> = {}) {
    return {
      worker_id: wrk,
      attempt_id: attempt,
      claim_token: token,
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
        receipt_sha256: receipt,
        error: null,
        ...reportPatch,
      },
      ...patch,
    };
  }

  for (const status of EXECUTION_STATUSES) {
    it(`accepts execution_status ${status}`, () => {
      const reportPatch: Record<string, unknown> = { execution_status: status };
      if (status !== "COMPLETED") {
        reportPatch.business_outcome = "FAILED";
        reportPatch.error = { stage: "task", code: "FAILED", message: "execution failed" };
      }
      const r = parseReport(body({}, reportPatch));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.report.execution_status).toBe(status);
    });
  }

  it("rejects unknown fields at top, report, executor, and error levels", () => {
    expect(parseReport(body({ user_id: "usr_x" })).ok).toBe(false);
    expect(parseReport(body({ workspace_id: "ws_x" })).ok).toBe(false);
    expect(parseReport(body({ resource_id: "res-x" })).ok).toBe(false);
    expect(parseReport(body({}, { local_path: "/tmp/out" })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "agy", version: "1", extra: 1 } })).ok).toBe(false);
    expect(parseReport(body({}, {
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: { stage: "task", code: "X", message: "m", extra: true },
    })).ok).toBe(false);
  });

  it("rejects invalid ids, token, hash, version, duration, executor, and unsafe timestamps", () => {
    expect(parseReport(body({ worker_id: "wrk-NOT" })).ok).toBe(false);
    expect(parseReport(body({ attempt_id: "not-a-uuid" })).ok).toBe(false);
    expect(parseReport(body({ claim_token: "ZZ" })).ok).toBe(false);
    expect(parseReport(body({}, { receipt_sha256: "ABC" })).ok).toBe(false);
    expect(parseReport(body({}, { schema_version: 1 })).ok).toBe(false);
    expect(parseReport(body({}, { schema_version: 3 })).ok).toBe(false);
    expect(parseReport(body({}, { finished_at_ms: -1 })).ok).toBe(false);
    expect(parseReport(body({}, { finished_at_ms: 1.5 })).ok).toBe(false);
    expect(parseReport(body({}, { finished_at_ms: Number.MAX_SAFE_INTEGER + 1 })).ok).toBe(false);
    expect(parseReport(body({}, { duration_ms: -1 })).ok).toBe(false);
    expect(parseReport(body({}, { duration_ms: 1.5 })).ok).toBe(false);
    expect(parseReport(body({}, { duration_ms: Number.MAX_SAFE_INTEGER + 1 })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "", version: "1" } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "bad@char", version: "1" } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "a".repeat(65), version: "1" } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "agy", version: "" } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "agy", version: "   " } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "agy", version: "x".repeat(257) } })).ok).toBe(false);
    expect(parseReport(body({}, { executor: { type: "agy_headless.1-beta", version: "x".repeat(256) } })).ok).toBe(true);
  });

  it("enforces invariants between execution_status, error, task_dispatched, and business_outcome", () => {
    expect(parseReport(body({}, { business_outcome: "VERIFIED" })).ok).toBe(false);
    // COMPLETED cannot have error
    expect(parseReport(body({}, {
      execution_status: "COMPLETED",
      error: { stage: "task", code: "ERR", message: "fail" },
    })).ok).toBe(false);
    // Non-COMPLETED must have error
    expect(parseReport(body({}, {
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: null,
    })).ok).toBe(false);
    // !task_dispatched requires NOT_STARTED
    expect(parseReport(body({}, {
      task_dispatched: false,
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: { stage: "task", code: "ERR", message: "fail" },
    })).ok).toBe(false);
    expect(parseReport(body({}, {
      task_dispatched: false,
      execution_status: "FAILED",
      business_outcome: "UNVERIFIED",
      error: { stage: "task", code: "ERR", message: "fail" },
    })).ok).toBe(false);
    expect(parseReport(body({}, {
      task_dispatched: false,
      execution_status: "FAILED",
      business_outcome: "NOT_STARTED",
      error: { stage: "preflight", code: "ERR", message: "fail" },
    })).ok).toBe(true);
    // UNVERIFIED requires task_dispatched = true
    expect(parseReport(body({}, {
      task_dispatched: true,
      execution_status: "COMPLETED",
      business_outcome: "UNVERIFIED",
      error: null,
    })).ok).toBe(true);
  });

  it("enforces the UTF-8 error-message limit and rejects whitespace-only messages", () => {
    const atLimit = "x".repeat(MAX_REPORT_ERROR_MESSAGE_BYTES);
    expect(parseReport(body({}, {
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: { stage: "task", code: "CODE", message: atLimit },
    })).ok).toBe(true);
    expect(parseReport(body({}, {
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: { stage: "task", code: "CODE", message: atLimit + "y" },
    })).ok).toBe(false);
    expect(parseReport(body({}, {
      execution_status: "FAILED",
      business_outcome: "FAILED",
      error: { stage: "task", code: "CODE", message: "   " },
    })).ok).toBe(false);
  });
});

describe("business digest", () => {
  const base = {
    workspace_ref: "ceo-agent-runtime",
    prompt: "translate next",
    acceptance: "> 0 lines",
    resource_id: null as string | null,
    execution_timeout_seconds: 120,
    result_target: "none" as const,
  };
  it("is stable across key-authoring order and excludes request_id/server-time concepts", () => {
    const a = businessDigest({ ...base });
    const b = businessDigest({
      acceptance: base.acceptance,
      execution_timeout_seconds: base.execution_timeout_seconds,
      prompt: base.prompt,
      resource_id: base.resource_id,
      result_target: "none",
      workspace_ref: base.workspace_ref,
    });
    expect(a).toBe(b);
  });
  it("changes when a business field changes", () => {
    expect(businessDigest({ ...base, prompt: "different task" })).not.toBe(businessDigest(base));
  });
  it("treats omitted result_target and explicit none identically via parseSubmit", () => {
    const p1 = parseSubmit(valid());
    const p2 = parseSubmit(valid({ result_target: "none" }));
    expect(p1.ok && p2.ok).toBe(true);
    if (p1.ok && p2.ok) {
      expect(businessDigest(p1.value)).toBe(businessDigest(p2.value));
    }
  });
  it("differentiates result_target none and resource", () => {
    const dNone = businessDigest({ ...base, result_target: "none" });
    const dResource = businessDigest({ ...base, result_target: "resource" });
    expect(dNone).not.toBe(dResource);
  });
});

describe("constants", () => {
  it("keeps a 7-day claim deadline (not a delete TTL) and known timeout bounds", () => {
    void CLAIM_TTL_MS;
    expect(CLAIM_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MIN_TIMEOUT_SECONDS).toBe(60);
    expect(MAX_TIMEOUT_SECONDS).toBe(7200);
  });
});

describe("sanitization helpers", () => {
  it("sanitizes request_id and job_id strictly to UUID format", () => {
    expect(sanitizeRequestId(uuid)).toBe(uuid);
    expect(sanitizeRequestId("not-a-uuid")).toBeNull();
    expect(sanitizeRequestId(123)).toBeNull();
    expect(sanitizeJobId(`job-${uuid}`)).toBe(`job-${uuid}`);
    expect(sanitizeJobId("job-not-a-uuid")).toBeNull();
    expect(sanitizeJobId("123")).toBeNull();
  });
});

describe("isNoScriptError helper", () => {
  it("matches NOSCRIPT code and message prefix", () => {
    expect(isNoScriptError({ code: "NOSCRIPT" })).toBe(true);
    expect(isNoScriptError({ message: "NOSCRIPT No matching script. Please use EVAL." })).toBe(true);
    expect(isNoScriptError({ cause: { code: "NOSCRIPT" } })).toBe(true);
    expect(isNoScriptError({ cause: { message: "NOSCRIPT No matching script" } })).toBe(true);
  });

  it("returns false for non-NOSCRIPT errors", () => {
    expect(isNoScriptError(null)).toBe(false);
    expect(isNoScriptError(new Error("Connection lost"))).toBe(false);
    expect(isNoScriptError({ code: "ETIMEDOUT" })).toBe(false);
  });
});

describe("createRedisRunnerFromClient factory failure", () => {
  it("reports the factory error once, stays unavailable, and never auto-retries", async () => {
    const reported: string[] = [];
    const runner = createRedisRunnerFromClient(
      () => {
        throw new Error("factory boom");
      },
      { onClientError: (err: unknown) => reported.push(String(err)) },
    );

    // A factory throw is contained: construction does not throw, the runner is
    // simply unavailable, and calls fail explicitly instead of hanging.
    expect(runner.ready()).toBe(false);
    await expect(runner.get("k")).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    await expect(runner.get("k")).rejects.toThrow(/Redis is not available/i);
    // No auto-retry: exactly one report, from the initial spawn.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/factory boom/);

    // dispose is safe and idempotent even on an unavailable runner.
    await runner.dispose();
    await runner.dispose();
  });
});

describe("MCP protocol layer enforcement and audit tracing", () => {
  it("rejects unknown fields at protocol layer before handler and records safe audit trace", async () => {
    const traces: TraceRecordInput[] = [];
    const mockAuditStore: AuditStore = {
      recordTrace: (t: TraceRecordInput) => {
        traces.push(t);
      },
    } as any;

    let submitHandlerCalled = false;
    const mockJobService: JobService = {
      submit: async () => {
        submitHandlerCalled = true;
        return { ok: true, view: {} } as any;
      },
      get: async () => {
        return { ok: true, view: {} } as any;
      },
    } as any;

    const server = new McpServer({ name: "ceo-server-test", version: "1.0.0" });
    registerJobTools(server, {
      service: mockJobService,
      scope: { user_id: "usr_test", workspace_id: "ws_test" },
      auditStore: mockAuditStore,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Call worker_submit with unknown field (e.g. forged user_id)
    const res = await client.callTool({
      name: "worker_submit",
      arguments: {
        ...valid(),
        forged_user_id: "usr_attacker",
      },
    });

    expect(res.isError).toBe(true);
    expect(submitHandlerCalled).toBe(false);

    // Verify audit record was created for the protocol rejection
    expect(traces.length).toBe(1);
    const trace = traces[0];
    expect(trace.tool_name).toBe("worker_submit");
    expect(trace.status).toBe("error");
    expect(trace.error_message).toBe("INVALID_INPUT");
    expect(trace.operation_request_id).toBe(uuid);
    expect(trace.input_json).toContain("full prompt/input withheld");

    const out = JSON.parse(trace.output_json);
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("INVALID_INPUT");
    expect(out.request_id).toBe(uuid);

    // Next, call with invalid request_id (illegal ID should be sanitized to null)
    const res2 = await client.callTool({
      name: "worker_submit",
      arguments: {
        ...valid({ request_id: "illegal-format-id" }),
      },
    });

    expect(res2.isError).toBe(true);
    expect(traces.length).toBe(2);
    const trace2 = traces[1];
    expect(trace2.operation_request_id).toBeNull();
    const out2 = JSON.parse(trace2.output_json);
    expect(out2.request_id).toBeNull();

    // Call worker_get with illegal job_id format
    const res3 = await client.callTool({
      name: "worker_get",
      arguments: {
        job_id: "not-a-job-id",
      },
    });

    expect(res3.isError).toBe(true);
    expect(traces.length).toBe(3);
    const trace3 = traces[2];
    expect(trace3.tool_name).toBe("worker_get");
    expect(trace3.status).toBe("error");
    const out3 = JSON.parse(trace3.output_json);
    expect(out3.job_id).toBeNull();

    await client.close();
    await server.close();
  });

  it("projects the report through worker_get and withholds the report body from audit", async () => {
    const SENTINEL = "UNIT_REPORT_SENTINEL_MESSAGE";
    const traces: TraceRecordInput[] = [];
    const mockAuditStore: AuditStore = {
      recordTrace: (t: TraceRecordInput) => {
        traces.push(t);
      },
    } as AuditStore;

    const mockJobService: JobService = {
      submit: async () => ({ ok: true, view: {} }) as never,
      get: async () => ({
        ok: true,
        view: {
          ok: true,
          job_id: `job-${uuid}`,
          state: "failed",
          created_at: "2026-09-12T23:20:00.000Z",
          expires_at: "2026-09-19T23:20:00.000Z",
          workspace_ref: "ceo-agent-runtime",
          resource_id: null,
          replayed: false,
          execution: {
            worker_id: "wrk-123e4567-e89b-12d3-a456-426614174000",
            attempt_id: uuid,
            phase: "running",
            claimed_at: "2026-09-12T23:21:00.000Z",
            started_at: "2026-09-12T23:21:01.000Z",
          },
          report: {
            schema_version: 1,
            execution_status: "FAILED",
            business_outcome: "FAILED",
            finished_at_ms: 1_789_255_887_000,
            receipt_sha256: "b".repeat(64),
            error: { stage: "task", code: "STDIN_WRITE_FAILED", message: SENTINEL },
            received_at: "2026-09-12T23:31:28.000Z",
          },
        },
      }),
    } as JobService;

    const server = new McpServer({ name: "ceo-server-test", version: "1.0.0" });
    registerJobTools(server, {
      service: mockJobService,
      scope: { user_id: "usr_test", workspace_id: "ws_test" },
      auditStore: mockAuditStore,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const desc = listed.tools.find((t) => t.name === "worker_get")?.description ?? "";
    expect(desc).toContain("Reported terminal states describe the Worker's execution report");
    expect(desc).toContain("If no report exists, claimed/running is only the last recorded assignment state");

    const res = await client.callTool({ name: "worker_get", arguments: { job_id: `job-${uuid}` } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { report: { error: { message: string } }; state: string };
    expect(out.state).toBe("failed");
    expect(out.report.error.message).toBe(SENTINEL);

    expect(JSON.stringify(traces)).not.toContain(SENTINEL);

    await client.close();
    await server.close();
  });

  describe("JobService submit resource validation error mapping", () => {
    it("throws RESOURCE_NOT_FOUND when resourceExists returns false", async () => {
      const service = new JobService(
        {
          store: {
            isReady: () => true,
            getPlaceholder: async () => null,
          } as any,
          resourceExists: async () => false,
        },
        () => true,
      );

      await expect(
        service.submit(
          { user_id: "usr_1", workspace_id: "ws_1" },
          {
            request_id: uuid,
            workspace_ref: "repo",
            prompt: "do something",
            acceptance: "it works",
            resource_id: "res-00000000-0000-0000-0000-000000000001",
          },
        ),
      ).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
    });

    it("maps unexpected runtime failure to QUEUE_UNAVAILABLE with RUNTIME_UNAVAILABLE reason", async () => {
      const service = new JobService(
        {
          store: {
            isReady: () => true,
            getPlaceholder: async () => null,
          } as any,
          resourceExists: async () => {
            throw new Error("Git runtime unavailable: failed to resolve repo");
          },
        },
        () => true,
      );

      await expect(
        service.submit(
          { user_id: "usr_1", workspace_id: "ws_1" },
          {
            request_id: uuid,
            workspace_ref: "repo",
            prompt: "do something",
            acceptance: "it works",
            resource_id: "res-00000000-0000-0000-0000-000000000001",
          },
        ),
      ).rejects.toMatchObject({
        code: "QUEUE_UNAVAILABLE",
        message: "Workspace runtime unavailable for resource validation.",
        details: { reason: "RUNTIME_UNAVAILABLE" },
      });
    });
  });
});


