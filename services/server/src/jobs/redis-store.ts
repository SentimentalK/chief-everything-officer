import {
  KEY_STREAM,
  requestKey,
  jobKey,
  JOBS_SCHEMA_VERSION,
  JOB_STREAM_SCHEMA_VERSION,
  type RequestPlaceholder,
  type PersistedJobRecord,
  type JobState,
} from "./schema.js";
import {
  type AssignmentJobRecord,
  type AssignmentScriptResult,
  type AssignmentState,
  type ClaimAssignmentInput,
  type StartAssignmentInput,
  type ReportAssignmentInput,
  type ResultAssignmentInput,
} from "./assignment-schema.js";
import { ASSIGNMENT_SCRIPT } from "./assignment-script.js";
import {
  type RedisRunner,
  StoreError,
  isNoScriptError,
  type RedisRunnerOptions,
  DEFAULT_REDIS_OP_TIMEOUT_MS,
  createRedisRunnerFromClient,
  type NeutralRedisTransport,
  openNeutralRedisRunner,
} from "./redis-runner.js";

export {
  type RedisRunner,
  StoreError,
  isNoScriptError,
  type RedisRunnerOptions,
  DEFAULT_REDIS_OP_TIMEOUT_MS,
  createRedisRunnerFromClient,
  type NeutralRedisTransport,
  openNeutralRedisRunner,
};

export interface AuthScope {
  user_id: string;
  workspace_id: string;
}

/** Decision returned by the atomic creation Lua. */
export type CommitDecision = "NEW" | "REPLAY" | "CONFLICT" | "INCOMPLETE";

/**
 * Atomic creation Lua. It first verifies the key TYPES it will write to are
 * either absent (`none`) or of the expected kind BEFORE writing anything, so a
 * coincidental wrong-type key collision (e.g. `ceo:jobs` existing as a string)
 * fails the whole script up front without leaving a partial placeholder.
 *
 * KEYS[1] = requestKey(user,ws,request)
 * KEYS[2] = stream key
 * ARGV[1] = business digest
 * ARGV[2] = JSON prepared record (pre-commit: status 'preparing', no stream id)
 * ARGV[3] = job_id
 */
const CREATE_SCRIPT = `
local P = 'ceo:job:'
local function badtype(key, ok)
  local t = redis.call('TYPE', key)
  -- TYPE returns a status in Lua; drive to a string.
  local tt = type(t) == 'table' and t.ok or tostring(t)
  if (tt ~= 'none') and (tt ~= ok) then return true end
  return false
end

if badtype(KEYS[1], 'string') then
  return redis.error_reply('WRONGTYPE_REQ_KEY')
end
if badtype(KEYS[2], 'stream') then
  return redis.error_reply('WRONGTYPE_STREAM_KEY')
end

local req = redis.call('GET', KEYS[1])
if req then
  local okreq, ph = pcall(cjson.decode, req)
  if not okreq then return redis.error_reply('CORRUPT_PLACEHOLDER') end
  local job = redis.call('GET', P .. ph.job_id)
  if not job then return 'INCOMPLETE' end
  local okjd, jd = pcall(cjson.decode, job)
  if not okjd then return 'INCOMPLETE' end
  if jd.user_id ~= ARGV[4] or jd.workspace_id ~= ARGV[5] then
    return 'INCOMPLETE'
  end
  if jd.request_digest ~= ARGV[1] then return 'CONFLICT' end
  if jd.status ~= 'queued' or jd.stream_entry_id == '' or jd.stream_entry_id == nil then
    return 'INCOMPLETE'
  end
  return 'REPLAY'
end

local job_id = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode({ job_id = job_id, request_digest = ARGV[1] }))
local prepared = cjson.decode(ARGV[2])
redis.call('SET', P .. job_id, cjson.encode(prepared))
local entry = redis.call('XADD', KEYS[2], '*',
  'schema_version', ARGV[6],
  'job_id', job_id,
  'user_id', prepared.user_id,
  'workspace_id', prepared.workspace_id)
prepared.status = 'queued'
prepared.stream_entry_id = entry
redis.call('SET', P .. job_id, cjson.encode(prepared))
return 'NEW'
`;

