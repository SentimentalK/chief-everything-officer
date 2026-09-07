import {
  KEY_STREAM,
  requestKey,
  jobKey,
  JOBS_SCHEMA_VERSION,
  type RequestPlaceholder,
  type PersistedJobRecord,
} from "./schema.js";
import type { RedisClientType } from "redis";

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

export class RedisJobStore {
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
      String(JOBS_SCHEMA_VERSION),
    ];
    let sha = await this.createScriptVia(redisLike);
    try {
      const res = await redisLike.evalsha(sha, 2, [req, KEY_STREAM], args);
      return normalizeDecision(res);
    } catch (error) {
      const cause = shapeOfError(error);
      if (cause.code === "NOSCRIPT") {
        sha = await this.createScriptVia(redisLike);
        const res = await redisLike.evalsha(sha, 2, [req, KEY_STREAM], args);
        return normalizeDecision(res);
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
      schema_version: JOBS_SCHEMA_VERSION,
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

/** Builds a real node-redis v5 adapter (offline queue disabled). */
export function createRedisRunnerFromClient(client: RedisClientType): RedisRunner {
  const ready = (): boolean => (typeof client.isReady === "boolean" ? client.isReady : client.isOpen);
  return {
    ready,
    async get(key) {
      const v = await client.get(key);
      return v === null ? null : String(v);
    },
    async set(key, value) {
      await client.set(key, value);
    },
    async xaddStream(payload) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(payload)) parts.push(k, String(v));
      if (!ready()) throw new StoreError("QUEUE_UNAVAILABLE", "Redis not ready for XADD.");
      const out = await client.sendCommand(["XADD", KEY_STREAM, "*", ...parts]);
      return String(out);
    },
    async xlen() {
      if (!ready()) throw new StoreError("QUEUE_UNAVAILABLE", "Redis not ready for XLEN.");
      const out = await client.sendCommand(["XLEN", KEY_STREAM]);
      return typeof out === "number" ? out : Number(out);
    },
    async scriptLoad(script) {
      if (!ready()) throw new StoreError("QUEUE_UNAVAILABLE", "Redis not ready for SCRIPT LOAD.");
      if (typeof client.scriptLoad === "function") return String(await client.scriptLoad(script));
      const out = await client.sendCommand(["SCRIPT", "LOAD", script]);
      return String(out);
    },
    async evalsha(sha, keyCount, keys, args) {
      // node-redis may surface NOSCRIPT with code 'NOSCRIPT' in cause.
      const out = await client.sendCommand(["EVALSHA", sha, String(keyCount), ...keys, ...args]);
      return String(out);
    },
    async scriptExists(sha) {
      const res = await client.sendCommand(["SCRIPT", "EXISTS", sha]);
      const arr = Array.isArray(res) ? res.map(String) : [String(res)];
      return arr.includes("1");
    },
    async flush() {
      await client.sendCommand(["FLUSHALL"]);
    },
  };
}