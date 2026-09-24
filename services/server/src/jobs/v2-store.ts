import {
  type RedisRunner,
  StoreError,
  isNoScriptError,
} from "./redis-runner.js";
import {
  KEY_STREAM_V2,
  jobKeyV2,
  attemptKeyV1,
  targetQueueKeyV1,
  jobAttemptsKeyV1,
  requestKeyV2,
  parseJobRecordV2,
  serializeJobRecordV2,
  parseAttemptRecordV1,
  type JobRecordV2,
  type AttemptRecordV1,
} from "./v2-schema.js";
import { type ExecutionReport } from "./execution-contract.js";
import {
  V2_CREATE_JOB_SCRIPT,
  V2_CLAIM_JOB_SCRIPT,
  V2_START_JOB_SCRIPT,
  V2_REPORT_JOB_SCRIPT,
} from "./v2-assignment-script.js";

export class V2StoreError extends StoreError {
  constructor(
    code: "QUEUE_UNAVAILABLE",
    message: string,
    public readonly reasonCode?: string,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, { reasonCode, ...details });
    this.name = "V2StoreError";
  }
}

export class V2JobNotFoundError extends Error {
  constructor(message = "Job not found.") {
    super(message);
    this.name = "V2JobNotFoundError";
  }
}

export class V2JobAlreadyClaimedError extends Error {
  constructor(message = "Job is already claimed.") {
    super(message);
    this.name = "V2JobAlreadyClaimedError";
  }
}

export class V2JobExpiredError extends Error {
  constructor(message = "Job claim deadline has expired.") {
    super(message);
    this.name = "V2JobExpiredError";
  }
}

export class V2JobFinishedError extends Error {
  constructor(message = "Job attempt is already finished.") {
    super(message);
    this.name = "V2JobFinishedError";
  }
}

export class V2IdempotencyConflictError extends Error {
  constructor(message = "Idempotency conflict on job submission or claim.") {
    super(message);
    this.name = "V2IdempotencyConflictError";
  }
}

export class V2AttemptLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "V2AttemptLifecycleError";
  }
}

export class V2ReportConflictError extends Error {
  constructor(message = "Terminal report does not match previously recorded report.") {
    super(message);
    this.name = "V2ReportConflictError";
  }
}

export class RedisJobStoreV2 {
  private createScriptSha: string | null = null;
  private claimScriptSha: string | null = null;
  private startScriptSha: string | null = null;
  private reportScriptSha: string | null = null;

  constructor(private readonly redis: RedisRunner) {}

  isReady(): boolean {
    return this.redis.ready();
  }

  private checkReady(): void {
    if (!this.redis.ready()) {
      throw new V2StoreError("QUEUE_UNAVAILABLE", "Redis is not available.");
    }
  }

  private async evalScript(
    script: string,
    getSha: () => string | null,
    setSha: (sha: string) => void,
    keys: string[],
    args: string[],
  ): Promise<string> {
    this.checkReady();
    let sha = getSha();
    if (!sha) {
      sha = await this.redis.scriptLoad(script);
      setSha(sha);
    }
    try {
      const res = await this.redis.evalsha(sha, keys.length, keys, args);
      return String(res);
    } catch (error) {
      if (isNoScriptError(error)) {
        sha = await this.redis.scriptLoad(script);
        setSha(sha);
        try {
          const res = await this.redis.evalsha(sha, keys.length, keys, args);
          return String(res);
        } catch (retryError) {
          throw new V2StoreError(
            "QUEUE_UNAVAILABLE",
            "Redis EVALSHA retry failed after NOSCRIPT reload.",
            "NOSCRIPT_RETRY_FAILED",
            { cause: String(retryError) },
          );
        }
      }
      throw error;
    }
  }

  async getJob(jobId: string): Promise<JobRecordV2 | null> {
    this.checkReady();
    const raw = await this.redis.get(jobKeyV2(jobId));
    if (!raw) return null;
    return parseJobRecordV2(raw);
  }

  async getAttempt(attemptId: string): Promise<AttemptRecordV1 | null> {
    this.checkReady();
    const raw = await this.redis.get(attemptKeyV1(attemptId));
    if (!raw) return null;
    return parseAttemptRecordV1(raw);
  }

  async getRequestJobId(userId: string, workspaceId: string, requestId: string): Promise<string | null> {
    this.checkReady();
    return await this.redis.get(requestKeyV2(userId, workspaceId, requestId));
  }

