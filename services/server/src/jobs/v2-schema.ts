import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  type ResultTarget,
  type PersistedExecutionReport,
  type PersistedJobResult,
  validatePersistedExecutionReport,
  validatePersistedJobResult,
  isWhitespaceOnly,
  utf8ByteLength,
  ExecutionContractError,
} from "./execution-contract.js";

export {
  type ResultTarget,
  type PersistedExecutionReport,
  type PersistedJobResult,
  validatePersistedExecutionReport,
  validatePersistedJobResult,
  isWhitespaceOnly,
  utf8ByteLength,
  ExecutionContractError,
};

export const JOBS_V2_SCHEMA_VERSION = 6 as const;
export const ATTEMPT_V1_SCHEMA_VERSION = 1 as const;
export const STREAM_V2_SCHEMA_VERSION = 2 as const;

export const KEY_STREAM_V2 = "ceo:jobs:v2";
export const JOB_V2_PREFIX = "ceo:job:v2:";
export const ATTEMPT_V1_PREFIX = "ceo:attempt:v1:";

export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 7200;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_ACCEPTANCE_BYTES = 8 * 1024;
export const JOB_CLAIM_TTL_MS_V2 = 7 * 24 * 60 * 60 * 1000;

export const JOB_ID_V2_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REQUEST_ID_V2_RE = /^(?:req-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TARGET_ID_V2_RE = /^tgt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEVICE_ID_V2_RE = /^dev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TARGET_BINDING_ID_V2_RE = /^dtb_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ATTEMPT_ID_V2_RE = /^(?:att[_-])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RESOURCE_ID_V2_RE = /^res-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX_64_RE = /^[0-9a-f]{64}$/;
export const STREAM_ENTRY_ID_RE = /^\d+-\d+$/;

export function jobKeyV2(job_id: string): string {
  return `${JOB_V2_PREFIX}${job_id}`;
}

/**
 * 1:N Job -> Attempts ZSET index.
 * ZSET score: claimed_at_ms
 * ZSET member: attempt_id
 */
export function jobAttemptsKeyV1(job_id: string): string {
  return `${JOB_V2_PREFIX}${job_id}:attempts`;
}

export function attemptKeyV1(attempt_id: string): string {
  return `${ATTEMPT_V1_PREFIX}${attempt_id}`;
}

export function requestKeyV2(user_id: string, workspace_id: string, request_id: string): string {
  return `ceo:request:v2:${user_id}:${workspace_id}:${request_id}`;
}

export function targetQueueKeyV1(target_id: string): string {
  return `ceo:target:v1:${target_id}:jobs`;
}

export type JobRecordV2Status = "preparing" | "queued" | "active" | "terminal";
export type AttemptRecordV1Phase = "claimed" | "running" | "terminal";

export interface JobRecordV2 {
  schema_version: typeof JOBS_V2_SCHEMA_VERSION;
  job_id: string;
  request_id: string;
  user_id: string;
  workspace_id: string;
  target_id: string;
  prompt: string;
  acceptance: string;
  resource_id: string | null;
  execution_timeout_seconds: number;
  result_target: ResultTarget;
  request_digest: string;
  status: JobRecordV2Status;
  stream_entry_id: string | null;
  latest_attempt_id: string | null;
  created_at_ms: number;
  claim_deadline_ms: number;
}

export interface AttemptRecordV1 {
  schema_version: typeof ATTEMPT_V1_SCHEMA_VERSION;
  attempt_id: string;
  job_id: string;
  user_id: string;
  workspace_id: string;
  target_id: string;
  device_id: string;
  target_binding_id: string;
  claim_token_sha256: string;
  phase: AttemptRecordV1Phase;
  claimed_at_ms: number;
  started_at_ms: number | null;
  report?: PersistedExecutionReport;
  result?: PersistedJobResult;
}

export interface JobStreamEntryV2 {
  schema_version: typeof STREAM_V2_SCHEMA_VERSION;
  job_id: string;
  user_id: string;
  workspace_id: string;
  target_id: string;
  created_at_ms: number;
}

/**
 * Canonical digest over normalized business parameters for V2 jobs.
 * Uses target_id instead of legacy workspace_ref.
 */
export function businessDigestV2(p: {
  target_id: string;
  prompt: string;
  acceptance: string;
  resource_id: string | null;
  execution_timeout_seconds: number;
  result_target: ResultTarget;
}): string {
  const canonical = JSON.stringify({
    acceptance: p.acceptance,
    execution_timeout_seconds: p.execution_timeout_seconds,
    prompt: p.prompt,
    resource_id: p.resource_id,
    result_target: p.result_target,
    target_id: p.target_id,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class V2SchemaError extends ExecutionContractError {
  constructor(message: string) {
    super(message);
    this.name = "V2SchemaError";
  }
}

const ALLOWED_JOB_V2_KEYS = new Set([
  "schema_version",
  "job_id",
  "request_id",
  "user_id",
  "workspace_id",
  "target_id",
  "prompt",
  "acceptance",
  "resource_id",
  "execution_timeout_seconds",
  "result_target",
  "request_digest",
  "status",
  "stream_entry_id",
  "latest_attempt_id",
  "created_at_ms",
  "claim_deadline_ms",
]);

export function parseJobRecordV2(raw: unknown): JobRecordV2 {
  let obj: unknown;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new V2SchemaError(`Invalid job record JSON: ${(e as Error).message}`);
    }
  } else {
    obj = raw;
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new V2SchemaError("Invalid job record: expected an object.");
  }

  const rec = obj as Record<string, unknown>;

  // Reject forbidden or unknown fields
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_JOB_V2_KEYS.has(key)) {
      throw new V2SchemaError(`Invalid job record: forbidden or unknown field '${key}'.`);
    }
  }

  // Strict schema version check
  if (rec.schema_version !== JOBS_V2_SCHEMA_VERSION) {
    throw new V2SchemaError(
      `Unsupported schema_version '${rec.schema_version}'; expected ${JOBS_V2_SCHEMA_VERSION}.`,
    );
  }

  if (typeof rec.job_id !== "string" || !JOB_ID_V2_RE.test(rec.job_id)) {
    throw new V2SchemaError("Invalid job record: 'job_id' must be formatted as job-<uuid>.");
  }

  if (typeof rec.request_id !== "string" || !REQUEST_ID_V2_RE.test(rec.request_id)) {
    throw new V2SchemaError("Invalid job record: 'request_id' must be a valid UUID or req-<uuid>.");
  }

  if (typeof rec.user_id !== "string" || isWhitespaceOnly(rec.user_id) || rec.user_id.length > 128) {
    throw new V2SchemaError("Invalid job record: 'user_id' must be a non-empty string.");
  }

  if (typeof rec.workspace_id !== "string" || isWhitespaceOnly(rec.workspace_id) || rec.workspace_id.length > 128) {
    throw new V2SchemaError("Invalid job record: 'workspace_id' must be a non-empty string.");
  }

  if (typeof rec.target_id !== "string" || !TARGET_ID_V2_RE.test(rec.target_id)) {
    throw new V2SchemaError("Invalid job record: 'target_id' must be formatted as tgt_<uuid>.");
  }

  if (typeof rec.prompt !== "string" || isWhitespaceOnly(rec.prompt)) {
    throw new V2SchemaError("Invalid job record: 'prompt' must be non-empty and not whitespace-only.");
  }
  if (utf8ByteLength(rec.prompt) > MAX_PROMPT_BYTES) {
    throw new V2SchemaError(`Invalid job record: 'prompt' exceeds maximum byte limit of ${MAX_PROMPT_BYTES} bytes.`);
  }

  if (typeof rec.acceptance !== "string" || isWhitespaceOnly(rec.acceptance)) {
    throw new V2SchemaError("Invalid job record: 'acceptance' must be non-empty and not whitespace-only.");
  }
  if (utf8ByteLength(rec.acceptance) > MAX_ACCEPTANCE_BYTES) {
    throw new V2SchemaError(`Invalid job record: 'acceptance' exceeds maximum byte limit of ${MAX_ACCEPTANCE_BYTES} bytes.`);
  }

  if (rec.result_target !== "none" && rec.result_target !== "resource") {
    throw new V2SchemaError("Invalid job record: 'result_target' must be 'none' or 'resource'.");
  }

  if (rec.result_target === "resource") {
    if (typeof rec.resource_id !== "string" || !RESOURCE_ID_V2_RE.test(rec.resource_id)) {
      throw new V2SchemaError("Invalid job record: 'resource_id' (res-<uuid>) is required when result_target is 'resource'.");
    }
  } else {
    // result_target === "none": resource_id may be null or a valid res-<uuid>
    if (rec.resource_id !== null && rec.resource_id !== undefined) {
      if (typeof rec.resource_id !== "string" || !RESOURCE_ID_V2_RE.test(rec.resource_id)) {
        throw new V2SchemaError("Invalid job record: 'resource_id' must be null or a valid res-<uuid> when result_target is 'none'.");
      }
    }
  }

  if (
    typeof rec.execution_timeout_seconds !== "number" ||
    !Number.isInteger(rec.execution_timeout_seconds) ||
    rec.execution_timeout_seconds < MIN_TIMEOUT_SECONDS ||
    rec.execution_timeout_seconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new V2SchemaError(
      `Invalid job record: 'execution_timeout_seconds' must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`,
    );
  }

  if (typeof rec.request_digest !== "string" || !HEX_64_RE.test(rec.request_digest)) {
    throw new V2SchemaError("Invalid job record: 'request_digest' must be exactly 64 lowercase hex characters.");
  }

  const validStatuses: JobRecordV2Status[] = ["preparing", "queued", "active", "terminal"];
  if (!validStatuses.includes(rec.status as JobRecordV2Status)) {
    throw new V2SchemaError(`Invalid job record: unknown status '${rec.status}'.`);
  }

  if (
    typeof rec.created_at_ms !== "number" ||
    !Number.isInteger(rec.created_at_ms) ||
    rec.created_at_ms < 0 ||
    rec.created_at_ms > Number.MAX_SAFE_INTEGER
  ) {
    throw new V2SchemaError("Invalid job record: 'created_at_ms' must be a non-negative safe integer.");
  }

  if (
    typeof rec.claim_deadline_ms !== "number" ||
    !Number.isInteger(rec.claim_deadline_ms) ||
    rec.claim_deadline_ms <= rec.created_at_ms ||
    rec.claim_deadline_ms > Number.MAX_SAFE_INTEGER
  ) {
    throw new V2SchemaError("Invalid job record: 'claim_deadline_ms' must be a safe integer greater than created_at_ms.");
  }

  if (rec.stream_entry_id !== null && (typeof rec.stream_entry_id !== "string" || !STREAM_ENTRY_ID_RE.test(rec.stream_entry_id))) {
    throw new V2SchemaError("Invalid job record: 'stream_entry_id' must be null or a valid Redis stream entry ID (<ms>-<seq>).");
  }

  if (rec.latest_attempt_id !== null && (typeof rec.latest_attempt_id !== "string" || !ATTEMPT_ID_V2_RE.test(rec.latest_attempt_id))) {
    throw new V2SchemaError("Invalid job record: 'latest_attempt_id' must be null or a valid attempt ID.");
  }

  // Freeze state invariants:
  // preparing: stream_entry_id = null, latest_attempt_id = null
  if (rec.status === "preparing") {
    if (rec.stream_entry_id !== null || rec.latest_attempt_id !== null) {
      throw new V2SchemaError("Job in 'preparing' state must have stream_entry_id=null and latest_attempt_id=null.");
    }
  }

  // queued: stream_entry_id != null, latest_attempt_id = null
  if (rec.status === "queued") {
    if (rec.stream_entry_id === null) {
      throw new V2SchemaError("Job in 'queued' state must have non-null stream_entry_id.");
    }
    if (rec.latest_attempt_id !== null) {
      throw new V2SchemaError("Job in 'queued' state cannot have latest_attempt_id set.");
    }
  }

  // active: stream_entry_id != null, latest_attempt_id != null
  if (rec.status === "active") {
    if (rec.stream_entry_id === null) {
      throw new V2SchemaError("Job in 'active' state must have non-null stream_entry_id.");
    }
    if (rec.latest_attempt_id === null) {
      throw new V2SchemaError("Job in 'active' state must have non-null latest_attempt_id.");
    }
  }

  // terminal: stream_entry_id != null, latest_attempt_id != null
  if (rec.status === "terminal") {
    if (rec.stream_entry_id === null) {
      throw new V2SchemaError("Job in 'terminal' state must have non-null stream_entry_id.");
    }
    if (rec.latest_attempt_id === null) {
      throw new V2SchemaError("Job in 'terminal' state must have non-null latest_attempt_id.");
    }
  }

  return {
    schema_version: JOBS_V2_SCHEMA_VERSION,
    job_id: rec.job_id as string,
    request_id: rec.request_id as string,
    user_id: rec.user_id as string,
    workspace_id: rec.workspace_id as string,
    target_id: rec.target_id as string,
    prompt: rec.prompt as string,
    acceptance: rec.acceptance as string,
    resource_id: (rec.resource_id as string | null) ?? null,
    execution_timeout_seconds: rec.execution_timeout_seconds as number,
    result_target: rec.result_target as ResultTarget,
    request_digest: rec.request_digest as string,
    status: rec.status as JobRecordV2Status,
    stream_entry_id: (rec.stream_entry_id as string | null) ?? null,
    latest_attempt_id: (rec.latest_attempt_id as string | null) ?? null,
    created_at_ms: rec.created_at_ms as number,
    claim_deadline_ms: rec.claim_deadline_ms as number,
  };
}

