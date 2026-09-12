import { createHash } from "node:crypto";
import {
  businessDigest,
  makeJobId,
  utcIsoFromMs,
  parseSubmit,
  parseJobGet,
  parseClaim,
  parseStart,
  parsePendingQuery,
  CLAIM_TTL_MS,
  JOBS_SCHEMA_VERSION,
  JOB_STREAM_SCHEMA_VERSION,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_BUDGET_MS,
  JOB_ID_RE,
  type NormalizedSubmit,
  type JobRequest,
  type PersistedJobRecord,
  type JobAssignment,
  type JobState,
  type PendingJobsResult,
  type PendingJob,
} from "./schema.js";
import {
  type ExecutionAssignmentView,
  type AssignmentScriptResult,
} from "./assignment-schema.js";
import { RedisJobStore, StoreError } from "./redis-store.js";

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
  | "ASSIGNMENT_MISMATCH"
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

export { type ExecutionAssignmentView } from "./assignment-schema.js";

export interface JobView {
  ok: true;
  job_id: string;
  state: JobState;
  created_at: string;
  expires_at: string;
  workspace_ref: string;
  resource_id: string | null;
  replayed: boolean;
  execution: ExecutionAssignmentView | null;
}

export interface SubmitResult {
  ok: boolean;
  view?: JobView;
  code?: JobErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ClaimJobInfo {
  job_id: string;
  workspace_ref: string;
  resource_id: string | null;
  prompt: string;
  acceptance: string;
  timeout_seconds: number;
}

export type AssignmentResult =
  | { ok: true; replayed: boolean; server_time: string; execution: ExecutionAssignmentView; job?: ClaimJobInfo }
  | { ok: false; code?: JobErrorCode; message?: string; reason?: string | null };

export interface JobServiceDeps {
  store: RedisJobStore;
  /** Existence check for a resource_id within the calling workspace (only for NEW tasks). */
  resourceExists?: (scope: JobAuthScope, resourceId: string) => Promise<boolean>;
}

function iso(ms: number): string {
  return utcIsoFromMs(ms);
}

function executionAssignmentView(ex: JobAssignment | null | undefined): ExecutionAssignmentView | null {
  if (!ex) return null;
  return {
    worker_id: ex.worker_id,
    attempt_id: ex.attempt_id,
    phase: ex.phase,
    claimed_at: iso(ex.claimed_at_ms),
    started_at: ex.started_at_ms == null ? null : iso(ex.started_at_ms),
  };
}

function viewFromAssignment(res: Extract<AssignmentScriptResult, { ok: true }>, replayed: boolean): JobView {
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
    execution: executionAssignmentView(rec.execution),
  };
}

/** Map a Lua assignment error into a JobError with an explicit, stable message. */
function assignmentToError(res: Extract<AssignmentScriptResult, { ok: false }>): JobError {
  const code = res.code as JobErrorCode;
  const reason = res.reason;
  const details = reason ? { reason } : {};
  const msg = (m: string) => new JobError(code, m, details);
  switch (code) {
    case "JOB_NOT_FOUND":
      return msg("Job not found.");
    case "JOB_EXPIRED":
      return msg("Job is past its seven-day claim window.");
    case "JOB_ALREADY_CLAIMED":
      return msg("Job already claimed by another attempt.");
    case "IDEMPOTENCY_CONFLICT":
      return msg("Attempt reused with different credentials.");
    case "JOB_NOT_CLAIMED":
      return msg("Job is not claimed.");
    case "ASSIGNMENT_MISMATCH":
      return msg("Execution credentials do not match.");
    case "WORKSPACE_MISMATCH":
      return msg("Workspace does not match the job.");
    case "QUEUE_UNAVAILABLE":
      return msg(queueErrorMessage(reason));
    default:
      return msg(queueErrorMessage(reason));
  }
}

function queueErrorMessage(reason: string | null): string {
  if (reason === "INCOMPLETE_SUBMISSION") {
    return "This job record is incomplete and not yet queued.";
  }
  if (reason === "CORRUPT_RECORD") {
    return "Queue record is corrupt.";
  }
  if (reason === "UNSUPPORTED_SCHEMA_VERSION") {
    return "Job record schema version is not supported by this server.";
  }
  return "Queue backend is not available.";
}

/** Constructor options for testability: a monotonic clock and/or a discovery
 *  budget override. Production keeps the real `performance.now()` clock and the
 *  DISCOVERY_BUDGET_MS default. These are internal seams only - no env var or
 *  CLI switch. */
export interface JobServiceOptions {
  /** Monotonic milliseconds clock for per-request discovery budgets. */
  nowMs?: () => number;
  /** Per-request discovery budget in the same units as `nowMs`. */
  discoveryBudgetMs?: number;
}

