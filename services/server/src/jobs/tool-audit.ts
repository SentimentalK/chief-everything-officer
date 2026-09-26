import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditStore } from "../audit.js";
import type { IdentityStore } from "../identity/store.js";
import {
  REQUEST_ID_V2_RE,
  JOB_ID_V2_RE,
  TARGET_ID_V2_RE,
  utf8ByteLength,
} from "./v2-schema.js";

export class WorkspaceAccessDeniedError extends Error {
  constructor(message = "Workspace access denied.") {
    super(message);
    this.name = "WorkspaceAccessDeniedError";
  }
}

export function assertHostWorkspaceAccess(
  identityStore: IdentityStore,
  scope: { user_id: string; workspace_id: string },
): void {
  if (!scope.user_id || !scope.workspace_id) {
    throw new WorkspaceAccessDeniedError();
  }
  if (!identityStore.isUserActive(scope.user_id)) {
    throw new WorkspaceAccessDeniedError("User is not active.");
  }
  const membership = identityStore.findWorkspaceMembership(scope.workspace_id, scope.user_id);
  if (!membership) {
    throw new WorkspaceAccessDeniedError("User is not a member of the workspace.");
  }
}

export function sanitizeRequestId(val: unknown): string | null {
  return typeof val === "string" && REQUEST_ID_V2_RE.test(val) ? val : null;
}

export function sanitizeJobId(val: unknown): string | null {
  return typeof val === "string" && JOB_ID_V2_RE.test(val) ? val : null;
}

export function sanitizeTargetId(val: unknown): string | null {
  return typeof val === "string" && TARGET_ID_V2_RE.test(val) ? val : null;
}

export interface SafeJobAuditLog {
  request_id?: string | null;
  job_id?: string | null;
  target_id?: string | null;
  request_digest?: string | null;
  prompt_bytes?: number | null;
  acceptance_bytes?: number | null;
  result_target?: string | null;
  state?: string | null;
  execution_status?: string | null;
  error_code?: string | null;
  limit?: number | null;
  cursor?: string | null;
  total_returned?: number | null;
  include_disabled?: boolean | null;
}

export function recordSafeJobAuditTrace(
  auditStore: AuditStore | null | undefined,
  workspaceId: string,
  userId: string,
  toolName: string,
  status: "success" | "error",
  latencyMs: number,
  safe: SafeJobAuditLog,
): void {
  if (!auditStore) return;
  const sanitizedReqId = sanitizeRequestId(safe.request_id);
  const sanitizedJobId = sanitizeJobId(safe.job_id);
  const sanitizedTgtId = sanitizeTargetId(safe.target_id);

  auditStore.recordTrace({
    workspace_id: workspaceId,
    timestamp_ms: Date.now(),
    tool_name: toolName,
    status,
    error_message: safe.error_code ?? null,
    operation_request_id: sanitizedReqId,
    input_json: JSON.stringify(
      "full prompt/input withheld" + (safe.request_digest ? `; digest: ${safe.request_digest}` : ""),
    ),
    output_json: JSON.stringify({
      ok: status === "success",
      scope: { user_id: userId, workspace_id: workspaceId },
      job_id: sanitizedJobId,
      request_id: sanitizedReqId,
      target_id: sanitizedTgtId,
      request_digest: safe.request_digest ?? null,
      prompt_bytes: safe.prompt_bytes ?? null,
      acceptance_bytes: safe.acceptance_bytes ?? null,
      result_target: safe.result_target ?? null,
      state: safe.state ?? null,
      execution_status: safe.execution_status ?? null,
      error_code: safe.error_code ?? null,
      limit: safe.limit ?? null,
      cursor: safe.cursor ?? null,
      total_returned: safe.total_returned ?? null,
      include_disabled: safe.include_disabled ?? null,
    }),
    semantic_output_json: JSON.stringify({
      ok: status === "success",
      job_id: sanitizedJobId,
      request_id: sanitizedReqId,
      target_id: sanitizedTgtId,
      ...(safe.error_code ? { error_code: safe.error_code } : {}),
    }),
    latency_ms: latencyMs,
  });
}

const RECOGNIZED_JOB_TOOLS = new Set([
  "execution_targets",
  "job_submit",
  "job_get",
  "job_list",
]);

export function installJobToolValidationAuditInterceptor(
  server: McpServer,
  auditStore: AuditStore | null | undefined,
  scope: { user_id: string; workspace_id: string },
): void {
  const innerServer = (server as any).server;
  if (
    innerServer &&
    typeof innerServer._requestHandlers?.get === "function" &&
    !innerServer.__toolsCallInterceptedForJobs
  ) {
    innerServer.__toolsCallInterceptedForJobs = true;
    const originalCallHandler = innerServer._requestHandlers.get("tools/call");
    if (typeof originalCallHandler === "function") {
      innerServer._requestHandlers.set("tools/call", async (request: any, extra: any) => {
        const started = Date.now();
        const res = await originalCallHandler(request, extra);
        const toolName = request?.params?.name;
        if (
          res?.isError &&
          !res.structuredContent &&
          typeof toolName === "string" &&
          RECOGNIZED_JOB_TOOLS.has(toolName)
        ) {
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          const reqId = sanitizeRequestId(args.request_id);
          const jobId = sanitizeJobId(args.job_id);
          const tgtId = sanitizeTargetId(args.target_id);
          const promptBytes = typeof args.prompt === "string" ? utf8ByteLength(args.prompt) : null;
          const accBytes = typeof args.acceptance === "string" ? utf8ByteLength(args.acceptance) : null;
          const resultTarget =
            args.result_target === "none" || args.result_target === "resource"
              ? args.result_target
              : null;
          recordSafeJobAuditTrace(
            auditStore,
            scope.workspace_id,
            scope.user_id,
            toolName,
            "error",
            Date.now() - started,
            {
              request_id: reqId,
              job_id: jobId,
              target_id: tgtId,
              prompt_bytes: promptBytes,
              acceptance_bytes: accBytes,
              result_target: resultTarget,
              error_code: "INVALID_INPUT",
            },
          );
        }
        return res;
      });
    }
  }
}