  async createJob(
    job: JobRecordV2,
    requestId: string,
  ): Promise<{ status: "created" | "replayed"; job_id: string; stream_entry_id?: string }> {
    const keys = [
      requestKeyV2(job.user_id, job.workspace_id, requestId),
      jobKeyV2(job.job_id),
      KEY_STREAM_V2,
      targetQueueKeyV1(job.target_id),
    ];
    const args = [
      job.job_id,
      job.user_id,
      job.workspace_id,
      job.target_id,
      String(job.created_at_ms),
      String(job.claim_deadline_ms),
      job.request_digest,
      serializeJobRecordV2(job),
      requestId,
    ];

    const raw = await this.evalScript(
      V2_CREATE_JOB_SCRIPT,
      () => this.createScriptSha,
      (s) => (this.createScriptSha = s),
      keys,
      args,
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Corrupt create script response: ${raw}`, "SCRIPT_CORRUPTION");
    }

    if (parsed.error) {
      const err = String(parsed.error);
      if (err === "JOB_ID_COLLISION") {
        throw new V2StoreError("QUEUE_UNAVAILABLE", "Job ID collision detected in queue.", "JOB_ID_COLLISION");
      }
      if (err === "IDEMPOTENCY_CONFLICT") {
        throw new V2IdempotencyConflictError("A job with this request ID already exists with different parameters.");
      }
      if (err === "INCOMPLETE_SUBMISSION") {
        throw new V2StoreError("QUEUE_UNAVAILABLE", "Previous submission with this request ID was incomplete.", "INCOMPLETE_SUBMISSION");
      }
      if (err === "CORRUPT_SUBMISSION_REFERENCE") {
        throw new V2StoreError("QUEUE_UNAVAILABLE", "Request placeholder references a missing Job.", "CORRUPT_SUBMISSION_REFERENCE");
      }
      if (err === "MALFORMED_JOB_RECORD") {
        throw new V2StoreError("QUEUE_UNAVAILABLE", "Job record in queue is malformed.", "MALFORMED_JOB_RECORD");
      }
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Creation failed: ${err}`, err);
    }