export class RedisJobStore {
  private cachedSha: string | null = null;
  private assignmentSha: string | null = null;

  constructor(private readonly redis: RedisRunner) {}

  isReady(): boolean {
    return this.redis.ready();
  }

  private keyCheck(): void {
    if (!this.redis.ready()) {
      throw new StoreError("QUEUE_UNAVAILABLE", "Redis is not available.");
    }
  }

  private async createScriptVia(redisLike: RedisRunner): Promise<string> {
    return redisLike.scriptLoad(CREATE_SCRIPT);
  }

  private async evalshaCreate(redisLike: RedisRunner, req: string, prepared: PersistedJobRecord): Promise<CommitDecision> {
    const args = [
      prepared.request_digest,
      JSON.stringify(prepared),
      prepared.job_id,
      prepared.user_id,
      prepared.workspace_id,
      String(JOB_STREAM_SCHEMA_VERSION),
    ];
    if (!this.cachedSha) {
      this.cachedSha = await this.createScriptVia(redisLike);
    }
    try {
      const res = await redisLike.evalsha(this.cachedSha, 2, [req, KEY_STREAM], args);
      return normalizeDecision(res);
    } catch (error) {
      if (isNoScriptError(error)) {
        this.cachedSha = await this.createScriptVia(redisLike);
        try {
          const res = await redisLike.evalsha(this.cachedSha, 2, [req, KEY_STREAM], args);
          return normalizeDecision(res);
        } catch (retryError) {
          throw new StoreError("QUEUE_UNAVAILABLE", "Redis EVALSHA retry failed after NOSCRIPT reload.", { cause: String(retryError) });
        }
      }
      throw new StoreError("QUEUE_UNAVAILABLE", "Redis EVALSHA failed.", { cause: String(error) });
    }
  }

  /** Atomic fast-path submit used by production and integration tests alike. */
  async submit(scope: AuthScope, requestId: string, prepared: PersistedJobRecord): Promise<CommitDecision> {
    this.keyCheck();
    const req = requestKey(scope.user_id, scope.workspace_id, requestId);
    return this.evalshaCreate(this.redis, req, prepared);
  }

  getCachedShaForTest(): string | null {
    return this.cachedSha;
  }

  setCachedShaForTest(sha: string | null): void {
    this.cachedSha = sha;
  }

  getAssignmentShaForTest(): string | null {
    return this.assignmentSha;
  }

  setAssignmentShaForTest(sha: string | null): void {
    this.assignmentSha = sha;
  }

  private async loadAssignmentScript(redisLike: RedisRunner): Promise<string> {
    return redisLike.scriptLoad(ASSIGNMENT_SCRIPT);
  }

  private async evalshaAssignment(
    redisLike: RedisRunner,
    keys: string[],
    args: string[],
  ): Promise<AssignmentScriptResult> {
    if (!this.assignmentSha) {
      this.assignmentSha = await this.loadAssignmentScript(redisLike);
    }
    const doRun = async (sha: string): Promise<AssignmentScriptResult> => {
      const res = await redisLike.evalsha(sha, keys.length, keys, args);
      return parseAssignmentResult(res);
    };
    try {
      return await doRun(this.assignmentSha);
    } catch (error) {
      if (error instanceof StoreError) {
        throw error;
      }
      if (isNoScriptError(error)) {
        this.assignmentSha = await this.loadAssignmentScript(redisLike);
        try {
          return await doRun(this.assignmentSha);
        } catch (retryError) {
          if (retryError instanceof StoreError) {
            throw retryError;
          }
          throw new StoreError(
            "QUEUE_UNAVAILABLE",
            "Redis assignment EVALSHA retry failed after NOSCRIPT reload.",
            { cause: String(retryError) },
          );
        }
      }
      throw new StoreError("QUEUE_UNAVAILABLE", "Redis assignment EVALSHA failed.", {
        cause: String(error),
      });
    }
  }

