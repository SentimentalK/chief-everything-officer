import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { RedisJobStore, createRedisRunnerFromClient } from "../src/jobs/redis-store.js";
import { JobService } from "../src/jobs/service.js";
import { makeJobId, JOBS_SCHEMA_VERSION, businessDigest } from "../src/jobs/schema.js";

// Real-Redis integration. Managed by CI only. When CEO_REDIS_URL is absent we
// skip locally; the CI workflow asserts CEO_REDIS_URL is present before running
// so these can never silently pass without a Redis backend.
const URL = process.env.CEO_REDIS_URL;

const userA = { user_id: "usr_a", workspace_id: "ws_a" };
const userB = { user_id: "usr_b", workspace_id: "ws_b" };

interface Prepared {
  schema_version: number;
  job_id: string;
  request_id: string;
  user_id: string;
  workspace_id: string;
  workspace_ref: string;
  resource_id: string | null;
  prompt: string;
  acceptance: string;
  execution_timeout_seconds: number;
  request_digest: string;
  status: "preparing";
  stream_entry_id: null;
  created_at_ms: number;
  claim_deadline_ms: number;
}

function makePrepared(scope: typeof userA, reqId: string, note = "x"): { prepared: Prepared } {
  const prompt = `p-${note}`;
  const job_id = makeJobId();
  const now = Date.now();
  const request_digest = businessDigest({
    workspace_ref: "tools",
    prompt,
    acceptance: "accept",
    resource_id: null,
    execution_timeout_seconds: 120,
  });
  return {
    prepared: {
      schema_version: JOBS_SCHEMA_VERSION,
      job_id,
      request_id: reqId,
      user_id: scope.user_id,
      workspace_id: scope.workspace_id,
      workspace_ref: "tools",
      resource_id: null,
      prompt,
      acceptance: "accept",
      execution_timeout_seconds: 120,
      request_digest,
      status: "preparing",
      stream_entry_id: null,
      created_at_ms: now,
      claim_deadline_ms: now + 7 * 24 * 60 * 60 * 1000,
    },
  };
}

const submitPayload = (req: string, prompt = "p-x") => ({
  request_id: req,
  workspace_ref: "tools",
  prompt,
  acceptance: "accept",
  timeout_seconds: 120,
});

