import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { JobService, SubmitResult } from "./service.js";
import type { JobAuthScope } from "./service.js";
import type { AuditStore } from "../audit.js";
import { businessDigest, utf8ByteLength } from "./schema.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

interface ToolContext {
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
  request_id?: string;
  job_id?: string;
  request_digest?: string;
  prompt_bytes?: number;
  acceptance_bytes?: number;
  error_code?: string | null;
}

function logTrace(ctx: ToolContext, toolName: string, status: "success" | "error", latencyMs: number, safe: SafeLog): void {
  if (!ctx.auditStore) return;
  ctx.auditStore.recordTrace({
    timestamp_ms: Date.now(),
    tool_name: toolName,
    status,
    error_message: safe.error_code ?? null,
    operation_request_id: safe.request_id ?? null,
    input_json: JSON.stringify("full prompt/input withheld; digest: " + (safe.request_digest ?? "")),
    output_json: JSON.stringify({
      ok: status === "success",
      scope: { user_id: ctx.scope.user_id, workspace_id: ctx.scope.workspace_id },
      job_id: safe.job_id ?? null,
      request_id: safe.request_id ?? null,
      request_digest: safe.request_digest ?? null,
      prompt_bytes: safe.prompt_bytes ?? null,
      acceptance_bytes: safe.acceptance_bytes ?? null,
      error_code: safe.error_code ?? null,
    }),
    semantic_output_json: JSON.stringify({
      ok: status === "success",
      job_id: safe.job_id ?? null,
      request_id: safe.request_id ?? null,
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
        "Enqueue a task for the configured worker bridge. This ONLY queues and returns a persistent job id/state 'queued'; the task is not started and 'queued' is not 'done'. After a success you may end the conversation. worker_get reflects queue state, not this machine being online - do not poll intensely. Retry with the same request_id when the submit outcome is unknown.",
      inputSchema: {
        request_id: z.string().describe("Client UUID; retries of the same logical task must reuse it."),
        workspace_ref: z.string().min(1).max(64).describe("Preconfigured local directory alias (1-64 [A-Za-z0-9_-])."),
        prompt: z.string().min(1).describe("Task instructions (non-empty, UTF-8 <= 64 KiB)."),
        acceptance: z.string().min(1).describe("Completion criterion (non-empty, UTF-8 <= 8 KiB)."),
        resource_id: z.string().optional().describe("Optional res-<uuid> that must already exist in your workspace."),
        timeout_seconds: z.number().int().optional().describe("Execution timeout; 1800 default, 60-7200."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const reqId = typeof body.request_id === "string" ? body.request_id : undefined;
      const promptBytes = typeof body.prompt === "string" ? utf8ByteLength(body.prompt) : undefined;
      const accBytes = typeof body.acceptance === "string" ? utf8ByteLength(body.acceptance) : undefined;
      if (!ctx.service) {
        logTrace(ctx, "worker_submit", "error", Date.now() - started, { request_id: reqId, prompt_bytes: promptBytes, acceptance_bytes: accBytes, error_code: "BRIDGE_DISABLED" });
        return result({ ok: false, code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." }, true);
      }
      try {
        const res: SubmitResult = await ctx.service.submit(scope, raw);
        const digest = typeof body.prompt === "string" ? submitDigest({ workspace_ref: String(body.workspace_ref ?? ""), prompt: String(body.prompt), acceptance: typeof body.acceptance === "string" ? body.acceptance : undefined, resource_id: typeof body.resource_id === "string" ? body.resource_id : undefined, timeout_seconds: typeof body.timeout_seconds === "number" ? body.timeout_seconds : undefined }) : undefined;
        logTrace(ctx, "worker_submit", res.ok ? "success" : "error", Date.now() - started, { request_id: reqId, job_id: res.ok ? res.view!.job_id : undefined, request_digest: digest, prompt_bytes: promptBytes, acceptance_bytes: accBytes, error_code: res.ok ? null : res.code ?? null });
        return toSubmitResult(res);
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_submit", "error", Date.now() - started, { request_id: reqId, error_code: info.code });
        return result({ ok: false, code: info.code, message: info.message }, true);
      }
    }) as unknown as any,
  );

  server.registerTool(
    "worker_get",
    {
      title: "Get worker job status",
      description: "Return queue/claim state, created/expiry time, and execution target for a job. The full prompt is not returned. A missing job or one not owned by this identity is reported uniformly as JOB_NOT_FOUND.",
      inputSchema: {
        job_id: z.string().describe("job-<uuid> returned by worker_submit."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      if (!ctx.service) {
        logTrace(ctx, "worker_get", "error", Date.now() - started, { error_code: "BRIDGE_DISABLED" });
        return result({ ok: false, code: "BRIDGE_DISABLED", message: "Job submission is disabled on this deployment." }, true);
      }
      try {
        const res = await ctx.service.get(scope, raw ?? {});
        logTrace(ctx, "worker_get", res.ok ? "success" : "error", Date.now() - started, { job_id: res.ok ? res.view!.job_id : (typeof raw === "object" && raw && typeof (raw as Record<string, unknown>).job_id === "string" ? (raw as Record<string, unknown>).job_id as string : undefined), error_code: res.ok ? null : res.code ?? null });
        if (!res.ok) return result({ ok: false, code: res.code, message: res.message }, true);
        const v = res.view!;
        return result({ ok: true, job_id: v.job_id, state: v.state, created_at: v.created_at, expires_at: v.expires_at, workspace_ref: v.workspace_ref, resource_id: v.resource_id });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "worker_get", "error", Date.now() - started, { error_code: info.code });
        return result({ ok: false, code: info.code, message: info.message }, true);
      }
    }) as unknown as any,
  );
}

function errInfo(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" && e.code ? e.code : "QUEUE_UNAVAILABLE";
    const message = typeof e.message === "string" ? e.message : String(error);
    return { code, message };
  }
  return { code: "QUEUE_UNAVAILABLE", message: String(error) };
}

function toSubmitResult(res: SubmitResult): ToolResult {
  if (!res.ok) return result({ ok: false, code: res.code, message: res.message }, true);
  const v = res.view!;
  return result({ ok: true, job_id: v.job_id, state: v.state, created_at: v.created_at, expires_at: v.expires_at, replayed: v.replayed });
}
