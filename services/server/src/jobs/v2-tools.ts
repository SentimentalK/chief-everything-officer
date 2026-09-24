import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AuditStore } from "../audit.js";
import type { IdentityStore } from "../identity/store.js";
import type { ConnectorControlStore } from "../connector/control-store.js";
import {
  JobCoordinatorV2,
  JobValidationError,
  TargetNotFoundError,
  TargetDisabledError,
  UserInactiveError,
  WorkspaceMembershipError,
  ResourceNotFoundError,
} from "./v2-service.js";
import {
  V2JobNotFoundError,
  V2IdempotencyConflictError,
  V2StoreError,
} from "./v2-store.js";
import {
  assertHostWorkspaceAccess,
  WorkspaceAccessDeniedError,
  sanitizeRequestId,
  sanitizeJobId,
  sanitizeTargetId,
  recordSafeJobAuditTrace,
  type SafeJobAuditLog,
} from "./tool-audit.js";
import {
  utf8ByteLength,
  businessDigestV2,
} from "./v2-schema.js";

export interface ConnectorJobToolContext {
  coordinator: JobCoordinatorV2 | null;
  controlStore: ConnectorControlStore;
  identityStore: IdentityStore;
  scope: { user_id: string; workspace_id: string };
  auditStore?: AuditStore | null;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function result(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function logTrace(
  ctx: ConnectorJobToolContext,
  toolName: string,
  status: "success" | "error",
  latencyMs: number,
  safe: SafeJobAuditLog,
): void {
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

function errInfo(error: unknown): { code: string; message: string; reason?: string } {
  if (error instanceof WorkspaceAccessDeniedError) {
    return { code: "WORKSPACE_ACCESS_DENIED", message: error.message };
  }
  if (error instanceof TargetNotFoundError) {
    return { code: "TARGET_NOT_FOUND", message: error.message };
  }
  if (error instanceof TargetDisabledError) {
    return { code: "TARGET_DISABLED", message: error.message };
  }
  if (error instanceof UserInactiveError) {
    return { code: "WORKSPACE_ACCESS_DENIED", message: error.message };
  }
  if (error instanceof WorkspaceMembershipError) {
    return { code: "WORKSPACE_ACCESS_DENIED", message: error.message };
  }
  if (error instanceof ResourceNotFoundError) {
    return { code: "RESOURCE_NOT_FOUND", message: error.message };
  }
  if (error instanceof V2JobNotFoundError) {
    return { code: "JOB_NOT_FOUND", message: error.message };
  }
  if (error instanceof V2IdempotencyConflictError) {
    return { code: "IDEMPOTENCY_CONFLICT", message: error.message };
  }
  if (error instanceof JobValidationError) {
    return { code: "INVALID_INPUT", message: error.message };
  }
  if (error instanceof V2StoreError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.reasonCode ? { reason: error.reasonCode } : {}),
    };
  }
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof e.code === "string" && e.code ? e.code : "QUEUE_UNAVAILABLE";
    const message = typeof e.message === "string" ? e.message : String(error);
    let reason: string | undefined;
    if (e.details && typeof e.details === "object") {
      const r =
        (e.details as { reason?: unknown; reasonCode?: unknown }).reasonCode ??
        (e.details as { reason?: unknown }).reason;
      if (typeof r === "string" && r) reason = r;
    }
    return { code, message, ...(reason ? { reason } : {}) };
  }
  return { code: "QUEUE_UNAVAILABLE", message: String(error) };
}

const executionTargetsSchema = z
  .object({
    include_disabled: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include disabled execution targets (defaults to false)"),
  })
  .strict();

const jobSubmitSchema = z
  .object({
    request_id: z.string().min(1).describe("Client idempotency key (UUID or req-<uuid>)"),
    target_id: z.string().min(1).describe("Execution Target ID (tgt_<uuid>)"),
    prompt: z.string().min(1).describe("Task goal and necessary inputs"),
    acceptance: z.string().min(1).describe("Concrete criteria for task completion"),
    resource_id: z.string().nullable().optional().default(null).describe("Optional resource ID (res-<uuid>)"),
    timeout_seconds: z
      .number()
      .int()
      .min(60)
      .max(7200)
      .optional()
      .default(3600)
      .describe("Execution timeout in seconds (60-7200, default 3600)"),
    result_target: z
      .enum(["none", "resource"])
      .optional()
      .default("none")
      .describe("Result destination ('none' or 'resource')"),
  })
  .strict();

const jobGetSchema = z
  .object({
    job_id: z.string().min(1).describe("Job ID (job-<uuid>)"),
    include_task: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include prompt, acceptance, and timeout in response (defaults to false)"),
  })
  .strict();