export function serializeJobRecordV2(job: unknown): string {
  const validated = parseJobRecordV2(job);
  return JSON.stringify(validated);
}

const ALLOWED_ATTEMPT_V1_KEYS = new Set([
  "schema_version",
  "attempt_id",
  "job_id",
  "user_id",
  "workspace_id",
  "target_id",
  "device_id",
  "target_binding_id",
  "claim_token_sha256",
  "phase",
  "claimed_at_ms",
  "started_at_ms",
  "report",
  "result",
]);

export function parseAttemptRecordV1(raw: unknown): AttemptRecordV1 {
  let obj: unknown;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new V2SchemaError(`Invalid attempt record JSON: ${(e as Error).message}`);
    }
  } else {
    obj = raw;
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new V2SchemaError("Invalid attempt record: expected an object.");
  }

  const rec = obj as Record<string, unknown>;

  // Reject forbidden or unknown fields
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_ATTEMPT_V1_KEYS.has(key)) {
      throw new V2SchemaError(`Invalid attempt record: forbidden or unknown field '${key}'.`);
    }
  }

  if (rec.schema_version !== ATTEMPT_V1_SCHEMA_VERSION) {
    throw new V2SchemaError(
      `Unsupported attempt schema_version '${rec.schema_version}'; expected ${ATTEMPT_V1_SCHEMA_VERSION}.`,
    );
  }

  if (typeof rec.attempt_id !== "string" || !ATTEMPT_ID_V2_RE.test(rec.attempt_id)) {
    throw new V2SchemaError("Invalid attempt record: 'attempt_id' must be a valid attempt ID (att_<uuid> or UUID).");
  }

  if (typeof rec.job_id !== "string" || !JOB_ID_V2_RE.test(rec.job_id)) {
    throw new V2SchemaError("Invalid attempt record: 'job_id' must be formatted as job-<uuid>.");
  }

  if (typeof rec.user_id !== "string" || isWhitespaceOnly(rec.user_id) || rec.user_id.length > 128) {
    throw new V2SchemaError("Invalid attempt record: 'user_id' must be a non-empty string.");
  }

  if (typeof rec.workspace_id !== "string" || isWhitespaceOnly(rec.workspace_id) || rec.workspace_id.length > 128) {
    throw new V2SchemaError("Invalid attempt record: 'workspace_id' must be a non-empty string.");
  }

  if (typeof rec.target_id !== "string" || !TARGET_ID_V2_RE.test(rec.target_id)) {
    throw new V2SchemaError("Invalid attempt record: 'target_id' must be formatted as tgt_<uuid>.");
  }

  if (typeof rec.device_id !== "string" || !DEVICE_ID_V2_RE.test(rec.device_id)) {
    throw new V2SchemaError("Invalid attempt record: 'device_id' must be formatted as dev_<uuid>.");
  }

  if (typeof rec.target_binding_id !== "string" || !TARGET_BINDING_ID_V2_RE.test(rec.target_binding_id)) {
    throw new V2SchemaError("Invalid attempt record: 'target_binding_id' must be formatted as dtb_<uuid>.");
  }

  if (typeof rec.claim_token_sha256 !== "string" || !HEX_64_RE.test(rec.claim_token_sha256)) {
    throw new V2SchemaError("Invalid attempt record: 'claim_token_sha256' must be exactly 64 lowercase hex characters.");
  }

  const validPhases: AttemptRecordV1Phase[] = ["claimed", "running", "terminal"];
  if (!validPhases.includes(rec.phase as AttemptRecordV1Phase)) {
    throw new V2SchemaError(`Invalid attempt record: unknown phase '${rec.phase}'.`);
  }

  if (
    typeof rec.claimed_at_ms !== "number" ||
    !Number.isInteger(rec.claimed_at_ms) ||
    rec.claimed_at_ms < 0 ||
    rec.claimed_at_ms > Number.MAX_SAFE_INTEGER
  ) {
    throw new V2SchemaError("Invalid attempt record: 'claimed_at_ms' must be a non-negative safe integer.");
  }

  let validatedReport: PersistedExecutionReport | undefined;
  let validatedResult: PersistedJobResult | undefined;

  if (rec.phase === "claimed") {
    if (rec.started_at_ms !== null) {
      throw new V2SchemaError("Attempt in 'claimed' phase must have started_at_ms = null.");
    }
    if (rec.report !== undefined) {
      throw new V2SchemaError("Attempt in 'claimed' phase cannot have a report.");
    }
    if (rec.result !== undefined) {
      throw new V2SchemaError("Attempt in 'claimed' phase cannot have a result.");
    }
  } else if (rec.phase === "running") {
    if (
      typeof rec.started_at_ms !== "number" ||
      !Number.isInteger(rec.started_at_ms) ||
      rec.started_at_ms < rec.claimed_at_ms ||
      rec.started_at_ms > Number.MAX_SAFE_INTEGER
    ) {
      throw new V2SchemaError("Attempt in 'running' phase must have started_at_ms >= claimed_at_ms.");
    }
    if (rec.report !== undefined) {
      throw new V2SchemaError("Attempt in 'running' phase cannot have a report.");
    }
    if (rec.result !== undefined && rec.result !== null) {
      try {
        validatedResult = validatePersistedJobResult(rec.result);
      } catch (err) {
        throw new V2SchemaError(`Invalid attempt result: ${(err as Error).message}`);
      }
      if (validatedResult.attempt_id !== rec.attempt_id) {
        throw new V2SchemaError(
          `Result attempt_id '${validatedResult.attempt_id}' does not match attempt record attempt_id '${rec.attempt_id}'.`,
        );
      }
    }
  } else {
    // terminal
    if (rec.report === undefined || rec.report === null) {
      throw new V2SchemaError("Attempt in 'terminal' phase requires a valid execution report.");
    }
    try {
      validatedReport = validatePersistedExecutionReport(rec.report);
    } catch (err) {
      throw new V2SchemaError(`Invalid attempt report: ${(err as Error).message}`);
    }

    if (validatedReport.task_dispatched) {
      // task_dispatched = true: started_at_ms MUST exist and be >= claimed_at_ms
      if (
        typeof rec.started_at_ms !== "number" ||
        !Number.isInteger(rec.started_at_ms) ||
        rec.started_at_ms < rec.claimed_at_ms ||
        rec.started_at_ms > Number.MAX_SAFE_INTEGER
      ) {
        throw new V2SchemaError(
          "Dispatched terminal attempt requires started_at_ms >= claimed_at_ms.",
        );
      }
      if (rec.result !== undefined && rec.result !== null) {
        try {
          validatedResult = validatePersistedJobResult(rec.result);
        } catch (err) {
          throw new V2SchemaError(`Invalid attempt result: ${(err as Error).message}`);
        }
        if (validatedResult.attempt_id !== rec.attempt_id) {
          throw new V2SchemaError(
            `Result attempt_id '${validatedResult.attempt_id}' does not match attempt record attempt_id '${rec.attempt_id}'.`,
          );
        }
      }
    } else {
      // task_dispatched = false: started_at_ms MAY be null
      if (rec.started_at_ms !== null) {
        if (
          typeof rec.started_at_ms !== "number" ||
          !Number.isInteger(rec.started_at_ms) ||
          rec.started_at_ms < rec.claimed_at_ms ||
          rec.started_at_ms > Number.MAX_SAFE_INTEGER
        ) {
          throw new V2SchemaError(
            "Undispatched terminal attempt with started_at_ms requires started_at_ms >= claimed_at_ms.",
          );
        }
      }
      // Undispatched task cannot have a result
      if (rec.result !== undefined && rec.result !== null) {
        throw new V2SchemaError(
          "Undispatched terminal attempt cannot have a result.",
        );
      }
    }
  }

  return {
    schema_version: ATTEMPT_V1_SCHEMA_VERSION,
    attempt_id: rec.attempt_id as string,
    job_id: rec.job_id as string,
    user_id: rec.user_id as string,
    workspace_id: rec.workspace_id as string,
    target_id: rec.target_id as string,
    device_id: rec.device_id as string,
    target_binding_id: rec.target_binding_id as string,
    claim_token_sha256: rec.claim_token_sha256 as string,
    phase: rec.phase as AttemptRecordV1Phase,
    claimed_at_ms: rec.claimed_at_ms as number,
    started_at_ms: (rec.started_at_ms as number | null) ?? null,
    ...(validatedReport ? { report: validatedReport } : {}),
    ...(validatedResult ? { result: validatedResult } : {}),
  };
}