describe.skipIf(!URL)("worker queue (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let store: RedisJobStore;
  let serviceA: JobService;
  let serviceB: JobService;

  beforeAll(async () => {
    client = createClient({ url: URL, socket: { reconnectStrategy: false } });
    client.on("error", () => void 0);
    await client.connect();
    store = new RedisJobStore(createRedisRunnerFromClient(client));
    serviceA = new JobService({ store }, () => true);
    serviceB = new JobService({ store }, () => true);
    await store.resetForTest();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      // Leave the final durable job in place (no flush) for the workflow's
      // AOF restart-persistence assertion; just release our own connection.
      await client.quit();
    }
  });

  it("submit then get returns the same job", async () => {
    await store.resetForTest();
    const req = "123e4567-e89b-12d3-a456-426614174001";
    const res = await serviceA.submit(userA, submitPayload(req));
    expect(res.ok).toBe(true);
    const got = await serviceA.get(userA, { job_id: res.view!.job_id });
    expect(got.ok).toBe(true);
    expect(got.view!.job_id).toBe(res.view!.job_id);
    expect(res.view!.replayed).toBe(false);
    expect(got.view!.state).toBe("queued");
  });

  it("submitting one request concurrently yields exactly one job and one stream message", async () => {
    await store.resetForTest();
    const req = "123e4567-e89b-12d3-a456-426614174002";
    const results = await Promise.all(Array.from({ length: 8 }, () => serviceA.submit(userA, submitPayload(req))));
    expect(results.some((r) => r.ok)).toBe(true);
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r) => r.view!.job_id)).size).toBe(1);
    expect(await store.streamLength()).toBe(1);
  });

  it("same request_id with different content is rejected", async () => {
    await store.resetForTest();
    const req = "123e4567-e89b-12d3-a456-426614174003";
    const first = await serviceA.submit(userA, submitPayload(req));
    expect(first.ok).toBe(true);
    await expect(serviceA.submit(userA, submitPayload(req, "DIFFERENT"))).rejects.toThrow(/different content/i);
  });

  it("lost-response retry returns the original job replayed without a second stream entry", async () => {
    await store.resetForTest();
    const req = "123e4567-e89b-12d3-a456-426614174004";
    const a = await serviceA.submit(userA, submitPayload(req));
    expect(a.ok).toBe(true);
    const b = await serviceA.submit(userA, submitPayload(req));
    expect(b.ok).toBe(true);
    expect(b.view!.replayed).toBe(true);
    expect(b.view!.job_id).toBe(a.view!.job_id);
    expect(await store.streamLength()).toBe(1);
  });

  it("real-Lua diagnosis of prior incomplete states and no duplicate XADD", async () => {
    // For each staged partial shape plant it over the REAL keys, then drive the
    // REAL production Lua (store.submit directly) and assert incomplete diagnosis + no
    // additional stream entry. plantPartialForTest exists only for tests.
    const stages = ["placeholder", "prepare", "stream"] as const;
    for (const stage of stages) {
      await store.resetForTest();
      const req = `123e4567-e89b-12d3-a456-4266141740${10 + stage.length}`;
      const { prepared } = makePrepared(userA, req, stage);
      await store.plantPartialForTest(userA, req, prepared, stage);

      // 1. Direct call to production RedisJobStore.submit() must return INCOMPLETE decision from Lua
      const decision = await store.submit(userA, req, prepared as any);
      expect(decision).toBe("INCOMPLETE");

      // 2. Service-level submit on incomplete state must reject with QUEUE_UNAVAILABLE
      await expect(serviceA.submit(userA, submitPayload(req, prepared.prompt))).rejects.toThrow(/incomplete|not available/i);

      // 3. For placeholder/prepare there must be no committed queued job and no NEW
      // stream append beyond the planted one in the 'stream' case.
      const len = await store.streamLength();
      if (stage === "stream") {
        // plant stage writes one stream entry; neither Lua nor service adds another.
        expect(len).toBe(1);
      } else {
        expect(len).toBe(0);
      }
    }
  });

  it("cross-identity isolation and forged identity rejection", async () => {
    await store.resetForTest();
    const req = "123e4567-e89b-12d3-a456-426614174006";
    const a = await serviceA.submit(userA, submitPayload(req));
    expect(a.ok).toBe(true);
    await expect(serviceB.get(userB, { job_id: a.view!.job_id })).rejects.toThrow(/not found/i);
    // forged identity fields are unknown -> schema rejection (never honored)
    const forged = await serviceA.submit(userA, { ...submitPayload(req), user_id: "usr_evil", workspace_id: "ws_evil" });
    expect(forged.ok).toBe(false);
  });

  it("EVALSHA+NOSCRIPT reload after SCRIPT FLUSH on cached SHA reloads and retries", async () => {
    await store.resetForTest();
    // 1. Initial submit to populate cached SHA
    const req1 = "123e4567-e89b-12d3-a456-426614174007";
    const res1 = await serviceA.submit(userA, submitPayload(req1));
    expect(res1.ok).toBe(true);
    const cachedSha = store.getCachedShaForTest();
    expect(cachedSha).toBeTruthy();
    expect(await store["redis"].scriptExists(cachedSha!)).toBe(true);

    // 2. Real SCRIPT FLUSH in Redis: script cache is wiped
    await client.sendCommand(["SCRIPT", "FLUSH"]);
    expect(await store["redis"].scriptExists(cachedSha!)).toBe(false);

    // 3. Next submit uses the cached SHA, receives NOSCRIPT, triggers reload and retry
    const req2 = "123e4567-e89b-12d3-a456-426614174008";
    const res2 = await serviceA.submit(userA, submitPayload(req2));
    expect(res2.ok).toBe(true);
    expect(await store["redis"].scriptExists(store.getCachedShaForTest()!)).toBe(true);
  });

  it("7-day claim deadline is preserved and not renewed on lost-response retry", async () => {
    await store.resetForTest();
    let currentNow = 1700000000000;
    const timeService = new JobService({ store, nowMs: () => currentNow }, () => true);

    const req = "123e4567-e89b-12d3-a456-426614174020";
    const res1 = await timeService.submit(userA, submitPayload(req));
    expect(res1.ok).toBe(true);
    const originalExpiresAt = res1.view!.expires_at;

    // Advance simulated time by 2 days
    currentNow += 2 * 24 * 60 * 60 * 1000;

    // Retry identical request
    const res2 = await timeService.submit(userA, submitPayload(req));
    expect(res2.ok).toBe(true);
    expect(res2.view!.replayed).toBe(true);
    expect(res2.view!.expires_at).toBe(originalExpiresAt);

    // Query via get: expires_at must still be the original deadline
    const got = await timeService.get(userA, { job_id: res1.view!.job_id });
    expect(got.ok).toBe(true);
    expect(got.view!.expires_at).toBe(originalExpiresAt);
  });

  it("multi-workspace isolation: same user across different workspaces does not collide or cross-read", async () => {
    await store.resetForTest();
    const userWorkspace1 = { user_id: "usr_alice", workspace_id: "ws_alpha" };
    const userWorkspace2 = { user_id: "usr_alice", workspace_id: "ws_beta" };

    const serviceWs1 = new JobService({ store }, () => true);
    const serviceWs2 = new JobService({ store }, () => true);

    const req = "123e4567-e89b-12d3-a456-426614174030";

    // Same user, same request_id, but different workspace: each gets its own independent job
    const res1 = await serviceWs1.submit(userWorkspace1, submitPayload(req, "job alpha"));
    const res2 = await serviceWs2.submit(userWorkspace2, submitPayload(req, "job beta"));

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.view!.job_id).not.toBe(res2.view!.job_id);

    // ws_alpha cannot read ws_beta job, and vice versa
    await expect(serviceWs1.get(userWorkspace1, { job_id: res2.view!.job_id })).rejects.toThrow(/not found/i);
    await expect(serviceWs2.get(userWorkspace2, { job_id: res1.view!.job_id })).rejects.toThrow(/not found/i);
  });

  it("surfaces QUEUE_UNAVAILABLE on disconnect", async () => {
    await store.resetForTest();
    const disconnectedClient = createClient({ url: "redis://127.0.0.1:6379", socket: { reconnectStrategy: false } });
    const disconnectedStore = new RedisJobStore(createRedisRunnerFromClient(disconnectedClient));
    const disconnectedService = new JobService({ store: disconnectedStore }, () => true);

    await expect(
      disconnectedService.submit(userA, submitPayload("123e4567-e89b-12d3-a456-426614174040")),
    ).rejects.toThrow(/QUEUE_UNAVAILABLE|not available/i);
  });
});
