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
} from "./assignment-schema.js";
import { ASSIGNMENT_SCRIPT } from "./assignment-script.js";
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
  type RedisClientType,
} from "redis";

export interface AuthScope {
  user_id: string;
  workspace_id: string;
}

/** Decision returned by the atomic creation Lua. */
export type CommitDecision = "NEW" | "REPLAY" | "CONFLICT" | "INCOMPLETE";

/**
 * Seam over the shared Redis connection. The production adapter (see
 * createRedisRunnerFromClient) has offline queues disabled and bounded connect
 * handling; per-command availability is surfaced as QUEUE_UNAVAILABLE. A fake
 * runner is used only in non-Redis unit tests; the Redis path itself is the
 * same for production and integration tests.
 */
export interface RedisRunner {
  ready(): boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Append a single-entry Redis Stream and return its entry id. */
  xaddStream(payload: Record<string, string | number>): Promise<string>;
  /** Number of entries in a key (stream length, for assertions). */
  xlen(key: string): Promise<number>;
  /** XRANGE over a stream from an EXCLUSIVE start with a bounded COUNT. */
  xrange(key: string, afterExclusive: string, count: number): Promise<Array<[string, string[]]>>;
  /** Load a Lua script; returns its sha1. */
  scriptLoad(script: string): Promise<string>;
  /** EVALSHA for our script; caller owns NOSCRIPT reload. */
  evalsha(sha: string, keyCount: number, keys: string[], args: string[]): Promise<unknown>;
  /** Check whether a sha is still cached (Redis restart clears the cache). */
  scriptExists(sha: string): Promise<boolean>;
  /** Remove keys+stream entries entirely (used ONLY by tests, never prod). */
  flush(): Promise<void>;
}

export class StoreError extends Error {
  constructor(
    public readonly code: "QUEUE_UNAVAILABLE",
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StoreError";
  }
}

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

export function isNoScriptError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const as = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (as.code === "NOSCRIPT" || as.cause?.code === "NOSCRIPT") return true;
  const msg = as.message ?? as.cause?.message;
  if (typeof msg === "string" && /^NOSCRIPT\b/i.test(msg.trim())) return true;
  return false;
}

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

export interface RedisRunnerOptions {
  opTimeoutMs?: number;
  /** Invoked for transport-level client/connect/factory errors (never for RESP reply errors). */
  onClientError?: (err: unknown) => void;
}

export const DEFAULT_REDIS_OP_TIMEOUT_MS = 2500;

/**
 * Production node-redis v5 adapter (offline queue disabled) with a bounded
 * per-command deadline that does NOT depend on node-redis abort support:
 * node-redis honors `abortSignal`/`timeout` only while a command is queued
 * pre-write; once written it waits for the reply forever (verified in the
 * installed @redis/client@5.12.1 commands-queue.js). This runner enforces its
 * own deadline and, on expiry, destroys and re-creates the shared connection
 * so no commands accumulate, in-flight siblings fail explicitly with
 * QUEUE_UNAVAILABLE, and a fresh connection recovers.
 *
 * The argument is a FACTORY because the runner owns the connection lifecycle
 * (initial + post-timeout replacement). Every call MUST return a NEW,
 * unconnected node-redis client; the runner connects it. No pre-connected
 * instances are accepted.
 */