export function serializeAttemptRecordV1(attempt: unknown): string {
  const validated = parseAttemptRecordV1(attempt);
  return JSON.stringify(validated);
}

const ALLOWED_STREAM_V2_KEYS = new Set([
  "schema_version",
  "job_id",
  "user_id",
  "workspace_id",
  "target_id",
  "created_at_ms",
]);

export function validateStreamEntryV2(raw: unknown): JobStreamEntryV2 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new V2SchemaError("Invalid stream entry: expected an object.");
  }
  const rec = raw as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_STREAM_V2_KEYS.has(k)) {
      throw new V2SchemaError(`Invalid stream entry: forbidden or unknown field '${k}'.`);
    }
  }

  const ver = typeof rec.schema_version === "string" ? Number(rec.schema_version) : rec.schema_version;
  if (ver !== STREAM_V2_SCHEMA_VERSION) {
    throw new V2SchemaError(`Unsupported stream entry schema_version '${rec.schema_version}'; expected ${STREAM_V2_SCHEMA_VERSION}.`);
  }

  if (typeof rec.job_id !== "string" || !JOB_ID_V2_RE.test(rec.job_id)) {
    throw new V2SchemaError("Invalid stream entry: 'job_id' must be formatted as job-<uuid>.");
  }
  if (typeof rec.user_id !== "string" || isWhitespaceOnly(rec.user_id) || rec.user_id.length > 128) {
    throw new V2SchemaError("Invalid stream entry: 'user_id' must be a non-empty string.");
  }
  if (typeof rec.workspace_id !== "string" || isWhitespaceOnly(rec.workspace_id) || rec.workspace_id.length > 128) {
    throw new V2SchemaError("Invalid stream entry: 'workspace_id' must be a non-empty string.");
  }
  if (typeof rec.target_id !== "string" || !TARGET_ID_V2_RE.test(rec.target_id)) {
    throw new V2SchemaError("Invalid stream entry: 'target_id' must be formatted as tgt_<uuid>.");
  }

  const createdAt = typeof rec.created_at_ms === "string" ? Number(rec.created_at_ms) : rec.created_at_ms;
  if (
    typeof createdAt !== "number" ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > Number.MAX_SAFE_INTEGER
  ) {
    throw new V2SchemaError("Invalid stream entry: 'created_at_ms' must be a valid integer timestamp.");
  }

  return {
    schema_version: STREAM_V2_SCHEMA_VERSION,
    job_id: rec.job_id as string,
    user_id: rec.user_id as string,
    workspace_id: rec.workspace_id as string,
    target_id: rec.target_id as string,
    created_at_ms: createdAt,
  };
}

