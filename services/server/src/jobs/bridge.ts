import { JobService, type JobAuthScope, type JobServiceDeps } from "./service.js";
import {
  RedisJobStore,
  StoreError,
  type RedisRunner,
  openNeutralRedisRunner,
} from "./redis-store.js";

export interface JobBridge {
  service: JobService | null;
  runner: RedisRunner | null;
  dispose(): Promise<void>;
}

export interface JobResourceExists {
  (scope: JobAuthScope, resourceId: string): Promise<boolean>;
}

const CONNECT_TIMEOUT_MS = 2000;

/**
 * Builds the optional worker-bridge job layer. When the bridge is disabled no
 * service is created (tools report BRIDGE_DISABLED). When enabled and a shared
 * runner is provided, it reuses that runner (lifecycle owned externally).
 * When enabled without a shared runner, we own ONE shared runner; HTTP startup
 * never blocks on the connect (client connects in the background).
 */
export function openJobBridge(
  cfg: { bridgeEnabled: boolean; redisUrl?: string },
  resourceExists?: JobResourceExists,
  sharedRunner?: RedisRunner | null,
): JobBridge {
  if (!cfg.bridgeEnabled) {
    return { service: null, runner: null, dispose: async () => void 0 };
  }
  if (sharedRunner) {
    const store = new RedisJobStore(sharedRunner);
    const service = new JobService({ store, resourceExists }, () => true);
    return {
      service,
      runner: sharedRunner,
      dispose: async () => void 0,
    };
  }
  if (!cfg.redisUrl) {
    // Enabled but misconfigured: not disabled; surface as unavailable forever.
    const never: RedisRunner = {
      ready: () => false,
      get: async () => null,
      set: async () => void 0,
      xlen: async () => 0,
      xrange: async () => {
        throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured.");
      },
      xrevrange: async () => {
        throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured.");
      },
      flush: async () => void 0,
      xaddStream: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      scriptLoad: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      evalsha: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      scriptExists: async () => false,
      zrangeWithScores: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
      zrem: async () => { throw new StoreError("QUEUE_UNAVAILABLE", "Redis URL not configured."); },
    };
    const deps: JobServiceDeps = { store: new RedisJobStore(never), resourceExists };
    return { service: new JobService(deps, () => true), runner: never, dispose: async () => void 0 };
  }

  const transport = openNeutralRedisRunner(cfg.redisUrl, {
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    opTimeoutMs: 2500,
    onClientError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`bridge: redis error: ${msg}\n`);
    },
  })!;
  const store = new RedisJobStore(transport.runner);
  const service = new JobService({ store, resourceExists }, () => true);
  return {
    service,
    runner: transport.runner,
    dispose: () => transport.dispose(),
  };
}
