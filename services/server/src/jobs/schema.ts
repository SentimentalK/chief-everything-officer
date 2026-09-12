import { randomUUID, createHash } from "node:crypto";
import type { JobAssignment, AssignmentState } from "./assignment-schema.js";
export type { JobAssignment, AssignmentState };

export const JOBS_SCHEMA_VERSION = 2 as const;
export const JOB_STREAM_SCHEMA_VERSION = 1 as const;
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 7200;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_ACCEPTANCE_BYTES = 8 * 1024;
export const WORKSPACE_REF_MAX = 64;
export const CLAIM_TTL_DAYS = 7;
export const CLAIM_TTL_MS = CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000;

export const KEY_STREAM = "ceo:jobs";
export const JOB_PREFIX = "ceo:job:";

export function requestKey(user_id: string, workspace_id: string, request_id: string): string {
  return `ceo:request:${user_id}:${workspace_id}:${request_id}`;
}
export function jobKey(job_id: string): string {
  return `${JOB_PREFIX}${job_id}`;
}

export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WORKSPACE_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const JOB_ID_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RESOURCE_ID_RE = /^res-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKER_ID_RE =
  /^wrk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ATTEMPT_ID_RE = REQUEST_ID_RE;
export const CLAIM_TOKEN_RE = /^[0-9a-f]{64}$/;

export function isWhitespaceOnly(s: string): boolean {
  return s.trim().length === 0;
}
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Public submit payload after strict parse + policy checks. */
export interface NormalizedSubmit {
  request_id: string;
  workspace_ref: string;
  prompt: string;
  acceptance: string;
  resource_id: string | null;
  execution_timeout_seconds: number;
}

export interface JobRequest {
  job_id: string;
}

export type JobRecordStatus = "queued";

/**
 * Derived execution/claim state surfaced to consumers.
 */
export type JobState = AssignmentState;

export interface PersistedJobRecord {
  schema_version: typeof JOBS_SCHEMA_VERSION;
  job_id: string;
  request_id: string;
  user_id: string;
  workspace_id: string;
  workspace_ref: string;
  resource_id: string | null;
  prompt: string;
  acceptance: string;
  execution_timeout_seconds: number;
  request_digest: string;
  // Authoritative commit marker, written last and atomically as one JSON value:
  // status === 'queued' AND stream_entry_id is set. A 'preparing' record (no
  // stream_entry_id) is an incomplete submission that is never returned as a
  // normal job nor executed by a consumer.
  status: "preparing" | "queued";
  stream_entry_id: string | null;
  created_at_ms: number;
  claim_deadline_ms: number;
  /** An absent execution field means unclaimed. An explicit null or malformed execution is invalid. */
  execution?: JobAssignment;
}

export interface RequestPlaceholder {
  job_id: string;
  request_digest: string;
}

export function makeJobId(): string {
  return `job-${randomUUID()}`;
}

/**
 * Canonical digest over normalized business parameters ONLY. Keys sorted so the
 * digest is stable regardless of authoring order. request_id is the dedupe key
 * and server time/ids are intentionally excluded.
 */
export function businessDigest(p: {
  workspace_ref: string;
  prompt: string;
  acceptance: string;
  resource_id: string | null;
  execution_timeout_seconds: number;
}): string {
  const canonical = JSON.stringify({
    acceptance: p.acceptance,
    execution_timeout_seconds: p.execution_timeout_seconds,
    prompt: p.prompt,
    resource_id: p.resource_id,
    workspace_ref: p.workspace_ref,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function utcIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issue: string; reason: string };

import * as z from "zod/v4";

export const workerSubmitSchema = z.object({
  request_id: z.string().regex(REQUEST_ID_RE, "request_id must be a UUID").describe("Client UUID; retries of the same logical task must reuse it."),
  workspace_ref: z.string().regex(WORKSPACE_REF_RE, "workspace_ref must be 1-64 [A-Za-z0-9_-]").describe("Preconfigured local directory alias (1-64 [A-Za-z0-9_-])."),
  prompt: z.string().min(1, "prompt must be non-empty").refine((s) => !isWhitespaceOnly(s), "prompt must not be whitespace-only").refine((s) => utf8ByteLength(s) <= MAX_PROMPT_BYTES, "prompt exceeds 64 KiB (UTF-8)").describe("Task instructions (non-empty, UTF-8 <= 64 KiB)."),
  acceptance: z.string().min(1, "acceptance must be non-empty").refine((s) => !isWhitespaceOnly(s), "acceptance must not be whitespace-only").refine((s) => utf8ByteLength(s) <= MAX_ACCEPTANCE_BYTES, "acceptance exceeds 8 KiB (UTF-8)").describe("Completion criterion (non-empty, UTF-8 <= 8 KiB)."),
  resource_id: z.string().regex(RESOURCE_ID_RE, "resource_id must be a res-<uuid>").optional().describe("Optional res-<uuid> that must already exist in your workspace."),
  timeout_seconds: z.number().int("timeout_seconds must be an integer").min(MIN_TIMEOUT_SECONDS, `timeout_seconds must be ${MIN_TIMEOUT_SECONDS}..${MAX_TIMEOUT_SECONDS}`).max(MAX_TIMEOUT_SECONDS, `timeout_seconds must be ${MIN_TIMEOUT_SECONDS}..${MAX_TIMEOUT_SECONDS}`).optional().describe("Execution timeout; 1800 default, 60-7200."),
}).strict();

export const workerGetSchema = z.object({
  job_id: z.string().regex(JOB_ID_RE, "job_id must be a job-<uuid>").describe("Canonical job identifier (job-<uuid>)."),
}).strict();

/**
 * Claim payload. Identity ownership is taken ONLY from the authenticated scope
 * (middleware), never from the body. The claim_token is client-generated so a
 * lost claim response can be safely retried with the original token.
 */
export const workerClaimSchema = z.object({
  worker_id: z.string().regex(WORKER_ID_RE, "worker_id must be a wrk-<uuid>"),
  attempt_id: z.string().regex(ATTEMPT_ID_RE, "attempt_id must be a UUID"),
  workspace_ref: z.string().regex(WORKSPACE_REF_RE, "workspace_ref must be 1-64 [A-Za-z0-9_-]"),
  claim_token: z.string().regex(CLAIM_TOKEN_RE, "claim_token must be 64 lowercase hex chars"),
}).strict();

export const workerStartSchema = z.object({
  worker_id: z.string().regex(WORKER_ID_RE, "worker_id must be a wrk-<uuid>"),
  attempt_id: z.string().regex(ATTEMPT_ID_RE, "attempt_id must be a UUID"),
  claim_token: z.string().regex(CLAIM_TOKEN_RE, "claim_token must be 64 lowercase hex chars"),
}).strict();

export function parseSubmit(raw: unknown): ParseOutcome<NormalizedSubmit> {
  const parsed = workerSubmitSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const issue = first ? first.message : "validation failed";
    return { ok: false, issue, reason: "INVALID_INPUT" };
  }
  const val = parsed.data;
  return {
    ok: true,
    value: {
      request_id: val.request_id,
      workspace_ref: val.workspace_ref,
      prompt: val.prompt,
      acceptance: val.acceptance,
      resource_id: val.resource_id ?? null,
      execution_timeout_seconds: val.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    },
  };
}

export function parseJobGet(raw: unknown): ParseOutcome<JobRequest> {
  const parsed = workerGetSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const issue = first ? first.message : "validation failed";
    return { ok: false, issue, reason: "INVALID_INPUT" };
  }
  return { ok: true, value: { job_id: parsed.data.job_id } };
}

