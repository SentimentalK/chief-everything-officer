import { createHash } from "node:crypto";
import type { PersistedExecutionReport } from "./report-schema.js";
import type { PersistedJobResult, ResultTarget } from "./schema.js";

export const JOBS_V2_SCHEMA_VERSION = 6 as const;
export const ATTEMPT_V1_SCHEMA_VERSION = 1 as const;
export const STREAM_V2_SCHEMA_VERSION = 2 as const;

export const KEY_STREAM_V2 = "ceo:jobs:v2";
export const JOB_V2_PREFIX = "ceo:job:v2:";
export const ATTEMPT_V1_PREFIX = "ceo:attempt:v1:";

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

export class V2SchemaError extends Error {}

export function serializeJobRecordV2(job: JobRecordV2): string {
  return JSON.stringify(job);
}

export function parseJobRecordV2(raw: unknown): JobRecordV2 {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== "object") {
    throw new V2SchemaError("Invalid job record: expected an object.");
  }

  const rec = obj as Record<string, unknown>;

  // Strict schema version check
  if (rec.schema_version !== JOBS_V2_SCHEMA_VERSION) {
    throw new V2SchemaError(
      `Unsupported schema_version '${rec.schema_version}'; expected ${JOBS_V2_SCHEMA_VERSION}.`,
    );
  }

  // Reject forbidden legacy fields
  if ("workspace_ref" in rec) {
    throw new V2SchemaError("Invalid V2 job record: 'workspace_ref' is forbidden in V2 schema.");
  }
  if ("execution" in rec) {
    throw new V2SchemaError("Invalid V2 job record: embedded 'execution' is forbidden in V2 schema.");
  }
  if ("worker_id" in rec) {
    throw new V2SchemaError("Invalid V2 job record: 'worker_id' is forbidden in V2 schema.");
  }

  const requiredStrings = ["job_id", "request_id", "user_id", "workspace_id", "target_id", "prompt", "acceptance", "request_digest"];
  for (const field of requiredStrings) {
    if (typeof rec[field] !== "string" || (rec[field] as string).length === 0) {
      throw new V2SchemaError(`Invalid job record: '${field}' must be a non-empty string.`);
    }
  }

  if (rec.resource_id !== null && typeof rec.resource_id !== "string") {
    throw new V2SchemaError("Invalid job record: 'resource_id' must be a string or null.");
  }

  if (!Number.isInteger(rec.execution_timeout_seconds) || (rec.execution_timeout_seconds as number) <= 0) {
    throw new V2SchemaError("Invalid job record: 'execution_timeout_seconds' must be a positive integer.");
  }

  if (rec.result_target !== "none" && rec.result_target !== "resource") {
    throw new V2SchemaError("Invalid job record: 'result_target' must be 'none' or 'resource'.");
  }

  const validStatuses: JobRecordV2Status[] = ["preparing", "queued", "active", "terminal"];
  if (!validStatuses.includes(rec.status as JobRecordV2Status)) {
    throw new V2SchemaError(`Invalid job record: unknown status '${rec.status}'.`);
  }

  if (rec.stream_entry_id !== null && typeof rec.stream_entry_id !== "string") {
    throw new V2SchemaError("Invalid job record: 'stream_entry_id' must be a string or null.");
  }

  if (rec.latest_attempt_id !== null && typeof rec.latest_attempt_id !== "string") {
    throw new V2SchemaError("Invalid job record: 'latest_attempt_id' must be a string or null.");
  }

  if (!Number.isInteger(rec.created_at_ms) || (rec.created_at_ms as number) < 0) {
    throw new V2SchemaError("Invalid job record: 'created_at_ms' must be a non-negative integer.");
  }

  if (!Number.isInteger(rec.claim_deadline_ms) || (rec.claim_deadline_ms as number) <= (rec.created_at_ms as number)) {
    throw new V2SchemaError("Invalid job record: 'claim_deadline_ms' must be > created_at_ms.");
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

export function serializeAttemptRecordV1(attempt: AttemptRecordV1): string {
  return JSON.stringify(attempt);
}

export function parseAttemptRecordV1(raw: unknown): AttemptRecordV1 {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== "object") {
    throw new V2SchemaError("Invalid attempt record: expected an object.");
  }

  const rec = obj as Record<string, unknown>;

  if (rec.schema_version !== ATTEMPT_V1_SCHEMA_VERSION) {
    throw new V2SchemaError(
      `Unsupported attempt schema_version '${rec.schema_version}'; expected ${ATTEMPT_V1_SCHEMA_VERSION}.`,
    );
  }

  const requiredStrings = [
    "attempt_id",
    "job_id",
    "user_id",
    "workspace_id",
    "target_id",
    "device_id",
    "target_binding_id",
    "claim_token_sha256",
  ];
  for (const field of requiredStrings) {
    if (typeof rec[field] !== "string" || (rec[field] as string).length === 0) {
      throw new V2SchemaError(`Invalid attempt record: '${field}' must be a non-empty string.`);
    }
  }

  const validPhases: AttemptRecordV1Phase[] = ["claimed", "running", "terminal"];
  if (!validPhases.includes(rec.phase as AttemptRecordV1Phase)) {
    throw new V2SchemaError(`Invalid attempt record: unknown phase '${rec.phase}'.`);
  }

  if (!Number.isInteger(rec.claimed_at_ms) || (rec.claimed_at_ms as number) < 0) {
    throw new V2SchemaError("Invalid attempt record: 'claimed_at_ms' must be a non-negative integer.");
  }

  if (rec.started_at_ms !== null && (!Number.isInteger(rec.started_at_ms) || (rec.started_at_ms as number) < 0)) {
    throw new V2SchemaError("Invalid attempt record: 'started_at_ms' must be a non-negative integer or null.");
  }

  // Phase-specific report requirements:
  // On terminal, report is required.
  // On claimed or running, report must be absent.
  if (rec.phase === "terminal") {
    if (!rec.report || typeof rec.report !== "object") {
      throw new V2SchemaError("Attempt in 'terminal' phase requires a valid execution report.");
    }
  } else {
    if (rec.report !== undefined && rec.report !== null) {
      throw new V2SchemaError(`Attempt in '${rec.phase}' phase cannot have a report.`);
    }
  }

  // Note: result is optional even when phase === 'terminal' (execution completion != business result).

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
    report: rec.report as PersistedExecutionReport | undefined,
    result: rec.result as PersistedJobResult | undefined,
  };
}

