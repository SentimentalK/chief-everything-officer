import {
  KEY_STREAM,
  requestKey,
  jobKey,
  JOBS_SCHEMA_VERSION,
  type RequestPlaceholder,
  type PersistedJobRecord,
  type NormalizedSubmit,
} from "./schema.js";
import type { RedisClientType } from "redis";

export interface AuthScope {
  user_id: string;
  workspace_id: string;
}

/** Decision returned by the atomic creation Lua. */
export type CommitDecision = "NEW" | "REPLAY" | "CONFLICT" | "INCOMPLETE";

/**
 * Minimal seam over the shared Redis connection so the store can be driven by a
 * real client in CI and by recording fakes in fault-injection/unit tests. The
 * production adapter has offline queues disabled and a bounded connect timeout;
 * it never silently queues a command after an error has been surfaced.
 */
export interface RedisRunner {
  ready(): boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Append a single-entry Redis Stream and return its entry id. */
  xaddStream(payload: Record<string, string | number>): Promise<string>;
  /** Load a Lua script; returns its sha1. */
  scriptLoad(script: string): Promise<string>;
  /** EVALSHA for our script; caller manages NOSCRIPT by reload-then-retry. */
  evalsha(sha: string, keyCount: number, keys: string[], args: string[]): Promise<unknown>;
  /** Check whether a sha is still cached (Redis restart clears the cache). */
  scriptExists(sha: string): Promise<boolean>;
}

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const CREATE_SCRIPT = `
-- KEYS[1] = requestKey(user,ws,request)
-- ARGV[1] = business digest
-- ARGV[2] = JSON prepared record (status 'preparing', stream_entry_id null)
-- ARGV[3] = job_id
-- ARGV[4] = schema_version string
return (function(redis)
  local req = redis.call('GET', KEYS[1])
  if req then
    local ph = cjson.decode(req)
    local job = redis.call('GET', 'ceo:job:' .. ph.job_id)
    if not job then return 'INCOMPLETE' end
    local jd = cjson.decode(job)
    if jd.request_digest ~= ARGV[1] then return 'CONFLICT' end
    if jd.status ~= 'queued' or jd.stream_entry_id == '' or jd.stream_entry_id == nil then
      return 'INCOMPLETE'
    end
    return 'REPLAY'
  end

  local job_id = ARGV[3]
  redis.call('SET', KEYS[1], cjson.encode({ job_id = job_id, request_digest = ARGV[1] }))
  local prepared = cjson.decode(ARGV[2])
  redis.call('SET', 'ceo:job:' .. job_id, cjson.encode(prepared))
  local entry = redis.call('XADD', 'ceo:jobs', '*',
    'schema_version', tostring(ARGV[4]),
    'job_id', job_id,
    'user_id', prepared.user_id,
    'workspace_id', prepared.workspace_id)
  prepared.status = 'queued'
  prepared.stream_entry_id = entry
  redis.call('SET', 'ceo:job:' .. job_id, cjson.encode(prepared))
  return 'NEW'
end)(redis)
`;

export class RedisJobStore {
  constructor(private readonly redis: RedisRunner) {}

  isReady(): boolean {
    return this.redis.ready();
  }

  private assertReady(): void {
    if (!this.redis.ready()) {
      throw new StoreError("QUEUE_UNAVAILABLE", "Redis is not available.");
    }
  }

  private async sha(): Promise<string> {
    const loaded = await Promise.resolve(this.redis.scriptLoad(CREATE_SCRIPT));
    return loaded;
  }

  private async evalCreate(scope: AuthScope, requestId: string, prepared: PersistedJobRecord): Promise<CommitDecision> {
    this.assertReady();
    const req = requestKey(scope.user_id, scope.workspace_id, requestId);
    let sha = await this.redis.scriptLoad(CREATE_SCRIPT);
    // NOSCRIPT clears the cache (e.g. Redis restart); reload then retry once.
    try {
      const res = await this.redis.evalsha(sha, 1, [req], [
        prepared.request_digest,
        JSON.stringify(prepared),
        prepared.job_id,
        String(JOBS_SCHEMA_VERSION),
      ]);
      return normalizeDecision(res);
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
      if (code === "NOSCRIPT") {
        sha = await this.redis.scriptLoad(CREATE_SCRIPT);
        const res = await this.redis.evalsha(sha, 1, [req], [
          prepared.request_digest,
          JSON.stringify(prepared),
          prepared.job_id,
          String(JOBS_SCHEMA_VERSION),
        ]);
        return normalizeDecision(res);
      }
      throw new StoreError("QUEUE_UNAVAILABLE", "Redis EVALSHA failed.", { cause: String(error) });
    }
  }

  /** Atomic fast-path submit used by production (one Job + one stream message). */
  async submit(scope: AuthScope, requestId: string, prepared: PersistedJobRecord): Promise<CommitDecision> {
    return this.evalCreate(scope, requestId, prepared);
  }