const jobListSchema = z
  .object({
    target_id: z.string().optional().describe("Filter by execution target ID"),
    state: z
      .enum(["queued", "expired", "claimed", "running", "terminal"])
      .optional()
      .describe("Filter by job lifecycle state"),
    execution_status: z
      .enum([
        "COMPLETED",
        "FAILED",
        "TIMED_OUT",
        "CANCELLED",
        "BLOCKED",
        "INTERRUPTED",
      ])
      .optional()
      .describe("Filter by reported execution status"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe("Max results (1-50, default 20)"),
    cursor: z.string().optional().describe("Pagination cursor from previous next_cursor"),
  })
  .strict();

export function registerConnectorJobTools(
  server: McpServer,
  ctx: ConnectorJobToolContext,
): void {
  const scope = ctx.scope;

  // 1. execution_targets
  server.registerTool(
    "execution_targets",
    {
      title: "List execution targets",
      description:
        "List execution targets available to the authenticated workspace for job dispatch. Aliases are descriptive; jobs must be dispatched by target_id. active_binding_count indicates how many enrolled devices are currently bound to the target (eligible to claim jobs), not whether a worker daemon is currently online or idle.",
      inputSchema: executionTargetsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const includeDisabled = Boolean(body.include_disabled);

      try {
        assertHostWorkspaceAccess(ctx.identityStore, scope);
        const rows = ctx.controlStore.listTargetsForUser(scope.user_id, {
          workspaceId: scope.workspace_id,
        });
        const filtered = rows.filter((r) =>
          includeDisabled ? true : r.target.disabled_at_ms === null,
        );
        const projected = filtered.map((r) => ({
          target_id: r.target.id,
          alias: r.target.alias,
          display_name: r.target.display_name,
          kind: r.target.kind,
          repository:
            r.target.repository_provider &&
            r.target.repository_external_id &&
            r.target.repository_full_name
              ? {
                  provider: r.target.repository_provider,
                  external_id: r.target.repository_external_id,
                  full_name: r.target.repository_full_name,
                }
              : null,
          active_binding_count: r.activeBindingCount,
          disabled: r.target.disabled_at_ms !== null,
          disabled_at: r.target.disabled_at_ms
            ? new Date(r.target.disabled_at_ms).toISOString()
            : null,
          created_at: new Date(r.target.created_at_ms).toISOString(),
        }));

        logTrace(ctx, "execution_targets", "success", Date.now() - started, {
          include_disabled: includeDisabled,
          total_returned: projected.length,
        });

        return result({
          ok: true,
          targets: projected,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "execution_targets", "error", Date.now() - started, {
          include_disabled: includeDisabled,
          error_code: info.code,
        });
        return result(
          {
            ok: false,
            code: info.code,
            message: info.message,
            ...(info.reason ? { reason: info.reason } : {}),
          },
          true,
        );
      }
    }) as unknown as any,
  );

  // 2. job_submit
  server.registerTool(
    "job_submit",
    {
      title: "Submit a connector job",
      description:
        "Submit a new job targeted to a specific execution target in the workspace. Retrying the same request_id returns the existing job.",
      inputSchema: jobSubmitSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const reqId = sanitizeRequestId(body.request_id);
      const tgtId = sanitizeTargetId(body.target_id);
      const promptBytes = typeof body.prompt === "string" ? utf8ByteLength(body.prompt) : null;
      const accBytes = typeof body.acceptance === "string" ? utf8ByteLength(body.acceptance) : null;
      const timeoutSeconds =
        typeof body.timeout_seconds === "number"
          ? body.timeout_seconds
          : 3600;
      const resultTarget =
        body.result_target === "none" || body.result_target === "resource"
          ? body.result_target
          : null;
      const digest =
        typeof body.target_id === "string" &&
        typeof body.prompt === "string" &&
        typeof body.acceptance === "string" &&
        resultTarget
          ? businessDigestV2({
              target_id: body.target_id,
              prompt: body.prompt,
              acceptance: body.acceptance,
              resource_id: typeof body.resource_id === "string" ? body.resource_id : null,
              execution_timeout_seconds: timeoutSeconds,
              result_target: resultTarget,
            })
          : null;

      try {
        assertHostWorkspaceAccess(ctx.identityStore, scope);

        if (!ctx.coordinator) {
          logTrace(ctx, "job_submit", "error", Date.now() - started, {
            request_id: reqId,
            target_id: tgtId,
            prompt_bytes: promptBytes,
            acceptance_bytes: accBytes,
            result_target: resultTarget,
            request_digest: digest,
            error_code: "QUEUE_UNAVAILABLE",
          });
          return result(
            {
              ok: false,
              code: "QUEUE_UNAVAILABLE",
              message: "Job coordination service is unavailable on this deployment.",
            },
            true,
          );
        }

        const res = await ctx.coordinator.submit(scope, {
          request_id: String(body.request_id),
          target_id: String(body.target_id),
          prompt: String(body.prompt),
          acceptance: String(body.acceptance),
          resource_id: (body.resource_id as string | null) ?? null,
          execution_timeout_seconds: timeoutSeconds,
          result_target: (resultTarget ?? "none") as "none" | "resource",
        });

        const detail = await ctx.coordinator.getJobForHost(scope, res.job.job_id);

        logTrace(ctx, "job_submit", "success", Date.now() - started, {
          request_id: reqId,
          job_id: res.job.job_id,
          target_id: tgtId,
          request_digest: digest,
          prompt_bytes: promptBytes,
          acceptance_bytes: accBytes,
          result_target: resultTarget,
          state: detail.state,
        });

        return result({
          ok: true,
          replayed: res.status === "replayed",
          job_id: detail.job_id,
          request_id: detail.request_id,
          target_id: detail.target_id,
          target_alias: detail.target_alias,
          state: detail.state,
          created_at: detail.created_at,
          expires_at: detail.expires_at,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "job_submit", "error", Date.now() - started, {
          request_id: reqId,
          target_id: tgtId,
          request_digest: digest,
          prompt_bytes: promptBytes,
          acceptance_bytes: accBytes,
          result_target: resultTarget,
          error_code: info.code,
        });
        return result(
          {
            ok: false,
            code: info.code,
            message: info.message,
            ...(info.reason ? { reason: info.reason } : {}),
          },
          true,
        );
      }
    }) as unknown as any,
  );

  // 3. job_get
  server.registerTool(
    "job_get",
    {
      title: "Get connector job status",
      description:
        "Show queue, execution attempt, and reported execution outcome for a job. A missing job or one not in this workspace is reported as JOB_NOT_FOUND.",
      inputSchema: jobGetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const jobId = sanitizeJobId(body.job_id);
      const includeTask = Boolean(body.include_task);

      try {
        assertHostWorkspaceAccess(ctx.identityStore, scope);

        if (!ctx.coordinator) {
          logTrace(ctx, "job_get", "error", Date.now() - started, {
            job_id: jobId,
            error_code: "QUEUE_UNAVAILABLE",
          });
          return result(
            {
              ok: false,
              code: "QUEUE_UNAVAILABLE",
              message: "Job coordination service is unavailable on this deployment.",
            },
            true,
          );
        }

        const detail = await ctx.coordinator.getJobForHost(scope, String(body.job_id), {
          include_task: includeTask,
        });

        logTrace(ctx, "job_get", "success", Date.now() - started, {
          job_id: detail.job_id,
          target_id: detail.target_id,
          state: detail.state,
          execution_status: detail.report?.execution_status ?? null,
        });

        return result({
          ok: true,
          ...detail,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "job_get", "error", Date.now() - started, {
          job_id: jobId,
          error_code: info.code,
        });
        return result(
          {
            ok: false,
            code: info.code,
            message: info.message,
            ...(info.reason ? { reason: info.reason } : {}),
          },
          true,
        );
      }
    }) as unknown as any,
  );

  // 4. job_list
  server.registerTool(
    "job_list",
    {
      title: "List connector jobs",
      description:
        "List recent jobs in this workspace in reverse chronological order (newest first). Filter by target, state, or execution status.",
      inputSchema: jobListSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (async (raw: any) => {
      const started = Date.now();
      const body = (raw ?? {}) as Record<string, unknown>;
      const tgtId = sanitizeTargetId(body.target_id);

      try {
        assertHostWorkspaceAccess(ctx.identityStore, scope);

        if (!ctx.coordinator) {
          logTrace(ctx, "job_list", "error", Date.now() - started, {
            target_id: tgtId,
            error_code: "QUEUE_UNAVAILABLE",
          });
          return result(
            {
              ok: false,
              code: "QUEUE_UNAVAILABLE",
              message: "Job coordination service is unavailable on this deployment.",
            },
            true,
          );
        }

        const query = {
          target_id: typeof body.target_id === "string" ? body.target_id : undefined,
          state: typeof body.state === "string" ? (body.state as any) : undefined,
          execution_status:
            typeof body.execution_status === "string"
              ? (body.execution_status as any)
              : undefined,
          limit: typeof body.limit === "number" ? body.limit : undefined,
          cursor: typeof body.cursor === "string" ? body.cursor : undefined,
        };

        const res = await ctx.coordinator.listJobsForHost(scope, query);

        logTrace(ctx, "job_list", "success", Date.now() - started, {
          target_id: tgtId,
          state: query.state ?? null,
          execution_status: query.execution_status ?? null,
          limit: query.limit ?? null,
          cursor: query.cursor ?? null,
          total_returned: res.jobs.length,
        });

        return result({
          ok: true,
          jobs: res.jobs,
          next_cursor: res.next_cursor,
        });
      } catch (error) {
        const info = errInfo(error);
        logTrace(ctx, "job_list", "error", Date.now() - started, {
          target_id: tgtId,
          error_code: info.code,
        });
        return result(
          {
            ok: false,
            code: info.code,
            message: info.message,
            ...(info.reason ? { reason: info.reason } : {}),
          },
          true,
        );
      }
    }) as unknown as any,
  );
}
