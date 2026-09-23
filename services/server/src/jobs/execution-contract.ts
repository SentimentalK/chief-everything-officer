import * as z from "zod/v4";

export function isWhitespaceOnly(s: string): boolean {
  return s.trim().length === 0;
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const MAX_REPORT_ERROR_MESSAGE_BYTES = 2 * 1024;
export const MAX_EXECUTOR_VERSION_BYTES = 256;

export const RESULT_TARGET_VALUES = ["none", "resource"] as const;
export type ResultTarget = (typeof RESULT_TARGET_VALUES)[number];

export const EXECUTION_STATUSES = [
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "BLOCKED",
  "INTERRUPTED",
] as const;

export const BUSINESS_OUTCOMES = ["UNVERIFIED", "FAILED", "NOT_STARTED"] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type BusinessOutcome = (typeof BUSINESS_OUTCOMES)[number];

export interface ExecutionReportError {
  stage: string;
  code: string;
  message: string;
}

export interface ExecutionReportExecutor {
  type: string;
  version: string;
}

export interface ExecutionReport {
  schema_version: 2;
  execution_status: ExecutionStatus;
  business_outcome: BusinessOutcome;
  task_dispatched: boolean;
  finished_at_ms: number;
  duration_ms: number;
  executor: ExecutionReportExecutor;
  receipt_sha256: string;
  error: ExecutionReportError | null;
}

export interface PersistedExecutionReport extends ExecutionReport {
  received_at_ms: number;
}

export interface PersistedJobResult {
  target: "resource";
  attempt_id: string;
  payload_sha256: string;
  resource_id: string;
  commit: string;
  received_at_ms: number;
}

export class ExecutionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContractError";
  }
}

const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");

export const reportErrorSchema = z
  .object({
    stage: z
      .string()
      .min(1, "error.stage must be 1-64 [A-Za-z0-9_-]")
      .max(64, "error.stage must be 1-64 [A-Za-z0-9_-]")
      .regex(/^[A-Za-z0-9_-]+$/, "error.stage must be 1-64 [A-Za-z0-9_-]"),
    code: z
      .string()
      .min(1, "error.code must be 1-64 [A-Z0-9_]")
      .max(64, "error.code must be 1-64 [A-Z0-9_]")
      .regex(/^[A-Z0-9_]+$/, "error.code must be 1-64 [A-Z0-9_]"),
    message: z
      .string()
      .min(1, "error.message must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "error.message must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_REPORT_ERROR_MESSAGE_BYTES,
        "error.message exceeds 2 KiB (UTF-8)",
      ),
  })
  .strict();

export const executorSchema = z
  .object({
    type: z
      .string()
      .min(1, "executor.type must be 1-64 [A-Za-z0-9_.-]")
      .max(64, "executor.type must be 1-64 [A-Za-z0-9_.-]")
      .regex(/^[A-Za-z0-9_.-]+$/, "executor.type must be 1-64 [A-Za-z0-9_.-]"),
    version: z
      .string()
      .min(1, "executor.version must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "executor.version must not be whitespace-only")
      .refine(
        (s) => utf8ByteLength(s) <= MAX_EXECUTOR_VERSION_BYTES,
        "executor.version exceeds 256 bytes (UTF-8)",
      ),
  })
  .strict();

export const executionReportSchema = z
  .object({
    schema_version: z.literal(2),
    execution_status: z.enum(EXECUTION_STATUSES),
    business_outcome: z.enum(BUSINESS_OUTCOMES),
    task_dispatched: z.boolean(),
    finished_at_ms: z
      .number()
      .int("finished_at_ms must be a nonnegative safe integer")
      .min(0, "finished_at_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "finished_at_ms must be a nonnegative safe integer"),
    duration_ms: z
      .number()
      .int("duration_ms must be a nonnegative safe integer")
      .min(0, "duration_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "duration_ms must be a nonnegative safe integer"),
    executor: executorSchema,
    receipt_sha256: sha256Hex,
    error: reportErrorSchema.nullable(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.execution_status === "COMPLETED" && val.error !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed report must not have error",
        path: ["error"],
      });
    }
    if (val.execution_status !== "COMPLETED" && val.error === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-completed report must include error",
        path: ["error"],
      });
    }
    if (!val.task_dispatched && val.business_outcome !== "NOT_STARTED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "undispatched task must have business_outcome NOT_STARTED",
        path: ["business_outcome"],
      });
    }
    if (val.business_outcome === "UNVERIFIED" && !val.task_dispatched) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unverified business outcome requires task_dispatched true",
        path: ["task_dispatched"],
      });
    }
  });

export const persistedExecutionReportSchema = z
  .object({
    schema_version: z.literal(2),
    execution_status: z.enum(EXECUTION_STATUSES),
    business_outcome: z.enum(BUSINESS_OUTCOMES),
    task_dispatched: z.boolean(),
    finished_at_ms: z
      .number()
      .int("finished_at_ms must be a nonnegative safe integer")
      .min(0, "finished_at_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "finished_at_ms must be a nonnegative safe integer"),
    duration_ms: z
      .number()
      .int("duration_ms must be a nonnegative safe integer")
      .min(0, "duration_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "duration_ms must be a nonnegative safe integer"),
    executor: executorSchema,
    receipt_sha256: sha256Hex,
    error: reportErrorSchema.nullable(),
    received_at_ms: z
      .number()
      .int("received_at_ms must be a nonnegative safe integer")
      .min(0, "received_at_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "received_at_ms must be a nonnegative safe integer"),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.execution_status === "COMPLETED" && val.error !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed report must not have error",
        path: ["error"],
      });
    }
    if (val.execution_status !== "COMPLETED" && val.error === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-completed report must include error",
        path: ["error"],
      });
    }
    if (!val.task_dispatched && val.business_outcome !== "NOT_STARTED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "undispatched task must have business_outcome NOT_STARTED",
        path: ["business_outcome"],
      });
    }
    if (val.business_outcome === "UNVERIFIED" && !val.task_dispatched) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unverified business outcome requires task_dispatched true",
        path: ["task_dispatched"],
      });
    }
  });

export const persistedJobResultSchema = z
  .object({
    target: z.literal("resource"),
    attempt_id: z
      .string()
      .regex(
        /^(?:att[_-])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "attempt_id must be a valid UUID or att_<uuid>",
      ),
    payload_sha256: sha256Hex,
    resource_id: z
      .string()
      .regex(
        /^res-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "resource_id must be a res-<uuid>",
      ),
    commit: z
      .string()
      .min(1, "commit must be non-empty")
      .refine((s) => !isWhitespaceOnly(s), "commit must not be whitespace-only"),
    received_at_ms: z
      .number()
      .int("received_at_ms must be a nonnegative safe integer")
      .min(0, "received_at_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "received_at_ms must be a nonnegative safe integer"),
  })
  .strict();

export function validatePersistedExecutionReport(raw: unknown): PersistedExecutionReport {
  const parsed = persistedExecutionReportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "Invalid execution report";
    throw new ExecutionContractError(`Invalid execution report: ${issue}`);
  }
  return parsed.data as PersistedExecutionReport;
}

export function validatePersistedJobResult(raw: unknown): PersistedJobResult {
  const parsed = persistedJobResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "Invalid job result";
    throw new ExecutionContractError(`Invalid job result: ${issue}`);
  }
  return parsed.data as PersistedJobResult;
}