  private async readJob(jobId: string): Promise<PersistedJobRecord | null> {
    const raw = await this.redis.get(jobKey(jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedJobRecord;
    } catch {
      return null;
    }
  }

  private async readPlaceholder(scope: AuthScope, requestId: string): Promise<RequestPlaceholder | null> {
    const raw = await this.redis.get(requestKey(scope.user_id, scope.workspace_id, requestId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RequestPlaceholder;
    } catch {
      return null;
    }
  }

  async getPlaceholder(scope: AuthScope, requestId: string): Promise<RequestPlaceholder | null> {
    return this.readPlaceholder(scope, requestId);
  }
  async getJob(jobId: string): Promise<PersistedJobRecord | null> {
    return this.readJob(jobId);
  }

  /**
   * Fault-tolerant staged commit used ONLY by tests and diagnostics. It mirrors
   * the authoritative order and can stop after any step to simulate a partial
   * write. `failAfterStep`: 0 = after request placeholder, 1 = after prepare
   * record, 2 = after stream add. Never reached in production.
   */
  async submitStaged(
    scope: AuthScope,
    requestId: string,
    prepared: PersistedJobRecord,
    failAfterStep?: 0 | 1 | 2,
  ): Promise<{ decision: CommitDecision; committed: boolean; jobId: string }> {
    this.assertReady();
    const req = requestKey(scope.user_id, scope.workspace_id, requestId);
    const job = jobKey(prepared.job_id);
    const existing = await this.readPlaceholder(scope, requestId);
    if (existing) {
      const rec = await this.readJob(existing.job_id);
      if (!rec) return { decision: "INCOMPLETE", committed: false, jobId: existing.job_id };
      if (rec.request_digest !== prepared.request_digest) {
        return { decision: "CONFLICT", committed: false, jobId: existing.job_id };
      }
      if (rec.status === "queued" && rec.stream_entry_id) {
        return { decision: "REPLAY", committed: true, jobId: rec.job_id };
      }
      return { decision: "INCOMPLETE", committed: false, jobId: existing.job_id };
    }

    // Step 0: placeholder
    await this.redis.set(req, JSON.stringify({ job_id: prepared.job_id, request_digest: prepared.request_digest }));
    if (failAfterStep !== undefined && failAfterStep <= 0) {
      return { decision: "INCOMPLETE", committed: false, jobId: prepared.job_id };
    }

    // Step 1: prepare record
    await this.redis.set(job, JSON.stringify(prepared));
    if (failAfterStep !== undefined && failAfterStep <= 1) {
      return { decision: "INCOMPLETE", committed: false, jobId: prepared.job_id };
    }

    // Step 2: stream add
    const entry = await this.redis.xaddStream({
      schema_version: JOBS_SCHEMA_VERSION,
      job_id: prepared.job_id,
      user_id: scope.user_id,
      workspace_id: scope.workspace_id,
    });
    if (failAfterStep !== undefined && failAfterStep <= 2) {
      return { decision: "INCOMPLETE", committed: false, jobId: prepared.job_id };
    }

    // Step 3: authoritative final record (status queued + stream_entry_id).
    const final = { ...prepared, status: "queued" as const, stream_entry_id: entry };
    await this.redis.set(job, JSON.stringify(final));
    return { decision: "NEW", committed: true, jobId: prepared.job_id };
  }

  async close(): Promise<void> {
    // Provided client is owned by server lifecycle; no-op here.
  }
}

function normalizeDecision(res: unknown): CommitDecision {
  const s = typeof res === "string" ? res : String(res);
  if (s === "NEW" || s === "REPLAY" || s === "CONFLICT" || s === "INCOMPLETE") return s;
  throw new StoreError("QUEUE_UNAVAILABLE", `Unexpected commit decision from Lua: ${s}`);
}

/** Builds a real node-redis v5 adapter with offline queue disabled. */
export function createRedisRunnerFromClient(client: RedisClientType): RedisRunner {
  return {
    ready: () => typeof client.isReady === "boolean" ? client.isReady : (typeof client.isOpen === "boolean" && client.isOpen),
    async get(key) {
      const v = await client.get(key);
      return v === null ? null : String(v);
    },
    async set(key, value) {
      await client.set(key, value);
    },
    async xaddStream(payload) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(payload)) {
        parts.push(k, String(v));
      }
      const out = await client.sendCommand(["XADD", KEY_STREAM, "*", ...parts]);
      return String(out);
    },
    async scriptLoad(script) {
      if (typeof client.scriptLoad === "function") return String(await client.scriptLoad(script));
      // fallback via generic SCRIPT LOAD
      const out = await client.sendCommand(["SCRIPT", "LOAD", script]);
      return String(out);
    },
    async evalsha(sha, keyCount, keys, args) {
      const out = await client.sendCommand(["EVALSHA", sha, String(keyCount), ...keys, ...args]);
      return String(out);
    },
    async scriptExists(sha) {
      const res = await client.sendCommand(["SCRIPT", "EXISTS", sha]);
      const arr = Array.isArray(res) ? res.map(String) : [String(res)];
      return arr.includes("1");
    },
  };
}
