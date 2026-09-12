import * as z from "zod/v4";
import {
  ATTEMPT_ID_RE,
  CLAIM_TOKEN_RE,
  WORKER_ID_RE,
  isWhitespaceOnly,
  utf8ByteLength,
  type ParseOutcome,
} from "./schema.js";

export const REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_REPORT_REQUEST_BYTES = 8 * 1024;
export const MAX_REPORT_ERROR_MESSAGE_BYTES = 2 * 1024;

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

export interface ExecutionReport {
  schema_version: 1;
  execution_status: ExecutionStatus;
  business_outcome: BusinessOutcome;
  finished_at_ms: number;
  receipt_sha256: string;
  error: ExecutionReportError | null;
}

export interface PersistedExecutionReport extends ExecutionReport {
  received_at_ms: number;
}

export interface ExecutionReportView {
  schema_version: 1;
  execution_status: ExecutionStatus;
  business_outcome: BusinessOutcome;
  finished_at_ms: number;
  receipt_sha256: string;
  error: ExecutionReportError | null;
  received_at: string;
}

export interface NormalizedReportRequest {
  worker_id: string;
  attempt_id: string;
  claim_token: string;
  report: ExecutionReport;
}

const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "receipt_sha256 must be 64 lowercase hex chars");

const reportErrorSchema = z
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

export const executionReportSchema = z
  .object({
    schema_version: z.literal(1),
    execution_status: z.enum(EXECUTION_STATUSES),
    business_outcome: z.enum(BUSINESS_OUTCOMES),
    finished_at_ms: z
      .number()
      .int("finished_at_ms must be a nonnegative safe integer")
      .min(0, "finished_at_ms must be a nonnegative safe integer")
      .max(Number.MAX_SAFE_INTEGER, "finished_at_ms must be a nonnegative safe integer"),
    receipt_sha256: sha256Hex,
    error: reportErrorSchema.nullable(),
  })
  .strict();

export const workerReportSchema = z
  .object({
    worker_id: z.string().regex(WORKER_ID_RE, "worker_id must be a wrk-<uuid>"),
    attempt_id: z.string().regex(ATTEMPT_ID_RE, "attempt_id must be a UUID"),
    claim_token: z.string().regex(CLAIM_TOKEN_RE, "claim_token must be 64 lowercase hex chars"),
    report: executionReportSchema,
  })
  .strict();

function issueOf(parsed: { success: false; error: z.ZodError<unknown> }): string {
  const first = parsed.error.issues[0];
  return first ? first.message : "validation failed";
}

export function parseReport(raw: unknown): ParseOutcome<NormalizedReportRequest> {
  const parsed = workerReportSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issue: issueOf(parsed), reason: "INVALID_INPUT" };
  }
  const normalized: NormalizedReportRequest = {
    worker_id: parsed.data.worker_id,
    attempt_id: parsed.data.attempt_id,
    claim_token: parsed.data.claim_token,
    report: parsed.data.report,
  };
  if (utf8ByteLength(JSON.stringify(normalized)) > MAX_REPORT_REQUEST_BYTES) {
    return { ok: false, issue: "report request exceeds 8 KiB (UTF-8)", reason: "INVALID_INPUT" };
  }
  return { ok: true, value: normalized };
}
