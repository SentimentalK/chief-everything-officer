import {
  businessDigest,
  makeJobId,
  utcIsoFromMs,
  parseSubmit,
  parseJobGet,
  CLAIM_TTL_MS,
  JOBS_SCHEMA_VERSION,
  type NormalizedSubmit,
  type JobRequest,
  type PersistedJobRecord,
} from "./schema.js";
import { RedisJobStore } from "./redis-store.js";

/** Trusted, already-authenticated identity. Never accepted from the payload. */
export interface JobAuthScope {
  user_id: string;
  workspace_id: string;
}

export type JobErrorCode =
  | "INVALID_INPUT"
  | "BRIDGE_DISABLED"
  | "QUEUE_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_NOT_FOUND"
  | "RESOURCE_NOT_FOUND"
  | "INCOMPLETE_SUBMISSION";

export class JobError extends Error {
  constructor(
    public readonly code: JobErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "JobError";
  }
}

export type JobState = "queued" | "expired";

export interface JobView {
  ok: true;
  job_id: string;
  state: JobState;
  created_at: string;
  expires_at: string;
  workspace_ref: string;
  resource_id: string | null;
  replayed: boolean;
}

export interface SubmitResult {
  ok: boolean;
  view?: JobView;
  code?: JobErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

export interface JobServiceDeps {
  store: RedisJobStore;
  /** Existence check for a resource_id within the calling workspace (only for NEW tasks). */
  resourceExists?: (scope: JobAuthScope, resourceId: string) => Promise<boolean>;
  nowMs?: () => number;
}

function effectiveState(rec: PersistedJobRecord, now: number): JobState {
  // Deadline is a CLAIM deadline, not a delete TTL. Records/dedupe are retained.
  if (rec.status !== "queued" || !rec.stream_entry_id) {
    // Incomplete submissions are never surfaced as jobs; handled by caller.
    throw new JobError("JOB_NOT_FOUND", "Unknown job.");
  }
  return now >= rec.claim_deadline_ms ? "expired" : "queued";
}

function toView(rec: PersistedJobRecord, replayed: boolean, now: number): JobView {
  return {
    ok: true,
    job_id: rec.job_id,
    state: effectiveState(rec, now),
    created_at: utcIsoFromMs(rec.created_at_ms),
    expires_at: utcIsoFromMs(rec.claim_deadline_ms),
    workspace_ref: rec.workspace_ref,
    resource_id: rec.resource_id,
    replayed,
  };
}

export class JobService {
  constructor(
    private readonly deps: JobServiceDeps,
    private readonly enabled: () => boolean,
  ) {}

  /** True when the bridge is enabled AND the shared Redis is reachable. */
  available(): boolean {
    return this.enabled() && this.deps.store.isReady();
  }

  private assertAvailable(): void {
    if (!this.enabled()) throw new JobError("BRIDGE_DISABLED", "Job submission is disabled on this deployment.");
    if (!this.deps.store.isReady()) throw new JobError("QUEUE_UNAVAILABLE", "Queue backend is not available.");
  }

  private assertSelf(scope: JobAuthScope): void {
    if (!scope?.user_id || !scope?.workspace_id) {
      throw new JobError("INVALID_INPUT", "Missing identity context; refusing to fall back to a default user.");
    }
  }

