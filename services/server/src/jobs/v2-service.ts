import crypto from "node:crypto";
import {
  type JobRecordV2,
  type AttemptRecordV1,
  type ResultTarget,
  JOBS_V2_SCHEMA_VERSION,
  JOB_CLAIM_TTL_MS_V2,
  businessDigestV2,
  ATTEMPT_ID_V2_RE,
  HEX_64_RE,
  REQUEST_ID_V2_RE,
  TARGET_ID_V2_RE,
  RESOURCE_ID_V2_RE,
  JOB_ID_V2_RE,
  STREAM_ENTRY_ID_RE,
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_PROMPT_BYTES,
  MAX_ACCEPTANCE_BYTES,
  utf8ByteLength,
  isWhitespaceOnly,
  validateStreamEntryV2,
  type ManagedResultEnvelope,
} from "./v2-schema.js";
import {
  type ExecutionReport,
  type ExecutionStatus,
  type BusinessOutcome,
  type PersistedJobResult,
  executionReportSchema,
} from "./execution-contract.js";
import {
  RedisJobStoreV2,
  V2JobNotFoundError,
  V2IdempotencyConflictError,
  V2ReportConflictError,
  V2AttemptLifecycleError,
  V2StoreError,
  V2CancelRaceError,
  type JobCancelOutcome,
} from "./v2-store.js";
import type {
  ConnectorControlStore,
} from "../connector/control-store.js";
import type { IdentityStore } from "../identity/store.js";
import type { ResourceService } from "../resource/service.js";
import { computeCanonicalSha256 } from "./canonical.js";
import { assertHostWorkspaceAccess } from "./tool-audit.js";

export type HostJobState = "queued" | "expired" | "claimed" | "running" | "terminal";

export interface ListJobsQuery {
  target_id?: string | null;
  state?: HostJobState | null;
  execution_status?: ExecutionStatus | null;
  limit?: number;
  cursor?: string | null;
}

/**
 * PROJECT-039: workspace-level Project deletion physically removes the
 * execution_targets row while historical Job records keep their historical
 * target_id. Historical jobs must therefore remain queryable after deletion:
 * when the Target row is gone, the record stays readable and the display
 * alias degrades to the historical target_id (never fabricated metadata).
 * A target row that EXISTS but mismatches the job remains corrupt state.
 */
export function resolveHostJobTargetAlias(
  controlStore: ConnectorControlStore,
  job: JobRecordV2,
): string {
  const target = controlStore.getExecutionTarget(job.target_id);
  if (!target) {
    return job.target_id;
  }
  if (target.id !== job.target_id || target.workspace_id !== job.workspace_id) {
    throw new V2StoreError(
      "QUEUE_UNAVAILABLE",
      `Job '${job.job_id}' references invalid execution target '${job.target_id}'.`,
      "CORRUPT_TARGET_STATE",
    );
  }
  return target.alias;
}

export interface HostJobSummary {
  job_id: string;
  request_id: string;
  target_id: string;
  target_alias: string;
  state: HostJobState;
  execution_status: ExecutionStatus | null;
  business_outcome: BusinessOutcome | null;
  created_at: string;
  expires_at: string | null;
  resource_id: string | null;
  result_target: ResultTarget;
}

export interface HostJobDetail extends HostJobSummary {
  execution_timeout_seconds: number;
  execution?: {
    attempt_id: string;
    phase: string;
    claimed_at: string;
    started_at: string | null;
  } | null;
  report?: {
    execution_status: ExecutionStatus;
    business_outcome: BusinessOutcome;
    task_dispatched: boolean;
    finished_at: string;
    duration_ms: number;
    executor: {
      type: string;
      version: string;
    };
    receipt_sha256: string;
    error: {
      stage: string;
      code: string;
      message: string;
    } | null;
    received_at: string;
  } | null;
  result?: {
    target: "resource";
    attempt_id: string;
    payload_sha256: string;
    resource_id: string;
    commit: string;
    received_at: string;
  } | null;
  task?: {
    prompt: string;
    acceptance: string;
    timeout_seconds: number;
  };
}

export const JOB_LIST_DEFAULT_LIMIT = 20;
export const JOB_LIST_MAX_LIMIT = 50;
export const JOB_LIST_SCAN_BATCH = 64;
export const JOB_LIST_MAX_SCANNED = 256;

export function deriveHostJobState(
  job: JobRecordV2,
  attempt: AttemptRecordV1 | null,
  nowMs: number,
): HostJobState {
  if (job.status === "preparing") {
    throw new V2StoreError(
      "QUEUE_UNAVAILABLE",
      `Job '${job.job_id}' is in preparing status.`,
      "CORRUPT_JOB_STATE",
    );
  }

  if (job.status === "queued") {
    return nowMs < job.claim_deadline_ms ? "queued" : "expired";
  }

  if (job.status === "active") {
    if (!attempt) {
      throw new V2StoreError(
        "QUEUE_UNAVAILABLE",
        `Active job '${job.job_id}' has no attempt record.`,
        "CORRUPT_JOB_STATE",
      );
    }
    if (attempt.phase === "claimed") return "claimed";
    if (attempt.phase === "running") return "running";
    throw new V2StoreError(
      "QUEUE_UNAVAILABLE",
      `Active job '${job.job_id}' has unexpected attempt phase '${attempt.phase}'.`,
      "CORRUPT_JOB_STATE",
    );
  }

  if (job.status === "terminal") {
    // Wave 2B: a job cancelled by an operator before any claim terminalizes
    // without an attempt; the durable cancel record carries the outcome.
    if (!attempt) {
      if (job.cancel) return "terminal";
      throw new V2StoreError(
        "QUEUE_UNAVAILABLE",
        `Terminal job '${job.job_id}' has no attempt record.`,
        "CORRUPT_JOB_STATE",
      );
    }
    if (attempt.phase === "terminal") return "terminal";
    throw new V2StoreError(
      "QUEUE_UNAVAILABLE",
      `Terminal job '${job.job_id}' has unexpected attempt phase '${attempt.phase}'.`,
      "CORRUPT_JOB_STATE",
    );
  }

  throw new V2StoreError(
    "QUEUE_UNAVAILABLE",
    `Job '${job.job_id}' has unrecognized status '${job.status}'.`,
    "CORRUPT_JOB_STATE",
  );
}

