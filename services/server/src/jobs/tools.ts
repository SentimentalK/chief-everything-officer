import type { McpServer } from "@modelcontextprotocol/server";
import type { JobService, SubmitResult } from "./service.js";
import type { JobAuthScope } from "./service.js";
import type { AuditStore } from "../audit.js";
import {
  businessDigest,
  utf8ByteLength,
  workerSubmitSchema,
  workerGetSchema,
  REQUEST_ID_RE,
  JOB_ID_RE,
} from "./schema.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolContext {
  service: JobService | null;
  scope: JobAuthScope;
  auditStore?: AuditStore | null;
}

function result(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

interface SafeLog {
  request_id?: string | null;
  job_id?: string | null;
  request_digest?: string | null;
  prompt_bytes?: number | null;
  acceptance_bytes?: number | null;
  error_code?: string | null;
}

export function sanitizeRequestId(val: unknown): string | null {
  return typeof val === "string" && REQUEST_ID_RE.test(val) ? val : null;
}

export function sanitizeJobId(val: unknown): string | null {
  return typeof val === "string" && JOB_ID_RE.test(val) ? val : null;
}

function logTrace(ctx: ToolContext, toolName: string, status: "success" | "error", latencyMs: number, safe: SafeLog): void {
  if (!ctx.auditStore) return;
  const sanitizedReqId = sanitizeRequestId(safe.request_id);
  const sanitizedJobId = sanitizeJobId(safe.job_id);

  ctx.auditStore.recordTrace({
    timestamp_ms: Date.now(),
    tool_name: toolName,
    status,
    error_message: safe.error_code ?? null,
    operation_request_id: sanitizedReqId,
    input_json: JSON.stringify("full prompt/input withheld; digest: " + (safe.request_digest ?? "")),
    output_json: JSON.stringify({
      ok: status === "success",
      scope: { user_id: ctx.scope.user_id, workspace_id: ctx.scope.workspace_id },
      job_id: sanitizedJobId,
      request_id: sanitizedReqId,
      request_digest: safe.request_digest ?? null,
      prompt_bytes: safe.prompt_bytes ?? null,
      acceptance_bytes: safe.acceptance_bytes ?? null,
      error_code: safe.error_code ?? null,
    }),
    semantic_output_json: JSON.stringify({
      ok: status === "success",
      job_id: sanitizedJobId,
      request_id: sanitizedReqId,
    }),
    latency_ms: latencyMs,
  });
}

function submitDigest(p: { workspace_ref: string; prompt: string; acceptance?: string; resource_id?: string; timeout_seconds?: number }): string {
  return businessDigest({
    workspace_ref: p.workspace_ref,
    prompt: p.prompt,
    acceptance: p.acceptance ?? "",
    resource_id: p.resource_id ?? null,
    execution_timeout_seconds: p.timeout_seconds ?? 1800,
  });
}

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  const scope = ctx.scope;

  server.registerTool(
    "worker_submit",
    {
      title: "Submit a worker task (queue only)",
      description:
        "Enqueue a task for the configured worker bridge. A first submission returns state 'queued'; it only enqueues - submission itself does not start the task, and 'queued' is not 'done'. Retrying the same request_id returns the original task with its CURRENT state (e.g. claimed/running/interrupted) rather than queuing again. worker_get reflects queue and execution-eligibility state; do not poll intensely. Retry with the same request_id when the submit outcome is unknown.",
      inputSchema: workerSubmitSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const reqId = sanitizeRequestId(body.request_id);
      const promptBytes = typeof body.prompt === "string" ? utf8ByteLength(body.prompt) : null;
      const accBytes = typeof body.acceptance === "string" ? utf8ByteLength(body.acceptance) : null;
      if (!ctx.service) {
        logTrace(ctx, "worker_submit", "error", Date.now() - started, { request_id: reqId, prompt_bytes: promptBytes, acceptance_bytes: accBytes, error_code: "BRIDGE_DISABLED" });
        return result({ ok: false, code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." }, true);
      }
      try {
        const res: SubmitResult = await ctx.service.submit(scope, raw);
        const digest = typeof body.prompt === "string" ? submitDigest({ workspace_ref: String(body.workspace_ref ?? ""), prompt: String(body.prompt), acceptance: typeof body.acceptance === "string" ? body.acceptance : undefined, resource_id: typeof body.resource_id === "string" ? body.resource_id : undefined, timeout_seconds: typeof body.timeout_seconds === "number" ? body.timeout_seconds : undefined }) : null;
        logTrace(ctx, "worker_submit", res.ok ? "success" : "error", Date.now() - started, { request_id: reqId, job_id: res.ok ? res.view!.job_id : null, request_digest: digest, prompt_bytes: promptBytes, acceptance_bytes: accBytes, error_code: res.ok ? null : res.code ?? null });
        return toSubmitResult(res);
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_submit", "error", Date.now() - started, { request_id: reqId, error_code: info.code });
        return result({ ok: false, code: info.code, message: info.message, ...(info.reason ? { reason: info.reason } : {}) }, true);
      }
    }) as unknown as any,
  );

  server.registerTool(
    "worker_get",
    {
      title: "Get worker job status",
      description:
        "Show queue and execution-eligibility state for a job: derived state (queued/expired/claimed/running/interrupted), created time, the seven-day claim expiry (expires_at, NOT an execution deadline), and the current execution lease when claimed. 'interrupted' only means the server can no longer confirm the current attempt holds execution eligibility - it does NOT confirm a remote process stopped or that the task succeeded/cancelled. The full prompt/acceptance is not returned. A missing job or one not owned by this identity is reported uniformly as JOB_NOT_FOUND.",
      inputSchema: workerGetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const jobId = sanitizeJobId(body.job_id);
      if (!ctx.service) {
        logTrace(ctx, "worker_get", "error", Date.now() - started, { job_id: jobId, error_code: "BRIDGE_DISABLED" });
        return result({ ok: false, code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." }, true);
      }
      try {
        const res = await ctx.service.get(scope, raw ?? {});
        logTrace(ctx, "worker_get", res.ok ? "success" : "error", Date.now() - started, { job_id: res.ok ? res.view!.job_id : jobId, error_code: res.ok ? null : res.code ?? null });
        if (!res.ok) return result({ ok: false, code: res.code, message: res.message }, true);
        const v = res.view!;
        return result({
          ok: true,
          job_id: v.job_id,
          state: v.state,
          created_at: v.created_at,
          expires_at: v.expires_at,
          workspace_ref: v.workspace_ref,
          resource_id: v.resource_id,
          execution: v.execution,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_get", "error", Date.now() - started, { job_id: jobId, error_code: info.code });
        return result({ ok: false, code: info.code, message: info.message, ...(info.reason ? { reason: info.reason } : {}) }, true);
      }
    }) as unknown as any,
  );

  // Intercept low-level tools/call to ensure schema validation errors occurring before
  // tool handlers record an audit trace with sanitized IDs and withheld prompts.
  const innerServer = (server as any).server;
  if (innerServer && typeof innerServer._requestHandlers?.get === "function" && !innerServer.__toolsCallInterceptedForJobs) {
    innerServer.__toolsCallInterceptedForJobs = true;
    const originalCallHandler = innerServer._requestHandlers.get("tools/call");
    if (typeof originalCallHandler === "function") {
      innerServer._requestHandlers.set("tools/call", async (request: any, extra: any) => {
        const started = Date.now();
        const res = await originalCallHandler(request, extra);
        if (
          res?.isError &&
          !res.structuredContent &&
          (request?.params?.name === "worker_submit" || request?.params?.name === "worker_get")
        ) {
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          const reqId = sanitizeRequestId(args.request_id);
          const jobId = sanitizeJobId(args.job_id);
          const promptBytes = typeof args.prompt === "string" ? utf8ByteLength(args.prompt) : null;
          const accBytes = typeof args.acceptance === "string" ? utf8ByteLength(args.acceptance) : null;
          logTrace(ctx, request.params.name, "error", Date.now() - started, {
            request_id: reqId,
            job_id: jobId,
            prompt_bytes: promptBytes,
            acceptance_bytes: accBytes,
            error_code: "INVALID_INPUT",
          });
        }
        return res;
      });
    }
  }
}

function errInfo(error: unknown): { code: string; message: string; reason?: string } {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof e.code === "string" && e.code ? e.code : "QUEUE_UNAVAILABLE";
    const message = typeof e.message === "string" ? e.message : String(error);
    let reason: string | undefined;
    if (e.details && typeof e.details === "object") {
      const r = (e.details as { reason?: unknown }).reason;
      if (typeof r === "string" && r) reason = r;
    }
    return { code, message, reason };
  }
  return { code: "QUEUE_UNAVAILABLE", message: String(error) };
}

function toSubmitResult(res: SubmitResult): ToolResult {
  if (!res.ok) return result({ ok: false, code: res.code, message: res.message }, true);
  const v = res.view!;
  return result({ ok: true, job_id: v.job_id, state: v.state, created_at: v.created_at, expires_at: v.expires_at, replayed: v.replayed });
}