  private async runAssignment(
    scope: AuthScope,
    operation: string,
    jobId: string,
    argsIn: {
      workerId?: string;
      attemptId?: string;
      workspaceRef?: string;
      tokenSha?: string;
      reportJson?: string;
    },
  ): Promise<AssignmentScriptResult> {
    this.keyCheck();
    const args = [
      operation,
      jobId,
      scope.user_id,
      scope.workspace_id,
      argsIn.workerId ?? "",
      argsIn.attemptId ?? "",
      argsIn.workspaceRef ?? "",
      argsIn.tokenSha ?? "",
      argsIn.reportJson ?? "",
    ];
    return this.evalshaAssignment(this.redis, [jobKey(jobId)], args);
  }

  async inspectAssignment(
    scope: AuthScope,
    jobId: string,
  ): Promise<AssignmentScriptResult> {
    return this.runAssignment(scope, "inspect", jobId, {});
  }

  async claimAssignment(
    scope: AuthScope,
    jobId: string,
    input: ClaimAssignmentInput,
  ): Promise<AssignmentScriptResult> {
    return this.runAssignment(scope, "claim", jobId, {
      workerId: input.worker_id,
      attemptId: input.attempt_id,
      workspaceRef: input.workspace_ref,
      tokenSha: input.claim_token_sha256,
    });
  }

  async startAssignment(
    scope: AuthScope,
    jobId: string,
    input: StartAssignmentInput,
  ): Promise<AssignmentScriptResult> {
    return this.runAssignment(scope, "start", jobId, {
      workerId: input.worker_id,
      attemptId: input.attempt_id,
      tokenSha: input.claim_token_sha256,
    });
  }

  async reportAssignment(
    scope: AuthScope,
    jobId: string,
    input: ReportAssignmentInput,
  ): Promise<AssignmentScriptResult> {
    return this.runAssignment(scope, "report", jobId, {
      workerId: input.worker_id,
      attemptId: input.attempt_id,
      tokenSha: input.claim_token_sha256,
      reportJson: JSON.stringify(input.report),
    });
  }

  async resultAssignment(
    scope: AuthScope,
    jobId: string,
    input: ResultAssignmentInput,
  ): Promise<AssignmentScriptResult> {
    return this.runAssignment(scope, "result", jobId, {
      workerId: input.worker_id,
      attemptId: input.attempt_id,
      tokenSha: input.claim_token_sha256,
      reportJson: JSON.stringify(input.result),
    });
  }

  async getJob(jobId: string): Promise<PersistedJobRecord | null> {
    this.keyCheck();
    const raw = await this.redis.get(jobKey(jobId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PersistedJobRecord;
      // A corrupt JSON payload must NOT be treated as "not found"; surface as
      // unavailable so operators can diagnose rather than trusting absence.
      if (!parsed || typeof parsed !== "object" || typeof parsed.job_id !== "string") {
        throw new Error("corrupt job record");
      }
      return parsed;
    } catch (error) {
      throw new StoreError("QUEUE_UNAVAILABLE", "Corrupt job record stored in queue.", {
        job_id: jobId,
        reason: "CORRUPT_RECORD",
        cause: String(error),
      });
    }
  }

  async getPlaceholder(scope: AuthScope, requestId: string): Promise<RequestPlaceholder | null> {
    this.keyCheck();
    const raw = await this.redis.get(requestKey(scope.user_id, scope.workspace_id, requestId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as RequestPlaceholder;
      if (!parsed || typeof parsed.job_id !== "string" || typeof parsed.request_digest !== "string") {
        throw new Error("corrupt placeholder");
      }
      return parsed;
    } catch (error) {
      throw new StoreError("QUEUE_UNAVAILABLE", "Corrupt placeholder stored in queue.", {
        reason: "CORRUPT_PLACEHOLDER",
        cause: String(error),
      });
    }
  }

  /** Stream length used by tests to assert exactly-once XADD. */
  async streamLength(): Promise<number> {
    this.keyCheck();
    return this.redis.xlen(KEY_STREAM);
  }

  /**
   * Read a bounded window of committed stream entries after an EXCLUSIVE start
   * (task-discovery source). Returns only {id, fields}; no consumer group is
   * used and no consumption state is mutated.
   */
  async readStreamEntries(
    afterExclusive: string,
    count: number,
  ): Promise<Array<{ id: string; fields: Record<string, string> }>> {
    this.keyCheck();
    const rows = await this.redis.xrange(KEY_STREAM, afterExclusive, count);
    return rows.map(([id, flat]) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        fields[flat[i]!] = flat[i + 1]!;
      }
      return { id, fields };
    });
  }