export function createRedisRunnerFromClient(
  createClientFn: () => RedisClientType,
  runnerOptions: RedisRunnerOptions = {},
): RedisRunner & { dispose(): Promise<void> } {
  const opTimeoutMs = runnerOptions.opTimeoutMs ?? DEFAULT_REDIS_OP_TIMEOUT_MS;
  const onClientError = runnerOptions.onClientError ?? (() => void 0);

  const OP_TIMEOUT_MESSAGE =
    "Redis command timed out; outcome may be unknown. Retry with the original request_id.";
  const TRANSPORT_FAULT_MESSAGE =
    "Redis connection fault; the operation may have been executed. Retry with the original request_id.";
  const NOT_AVAILABLE_MESSAGE = "Redis is not available.";

  interface Connection {
    client: RedisClientType;
    /** Set when THIS runner tears the client down (reset or dispose). Every
     *  rejection the teardown produces (node-redis destroy() flushes the queue
     *  with a DisconnectsClientError, which never passes through the client's
     *  'error' listener and reports name === "Error") maps to QUEUE_UNAVAILABLE. */
    invalidated: boolean;
  }

  // Errors node-redis surfaces on a client's 'error' event are emitted BEFORE
  // the queue is flushed with the same object (client/index.js
  // #attachListeners), so marking here catches genuine socket faults. This is
  // a SUPPLEMENT: the authoritative signals are connection.invalidated (our
  // own teardown), instanceof of the real exported classes, and OS codes.
  const transportFaults = new WeakSet<object>();

  let current: Connection | null = null;
  let disposed = false;

  /** A user logging callback must never break the runner or leak a rejection. */
  function reportClientError(err: unknown): void {
    try {
      onClientError(err);
    } catch {
      /* ignore user callback failures */
    }
  }

  /** Mandatory 'error' listener (an unhandled 'error' event would crash the
   *  process) + log callback wiring. */
  function wire(client: RedisClientType): void {
    client.on("error", (err: unknown) => {
      if (err && typeof err === "object") transportFaults.add(err);
      reportClientError(err);
    });
  }

  /** Create the next connection and start its background connect. A factory
   *  throw is reported via onClientError and returns null: the runner stays
   *  unavailable (current === null -> ready() false -> QUEUE_UNAVAILABLE) and
   *  factory failures are NOT auto-retried. Recovery from network connect
   *  failures is delegated to the client's own reconnectStrategy (production
   *  bridge). The connect() rejection is always caught, so a failed connect —
   *  or a destroy while connecting — can never become an unhandled rejection. */
  function spawn(): Connection | null {
    let client: RedisClientType;
    try {
      client = createClientFn();
    } catch (err) {
      reportClientError(err);
      return null;
    }
    wire(client);
    const connection: Connection = { client, invalidated: false };
    current = connection;
    client.connect().catch((err: unknown) => reportClientError(err));
    return connection;
  }

  spawn(); // initial connection (a synchronous factory throw is reported, not propagated)

  function ready(): boolean {
    if (disposed) return false;
    return current?.client.isReady === true;
  }

  function isTransportFault(connection: Connection, error: unknown): boolean {
    if (connection.invalidated) return true; // torn down by this runner
    if (!error || typeof error !== "object") return false;
    if (transportFaults.has(error)) return true;
    if (
      error instanceof ClientClosedError ||
      error instanceof ClientOfflineError ||
      error instanceof DisconnectsClientError ||
      error instanceof ConnectionTimeoutError ||
      error instanceof ReconnectStrategyError ||
      error instanceof SocketClosedUnexpectedlyError
    ) {
      return true;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && /^(ECONN|ENET|EHOST|ETIMEDOUT|EPIPE|EAI_)/.test(code);
  }

  /** Tear down one stuck connection and bring up a fresh one. SYNCHRONOUS and
   *  idempotent by connection identity: a later deadline callback observes
   *  current !== connection (or disposed) and is a no-op. Never respawns after
   *  dispose. */
  function resetTransport(connection: Connection): void {
    if (disposed || current !== connection) return;
    current = null; // new ops fail fast ("Redis is not available.") meanwhile
    connection.invalidated = true; // destroy-flush rejections map below
    try {
      connection.client.destroy(); // flushAll rejects every in-flight command
    } catch {
      /* already closed */
    }
    spawn();
  }

  async function execute<T>(
    operation: string,
    run: (client: RedisClientType) => Promise<T>,
  ): Promise<T> {
    const connection = current;
    if (disposed || !connection || !connection.client.isReady) {
      throw new StoreError("QUEUE_UNAVAILABLE", NOT_AVAILABLE_MESSAGE);
    }
    const client = connection.client;
    let settled = false;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new StoreError("QUEUE_UNAVAILABLE", OP_TIMEOUT_MESSAGE, {
            timeoutMs: opTimeoutMs,
            operation,
          }),
        );
        resetTransport(connection);
      }, opTimeoutMs);
      let runPromise: Promise<T>;
      try {
        // Hand the command to the client before any interleaving can reset the
        // connection; a synchronous sendCommand throw must not leak the timer
        // or spuriously reset a healthy connection.
        runPromise = run(client);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
        return;
      }
      runPromise.then(
        (value) => {
          if (settled) return; // late success after the deadline: ignored
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return; // late failure after the deadline: already reported
          settled = true;
          clearTimeout(timer);
          if (isTransportFault(connection, error)) {
            reject(
              new StoreError("QUEUE_UNAVAILABLE", TRANSPORT_FAULT_MESSAGE, {
                operation,
                cause: String(error),
              }),
            );
          } else {
            reject(error); // RESP reply errors (e.g. NOSCRIPT) keep flowing through
          }
        },
      );
    });
  }

  return {
    ready,
    async get(key) {
      return execute("GET", async (client) => {
        const v = await client.sendCommand(["GET", key]);
        return v === null ? null : String(v);
      });
    },
    async set(key, value) {
      await execute("SET", async (client) => {
        await client.sendCommand(["SET", key, value]);
      });
    },
    async xaddStream(payload) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(payload)) parts.push(k, String(v));
      return execute("XADD", async (client) => {
        const out = await client.sendCommand(["XADD", KEY_STREAM, "*", ...parts]);
        return String(out);
      });
    },
    async xlen() {
      return execute("XLEN", async (client) => {
        const out = await client.sendCommand(["XLEN", KEY_STREAM]);
        return typeof out === "number" ? out : Number(out);
      });
    },
    async xrange(key, afterExclusive, count) {
      return execute("XRANGE", async (client) => {
        const out = await client.sendCommand([
          "XRANGE",
          key,
          `(${afterExclusive}`,
          "+",
          "COUNT",
          String(count),
        ]);
        const rows = Array.isArray(out) ? out : [];
        return rows.map((row) => {
          const arr = Array.isArray(row) ? row : [];
          const id = arr[0] === null ? "" : String(arr[0]);
          const flat = (Array.isArray(arr[1]) ? arr[1] : []) as unknown[];
          const fields = flat.map((f) => (f === null ? "" : String(f)));
          return [id, fields] as [string, string[]];
        });
      });
    },
    async scriptLoad(script) {
      return execute("SCRIPT LOAD", async (client) => {
        const out = await client.sendCommand(["SCRIPT", "LOAD", script]);
        return String(out);
      });
    },
    async evalsha(sha, keyCount, keys, args) {
      return execute("EVALSHA", async (client) => {
        const out = await client.sendCommand([
          "EVALSHA",
          sha,
          String(keyCount),
          ...keys,
          ...args,
        ]);
        return String(out);
      });
    },
    async scriptExists(sha) {
      return execute("SCRIPT EXISTS", async (client) => {
        const res = await client.sendCommand(["SCRIPT", "EXISTS", sha]);
        const arr = Array.isArray(res) ? res.map(String) : [String(res)];
        return arr.includes("1");
      });
    },
    async flush() {
      await execute("FLUSHALL", async (client) => {
        await client.sendCommand(["FLUSHALL"]);
      });
    },
    async dispose(): Promise<void> {
      disposed = true;
      const connection = current;
      current = null;
      if (connection) {
        connection.invalidated = true; // any pending op now rejects QUEUE_UNAVAILABLE
        try {
          connection.client.destroy();
        } catch {
          /* already closed */
        }
      }
    },
  };
}