export function serializeStreamEntryV2(entry: JobStreamEntryV2): Record<string, string> {
  return {
    schema_version: String(entry.schema_version),
    job_id: entry.job_id,
    user_id: entry.user_id,
    workspace_id: entry.workspace_id,
    target_id: entry.target_id,
    created_at_ms: String(entry.created_at_ms),
  };
}

export function parseStreamEntryV2(fields: Record<string, string>): JobStreamEntryV2 {
  if (fields.schema_version !== String(STREAM_V2_SCHEMA_VERSION)) {
    throw new V2SchemaError(
      `Unsupported stream entry schema_version '${fields.schema_version}'; expected ${STREAM_V2_SCHEMA_VERSION}.`,
    );
  }

  const required = ["job_id", "user_id", "workspace_id", "target_id", "created_at_ms"];
  for (const f of required) {
    if (!fields[f] || fields[f].length === 0) {
      throw new V2SchemaError(`Invalid stream entry: missing or empty '${f}'.`);
    }
  }

  const createdAt = Number(fields.created_at_ms);
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    throw new V2SchemaError("Invalid stream entry: 'created_at_ms' must be a valid integer timestamp.");
  }

  return {
    schema_version: STREAM_V2_SCHEMA_VERSION,
    job_id: fields.job_id!,
    user_id: fields.user_id!,
    workspace_id: fields.workspace_id!,
    target_id: fields.target_id!,
    created_at_ms: createdAt,
  };
}