/**
 * Read-model execution status. Operator-cancelled jobs that never created an
 * attempt (cancel-before-claim) derive CANCELLED from the durable job cancel
 * record.
 */
export function jobExecutionStatusView(
  job: JobRecordV2,
  attempt: AttemptRecordV1 | null,
): ExecutionStatus | null {
  if (attempt?.report) return attempt.report.execution_status;
  if (job.cancel) return "CANCELLED";
  return null;
}

/**
 * Read-model business outcome; NOT_STARTED for cancel-before-claim jobs.
 */
export function jobBusinessOutcomeView(
  job: JobRecordV2,
  attempt: AttemptRecordV1 | null,
): BusinessOutcome | null {
  if (attempt?.report) return attempt.report.business_outcome;
  if (job.cancel) return "NOT_STARTED";
  return null;
}

export interface JobSubmitScopeV2 {
  user_id: string;
  workspace_id: string;
}

export interface SubmitJobInputV2 {
  request_id: string;
  target_id: string;
  prompt: string;
  acceptance: string;
  resource_id: string | null;
  execution_timeout_seconds: number;
  result_target: ResultTarget;
}

export interface PendingJobSummary {
  job_id: string;
  workspace_id: string;
  target_id: string;
  resource_id: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface ClaimJobResult {
  ok: true;
  replayed: boolean;
  server_time: string;
  attempt: {
    attempt_id: string;
    phase: string;
    claimed_at: string;
    started_at: string | null;
  };
  job: {
    job_id: string;
    workspace_id: string;
    target_id: string;
    resource_id: string | null;
    prompt: string;
    acceptance: string;
    timeout_seconds: number;
    result_target: ResultTarget;
  };
}

export interface StartJobResult {
  ok: true;
  replayed: boolean;
  server_time: string;
}

export interface ReportJobResult {
  ok: true;
  replayed: boolean;
  server_time: string;
}

/**
 * Typed device-scoped operator cancel outcome (Wave 2B).
 * action:
 * - cancelled: cancellation was newly applied by this request.
 * - already_cancelled: job was already operator-cancelled (idempotent replay).
 * - already_terminal: job finished with a non-cancelled outcome; history preserved.
 */
export interface JobCancelResult {
  job_id: string;
  previous_state: HostJobState;
  state: "terminal";
  execution_status: ExecutionStatus;
  business_outcome: BusinessOutcome;
  action: "cancelled" | "already_cancelled" | "already_terminal";
  attempt_id: string | null;
  message: string;
}

export const JOB_CANCEL_MAX_RACE_RETRIES = 3;

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

export class TargetNotFoundError extends Error {
  constructor(message = "Execution target not found or not in workspace.") {
    super(message);
    this.name = "TargetNotFoundError";
  }
}

export class TargetDisabledError extends Error {
  constructor(message = "Execution target is disabled.") {
    super(message);
    this.name = "TargetDisabledError";
  }
}

export class UserInactiveError extends Error {
  constructor(message = "User is not active.") {
    super(message);
    this.name = "UserInactiveError";
  }
}

export class WorkspaceMembershipError extends Error {
  constructor(message = "User is not a member of the workspace.") {
    super(message);
    this.name = "WorkspaceMembershipError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message = "Referenced resource does not exist.") {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export interface JobCoordinatorV2Deps {
  store: RedisJobStoreV2;
  controlStore: ConnectorControlStore;
  identityStore: IdentityStore;
  resourceService?:
    | ResourceService
    | ((workspaceId: string) => Promise<ResourceService> | ResourceService);
  resourceExists?: (
    scope: { userId: string; workspaceId: string },
    resourceId: string,
  ) => Promise<boolean> | boolean;
  nowMs?: () => number;
}

export class JobCoordinatorV2 {
  private readonly store: RedisJobStoreV2;
  private readonly controlStore: ConnectorControlStore;
  private readonly identityStore: IdentityStore;
  private readonly resourceService?:
    | ResourceService
    | ((workspaceId: string) => Promise<ResourceService> | ResourceService);
  private readonly resourceExists?: (
    scope: { userId: string; workspaceId: string },
    resourceId: string,
  ) => Promise<boolean> | boolean;
  private readonly nowMs: () => number;

