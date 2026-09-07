import { createHash } from "node:crypto";
import {
  businessDigest,
  makeJobId,
  utcIsoFromMs,
  parseSubmit,
  parseJobGet,
  parseClaim,
  parseLeaseOperation,
  CLAIM_TTL_MS,
  JOBS_SCHEMA_VERSION,
  type NormalizedSubmit,
  type JobRequest,
  type PersistedJobRecord,
  type JobExecution,
  type JobState,
  type LeaseScriptResult,
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
  | "INCOMPLETE_SUBMISSION"
  | "JOB_EXPIRED"
  | "JOB_ALREADY_CLAIMED"
  | "JOB_NOT_CLAIMED"
  | "LEASE_MISMATCH"
  | "LEASE_EXPIRED"
  | "WORKSPACE_MISMATCH";

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

/** Get output execution sub-object (worker_get). No phase; reason on interrupt. */
export interface ExecutionGetView {
  worker_id: string;
  attempt_id: string;
  claimed_at: string;
  start_deadline: string;
  started_at: string | null;
  lease_expires_at: string;
  execution_deadline: string | null;
  reason: string | null;
}

export interface JobView {
  ok: true;
  job_id: string;
  state: JobState;
  created_at: string;
  expires_at: string;
  workspace_ref: string;
  resource_id: string | null;
  replayed: boolean;
  execution: ExecutionGetView | null;
}

export interface SubmitResult {
  ok: boolean;
  view?: JobView;
  code?: JobErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

/** Lease HTTP execution sub-object (claim/start/heartbeat). Includes phase. */
export interface ExecutionLeaseView {
  worker_id: string;
  attempt_id: string;
  phase: "claimed" | "running";
  claimed_at: string;
  start_deadline: string;
  started_at: string | null;
  lease_expires_at: string;
  execution_deadline: string | null;
}

export interface ClaimJobInfo {
  job_id: string;
  workspace_ref: string;
  resource_id: string | null;
  prompt: string;
  acceptance: string;
  timeout_seconds: number;
}

export type LeaseResult =
  | { ok: true; replayed: boolean; server_time: string; execution: ExecutionLeaseView; job?: ClaimJobInfo }
  | { ok: false; code?: JobErrorCode; message?: string; reason?: string | null };

export interface JobServiceDeps {
  store: RedisJobStore;
  /** Existence check for a resource_id within the calling workspace (only for NEW tasks). */
  resourceExists?: (scope: JobAuthScope, resourceId: string) => Promise<boolean>;
}

function iso(ms: number): string {
  return utcIsoFromMs(ms);
}

function executionGetView(rec: PersistedJobRecord, reason: string | null): ExecutionGetView | null {
  const ex = rec.execution;
  if (!ex) return null;
  return {
    worker_id: ex.worker_id,
    attempt_id: ex.attempt_id,
    claimed_at: iso(ex.claimed_at_ms),
    start_deadline: iso(ex.start_deadline_ms),
    started_at: ex.started_at_ms == null ? null : iso(ex.started_at_ms),
    lease_expires_at: iso(ex.lease_expires_at_ms),
    execution_deadline: ex.execution_deadline_ms == null ? null : iso(ex.execution_deadline_ms),
    reason,
  };
}

function executionLeaseView(ex: JobExecution): ExecutionLeaseView {
  return {
    worker_id: ex.worker_id,
    attempt_id: ex.attempt_id,
    phase: ex.phase,
    claimed_at: iso(ex.claimed_at_ms),
    start_deadline: iso(ex.start_deadline_ms),
    started_at: ex.started_at_ms == null ? null : iso(ex.started_at_ms),
    lease_expires_at: iso(ex.lease_expires_at_ms),
    execution_deadline: ex.execution_deadline_ms == null ? null : iso(ex.execution_deadline_ms),
  };
}

function viewFromLease(res: Extract<LeaseScriptResult, { ok: true }>, replayed: boolean): JobView {
  const rec = res.record;
  return {
    ok: true,
    job_id: rec.job_id,
    state: res.state,
    created_at: iso(rec.created_at_ms),
    expires_at: iso(rec.claim_deadline_ms),
    workspace_ref: rec.workspace_ref,
    resource_id: rec.resource_id,
    replayed,
    execution: executionGetView(rec, res.state === "interrupted" ? res.reason : null),
  };
}

/** Map a Lua lease error into a JobError with an explicit, stable message. */
function leaseToError(res: Extract<LeaseScriptResult, { ok: false }>): JobError {
  const code = res.code as JobErrorCode;
  const reason = res.reason;
  switch (code) {
    case "JOB_NOT_FOUND":
      return new JobError("JOB_NOT_FOUND", "Job not found.");
    case "JOB_EXPIRED":
      return new JobError("JOB_EXPIRED", "Job is past its seven-day claim window.");
    case "JOB_ALREADY_CLAIMED":
      return new JobError("JOB_ALREADY_CLAIMED", "Job already claimed by another attempt.");
    case "IDEMPOTENCY_CONFLICT":
      return new JobError("IDEMPOTENCY_CONFLICT", "Attempt reused with different credentials.");
    case "JOB_NOT_CLAIMED":
      return new JobError("JOB_NOT_CLAIMED", "Job is not claimed.");
    case "LEASE_MISMATCH":
      return new JobError("LEASE_MISMATCH", "Execution credentials do not match.");
    case "LEASE_EXPIRED":
      return new JobError("LEASE_EXPIRED", "Execution lease has expired.");
    case "WORKSPACE_MISMATCH":
      return new JobError("WORKSPACE_MISMATCH", "Workspace does not match the job.");
    case "QUEUE_UNAVAILABLE":
      return new JobError("QUEUE_UNAVAILABLE", incompleteQueueMessage(reason), {
        ...(reason ? { reason } : {}),
      });
    default:
      return new JobError("QUEUE_UNAVAILABLE", incompleteQueueMessage(reason), {
        ...(reason ? { reason } : {}),
      });
  }
}

function incompleteQueueMessage(reason: string | null): string {
  if (reason === "INCOMPLETE_SUBMISSION") {
    return "This job record is incomplete and not yet queued.";
  }
  if (reason === "CORRUPT_RECORD") {
    return "Queue record is corrupt.";
  }
  return "Queue backend is not available.";
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

  /** Single source of truth for building a JobView: always via the lease inspect. */
  private async inspectView(scope: JobAuthScope, jobId: string, replayed: boolean): Promise<JobView> {
    let res: LeaseScriptResult;
    try {
      res = await this.deps.store.inspect(scope, jobId);
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw leaseToError(res);
    return viewFromLease(res, replayed);
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
        return { ok: true, view: await this.inspectView(scope, existing.jobId, true) };
      case "incomplete":
        throw new JobError("QUEUE_UNAVAILABLE", "Queue received an incomplete prior submission.", {
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

    const now = Date.now();
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
      throw new JobError("QUEUE_UNAVAILABLE", "Queue received an incomplete prior submission.", {
        job_id: jobId,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }

    // NEW: we created our own job. REPLAY: a concurrent winner created theirs
    // between our placeholder-read and our atomic submit, so resolve by request.
    let resolvedJobId: string;
    if (decision === "NEW") {
      resolvedJobId = jobId;
    } else {
      const phAfter = await this.deps.store.getPlaceholder(scope, input.request_id);
      resolvedJobId = phAfter ? phAfter.job_id : jobId;
    }
    const replayed = decision === "REPLAY";
    try {
      return { ok: true, view: await this.inspectView(scope, resolvedJobId, replayed) };
    } catch (error) {
      if (error instanceof JobError && error.code === "JOB_NOT_FOUND") {
        throw new JobError("QUEUE_UNAVAILABLE", "Queue bound job to an unexpected identity.");
      }
      throw error;
    }
  }

  async get(scope: JobAuthScope, raw: unknown): Promise<SubmitResult> {
    this.assertSelf(scope);
    const parsed = parseJobGet(raw);
    if (!parsed.ok) {
      return err(parsed.reason, parsed.issue);
    }
    const request: JobRequest = parsed.value;
    this.assertAvailable();
    // Missing, unknown, or not owned -> uniform JOB_NOT_FOUND (from Lua inspect).
    const view = await this.inspectView(scope, request.job_id, false);
    return { ok: true, view };
  }

  private async readExistingFull(
    scope: JobAuthScope,
    input: NormalizedSubmit,
  ): Promise<
    | { kind: "conflict" }
    | { kind: "replay"; jobId: string }
    | { kind: "incomplete"; jobId: string | undefined }
    | { kind: "none" }
  > {
    const ph = await this.deps.store.getPlaceholder(scope, input.request_id);
    if (!ph) return { kind: "none" };
    let rec: PersistedJobRecord | null;
    try {
      rec = await this.deps.store.getJob(ph.job_id);
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError("QUEUE_UNAVAILABLE", "Queue bound job to an unexpected identity.", {
        job_id: ph.job_id,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }
    if (rec && (rec.user_id !== scope.user_id || rec.workspace_id !== scope.workspace_id)) {
      // The request placeholder under this scope references a job that is NOT
      // owned by this identity - corrupt/mismatched association. Never replay
      // or leak another identity's record.
      throw new JobError("QUEUE_UNAVAILABLE", "Queue bound job to an unexpected identity.", {
        job_id: ph.job_id,
        reason: "INCOMPLETE_SUBMISSION",
      });
    }
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
    return { kind: "replay", jobId: rec.job_id };
  }

  /** sha256 hex of the raw lease token (the only form stored/compared). */
  private static hashLeaseToken(leaseToken: string): string {
    return createHash("sha256").update(leaseToken, "utf8").digest("hex");
  }

  async claim(scope: JobAuthScope, jobId: string, raw: unknown): Promise<LeaseResult> {
    this.assertSelf(scope);
    const parsed = parseClaim(raw);
    if (!parsed.ok) {
      return leaseErr(parsed.reason as JobErrorCode, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();
    let res: LeaseScriptResult;
    try {
      res = await this.deps.store.claimLease(scope, jobId, {
        worker_id: input.worker_id,
        attempt_id: input.attempt_id,
        workspace_ref: input.workspace_ref,
        lease_token_sha256: JobService.hashLeaseToken(input.lease_token),
      });
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw leaseToError(res);
    const ex = res.record.execution;
    if (!ex) throw new JobError("QUEUE_UNAVAILABLE", "Claim did not attach an execution record.");
    const rec = res.record;
    return {
      ok: true,
      replayed: res.replayed,
      server_time: iso(res.server_time_ms),
      execution: executionLeaseView(ex),
      job: {
        job_id: rec.job_id,
        workspace_ref: rec.workspace_ref,
        resource_id: rec.resource_id,
        prompt: rec.prompt,
        acceptance: rec.acceptance,
        timeout_seconds: rec.execution_timeout_seconds,
      },
    };
  }

  async start(scope: JobAuthScope, jobId: string, raw: unknown): Promise<LeaseResult> {
    this.assertSelf(scope);
    const parsed = parseLeaseOperation(raw);
    if (!parsed.ok) {
      return leaseErr(parsed.reason as JobErrorCode, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();
    let res: LeaseScriptResult;
    try {
      res = await this.deps.store.startLease(scope, jobId, {
        worker_id: input.worker_id,
        attempt_id: input.attempt_id,
        lease_token_sha256: JobService.hashLeaseToken(input.lease_token),
      });
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw leaseToError(res);
    const ex = res.record.execution;
    if (!ex) throw new JobError("QUEUE_UNAVAILABLE", "Start did not produce an execution record.");
    return {
      ok: true,
      replayed: res.replayed,
      server_time: iso(res.server_time_ms),
      execution: executionLeaseView(ex),
    };
  }

  async heartbeat(scope: JobAuthScope, jobId: string, raw: unknown): Promise<LeaseResult> {
    this.assertSelf(scope);
    const parsed = parseLeaseOperation(raw);
    if (!parsed.ok) {
      return leaseErr(parsed.reason as JobErrorCode, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();
    let res: LeaseScriptResult;
    try {
      res = await this.deps.store.heartbeatLease(scope, jobId, {
        worker_id: input.worker_id,
        attempt_id: input.attempt_id,
        lease_token_sha256: JobService.hashLeaseToken(input.lease_token),
      });
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw leaseToError(res);
    const ex = res.record.execution;
    if (!ex) throw new JobError("QUEUE_UNAVAILABLE", "Heartbeat did not produce an execution record.");
    return {
      ok: true,
      replayed: false,
      server_time: iso(res.server_time_ms),
      execution: executionLeaseView(ex),
    };
  }
}

function err(code: string, message: string): SubmitResult {
  return { ok: false, code: code as JobErrorCode, message };
}

function leaseErr(code: JobErrorCode, message: string): LeaseResult {
  return { ok: false, code, message };
}

function wrapStore(error: unknown): JobError {
  if (error instanceof JobError) return error;
  return new JobError("QUEUE_UNAVAILABLE", "Queue backend is not available.", {
    error: error instanceof Error ? error.message : String(error),
  });
}