    return {
      status: parsed.status as "created" | "replayed",
      job_id: String(parsed.job_id),
      stream_entry_id: parsed.stream_entry_id ? String(parsed.stream_entry_id) : undefined,
    };
  }

  async claimJob(params: {
    job_id: string;
    expected_workspace_id: string;
    expected_target_id: string;
    device_id: string;
    target_binding_id: string;
    attempt_id: string;
    claim_token_sha256: string;
    is_replay_only: boolean;
  }): Promise<{ status: "claimed" | "replayed"; attempt: AttemptRecordV1; server_time_ms: number }> {
    const keys = [
      jobKeyV2(params.job_id),
      targetQueueKeyV1(params.expected_target_id),
      jobAttemptsKeyV1(params.job_id),
      attemptKeyV1(params.attempt_id),
    ];
    const args = [
      params.job_id,
      params.expected_workspace_id,
      params.expected_target_id,
      params.device_id,
      params.target_binding_id,
      params.attempt_id,
      params.claim_token_sha256,
      params.is_replay_only ? "1" : "0",
    ];

    const raw = await this.evalScript(
      V2_CLAIM_JOB_SCRIPT,
      () => this.claimScriptSha,
      (s) => (this.claimScriptSha = s),
      keys,
      args,
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Corrupt claim script response: ${raw}`, "SCRIPT_CORRUPTION");
    }

    if (parsed.error) {
      const err = String(parsed.error);
      if (err === "JOB_NOT_FOUND") throw new V2JobNotFoundError();
      if (err === "JOB_ALREADY_CLAIMED") throw new V2JobAlreadyClaimedError();
      if (err === "JOB_EXPIRED") throw new V2JobExpiredError();
      if (err === "JOB_FINISHED") throw new V2JobFinishedError();
      if (err === "IDEMPOTENCY_CONFLICT") throw new V2IdempotencyConflictError("Claim token or identity mismatch on attempt replay.");
      if (err === "ATTEMPT_ID_COLLISION") throw new V2IdempotencyConflictError("Attempt ID collision detected.");
      if (err === "NOT_OWNER_REPLAY") throw new V2JobNotFoundError();
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Claim failed: ${err}`, err);
    }

    const attempt = parseAttemptRecordV1(parsed.attempt);
    return {
      status: parsed.status as "claimed" | "replayed",
      attempt,
      server_time_ms: Number(parsed.server_time_ms),
    };
  }

  async startJob(params: {
    job_id: string;
    attempt_id: string;
    device_id: string;
    claim_token_sha256: string;
  }): Promise<{ status: "started" | "replayed"; attempt: AttemptRecordV1; server_time_ms: number }> {
    const keys = [
      jobKeyV2(params.job_id),
      attemptKeyV1(params.attempt_id),
    ];
    const args = [
      params.attempt_id,
      params.device_id,
      params.claim_token_sha256,
    ];

    const raw = await this.evalScript(
      V2_START_JOB_SCRIPT,
      () => this.startScriptSha,
      (s) => (this.startScriptSha = s),
      keys,
      args,
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Corrupt start script response: ${raw}`, "SCRIPT_CORRUPTION");
    }

    if (parsed.error) {
      const err = String(parsed.error);
      if (err === "JOB_NOT_FOUND") throw new V2JobNotFoundError();
      if (err === "ATTEMPT_NOT_FOUND" || err === "JOB_NOT_ACTIVE" || err === "IDENTITY_MISMATCH") {
        throw new V2AttemptLifecycleError(err, `Start validation failed: ${err}`);
      }
      if (err === "INVALID_ATTEMPT_PHASE") {
        throw new V2AttemptLifecycleError("INVALID_ATTEMPT_PHASE", `Attempt is in '${parsed.phase}' phase; cannot transition to running.`);
      }
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Start failed: ${err}`, err);
    }

    const attempt = parseAttemptRecordV1(parsed.attempt);
    return {
      status: parsed.status as "started" | "replayed",
      attempt,
      server_time_ms: Number(parsed.server_time_ms),
    };
  }

  async reportJob(params: {
    job_id: string;
    attempt_id: string;
    device_id: string;
    claim_token_sha256: string;
    report: ExecutionReport;
  }): Promise<{ status: "reported" | "replayed"; server_time_ms: number }> {
    const keys = [
      jobKeyV2(params.job_id),
      attemptKeyV1(params.attempt_id),
    ];
    const args = [
      params.attempt_id,
      params.device_id,
      params.claim_token_sha256,
      JSON.stringify(params.report),
    ];

    const raw = await this.evalScript(
      V2_REPORT_JOB_SCRIPT,
      () => this.reportScriptSha,
      (s) => (this.reportScriptSha = s),
      keys,
      args,
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Corrupt report script response: ${raw}`, "SCRIPT_CORRUPTION");
    }

    if (parsed.error) {
      const err = String(parsed.error);
      if (err === "JOB_NOT_FOUND") throw new V2JobNotFoundError();
      if (err === "REPORT_CONFLICT") throw new V2ReportConflictError();
      if (
        err === "ATTEMPT_NOT_FOUND" ||
        err === "ATTEMPT_MISMATCH" ||
        err === "IDENTITY_MISMATCH" ||
        err === "INVALID_JOB_STATUS" ||
        err === "INVALID_ATTEMPT_PHASE" ||
        err === "DISPATCHED_REPORT_REQUIRES_RUNNING" ||
        err.startsWith("INVALID_") ||
        err.includes("REPORT")
      ) {
        throw new V2AttemptLifecycleError(err, `Report validation failed: ${err}`);
      }
      throw new V2StoreError("QUEUE_UNAVAILABLE", `Report failed: ${err}`, err);
    }

    return {
      status: parsed.status as "reported" | "replayed",
      server_time_ms: Number(parsed.server_time_ms),
    };
  }

  async getQueuedJobIdsForTarget(
    targetId: string,
    limit: number,
  ): Promise<Array<{ job_id: string; created_at_ms: number }>> {
    this.checkReady();
    const rows = await this.redis.zrangeWithScores(targetQueueKeyV1(targetId), 0, Math.max(0, limit - 1));
    return rows.map((r) => ({
      job_id: r.member,
      created_at_ms: r.score,
    }));
  }

  async pruneTargetQueue(targetId: string, ...jobIds: string[]): Promise<number> {
    this.checkReady();
    if (jobIds.length === 0) return 0;
    return await this.redis.zrem(targetQueueKeyV1(targetId), ...jobIds);
  }
}