  constructor(deps: JobCoordinatorV2Deps) {
    this.store = deps.store;
    this.controlStore = deps.controlStore;
    this.identityStore = deps.identityStore;
    this.resourceService = deps.resourceService;
    this.resourceExists = deps.resourceExists;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async checkExistingSubmission(
    scope: JobSubmitScopeV2,
    input: SubmitJobInputV2,
  ): Promise<JobRecordV2 | null> {
    assertHostWorkspaceAccess(this.identityStore, scope);

    // Validate request_id
    if (!input.request_id || !REQUEST_ID_V2_RE.test(input.request_id)) {
      throw new JobValidationError("Invalid request_id format.");
    }
    // Validate target_id
    if (!input.target_id || !TARGET_ID_V2_RE.test(input.target_id)) {
      throw new JobValidationError("Invalid target_id format.");
    }
    // Validate prompt
    if (typeof input.prompt !== "string" || isWhitespaceOnly(input.prompt)) {
      throw new JobValidationError("Prompt must not be empty or whitespace-only.");
    }
    if (utf8ByteLength(input.prompt) > MAX_PROMPT_BYTES) {
      throw new JobValidationError(`Prompt exceeds maximum byte limit of ${MAX_PROMPT_BYTES} bytes.`);
    }
    // Validate acceptance
    if (typeof input.acceptance !== "string" || isWhitespaceOnly(input.acceptance)) {
      throw new JobValidationError("Acceptance must not be empty or whitespace-only.");
    }
    if (utf8ByteLength(input.acceptance) > MAX_ACCEPTANCE_BYTES) {
      throw new JobValidationError(`Acceptance exceeds maximum byte limit of ${MAX_ACCEPTANCE_BYTES} bytes.`);
    }
    // Validate execution_timeout_seconds
    if (
      typeof input.execution_timeout_seconds !== "number" ||
      !Number.isInteger(input.execution_timeout_seconds) ||
      input.execution_timeout_seconds < MIN_TIMEOUT_SECONDS ||
      input.execution_timeout_seconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new JobValidationError(
        `execution_timeout_seconds must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`,
      );
    }
    // Validate result_target & resource_id
    if (input.result_target !== "none" && input.result_target !== "resource") {
      throw new JobValidationError("result_target must be 'none' or 'resource'.");
    }
    if (input.result_target === "resource") {
      if (!input.resource_id || !RESOURCE_ID_V2_RE.test(input.resource_id)) {
        throw new JobValidationError("resource_id is required when result_target is 'resource'.");
      }
    } else {
      if (input.resource_id !== null && input.resource_id !== undefined && !RESOURCE_ID_V2_RE.test(input.resource_id)) {
        throw new JobValidationError("resource_id must be null or valid res-<uuid>.");
      }
    }

    const digest = businessDigestV2({
      target_id: input.target_id,
      prompt: input.prompt,
      acceptance: input.acceptance,
      resource_id: input.resource_id ?? null,
      execution_timeout_seconds: input.execution_timeout_seconds,
      result_target: input.result_target,
    });

    // Idempotency lookup
    const existingJobId = await this.store.getRequestJobId(scope.user_id, scope.workspace_id, input.request_id);
    if (!existingJobId) {
      return null;
    }

    const existingJob = await this.store.getJob(existingJobId);
    if (!existingJob) {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Request placeholder references a missing Job.", "CORRUPT_SUBMISSION_REFERENCE");
    }
    if (
      existingJob.user_id !== scope.user_id ||
      existingJob.workspace_id !== scope.workspace_id ||
      existingJob.request_id !== input.request_id
    ) {
      throw new V2IdempotencyConflictError("Existing job identity mismatch.");
    }
    if (existingJob.status === "preparing") {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Previous submission with this request ID was incomplete.", "INCOMPLETE_SUBMISSION");
    }
    if (existingJob.request_digest === digest) {
      return existingJob;
    }
    throw new V2IdempotencyConflictError("Request digest mismatch with existing job.");
  }

  /**
   * Runs idempotency replay for Resource acquisition submissions BEFORE any
   * workspace default runtime target resolution. Looks up the existing Job for
   * the same request_id and validates that it expresses the same Resource
   * acquisition business request (resource_id, result_target, canonical
   * prompt/acceptance, and execution_timeout_seconds). The existing Job's
   * historical immutable target_id remains authoritative: current workspace
   * default target drift is deliberately ignored on replay. A materially
   * different business request surfaces the same idempotency conflict
   * semantics used by job_submit.
   */
  async checkExistingResourceAcquisitionSubmission(
    scope: JobSubmitScopeV2,
    input: {
      request_id: string;
      prompt: string;
      acceptance: string;
      resource_id: string;
      execution_timeout_seconds: number;
      result_target: "resource";
    },
  ): Promise<JobRecordV2 | null> {
    assertHostWorkspaceAccess(this.identityStore, scope);

    if (!input.request_id || !REQUEST_ID_V2_RE.test(input.request_id)) {
      throw new JobValidationError("Invalid request_id format.");
    }
    if (typeof input.prompt !== "string" || isWhitespaceOnly(input.prompt)) {
      throw new JobValidationError("Prompt must not be empty or whitespace-only.");
    }
    if (typeof input.acceptance !== "string" || isWhitespaceOnly(input.acceptance)) {
      throw new JobValidationError("Acceptance must not be empty or whitespace-only.");
    }
    if (
      typeof input.execution_timeout_seconds !== "number" ||
      !Number.isInteger(input.execution_timeout_seconds) ||
      input.execution_timeout_seconds < MIN_TIMEOUT_SECONDS ||
      input.execution_timeout_seconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new JobValidationError(
        `execution_timeout_seconds must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`,
      );
    }
    if (input.result_target !== "resource") {
      throw new JobValidationError("Resource acquisition replay requires result_target 'resource'.");
    }
    if (!input.resource_id || !RESOURCE_ID_V2_RE.test(input.resource_id)) {
      throw new JobValidationError("resource_id is required for resource acquisition replay.");
    }

    const existingJobId = await this.store.getRequestJobId(scope.user_id, scope.workspace_id, input.request_id);
    if (!existingJobId) {
      return null;
    }

    const existingJob = await this.store.getJob(existingJobId);
    if (!existingJob) {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Request placeholder references a missing Job.", "CORRUPT_SUBMISSION_REFERENCE");
    }
    if (
      existingJob.user_id !== scope.user_id ||
      existingJob.workspace_id !== scope.workspace_id ||
      existingJob.request_id !== input.request_id
    ) {
      throw new V2IdempotencyConflictError("Existing job identity mismatch.");
    }
    if (existingJob.status === "preparing") {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Previous submission with this request ID was incomplete.", "INCOMPLETE_SUBMISSION");
    }

    // Identical business request, ignoring target_id (historical immutable target
    // stays authoritative even if the workspace default target changed since).
    const sameBusiness =
      existingJob.result_target === "resource" &&
      existingJob.resource_id === input.resource_id &&
      existingJob.execution_timeout_seconds === input.execution_timeout_seconds &&
      existingJob.prompt === input.prompt &&
      existingJob.acceptance === input.acceptance;
    if (sameBusiness) {
      return existingJob;
    }
    throw new V2IdempotencyConflictError("Request digest mismatch with existing job.");
  }

  async submit(
    scope: JobSubmitScopeV2,
    input: SubmitJobInputV2,
  ): Promise<{ status: "created" | "replayed"; job: JobRecordV2 }> {
    // Step 1: Idempotency check with business digest validation
    const existing = await this.checkExistingSubmission(scope, input);
    if (existing) {
      return { status: "replayed", job: existing };
    }

    const digest = businessDigestV2({
      target_id: input.target_id,
      prompt: input.prompt,
      acceptance: input.acceptance,
      resource_id: input.resource_id ?? null,
      execution_timeout_seconds: input.execution_timeout_seconds,
      result_target: input.result_target,
    });

    // Step 2: Genuinely new job authorization
    const target = this.controlStore.getExecutionTarget(input.target_id);
    if (!target || target.workspace_id !== scope.workspace_id) {
      throw new TargetNotFoundError("ExecutionTarget not found or does not belong to the workspace.");
    }
    if (target.disabled_at_ms !== null) {
      throw new TargetDisabledError("ExecutionTarget is disabled.");
    }
    if (!this.identityStore.isUserActive(scope.user_id)) {
      throw new UserInactiveError("Submitting user is not active.");
    }
    const membership = this.identityStore.findWorkspaceMembership(scope.workspace_id, scope.user_id);
    if (!membership) {
      throw new WorkspaceMembershipError("Submitting user is not a member of the workspace.");
    }

    if (input.resource_id && this.resourceExists) {
      const exists = await this.resourceExists(
        { userId: scope.user_id, workspaceId: scope.workspace_id },
        input.resource_id,
      );
      if (!exists) {
        throw new ResourceNotFoundError(`Resource '${input.resource_id}' does not exist.`);
      }
    }

    // Step 3: Create Job
    const jobId = `job-${crypto.randomUUID()}`;
    const now = this.nowMs();
    const claimDeadlineMs = now + JOB_CLAIM_TTL_MS_V2;

    const jobRecord: JobRecordV2 = {
      schema_version: JOBS_V2_SCHEMA_VERSION,
      job_id: jobId,
      request_id: input.request_id,
      user_id: scope.user_id,
      workspace_id: scope.workspace_id,
      target_id: input.target_id,
      prompt: input.prompt,
      acceptance: input.acceptance,
      resource_id: input.resource_id ?? null,
      execution_timeout_seconds: input.execution_timeout_seconds,
      result_target: input.result_target,
      request_digest: digest,
      status: "preparing",
      stream_entry_id: null,
      latest_attempt_id: null,
      created_at_ms: now,
      claim_deadline_ms: claimDeadlineMs,
      cancel: null,
    };

    const res = await this.store.createJob(jobRecord, input.request_id);
    const finalJob = await this.store.getJob(res.job_id);
    if (!finalJob) {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Failed to retrieve job after creation.", "JOB_RETRIEVAL_FAILED");
    }

    return { status: res.status, job: finalJob };
  }

  async getPendingJobs(deviceId: string, limit = 20): Promise<PendingJobSummary[]> {
    const boundedLimit = Math.min(Math.max(1, limit), 50);
    const eligibleTargetIds = this.controlStore.listEligibleTargetIdsForDevice(deviceId);
    if (eligibleTargetIds.length === 0) {
      return [];
    }

    // Query all eligible targets without arbitrary truncation
    const allCandidates: Array<{ job_id: string; created_at_ms: number; target_id: string }> = [];
    for (const targetId of eligibleTargetIds) {
      const rows = await this.store.getQueuedJobIdsForTarget(targetId, boundedLimit);
      for (const row of rows) {
        allCandidates.push({ ...row, target_id: targetId });
      }
    }

    allCandidates.sort((a, b) => a.created_at_ms - b.created_at_ms);

    const results: PendingJobSummary[] = [];
    const now = this.nowMs();

    for (const candidate of allCandidates) {
      if (results.length >= boundedLimit) break;
      const job = await this.store.getJob(candidate.job_id);
      if (!job || job.status !== "queued") {
        // Opportunistically prune stale queue item
        await this.store.pruneTargetQueue(candidate.target_id, candidate.job_id).catch(() => 0);
        continue;
      }
      if (job.claim_deadline_ms > 0 && now >= job.claim_deadline_ms) {
        await this.store.pruneTargetQueue(candidate.target_id, candidate.job_id).catch(() => 0);
        continue;
      }
      if (job.target_id !== candidate.target_id) {
        process.stderr.write(
          `jobs-v2: queue corruption: job ${job.job_id} target_id '${job.target_id}' does not match queue target '${candidate.target_id}'; pruning from queue.\n`,
        );
        await this.store.pruneTargetQueue(candidate.target_id, candidate.job_id).catch(() => 0);
        continue;
      }

      results.push({
        job_id: job.job_id,
        workspace_id: job.workspace_id,
        target_id: job.target_id,
        resource_id: job.resource_id,
        created_at: new Date(job.created_at_ms).toISOString(),
        expires_at: job.claim_deadline_ms > 0 ? new Date(job.claim_deadline_ms).toISOString() : null,
      });
    }

    return results;
  }

  async claimJob(
    deviceId: string,
    jobId: string,
    attemptId: string,
    claimToken: string,
  ): Promise<ClaimJobResult> {
    if (!ATTEMPT_ID_V2_RE.test(attemptId)) {
      throw new JobValidationError("Invalid attempt_id format.");
    }
    if (!HEX_64_RE.test(claimToken)) {
      throw new JobValidationError("claim_token must be 64 lowercase hex characters.");
    }

    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new V2JobNotFoundError();
    }

    const claimTokenSha256 = crypto.createHash("sha256").update(claimToken, "utf8").digest("hex");

    let claimRes: { status: "claimed" | "replayed"; attempt: AttemptRecordV1; server_time_ms: number };

    if (job.latest_attempt_id === attemptId) {
      // Path A: Ownership Replay (bypasses resolveEligibleBinding, survives disable/unbind)
      claimRes = await this.store.claimJob({
        job_id: jobId,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: "", // read from historical attempt in Lua
        attempt_id: attemptId,
        claim_token_sha256: claimTokenSha256,
        is_replay_only: true,
      });
    } else {
      // Path B: New Claim Ownership (requires active eligibility)
      const resolution = this.controlStore.resolveEligibleBinding(deviceId, job.target_id);
      if (!resolution.eligible || !resolution.target || !resolution.binding) {
        throw new V2JobNotFoundError();
      }
      if (resolution.target.workspace_id !== job.workspace_id) {
        throw new V2JobNotFoundError();
      }

      claimRes = await this.store.claimJob({
        job_id: jobId,
        expected_workspace_id: job.workspace_id,
        expected_target_id: job.target_id,
        device_id: deviceId,
        target_binding_id: resolution.binding.id,
        attempt_id: attemptId,
        claim_token_sha256: claimTokenSha256,
        is_replay_only: false,
      });
    }

    return {
      ok: true,
      replayed: claimRes.status === "replayed",
      server_time: new Date(claimRes.server_time_ms).toISOString(),
      attempt: {
        attempt_id: claimRes.attempt.attempt_id,
        phase: claimRes.attempt.phase,
        claimed_at: new Date(claimRes.attempt.claimed_at_ms).toISOString(),
        started_at: claimRes.attempt.started_at_ms ? new Date(claimRes.attempt.started_at_ms).toISOString() : null,
      },
      job: {
        job_id: job.job_id,
        workspace_id: job.workspace_id,
        target_id: job.target_id,
        resource_id: job.resource_id,
        prompt: job.prompt,
        acceptance: job.acceptance,
        timeout_seconds: job.execution_timeout_seconds,
        result_target: job.result_target,
      },
    };
  }

