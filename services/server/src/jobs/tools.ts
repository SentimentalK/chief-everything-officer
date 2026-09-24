import type { McpServer } from "@modelcontextprotocol/server";
import type { JobService, SubmitResult } from "./service.js";
import type { JobAuthScope } from "./service.js";
import type { AuditStore } from "../audit.js";
import {
  businessDigest,
  parseSubmit,
  utf8ByteLength,
  workerSubmitSchema,
  workerGetSchema,
  REQUEST_ID_RE,
  JOB_ID_RE,
} from "./schema.js";

import {
  sanitizeRequestId,
  sanitizeJobId,
  recordSafeJobAuditTrace,
  type SafeJobAuditLog,
} from "./tool-audit.js";

export { sanitizeRequestId, sanitizeJobId };

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

function logTrace(ctx: ToolContext, toolName: string, status: "success" | "error", latencyMs: number, safe: SafeJobAuditLog): void {
  recordSafeJobAuditTrace(
    ctx.auditStore,
    ctx.scope.workspace_id,
    ctx.scope.user_id,
    toolName,
    status,
    latencyMs,
    safe,
  );
}

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  const scope = ctx.scope;

  server.registerTool(
    "worker_submit",
    {
      title: "Submit a worker task (queue only)",
      description:
        "Enqueue a task for the configured worker bridge. Submission queues work; it does not require an online Worker, and 'queued' is not 'done'. Retrying the same request_id returns the original task with its CURRENT state (which may already be claimed/running) rather than queuing again. " +
        "prompt describes the task goal and necessary inputs only. Do not include CEO/Worker transport mechanics, managed-result paths, Git persistence instructions, or generic runtime safety rules; those are injected by the Worker/runtime. " +
        "For external Resource ingestion, use this semantic pattern: 1) resource_capture(URL) -> resource_id, 2) worker_submit(workspace_ref=\"ceo-agent-runtime\", resource_id=<captured id>, result_target=\"resource\", prompt=\"Extract the complete usable source content from <URL>.\", acceptance=\"A non-empty faithful source transcript/content is extracted.\"), 3) worker_get until completed -> resource_get(content). " +
        "timeout_seconds is optional and defaults to 3600 (1 hour); omit it or keep it at 3600 for media ingestion or long tasks. " +
        "worker_get reflects queue and assignment state; do not poll intensely. Retry with the original request_id when the submit outcome is unknown.",
      inputSchema: workerSubmitSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const reqId = sanitizeRequestId(body.request_id);
      const promptBytes = typeof body.prompt === "string" ? utf8ByteLength(body.prompt) : null;
      const accBytes = typeof body.acceptance === "string" ? utf8ByteLength(body.acceptance) : null;
      const parsed = parseSubmit(raw);
      const resultTarget = parsed.ok ? parsed.value.result_target : null;
      const digest = parsed.ok ? businessDigest(parsed.value) : null;

      if (!ctx.service) {
        logTrace(ctx, "worker_submit", "error", Date.now() - started, {
          request_id: reqId,
          prompt_bytes: promptBytes,
          acceptance_bytes: accBytes,
          result_target: resultTarget,
          error_code: "BRIDGE_DISABLED",
        });
        return result({ ok: false, code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." }, true);
      }
      try {
        const res: SubmitResult = await ctx.service.submit(scope, raw);
        logTrace(ctx, "worker_submit", res.ok ? "success" : "error", Date.now() - started, {
          request_id: reqId,
          job_id: res.ok ? res.view!.job_id : null,
          request_digest: digest,
          prompt_bytes: promptBytes,
          acceptance_bytes: accBytes,
          result_target: resultTarget,
          error_code: res.ok ? null : res.code ?? null,
        });
        return toSubmitResult(res);
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_submit", "error", Date.now() - started, {
          request_id: reqId,
          request_digest: digest,
          prompt_bytes: promptBytes,
          acceptance_bytes: accBytes,
          result_target: resultTarget,
          error_code: info.code,
        });
        return result({ ok: false, code: info.code, message: info.message, ...(info.reason ? { reason: info.reason } : {}) }, true);
      }
    }) as unknown as any,
  );

  server.registerTool(
    "worker_get",
    {
      title: "Get worker job status",
      description:
        "Show queue, assignment, and reported execution outcome for a job. Reported terminal states describe the Worker's execution report. COMPLETED does not establish independent business verification or artifact upload. If no report exists, claimed/running is only the last recorded assignment state. expires_at applies only before the first claim, not as an execution deadline. The full prompt/acceptance is not returned. A missing job or one not owned by this identity is reported uniformly as JOB_NOT_FOUND.",
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
          result_target: v.result_target,
          result: v.result ?? null,
          execution: v.execution,
          report: v.report ?? null,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_get", "error", Date.now() - started, { job_id: jobId, error_code: info.code });
        return result({ ok: false, code: info.code, message: info.message, ...(info.reason ? { reason: info.reason } : {}) }, true);
      }
    }) as unknown as any,
  );
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

