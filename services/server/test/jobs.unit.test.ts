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
  isNoScriptError,
  createRedisRunnerFromClient,
  StoreError,
} from "../src/jobs/redis-store.js";
import { registerJobTools, sanitizeRequestId, sanitizeJobId } from "../src/jobs/tools.js";
import type { JobService } from "../src/jobs/service.js";
import type { AuditStore, TraceRecordInput } from "../src/audit.js";

const uuid = "123e4567-e89b-12d3-a456-426614174000";
const wsRef = "tools";

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
  it("defaults timeout to 1800 and treats absent resource_id as null", () => {
    const r = parseSubmit(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.execution_timeout_seconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(r.value.resource_id).toBeNull();
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

describe("business digest", () => {
  const base = {
    workspace_ref: "tools",
    prompt: "translate next",
    acceptance: "> 0 lines",
    resource_id: null as string | null,
    execution_timeout_seconds: 120,
  };
  it("is stable across key-authoring order and excludes request_id/server-time concepts", () => {
    const a = businessDigest({ ...base });
    const b = businessDigest({
      acceptance: base.acceptance,
      execution_timeout_seconds: base.execution_timeout_seconds,
      prompt: base.prompt,
      resource_id: base.resource_id,
      workspace_ref: base.workspace_ref,
    });
    expect(a).toBe(b);
  });
  it("changes when a business field changes", () => {
    expect(businessDigest({ ...base, prompt: "different task" })).not.toBe(businessDigest(base));
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

describe("createRedisRunnerFromClient bounded timeout", () => {
  it("times out hanging commands and provides original request_id retry guidance", async () => {
    const fakeClient: any = {
      isOpen: true,
      isReady: true,
      async sendCommand(args: string[], options?: { abortSignal?: AbortSignal }) {
        return new Promise((resolve, reject) => {
          if (args[0] === "HANG") {
            if (options?.abortSignal) {
              options.abortSignal.addEventListener("abort", () => {
                const err: any = new Error("The command was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
            return;
          }
          resolve("OK_RESULT");
        });
      },
    };

    const runner = createRedisRunnerFromClient(fakeClient, { opTimeoutMs: 30 });

    let caught: any;
    try {
      await (runner as any).get("test-key");
    } catch (err) {
      caught = err;
    }

    // Now test hanging get
    fakeClient.sendCommand = (args: string[], options?: { abortSignal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        if (options?.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            const err: any = new Error("The command was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    await expect(runner.get("hang-key")).rejects.toThrow(StoreError);
    await expect(runner.get("hang-key")).rejects.toThrow(/retry with the original request_id/);

    // Verify subsequent successful calls work
    fakeClient.sendCommand = async (args: string[]) => {
      if (args[0] === "GET") return "subsequent_value";
      return "OK";
    };
    expect(await runner.get("good-key")).toBe("subsequent_value");
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
});