/**
 * A per-request discovery deadline expressed in monotonic milliseconds. It is
 * both the internal checkpoints' source of truth AND the signal the outer
 * wall-clock deadline uses to stop the page loop (no further Redis reads are
 * scheduled after cancel). Deadline comparisons use `>=`.
 */
class DiscoveryBudget {
  readonly deadlineMs: number;
  cancelled = false;
  constructor(
    private readonly now: () => number,
    private readonly budgetMs: number,
  ) {
    this.deadlineMs = now() + budgetMs;
  }
  /** Throws QUEUE_UNAVAILABLE once the deadline has been reached or cancelled. */
  ensure(step: string): void {
    if (this.cancelled || this.now() >= this.deadlineMs) {
      throw new JobError("QUEUE_UNAVAILABLE", `Discovery budget exceeded (${step}).`);
    }
  }
  cancel(): void {
    this.cancelled = true;
  }
}

export class JobService {
  private readonly nowMs: () => number;
  private readonly discoveryBudgetMs: number;

  constructor(
    private readonly deps: JobServiceDeps,
    private readonly enabled: () => boolean,
    options: JobServiceOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS;
  }

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

  /** Single source of truth for building a JobView: always via the assignment inspect. */
  private async inspectView(scope: JobAuthScope, jobId: string, replayed: boolean): Promise<JobView> {
    let res: AssignmentScriptResult;
    try {
      res = await this.deps.store.inspectAssignment(scope, jobId);
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw assignmentToError(res);
    return viewFromAssignment(res, replayed);
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

  /** sha256 hex of the raw claim token (the only form stored/compared). */
  private static hashClaimToken(claimToken: string): string {
    return createHash("sha256").update(claimToken, "utf8").digest("hex");
  }

  async claim(scope: JobAuthScope, jobId: string, raw: unknown): Promise<AssignmentResult> {
    this.assertSelf(scope);
    const parsed = parseClaim(raw);
    if (!parsed.ok) {
      return assignmentErr(parsed.reason as JobErrorCode, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();
    let res: AssignmentScriptResult;
    try {
      res = await this.deps.store.claimAssignment(scope, jobId, {
        worker_id: input.worker_id,
        attempt_id: input.attempt_id,
        workspace_ref: input.workspace_ref,
        claim_token_sha256: JobService.hashClaimToken(input.claim_token),
      });
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw assignmentToError(res);
    const ex = res.record.execution;
    if (!ex) throw new JobError("QUEUE_UNAVAILABLE", "Claim did not attach an execution record.");
    const view = executionAssignmentView(ex);
    if (!view) throw new JobError("QUEUE_UNAVAILABLE", "Claim did not attach an execution record.");
    const rec = res.record;
    return {
      ok: true,
      replayed: res.replayed,
      server_time: iso(res.server_time_ms),
      execution: view,
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

  async start(scope: JobAuthScope, jobId: string, raw: unknown): Promise<AssignmentResult> {
    this.assertSelf(scope);
    const parsed = parseStart(raw);
    if (!parsed.ok) {
      return assignmentErr(parsed.reason as JobErrorCode, parsed.issue);
    }
    const input = parsed.value;
    this.assertAvailable();
    let res: AssignmentScriptResult;
    try {
      res = await this.deps.store.startAssignment(scope, jobId, {
        worker_id: input.worker_id,
        attempt_id: input.attempt_id,
        claim_token_sha256: JobService.hashClaimToken(input.claim_token),
      });
    } catch (error) {
      throw wrapStore(error);
    }
    if (!res.ok) throw assignmentToError(res);
    const ex = res.record.execution;
    if (!ex) throw new JobError("QUEUE_UNAVAILABLE", "Start did not produce an execution record.");
    const view = executionAssignmentView(ex);
    if (!view) throw new JobError("QUEUE_UNAVAILABLE", "Start did not produce an execution record.");
    return {
      ok: true,
      replayed: res.replayed,
      server_time: iso(res.server_time_ms),
      execution: view,
    };
  }

  /**
   * Task discovery: read a bounded window of committed stream entries after an
   * exclusive cursor, then return those belonging to THIS identity/workspace_ref
   * whose authoritative state (via the shared assignment inspect, Redis TIME) is
   * still "queued". Only read-only queries happen; claim ownership is decided
   * later by the atomic claim. Records are never mutated or re-queued.
   *
   * The whole page runs against ONE monotonic deadline (default 5000 ms) that
   * covers the initial XRANGE, every inspect, and result assembly. Internal
   * checkpoints stop scheduling further work once the deadline is reached, and
   * an outer wall-clock deadline guarantees the caller never waits longer than
   * the budget even if a single Redis command overshoots. No background loop
   * keeps scanning after the deadline.
   */
  async pending(scope: JobAuthScope, rawQuery: unknown): Promise<PendingJobsResult> {
    this.assertSelf(scope);
    const parsed = parsePendingQuery(rawQuery);
    if (!parsed.ok) {
      throw new JobError("INVALID_INPUT", parsed.issue);
    }
    const query = parsed.value;
    this.assertAvailable();

    const budget = new DiscoveryBudget(this.nowMs, this.discoveryBudgetMs);

    const work = (async (): Promise<PendingJobsResult> => {
      const jobs: PendingJob[] = [];
      const diag = (reason: string, entryId: string | null, jobId: string | null): void => {
        // Only ever reached for entries already identified as owned/corrupt, so no
        // other-identity job details leak. job_id is emitted only in valid form.
        const out: Record<string, unknown> = {
          event: "discovery_skip",
          reason,
          entry_id: entryId,
          job_id: jobId && JOB_ID_RE.test(jobId) ? jobId : null,
          user_id: scope.user_id,
          workspace_id: scope.workspace_id,
        };
        process.stderr.write(`jobs-discovery ${JSON.stringify(out)}\n`);
      };

      // (1) Before XRANGE.
      budget.ensure("start");
      let entries;
      try {
        entries = await this.deps.store.readStreamEntries(query.after, DISCOVERY_PAGE_SIZE);
      } catch (error) {
        throw wrapStore(error);
      }
      // (2) After XRANGE returned.
      budget.ensure("after stream read");

      for (const entry of entries) {
        const f = entry.fields;
        const jobId = f.job_id;
        const entryUser = f.user_id;
        const entryWs = f.workspace_id;
        // Other identity: skip without reading a JobRecord and without logging.
        if (typeof entryUser === "string" && typeof entryWs === "string") {
          if (entryUser !== scope.user_id || entryWs !== scope.workspace_id) continue;
        }
        // Owned (or unidentifiable) entry must still be structurally valid.
        if (f.schema_version !== String(JOB_STREAM_SCHEMA_VERSION) || typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
          diag("ENTRY_MALFORMED", entry.id, typeof jobId === "string" ? jobId : null);
          continue;
        }
        // (3) Before each inspect.
        budget.ensure(`inspect ${jobId}`);
        let res: AssignmentScriptResult;
        try {
          res = await this.deps.store.inspectAssignment(scope, jobId);
        } catch (error) {
          // Transport/timeout is an infrastructure fault -> fail the whole page.
          throw wrapStore(error);
        }
        // (4) After each inspect returned.
        budget.ensure(`after inspect ${jobId}`);
        if (!res.ok) {
          // Per-record data problems: corrupt record, incomplete submission, or a
          // record that is not owned after all -> skip, never return as a candidate.
          diag(
            res.code === "JOB_NOT_FOUND" ? "RECORD_MISSING" : res.reason ?? "RECORD_INVALID",
            entry.id,
            jobId,
          );
          continue;
        }
        const rec = res.record;
        // The record's committed stream entry must be THIS entry (association).
        if (rec.stream_entry_id !== entry.id) {
          diag("ENTRY_RECORD_MISMATCH", entry.id, jobId);
          continue;
        }
        if (res.state !== "queued" || rec.workspace_ref !== query.workspace_ref) continue;
        jobs.push({
          job_id: rec.job_id,
          workspace_ref: rec.workspace_ref,
          resource_id: rec.resource_id,
          created_at: iso(rec.created_at_ms),
          expires_at: iso(rec.claim_deadline_ms),
        });
      }

      // (5) Immediately before returning a success result.
      budget.ensure("before returning success");
      const last = entries.length > 0 ? entries[entries.length - 1]!.id : query.after;
      return {
        ok: true,
        jobs,
        next_cursor: last,
        has_more: entries.length === DISCOVERY_PAGE_SIZE,
      };
    })();

    // Outer wall-clock deadline: even if one in-flight Redis command overshoots
    // the per-request budget, the caller never waits longer than it. Firing it
    // also cancels the page loop so no further inspect is scheduled.
    let timer: NodeJS.Timeout | undefined;
    const deadlineGuard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        budget.cancel();
        reject(new JobError("QUEUE_UNAVAILABLE", "Discovery budget exceeded."));
      }, this.discoveryBudgetMs);
    });
    try {
      return await Promise.race([work, deadlineGuard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function err(code: string, message: string): SubmitResult {
  return { ok: false, code: code as JobErrorCode, message };
}

function assignmentErr(code: JobErrorCode, message: string): AssignmentResult {
  return { ok: false, code, message };
}

const PUBLIC_STORE_REASONS = new Set([
  "INVALID_SCRIPT_RESPONSE",
  "CORRUPT_RECORD",
  "CORRUPT_PLACEHOLDER",
]);

function wrapStore(error: unknown): JobError {
  if (error instanceof JobError) return error;
  const reason =
    error instanceof StoreError &&
    typeof error.details.reason === "string" &&
    PUBLIC_STORE_REASONS.has(error.details.reason)
      ? error.details.reason
      : undefined;
  return new JobError(
    "QUEUE_UNAVAILABLE",
    "Queue backend is not available.",
    reason ? { reason } : {},
  );
}
