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
  MIN_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_PROMPT_BYTES,
  MAX_ACCEPTANCE_BYTES,
  utf8ByteLength,
  isWhitespaceOnly,
} from "./v2-schema.js";
import {
  type ExecutionReport,
  executionReportSchema,
} from "./execution-contract.js";
import {
  RedisJobStoreV2,
  V2JobNotFoundError,
  V2IdempotencyConflictError,
  V2StoreError,
} from "./v2-store.js";
import type { ConnectorControlStore } from "../connector/control-store.js";
import type { IdentityStore } from "../identity/store.js";

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
  private readonly resourceExists?: (
    scope: { userId: string; workspaceId: string },
    resourceId: string,
  ) => Promise<boolean> | boolean;
  private readonly nowMs: () => number;

  constructor(deps: JobCoordinatorV2Deps) {
    this.store = deps.store;
    this.controlStore = deps.controlStore;
    this.identityStore = deps.identityStore;
    this.resourceExists = deps.resourceExists;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async submit(
    scope: JobSubmitScopeV2,
    input: SubmitJobInputV2,
  ): Promise<{ status: "created" | "replayed"; job: JobRecordV2 }> {
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

    // Step 1: Idempotency check first
    const existingJobId = await this.store.getRequestJobId(scope.user_id, scope.workspace_id, input.request_id);
    if (existingJobId) {
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
        return { status: "replayed", job: existingJob };
      }
      throw new V2IdempotencyConflictError("Request digest mismatch with existing job.");
    }

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

    const parsedReport = executionReportSchema.parse(rawReport) as ExecutionReport;
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
}