  async submit(scope: JobAuthScope, raw: unknown): Promise<SubmitResult> {
    this.assertSelf(scope);
    const parsed = parseSubmit(raw);
    if (!parsed.ok) {
      return err(parsed.reason, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();

    // Existing request first (dedupe/replay or explicit conflict), so a retry
    // of a completed request is not blocked by a later resource deletion.
    const existing = await this.readExistingFull(scope, input);
    switch (existing.kind) {
      case "none":
        break;
      case "conflict":
        throw new JobError("IDEMPOTENCY_CONFLICT", "Request ID reused with different content.");
      case "replay":
        return { ok: true, view: toView(existing.rec, true, (this.deps.nowMs ?? Date.now)()) };
      case "incomplete":
        throw new JobError("INCOMPLETE_SUBMISSION", "Queue received an incomplete prior submission.", {
          job_id: existing.jobId,
          reason: "INCOMPLETE_SUBMISSION",
        });
      default:
        break;
    }

    // New task: validate optional resource exists in this user's workspace.
    if (input.resource_id && this.deps.resourceExists) {
      const okRes = await this.deps.resourceExists(scope, input.resource_id);
      if (!okRes) throw new JobError("RESOURCE_NOT_FOUND", "Referenced resource not found in this workspace.");
    }

    const now = (this.deps.nowMs ?? Date.now)();
    const digest = businessDigest({
      workspace_ref: input.workspace_ref,
      prompt: input.prompt,
      acceptance: input.acceptance,
      resource_id: input.resource_id,
      execution_timeout_seconds: input.execution_timeout_seconds,
    });
    const jobId = makeJobId();
    const prepared: PersistedJobRecord = {
      schema_version: JOBS_SCHEMA_VERSION,
      job_id: jobId,
      request_id: input.request_id,
      user_id: scope.user_id,
      workspace_id: scope.workspace_id,
      workspace_ref: input.workspace_ref,
      resource_id: input.resource_id,
      prompt: input.prompt,
      acceptance: input.acceptance,
      execution_timeout_seconds: input.execution_timeout_seconds,
      request_digest: digest,
      status: "preparing",
      stream_entry_id: null,
      created_at_ms: now,
      claim_deadline_ms: now + CLAIM_TTL_MS,
    };

    let decision;
    try {
      decision = await this.deps.store.submit(scope, input.request_id, prepared);
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError("QUEUE_UNAVAILABLE", "Queue backend failed during submission.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (decision === "CONFLICT") {
      throw new JobError("IDEMPOTENCY_CONFLICT", "Request ID reused with different content.");
    }
    if (decision === "INCOMPLETE") {
      throw new JobError("INCOMPLETE_SUBMISSION", "Queue received an incomplete prior submission.", {
        job_id: jobId,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }

    // NEW: we created our own job. REPLAY: a concurrent winner created theirs
    // between our placeholder-read and our atomic submit, so resolve by request.
    let recOrNull: PersistedJobRecord | null = null;
    if (decision === "NEW") {
      recOrNull = await this.deps.store.getJob(jobId);
    } else {
      const phAfter = await this.deps.store.getPlaceholder(scope, input.request_id);
      recOrNull = phAfter ? await this.deps.store.getJob(phAfter.job_id) : null;
    }
    if (!recOrNull) {
      throw new JobError("QUEUE_UNAVAILABLE", "Queue backend could not confirm the written job.");
    }
    if (recOrNull.user_id !== scope.user_id || recOrNull.workspace_id !== scope.workspace_id) {
      throw new JobError("QUEUE_UNAVAILABLE", "Queue bound job to an unexpected identity.");
    }
    const replayed = decision === "REPLAY";
    return { ok: true, view: toView(recOrNull, replayed, (this.deps.nowMs ?? Date.now)()) };
  }

  async get(scope: JobAuthScope, raw: unknown): Promise<SubmitResult> {
    this.assertSelf(scope);
    const parsed = parseJobGet(raw);
    if (!parsed.ok) {
      return err(parsed.reason, parsed.issue);
    }
    const request: JobRequest = parsed.value;
    // Missing, unknown, or not owned -> uniform JOB_NOT_FOUND.
    const rec = await this.deps.store.getJob(request.job_id);
    if (!rec) throw new JobError("JOB_NOT_FOUND", "Job not found.");
    if (rec.user_id !== scope.user_id || rec.workspace_id !== scope.workspace_id) {
      throw new JobError("JOB_NOT_FOUND", "Job not found.");
    }
    // Own identity but the record is still preparing -> incomplete submission.
    if (rec.status !== "queued") {
      throw new JobError("INCOMPLETE_SUBMISSION", "This job record is incomplete and not yet queued.", {
        job_id: request.job_id,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }
    if (!rec.stream_entry_id) {
      throw new JobError("INCOMPLETE_SUBMISSION", "This job record is incomplete and not yet queued.", {
        job_id: request.job_id,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }
    return { ok: true, view: toView(rec, false, (this.deps.nowMs ?? Date.now)()) };
  }

  private async readExistingFull(
    scope: JobAuthScope,
    input: NormalizedSubmit,
  ): Promise<
    | { kind: "conflict" }
    | { kind: "replay"; rec: PersistedJobRecord }
    | { kind: "incomplete"; jobId: string | undefined }
    | { kind: "none" }
  > {
    const ph = await this.deps.store.getPlaceholder(scope, input.request_id);
    if (!ph) return { kind: "none" };
    const rec = await this.deps.store.getJob(ph.job_id);
    const digest = businessDigest({
      workspace_ref: input.workspace_ref,
      prompt: input.prompt,
      acceptance: input.acceptance,
      resource_id: input.resource_id,
      execution_timeout_seconds: input.execution_timeout_seconds,
    });
    if (rec && rec.request_digest !== digest) return { kind: "conflict" };
    if (!rec || rec.status !== "queued" || !rec.stream_entry_id) {
      return { kind: "incomplete", jobId: ph.job_id };
    }
    return { kind: "replay", rec };
  }
}

function err(code: string, message: string): SubmitResult {
  return { ok: false, code: code as JobErrorCode, message };
}
