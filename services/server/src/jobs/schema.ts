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

export function unknownFieldCheck(raw: unknown, allowedKeys: string[]) {
  if (raw !== null && typeof raw === "object") {
    const extra = Object.keys(raw as Record<string, unknown>).filter((k) => !allowedKeys.includes(k));
    if (extra.length > 0) return extra;
  }
  return [];
}

export function parseSubmit(raw: unknown): ParseOutcome<NormalizedSubmit> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issue: "input must be an object", reason: "INVALID_INPUT" };
  }
  const allowed = ["request_id", "workspace_ref", "prompt", "acceptance", "resource_id", "timeout_seconds"];
  const extra = unknownFieldCheck(raw, allowed);
  if (extra.length > 0) {
    return { ok: false, issue: `unexpected field(s): ${extra.join(", ")}`, reason: "INVALID_INPUT" };
  }
  const r = raw as Record<string, unknown>;

  const request_id = r.request_id;
  if (typeof request_id !== "string" || !REQUEST_ID_RE.test(request_id)) {
    return { ok: false, issue: "request_id must be a UUID", reason: "INVALID_INPUT" };
  }

  const workspace_ref = r.workspace_ref;
  if (typeof workspace_ref !== "string" || !WORKSPACE_REF_RE.test(workspace_ref)) {
    return { ok: false, issue: "workspace_ref must be 1-64 [A-Za-z0-9_-]", reason: "INVALID_INPUT" };
  }

  const prompt = r.prompt;
  if (typeof prompt !== "string" || isWhitespaceOnly(prompt)) {
    return { ok: false, issue: "prompt must be a non-empty, non-whitespace string", reason: "INVALID_INPUT" };
  }
  if (utf8ByteLength(prompt) > MAX_PROMPT_BYTES) {
    return { ok: false, issue: "prompt exceeds 64 KiB (UTF-8)", reason: "INVALID_INPUT" };
  }

  const acceptance = r.acceptance;
  if (typeof acceptance !== "string" || isWhitespaceOnly(acceptance)) {
    return { ok: false, issue: "acceptance must be a non-empty, non-whitespace string", reason: "INVALID_INPUT" };
  }
  if (utf8ByteLength(acceptance) > MAX_ACCEPTANCE_BYTES) {
    return { ok: false, issue: "acceptance exceeds 8 KiB (UTF-8)", reason: "INVALID_INPUT" };
  }

  let resource_id: string | null = null;
  if (r.resource_id !== undefined) {
    if (typeof r.resource_id !== "string" || !RESOURCE_ID_RE.test(r.resource_id)) {
      return { ok: false, issue: "resource_id must be a res-<uuid>", reason: "INVALID_INPUT" };
    }
    resource_id = r.resource_id;
  }

  let timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
  if (r.timeout_seconds !== undefined) {
    if (typeof r.timeout_seconds !== "number" || !Number.isInteger(r.timeout_seconds)) {
      return { ok: false, issue: "timeout_seconds must be an integer", reason: "INVALID_INPUT" };
    }
    if (r.timeout_seconds < MIN_TIMEOUT_SECONDS || r.timeout_seconds > MAX_TIMEOUT_SECONDS) {
      return { ok: false, issue: `timeout_seconds must be ${MIN_TIMEOUT_SECONDS}..${MAX_TIMEOUT_SECONDS}`, reason: "INVALID_INPUT" };
    }
    timeout_seconds = r.timeout_seconds;
  }

  return {
    ok: true,
    value: {
      request_id,
      workspace_ref,
      prompt,
      acceptance,
      resource_id,
      execution_timeout_seconds: timeout_seconds,
    },
  };
}

export function parseJobGet(raw: unknown): ParseOutcome<JobRequest> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issue: "input must be an object", reason: "INVALID_INPUT" };
  }
  const extra = unknownFieldCheck(raw, ["job_id"]);
  if (extra.length > 0) {
    return { ok: false, issue: `unexpected field(s): ${extra.join(", ")}`, reason: "INVALID_INPUT" };
  }
  const job_id = (raw as Record<string, unknown>).job_id;
  if (typeof job_id !== "string" || !JOB_ID_RE.test(job_id)) {
    return { ok: false, issue: "job_id must be a job-<uuid>", reason: "INVALID_INPUT" };
  }
  return { ok: true, value: { job_id } };
}