  async startJob(
    deviceId: string,
    jobId: string,
    attemptId: string,
    claimToken: string,
  ): Promise<StartJobResult> {
    if (!ATTEMPT_ID_V2_RE.test(attemptId)) {
      throw new JobValidationError("Invalid attempt_id format.");
    }
    if (!HEX_64_RE.test(claimToken)) {
      throw new JobValidationError("claim_token must be 64 lowercase hex characters.");
    }

    const claimTokenSha256 = crypto.createHash("sha256").update(claimToken, "utf8").digest("hex");
    const res = await this.store.startJob({
      job_id: jobId,
      attempt_id: attemptId,
      device_id: deviceId,
      claim_token_sha256: claimTokenSha256,
    });

    return {
      ok: true,
      replayed: res.status === "replayed",
      server_time: new Date(res.server_time_ms).toISOString(),
    };
  }

  async submitJobResult(
    deviceId: string,
    jobId: string,
    attemptId: string,
    claimToken: string,
    result: ManagedResultEnvelope,
    payloadSha256: string,
    deliveryMode: "automatic" | "explicit_redelivery" = "automatic",
  ): Promise<{
    ok: true;
    replayed: boolean;
    server_time: string;
    resource_id: string;
    commit: string;
  }> {
    if (!jobId || !JOB_ID_V2_RE.test(jobId)) {
      throw new JobValidationError("Invalid job_id format.");
    }
    if (!attemptId || !ATTEMPT_ID_V2_RE.test(attemptId)) {
      throw new JobValidationError("Invalid attempt_id format.");
    }
    if (!claimToken || typeof claimToken !== "string") {
      throw new JobValidationError("claim_token is required.");
    }
    if (!this.resourceService) {
      throw new JobValidationError("ResourceService is not configured on coordinator.");
    }

    // Verify JCS canonical digest matches payloadSha256
    const expectedDigest = computeCanonicalSha256(result);
    if (expectedDigest !== payloadSha256) {
      throw new JobValidationError("payload_sha256 does not match canonical JCS digest of result.");
    }

    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new V2JobNotFoundError();
    }
    if (job.result_target !== "resource") {
      throw new JobValidationError("Job result_target is not 'resource'.");
    }
    if (job.resource_id !== result.resource_id) {
      throw new JobValidationError(
        `Result resource_id '${result.resource_id}' does not match job resource_id '${job.resource_id}'.`,
      );
    }

    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt || attempt.job_id !== jobId) {
      throw new V2AttemptLifecycleError("ATTEMPT_NOT_FOUND", "Attempt not found for job.");
    }
    if (attempt.device_id !== deviceId) {
      throw new V2AttemptLifecycleError("IDENTITY_MISMATCH", "Device ID mismatch.");
    }

