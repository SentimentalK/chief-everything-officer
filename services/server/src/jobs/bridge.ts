import { createClient, type RedisClientType } from "redis";
import { JobService, type JobAuthScope, type JobServiceDeps } from "./service.js";
import { RedisJobStore, createRedisRunnerFromClient, StoreError } from "./redis-store.js";

export interface JobBridge {
  service: JobService | null;
  dispose(): Promise<void>;
}

export interface JobResourceExists {
  (scope: JobAuthScope, resourceId: string): Promise<boolean>;
}

const CONNECT_TIMEOUT_MS = 2000;

/**
 * Builds the optional worker-bridge job layer. When the bridge is disabled no
 * service is created (tools report BRIDGE_DISABLED). When enabled we own ONE
 * shared node-redis client with offline queue disabled and bounded connect/op
 * timeouts; readiness is read live so QUEUE_UNAVAILABLE is surfaced until the
 * backend recovers, after which tools become usable again. HTTP startup never
 * blocks on the connect (client connects in the background).
 */
export function openJobBridge(
  cfg: { bridgeEnabled: boolean; redisUrl?: string },
  resourceExists?: JobResourceExists,
): JobBridge {
  if (!cfg.bridgeEnabled) {
    return { service: null, dispose: async () => void 0 };
  }
  if (!cfg.redisUrl) {
    // Enabled but misconfigured: not disabled; surface as unavailable forever.
    const never = {
      ready: () => false,
      get: async () => null,
      set: async () => void 0,
      xlen: async () => 0,
      flush: async () => void 0,
      xaddStream: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      scriptLoad: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      evalsha: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      scriptExists: async () => false,
    };
    const deps: JobServiceDeps = { store: new RedisJobStore(never), resourceExists };
    return { service: new JobService(deps, () => true), dispose: async () => void 0 };
  }

  const client: RedisClientType = createClient({
    url: cfg.redisUrl,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Do not buffer offline commands: a datastore fault must surface as an
      // error, never silently commit after recovery.
      reconnectStrategy: (retries: number) => Math.min(retries * 500, 5000),
    },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 2,
  });
  // Swallow expected transport noise; readiness is reflected by client.isReady.
  client.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bridge: redis error: ${msg}\n`);
  });

  // Fire background connect; never block server listen.
  client.connect().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`bridge: redis connect deferred error: ${msg}\n`);
  });

  const runner = createRedisRunnerFromClient(client);
  const store = new RedisJobStore(runner);
  const service = new JobService({ store, resourceExists, nowMs: Date.now }, () => true);
  return {
    service,
    dispose: async () => {
      if (client.isOpen) {
        try {
          await client.quit();
        } catch {
          client.destroy();
        }
      }
    },
  };
}