  /**
   * TEST-ONLY: remove the whole queue key-space for a clean test (never used in
   * a running server).
   */
  async resetForTest(): Promise<void> {
    this.keyCheck();
    return this.redis.flush();
  }

  /**
   * TEST-ONLY: plant a detectable partial submission directly over the REAL
   * keys + REAL Lua successor semantics so tests fault-inject the actual
   * on-disk states the production path must diagnose. stage:
   *   - 'placeholder'      => only the request placeholder
   *   - 'prepare'          => placeholder + a 'preparing' job (no stream yet)
   *   - 'stream'           => placeholder + preparing job + a stray stream entry
   * Never used outside integration/unit fault-injection tests.
   */
  async plantPartialForTest(
    scope: AuthScope,
    requestId: string,
    prepared: PersistedJobRecord,
    stage: "placeholder" | "prepare" | "stream",
  ): Promise<void> {
    this.keyCheck();
    const req = requestKey(scope.user_id, scope.workspace_id, requestId);
    const job = jobKey(prepared.job_id);
    const placeholder: RequestPlaceholder = { job_id: prepared.job_id, request_digest: prepared.request_digest };
    await this.redis.set(req, JSON.stringify(placeholder));
    if (stage === "placeholder") return;

    await this.redis.set(job, JSON.stringify({ ...prepared }));
    if (stage === "prepare") return;

    // stray stream entry to mimic an XADD that happened but the final record
    // never reached 'queued'.
    await this.redis.xaddStream({
      schema_version: JOB_STREAM_SCHEMA_VERSION,
      job_id: prepared.job_id,
      user_id: scope.user_id,
      workspace_id: scope.workspace_id,
    });
  }
}

function shapeOfError(error: unknown): { code?: string } {
  const as = error as { cause?: { code?: string }; code?: string };
  return { code: as?.cause?.code ?? as?.code };
}

function normalizeDecision(res: unknown): CommitDecision {
  const s = typeof res === "string" ? res : String(res);
  if (s === "NEW" || s === "REPLAY" || s === "CONFLICT" || s === "INCOMPLETE") return s;
  // WRONGTYPE / CORRUPT_* become an errored EVAL whose reply is an error object.
  throw new StoreError("QUEUE_UNAVAILABLE", `Unexpected queue decision: ${s}`);
}

function parseAssignmentResult(res: unknown): AssignmentScriptResult {
  const s = typeof res === "string" ? res : String(res);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    throw new StoreError(
      "QUEUE_UNAVAILABLE",
      "Invalid assignment script response.",
      { reason: "INVALID_SCRIPT_RESPONSE" },
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new StoreError(
      "QUEUE_UNAVAILABLE",
      "Invalid assignment script response.",
      { reason: "INVALID_SCRIPT_RESPONSE" },
    );
  }
  const ok = obj.ok === true;
  if (!ok) {
    const code = typeof obj.code === "string" ? obj.code : "QUEUE_UNAVAILABLE";
    const reason = obj.reason == null ? null : String(obj.reason);
    return { ok: false, code, reason };
  }
  const record = obj.record as unknown;
  const serverTimeMs = obj.server_time_ms;
  if (
    !record ||
    typeof record !== "object" ||
    typeof serverTimeMs !== "number" ||
    typeof obj.state !== "string"
  ) {
    throw new StoreError(
      "QUEUE_UNAVAILABLE",
      "Invalid assignment script response.",
      { reason: "INVALID_SCRIPT_RESPONSE" },
    );
  }
  return {
    ok: true,
    record: record as AssignmentJobRecord,
    server_time_ms: serverTimeMs,
    state: obj.state as AssignmentState,
    replayed: obj.replayed === true,
  };
}
