import { randomUUID, createHash } from "node:crypto";

export const JOBS_SCHEMA_VERSION = 1;
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

export interface PersistedJobRecord {
  schema_version: number;
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