export interface NormalizedClaim {
  worker_id: string;
  attempt_id: string;
  workspace_ref: string;
  claim_token: string;
}

export interface NormalizedStart {
  worker_id: string;
  attempt_id: string;
  claim_token: string;
}

function issueOf(parsed: { success: false; error: z.ZodError<unknown> }): string {
  const first = parsed.error.issues[0];
  return first ? first.message : "validation failed";
}

export function parseClaim(raw: unknown): ParseOutcome<NormalizedClaim> {
  const parsed = workerClaimSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issue: issueOf(parsed), reason: "INVALID_INPUT" };
  }
  return {
    ok: true,
    value: {
      worker_id: parsed.data.worker_id,
      attempt_id: parsed.data.attempt_id,
      workspace_ref: parsed.data.workspace_ref,
      claim_token: parsed.data.claim_token,
    },
  };
}

export function parseStart(raw: unknown): ParseOutcome<NormalizedStart> {
  const parsed = workerStartSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issue: issueOf(parsed), reason: "INVALID_INPUT" };
  }
  return {
    ok: true,
    value: {
      worker_id: parsed.data.worker_id,
      attempt_id: parsed.data.attempt_id,
      claim_token: parsed.data.claim_token,
    },
  };
}

// ---- Task discovery (GET /api/worker/jobs/pending) ----

export const DISCOVERY_PAGE_SIZE = 25;
export const DISCOVERY_BUDGET_MS = 5000;

/**
 * A Redis Stream ID is two unsigned 64-bit decimals ("<ms>-<seq>"). Parse each
 * half as a BigInt (never JavaScript Number, which loses precision) and confirm
 * it fits u64 so the value can be used as an exclusive XRANGE start.
 */
export function isValidStreamId(value: string): boolean {
  const m = /^([0-9]+)-([0-9]+)$/.exec(value);
  if (!m) return false;
  const ms = m[1];
  const seq = m[2];
  const max = BigInt("18446744073709551615"); // u64 max
  try {
    if (BigInt(ms!) > max || BigInt(seq!) > max) return false;
  } catch {
    return false;
  }
  return true;
}

export interface NormalizedPendingQuery {
  workspace_ref: string;
  after: string;
}

export interface PendingJob {
  job_id: string;
  workspace_ref: string;
  resource_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface PendingJobsResult {
  ok: true;
  jobs: PendingJob[];
  next_cursor: string;
  has_more: boolean;
}

export const workerPendingSchema = z.object({
  workspace_ref: z.string().regex(WORKSPACE_REF_RE, "workspace_ref must be 1-64 [A-Za-z0-9_-]"),
  after: z.string().optional().refine((v) => v === undefined || isValidStreamId(v), "after must be a Redis stream ID (two u64 decimal parts)"),
}).strict();

/** Raw query-object shape (express query). Rejects arrays/nesting via strict. */
export function parsePendingQuery(raw: unknown): ParseOutcome<NormalizedPendingQuery> {
  const parsed = workerPendingSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issue: issueOf(parsed), reason: "INVALID_INPUT" };
  }
  return {
    ok: true,
    value: {
      workspace_ref: parsed.data.workspace_ref,
      after: parsed.data.after ?? "0-0",
    },
  };
}
