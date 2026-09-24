import {
  createClient,
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
  type RedisClientType,
} from "redis";
import { KEY_STREAM } from "./schema.js";

export interface NeutralRedisTransport {
  runner: RedisRunner;
  dispose(): Promise<void>;
}

export function openNeutralRedisRunner(
  redisUrl?: string,
  options?: {
    connectTimeoutMs?: number;
    opTimeoutMs?: number;
    onClientError?: (err: unknown) => void;
  },
): NeutralRedisTransport | null {
  if (!redisUrl) return null;
  const connectTimeout = options?.connectTimeoutMs ?? 2000;
  const runner = createRedisRunnerFromClient(
    () =>
      createClient({
        url: redisUrl,
        socket: {
          connectTimeout,
          reconnectStrategy: (retries: number) => Math.min(retries * 500, 5000),
        },
        disableOfflineQueue: true,
        commandsQueueMaxLength: 64,
      }),
    {
      opTimeoutMs: options?.opTimeoutMs ?? DEFAULT_REDIS_OP_TIMEOUT_MS,
      onClientError: options?.onClientError ?? ((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`redis-runner: redis error: ${msg}\n`);
      }),
    },
  );

  return {
    runner,
    dispose: () => runner.dispose(),
  };
}

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
  /** XREVRANGE over a stream from a high bound (exclusive if beforeExclusive is non-null, else +) down to - with a bounded COUNT. */
  xrevrange(key: string, beforeExclusive: string | null, count: number): Promise<Array<[string, string[]]>>;
  /** Load a Lua script; returns its sha1. */
  scriptLoad(script: string): Promise<string>;
  /** EVALSHA for our script; caller owns NOSCRIPT reload. */
  evalsha(sha: string, keyCount: number, keys: string[], args: string[]): Promise<unknown>;
  /** Check whether a sha is still cached (Redis restart clears the cache). */
  scriptExists(sha: string): Promise<boolean>;
  /** Remove keys+stream entries entirely (used ONLY by tests, never prod). */
  flush(): Promise<void>;
  /** ZRANGE over a ZSET with scores (start and stop are 0-based indices). */
  zrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
  /** ZREM members from a ZSET key; returns number of removed members. */
  zrem(key: string, ...members: string[]): Promise<number>;
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

export function isNoScriptError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const as = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (as.code === "NOSCRIPT" || as.cause?.code === "NOSCRIPT") return true;
  const msg = as.message ?? as.cause?.message;
  if (typeof msg === "string" && /^NOSCRIPT\b/i.test(msg.trim())) return true;
  return false;
}

export interface RedisRunnerOptions {
  opTimeoutMs?: number;
  /** Invoked for transport-level client/connect/factory errors (never for RESP reply errors). */
  onClientError?: (err: unknown) => void;
}

export const DEFAULT_REDIS_OP_TIMEOUT_MS = 2500;

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
    invalidated: boolean;
  }

  const transportFaults = new WeakSet<object>();

  let current: Connection | null = null;
  let disposed = false;

  function reportClientError(err: unknown): void {
    try {
      onClientError(err);
    } catch {
      /* ignore user callback failures */
    }
  }

  function wire(client: RedisClientType): void {
    client.on("error", (err: unknown) => {
      if (err && typeof err === "object") transportFaults.add(err);
      reportClientError(err);
    });
  }

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

  spawn();

  function ready(): boolean {
    if (disposed) return false;
    return current?.client.isReady === true;
  }

  function isTransportFault(connection: Connection, error: unknown): boolean {
    if (connection.invalidated) return true;
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

  function resetTransport(connection: Connection): void {
    if (disposed || current !== connection) return;
    current = null;
    connection.invalidated = true;
    try {
      connection.client.destroy();
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
        runPromise = run(client);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
        return;
      }
      runPromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
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
            reject(error);
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
    async xrevrange(key, beforeExclusive, count) {
      return execute("XREVRANGE", async (client) => {
        const end = beforeExclusive ? `(${beforeExclusive}` : "+";
        const out = await client.sendCommand([
          "XREVRANGE",
          key,
          end,
          "-",
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
    async zrangeWithScores(key, start, stop) {
      return execute("ZRANGE", async (client) => {
        const out = await client.sendCommand([
          "ZRANGE",
          key,
          String(start),
          String(stop),
          "WITHSCORES",
        ]);
        const rows = Array.isArray(out) ? out : [];
        const result: Array<{ member: string; score: number }> = [];
        for (let i = 0; i < rows.length; i += 2) {
          const member = String(rows[i]);
          const score = Number(rows[i + 1]);
          result.push({ member, score });
        }
        return result;
      });
    },
    async zrem(key, ...members) {
      if (members.length === 0) return 0;
      return execute("ZREM", async (client) => {
        const out = await client.sendCommand(["ZREM", key, ...members]);
        return typeof out === "number" ? out : Number(out);
      });
    },
    async dispose(): Promise<void> {
      disposed = true;
      const connection = current;
      current = null;
      if (connection) {
        connection.invalidated = true;
        try {
          connection.client.destroy();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