    const claimTokenSha256 = crypto.createHash("sha256").update(claimToken, "utf8").digest("hex");
    if (attempt.claim_token_sha256 !== claimTokenSha256) {
      throw new V2AttemptLifecycleError("IDENTITY_MISMATCH", "Claim token mismatch.");
    }

    // Fast replay check if attempt already has this exact result
    if (attempt.result) {
      if (attempt.result.payload_sha256 === payloadSha256) {
        return {
          ok: true,
          replayed: true,
          server_time: new Date().toISOString(),
          resource_id: attempt.result.resource_id,
          commit: attempt.result.commit,
        };
      } else if (deliveryMode !== "explicit_redelivery") {
        throw new V2ReportConflictError("STALE_RESULT_SUBMISSION");
      }
    }

    const resourceService =
      typeof this.resourceService === "function"
        ? await this.resourceService(job.workspace_id)
        : this.resourceService;

    // Apply via deterministic Resource transaction
    const txRes = await resourceService.applyManagedJobResult({
      jobId,
      attemptId,
      resourceId: result.resource_id,
      summary: result.summary,
      operations: result.operations,
      payloadSha256,
    });

    const persistedResult: PersistedJobResult = {
      target: "resource",
      attempt_id: attemptId,
      payload_sha256: payloadSha256,
      resource_id: result.resource_id,
      commit: txRes.commit,
      received_at_ms: Date.now(),
    };

    const storeRes = await this.store.recordJobResult({
      job_id: jobId,
      attempt_id: attemptId,
      device_id: deviceId,
      claim_token_sha256: claimTokenSha256,
      result: persistedResult,
      delivery_mode: deliveryMode,
    });

    return {
      ok: true,
      replayed: txRes.replayed || storeRes.status === "replayed",
      server_time: new Date(storeRes.server_time_ms).toISOString(),
      resource_id: storeRes.resource_id,
      commit: storeRes.commit,
    };
  }

  async reportJob(
    deviceId: string,
    jobId: string,
    attemptId: string,
    claimToken: string,
    rawReport: unknown,
  ): Promise<ReportJobResult> {
    if (!ATTEMPT_ID_V2_RE.test(attemptId)) {
      throw new JobValidationError("Invalid attempt_id format.");
    }
    if (!HEX_64_RE.test(claimToken)) {
      throw new JobValidationError("claim_token must be 64 lowercase hex characters.");
    }

    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new V2JobNotFoundError();
    }

    const parsedReport = executionReportSchema.parse(rawReport) as ExecutionReport;

    if (job.result_target === "resource" && parsedReport.execution_status === "COMPLETED") {
      const attempt = await this.store.getAttempt(attemptId);
      if (!attempt || !attempt.result) {
        throw new V2ReportConflictError("RESULT_REQUIRED");
      }
    }

    const claimTokenSha256 = crypto.createHash("sha256").update(claimToken, "utf8").digest("hex");

    const res = await this.store.reportJob({
      job_id: jobId,
      attempt_id: attemptId,
      device_id: deviceId,
      claim_token_sha256: claimTokenSha256,
      report: parsedReport,
    });