export function serializeStreamEntryV2(entry: unknown): Record<string, string> {
  const validated = validateStreamEntryV2(entry);
  return {
    schema_version: String(validated.schema_version),
    job_id: validated.job_id,
    user_id: validated.user_id,
    workspace_id: validated.workspace_id,
    target_id: validated.target_id,
    created_at_ms: String(validated.created_at_ms),
  };
}

export function parseStreamEntryV2(fields: Record<string, string>): JobStreamEntryV2 {
  return validateStreamEntryV2(fields);
}

export const MAX_MANAGED_RESULT_BYTES = 64 * 1024;

export const managedResultEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: z.string().regex(JOB_ID_V2_RE, "Invalid job_id format"),
    attempt_id: z.string().regex(ATTEMPT_ID_V2_RE, "Invalid attempt_id format"),
    resource_id: z.string().regex(RESOURCE_ID_V2_RE, "Invalid resource_id format"),
    summary: z
      .string()
      .min(1, "summary cannot be empty")
      .refine((s) => !isWhitespaceOnly(s), "summary cannot be whitespace"),
    operations: z.array(z.record(z.string(), z.unknown())).min(1, "operations cannot be empty"),
  })
  .strict();

export type ManagedResultEnvelope = z.infer<typeof managedResultEnvelopeSchema>;

export const jobResultRequestSchema = z
  .object({
    attempt_id: z.string().regex(ATTEMPT_ID_V2_RE, "Invalid attempt_id format"),
    claim_token: z.string().min(1, "claim_token is required"),
    result: managedResultEnvelopeSchema,
    payload_sha256: z.string().regex(HEX_64_RE, "payload_sha256 must be 64 lowercase hex chars"),
  })
  .strict();

export type JobResultRequest = z.infer<typeof jobResultRequestSchema>;

export const jobResultResponseSchema = z
  .object({
    ok: z.literal(true),
    replayed: z.boolean(),
    server_time: z.string(),
    resource_id: z.string(),
    commit: z.string(),
  })
  .strict();

export type JobResultResponse = z.infer<typeof jobResultResponseSchema>;
