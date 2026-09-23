import * as z from "zod/v4";
import {
  ATTEMPT_ID_RE,
  CLAIM_TOKEN_RE,
  WORKER_ID_RE,
  type ParseOutcome,
} from "./schema.js";
import {
  isWhitespaceOnly,
  utf8ByteLength,
  MAX_REPORT_ERROR_MESSAGE_BYTES,
  MAX_EXECUTOR_VERSION_BYTES,
  EXECUTION_STATUSES,
  BUSINESS_OUTCOMES,
  type ExecutionStatus,
  type BusinessOutcome,
  type ExecutionReportError,
  type ExecutionReportExecutor,
  type ExecutionReport,
  type PersistedExecutionReport,
  reportErrorSchema,
  executorSchema,
  executionReportSchema,
} from "./execution-contract.js";

export {
  MAX_REPORT_ERROR_MESSAGE_BYTES,
  MAX_EXECUTOR_VERSION_BYTES,
  EXECUTION_STATUSES,
  BUSINESS_OUTCOMES,
  type ExecutionStatus,
  type BusinessOutcome,
  type ExecutionReportError,
  type ExecutionReportExecutor,
  type ExecutionReport,
  type PersistedExecutionReport,
  reportErrorSchema,
  executorSchema,
  executionReportSchema,
};

export const REPORT_SCHEMA_VERSION = 2 as const;
export const MAX_REPORT_REQUEST_BYTES = 8 * 1024;

export interface ExecutionReportView {
  schema_version: 2;
  execution_status: ExecutionStatus;
  business_outcome: BusinessOutcome;
  task_dispatched: boolean;
  finished_at_ms: number;
  duration_ms: number;
  executor: ExecutionReportExecutor;
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