    return {
      ok: true,
      replayed: res.status === "replayed",
      server_time: new Date(res.server_time_ms).toISOString(),
    };
  }

  /**
   * Wave 2B: device-scoped operator cancel with server-authoritative,
   * state-dependent semantics:
   *
   * - queued/expired (not yet claimed): terminalize immediately; no attempt
   *   is created; idempotent on replay.
   * - claimed/running: the CURRENT attempt is terminalized authoritatively
   *   with a CANCELLED report (no second attempt). A live Connector observes
   *   the cancellation via its read surface and stops; a late runner report
   *   deterministically loses (REPORT_CONFLICT).
   * - already terminal: no mutation. Repeating a cancel on an
   *   operator-cancelled job is idempotent (already_cancelled); any other
   *   terminal outcome is reported explicitly (already_terminal) and history
   *   is never rewritten to CANCELLED.
   *
   * Authorization mirrors the device read surface: the device must hold a
   * binding to the job's target; inaccessible jobs are indistinguishable
   * from missing ones (404, no existence leak).
   */
  async cancelJobForDevice(
    deviceId: string,
    userId: string,
    jobId: string,
  ): Promise<JobCancelResult> {
    if (!jobId || !JOB_ID_V2_RE.test(jobId)) {
      throw new JobValidationError("Invalid job_id format.");
    }

    // Bounded race-retry budget: a claim/report landing between our read and
    // the atomic cancel script raises CANCEL_RACE; re-read and retry.
    let lastRaceError: V2CancelRaceError | null = null;
    for (let round = 0; round < JOB_CANCEL_MAX_RACE_RETRIES; round++) {
      const job = await this.store.getJob(jobId);
      if (!job) {
        throw new V2JobNotFoundError();
      }

      // Do not reveal whether the job exists for unauthorized devices.
      this.assertDeviceTargetAccess(deviceId, job.target_id);

      const attempt = job.latest_attempt_id
        ? await this.store.getAttempt(job.latest_attempt_id)
        : null;
      const previousState = deriveHostJobState(job, attempt, this.nowMs());

      if (previousState === "terminal") {
        // Terminal jobs are immutable; decide from current durable records
        // without any store mutation.
        const executionStatus = jobExecutionStatusView(job, attempt) ?? "CANCELLED";
        const businessOutcome = jobBusinessOutcomeView(job, attempt) ?? "NOT_STARTED";
        const action: JobCancelResult["action"] =
          executionStatus === "CANCELLED" ? "already_cancelled" : "already_terminal";
        return {
          job_id: job.job_id,
          previous_state: previousState,
          state: "terminal",
          execution_status: executionStatus,
          business_outcome: businessOutcome,
          action,
          attempt_id: attempt?.attempt_id ?? null,
          message:
            action === "already_cancelled"
              ? "Job was already cancelled by operator. No change."
              : `Job already finished with execution status '${executionStatus}'. History preserved; not rewritten to CANCELLED.`,
        };
      }

      // Device cancellation is a device-scoped action: the cancel record
      // attributes the operator action to the calling device.
      const expectedAttemptId = job.latest_attempt_id ?? "";
      const cancelReceiptSha256 = crypto
        .createHash("sha256")
        .update(`ceo:operator-cancel\u0000${job.job_id}\u0000${expectedAttemptId}\u0000${deviceId}`, "utf8")
        .digest("hex");

      let outcome: JobCancelOutcome;
      try {
        outcome = await this.store.cancelJob({
          job_id: job.job_id,
          expected_attempt_id: job.latest_attempt_id,
          expected_target_id: job.target_id,
          device_id: deviceId,
          reason: `operator cancel by user ${userId} via ceo-connector CLI`,
          cancel_receipt_sha256: cancelReceiptSha256,
        });
      } catch (err) {
        if (err instanceof V2CancelRaceError) {
          lastRaceError = err;
          continue;
        }
        throw err;
      }

      const action: JobCancelResult["action"] =
        outcome.result === "cancelled" ? "cancelled" : "already_cancelled";
      const message =
        action === "cancelled"
          ? previousState === "running"
            ? "Running job terminalized by operator cancel. The owning Connector will observe the cancellation and stop."
            : previousState === "claimed"
              ? "Claimed job cancelled by operator before execution started."
              : "Job cancelled before claim. No attempt was created."
          : "Job was already cancelled by operator. No change.";

      return {
        job_id: job.job_id,
        previous_state: previousState,
        state: "terminal",
        execution_status: outcome.execution_status,
        business_outcome: outcome.business_outcome,
        action,
        attempt_id: outcome.attempt_id,
        message,
      };
    }

    throw new V2StoreError(
      "QUEUE_UNAVAILABLE",
      "Job state kept changing during cancel (claim/report race); retry.",
      "CANCEL_RACE_EXHAUSTED",
    );
  }

  async getJobIdByRequestId(
    scope: JobSubmitScopeV2,
    requestId: string,
  ): Promise<string | null> {
    assertHostWorkspaceAccess(this.identityStore, scope);
    if (!requestId || !REQUEST_ID_V2_RE.test(requestId)) {
      throw new JobValidationError("Invalid request_id format.");
    }
    return this.store.getRequestJobId(scope.user_id, scope.workspace_id, requestId);
  }

  async getJobForHost(
    scope: JobSubmitScopeV2,
    jobId: string,
    options?: { include_task?: boolean },
  ): Promise<HostJobDetail> {
    assertHostWorkspaceAccess(this.identityStore, scope);

    if (!jobId || !JOB_ID_V2_RE.test(jobId)) {
      throw new JobValidationError("Invalid job_id format.");
    }

    const job = await this.store.getJob(jobId);
    if (!job || job.workspace_id !== scope.workspace_id) {
      throw new V2JobNotFoundError();
    }

    let attempt: AttemptRecordV1 | null = null;
    if (job.latest_attempt_id) {
      attempt = await this.store.getAttempt(job.latest_attempt_id);
      if (!attempt) {
        throw new V2StoreError(
          "QUEUE_UNAVAILABLE",
          `Job references missing attempt: ${job.latest_attempt_id}`,
          "CORRUPT_ATTEMPT_LINKAGE",
        );
      }
      if (
        attempt.job_id !== job.job_id ||
        attempt.workspace_id !== job.workspace_id ||
        attempt.target_id !== job.target_id ||
        attempt.user_id !== job.user_id
      ) {
        throw new V2StoreError(
          "QUEUE_UNAVAILABLE",
          `Attempt linkage mismatch: ${attempt.attempt_id}`,
          "CORRUPT_ATTEMPT_LINKAGE",
        );
      }
    }

    const hostState = deriveHostJobState(job, attempt, this.nowMs());
    const targetAlias = resolveHostJobTargetAlias(this.controlStore, job);

    const expiresAt =
      hostState === "queued" || hostState === "expired"
        ? new Date(job.claim_deadline_ms).toISOString()
        : null;

    const detail: HostJobDetail = {
      job_id: job.job_id,
      request_id: job.request_id,
      target_id: job.target_id,
      target_alias: targetAlias,
      state: hostState,
      execution_status: jobExecutionStatusView(job, attempt),
      business_outcome: jobBusinessOutcomeView(job, attempt),
      created_at: new Date(job.created_at_ms).toISOString(),
      expires_at: expiresAt,
      execution_timeout_seconds: job.execution_timeout_seconds,
      resource_id: job.resource_id,
      result_target: job.result_target,
      execution: attempt
        ? {
            attempt_id: attempt.attempt_id,
            phase: attempt.phase,
            claimed_at: new Date(attempt.claimed_at_ms).toISOString(),
            started_at: attempt.started_at_ms
              ? new Date(attempt.started_at_ms).toISOString()
              : null,
          }
        : null,
      report: attempt?.report
        ? {
            execution_status: attempt.report.execution_status,
            business_outcome: attempt.report.business_outcome,
            task_dispatched: attempt.report.task_dispatched,
            finished_at: new Date(attempt.report.finished_at_ms).toISOString(),
            duration_ms: attempt.report.duration_ms,
            executor: {
              type: attempt.report.executor.type,
              version: attempt.report.executor.version,
            },
            receipt_sha256: attempt.report.receipt_sha256,
            error: attempt.report.error
              ? {
                  stage: attempt.report.error.stage,
                  code: attempt.report.error.code,
                  message: attempt.report.error.message,
                }
              : null,
            received_at: new Date(attempt.report.received_at_ms).toISOString(),
          }
        : null,
      result: attempt?.result
        ? {
            target: attempt.result.target,
            attempt_id: attempt.result.attempt_id,
            payload_sha256: attempt.result.payload_sha256,
            resource_id: attempt.result.resource_id,
            commit: attempt.result.commit,
            received_at: new Date(attempt.result.received_at_ms).toISOString(),
          }
        : null,
    };

    if (options?.include_task) {
      detail.task = {
        prompt: job.prompt,
        acceptance: job.acceptance,
        timeout_seconds: job.execution_timeout_seconds,
      };
    }

    return detail;
  }

  async listJobsForHost(
    scope: JobSubmitScopeV2,
    query: ListJobsQuery = {},
  ): Promise<{ jobs: HostJobSummary[]; next_cursor: string | null }> {
    assertHostWorkspaceAccess(this.identityStore, scope);

    if (query.target_id !== undefined && query.target_id !== null) {
      if (!TARGET_ID_V2_RE.test(query.target_id)) {
        throw new JobValidationError("Invalid target_id format.");
      }
      // PROJECT-039: a deleted Target no longer has a control-store row, yet
      // its historical jobs must remain queryable. Only an EXISTING target in
      // a foreign workspace is rejected; an absent row defers isolation to
      // the workspace-scoped stream scan below.
      const target = this.controlStore.getExecutionTarget(query.target_id);
      if (target && target.workspace_id !== scope.workspace_id) {
        throw new TargetNotFoundError();
      }
    }

    if (query.cursor !== undefined && query.cursor !== null) {
      if (!STREAM_ENTRY_ID_RE.test(query.cursor)) {
        throw new JobValidationError("Invalid cursor format.");
      }
    }

    const limit = Math.min(
      Math.max(1, query.limit ?? JOB_LIST_DEFAULT_LIMIT),
      JOB_LIST_MAX_LIMIT,
    );

    let currentCursor: string | null = query.cursor ?? null;
    const jobs: HostJobSummary[] = [];
    let totalScanned = 0;
    let nextCursor: string | null = null;

    while (jobs.length < limit && totalScanned < JOB_LIST_MAX_SCANNED) {
      const batchToFetch = Math.min(
        JOB_LIST_SCAN_BATCH,
        JOB_LIST_MAX_SCANNED - totalScanned,
      );
      const entries = await this.store.readJobStreamReverse(currentCursor, batchToFetch);
      if (entries.length === 0) {
        nextCursor = null;
        break;
      }

      for (const entry of entries) {
        totalScanned++;
        currentCursor = entry.id;

        // Two-phase tenant isolation:
        // Step 1: Read raw workspace_id
        const rawWs = entry.fields["workspace_id"];
        if (
          typeof rawWs !== "string" ||
          !rawWs ||
          isWhitespaceOnly(rawWs) ||
          rawWs.length > 128
        ) {
          throw new V2StoreError(
            "QUEUE_UNAVAILABLE",
            `Corrupt stream entry: invalid workspace_id in entry ${entry.id}`,
            "CORRUPT_JOB_INDEX",
          );
        }

        if (rawWs !== scope.workspace_id) {
          // Foreign workspace: skip immediately without loading Job or doing full validation
          if (totalScanned >= JOB_LIST_MAX_SCANNED) {
            nextCursor = entry.id;
            break;
          }
          continue;
        }

        // Step 2: Authenticated workspace stream entry: strict validation
        let streamEntry;
        try {
          streamEntry = validateStreamEntryV2(entry.fields);
        } catch (e) {
          throw new V2StoreError(
            "QUEUE_UNAVAILABLE",
            `Corrupt stream entry for workspace: ${(e as Error).message}`,
            "CORRUPT_JOB_INDEX",
          );
        }

        // Step 3: Load Job
        const job = await this.store.getJob(streamEntry.job_id);
        if (!job) {
          throw new V2StoreError(
            "QUEUE_UNAVAILABLE",
            `Stream points to non-existent job: ${streamEntry.job_id}`,
            "CORRUPT_JOB_INDEX",
          );
        }

        if (
          job.job_id !== streamEntry.job_id ||
          job.user_id !== streamEntry.user_id ||
          job.workspace_id !== streamEntry.workspace_id ||
          job.target_id !== streamEntry.target_id ||
          job.created_at_ms !== streamEntry.created_at_ms
        ) {
          throw new V2StoreError(
            "QUEUE_UNAVAILABLE",
            `Stream entry mismatch with job record: ${job.job_id}`,
            "CORRUPT_JOB_INDEX",
          );
        }

        // If target_id filter was provided
        if (query.target_id && job.target_id !== query.target_id) {
          if (totalScanned >= JOB_LIST_MAX_SCANNED) {
            nextCursor = entry.id;
            break;
          }
          continue;
        }

        let attempt: AttemptRecordV1 | null = null;
        if (job.latest_attempt_id) {
          attempt = await this.store.getAttempt(job.latest_attempt_id);
          if (!attempt) {
            throw new V2StoreError(
              "QUEUE_UNAVAILABLE",
              `Job references missing attempt: ${job.latest_attempt_id}`,
              "CORRUPT_ATTEMPT_LINKAGE",
            );
          }
          if (
            attempt.job_id !== job.job_id ||
            attempt.workspace_id !== job.workspace_id ||
            attempt.target_id !== job.target_id ||
            attempt.user_id !== job.user_id
          ) {
            throw new V2StoreError(
              "QUEUE_UNAVAILABLE",
              `Attempt linkage mismatch: ${attempt.attempt_id}`,
              "CORRUPT_ATTEMPT_LINKAGE",
            );
          }
        }

        const hostState = deriveHostJobState(job, attempt, this.nowMs());
        if (query.state && hostState !== query.state) {
          if (totalScanned >= JOB_LIST_MAX_SCANNED) {
            nextCursor = entry.id;
            break;
          }
          continue;
        }

        if (query.execution_status) {
          const execStatus = attempt?.report?.execution_status;
          if (execStatus !== query.execution_status) {
            if (totalScanned >= JOB_LIST_MAX_SCANNED) {
              nextCursor = entry.id;
              break;
            }
            continue;
          }
        }

        const targetAlias = resolveHostJobTargetAlias(this.controlStore, job);

        const expiresAt =
          hostState === "queued" || hostState === "expired"
            ? new Date(job.claim_deadline_ms).toISOString()
            : null;

        const summary: HostJobSummary = {
          job_id: job.job_id,
          request_id: job.request_id,
          target_id: job.target_id,
          target_alias: targetAlias,
          state: hostState,
          execution_status: jobExecutionStatusView(job, attempt),
          business_outcome: jobBusinessOutcomeView(job, attempt),
          created_at: new Date(job.created_at_ms).toISOString(),
          expires_at: expiresAt,
          resource_id: job.resource_id,
          result_target: job.result_target,
        };

        jobs.push(summary);

        if (jobs.length >= limit) {
          nextCursor = entry.id;
          break;
        }

        if (totalScanned >= JOB_LIST_MAX_SCANNED) {
          nextCursor = entry.id;
          break;
        }
      }

      if (
        entries.length < batchToFetch &&
        jobs.length < limit &&
        totalScanned < JOB_LIST_MAX_SCANNED
      ) {
        nextCursor = null;
        break;
      }
    }

    return { jobs, next_cursor: nextCursor };
  }

  // ---------------------------------------------------------------------
  // Device-scoped read models (Connector CLI read side; read-only)
  // ---------------------------------------------------------------------

  /**
   * Device-scoped job detail. A device may read a job only when it has a
   * binding (current or historical) to the job's target. Workspace-level
   * authorization is inherited from getJobForHost via the device's user.
   */
  async getJobForDevice(
    deviceId: string,
    userId: string,
    jobId: string,
    options?: { include_task?: boolean },
  ): Promise<HostJobDetail> {
    if (!jobId || !JOB_ID_V2_RE.test(jobId)) {
      throw new JobValidationError("Invalid job_id format.");
    }

    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new V2JobNotFoundError();
    }

    this.assertDeviceTargetAccess(deviceId, job.target_id);

    return this.getJobForHost(
      { user_id: userId, workspace_id: job.workspace_id },
      jobId,
      options,
    );
  }

  /**
   * Device-scoped job list. Visibility is limited to jobs whose target is
   * (or was) bound to this device. With a target_id filter, only that
   * target's workspace is scanned.
   */
  async listJobsForDevice(
    deviceId: string,
    userId: string,
    query: ListJobsQuery = {},
  ): Promise<{ jobs: HostJobSummary[]; next_cursor: string | null }> {
    const deviceTargetIds = new Set(
      this.controlStore
        .listBindingsForDevice(deviceId, { includeDisabled: true })
        .map((b) => b.target_id),
    );

    let workspaceIds = new Set<string>();
    for (const targetId of deviceTargetIds) {
      const target = this.controlStore.getExecutionTarget(targetId);
      if (target) {
        workspaceIds.add(target.workspace_id);
      }
    }

    if (query.target_id) {
      if (!deviceTargetIds.has(query.target_id)) {
        // Target exists but is not visible to this device: return an empty
        // result rather than leaking target state.
        return { jobs: [], next_cursor: null };
      }
      const target = this.controlStore.getExecutionTarget(query.target_id);
      if (!target) {
        return { jobs: [], next_cursor: null };
      }
      workspaceIds = new Set([target.workspace_id]);
    }

    if (workspaceIds.size === 0) {
      return { jobs: [], next_cursor: null };
    }

    const workspaceList = [...workspaceIds];
    if (workspaceList.length === 1 && workspaceList[0] !== undefined) {
      return this.listJobsForHost(
        { user_id: userId, workspace_id: workspaceList[0] },
        query,
      );
    }

    // Multi-workspace devices: merge newest-first across the device's
    // workspaces. Cursor pagination is not supported across workspaces in
    // this read model; page within a single workspace via target_id filter.
    const limit = Math.min(
      Math.max(1, query.limit ?? JOB_LIST_DEFAULT_LIMIT),
      JOB_LIST_MAX_LIMIT,
    );
    const merged: HostJobSummary[] = [];
    for (const workspaceId of workspaceIds) {
      const res = await this.listJobsForHost(
        { user_id: userId, workspace_id: workspaceId },
        { ...query, limit, cursor: null },
      );
      merged.push(...res.jobs);
    }
    merged.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    return { jobs: merged.slice(0, limit), next_cursor: null };
  }

  private assertDeviceTargetAccess(deviceId: string, targetId: string): void {
    const bindings = this.controlStore.listBindingsForDevice(deviceId, {
      includeDisabled: true,
    });
    if (!bindings.some((b) => b.target_id === targetId)) {
      // Do not reveal whether the job exists.
      throw new V2JobNotFoundError();
    }
  }
}
