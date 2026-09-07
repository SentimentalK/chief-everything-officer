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
    // REAL production Lua (store.submit) and assert incomplete diagnosis + no
    // additional stream entry. plantPartialForTest exists only for tests.
    const stages = ["placeholder", "prepare", "stream"] as const;
    for (const stage of stages) {
      await store.resetForTest();
      const req = `123e4567-e89b-12d3-a456-4266141740${10 + stage.length}`;
      const { prepared } = makePrepared(userA, req, stage);
      await store.plantPartialForTest(userA, req, prepared, stage);
      await expect(serviceA.submit(userA, submitPayload(req, prepared.prompt))).rejects.toThrow(/incomplete|not available/i);
      // For placeholder/prepare there must be no committed queued job and no NEW
      // stream append beyond the planted one in the 'stream' case.
      const plantedStreamAppend = stage === "stream" ? 0 : 0;
      void plantedStreamAppend;
      // The real Lua path returns INCOMPLETE and must not XADD a NEW entry.
      const len = await store.streamLength();
      if (stage === "stream") {
        // plant stage writes one stream entry; a submit must not add another.
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

  it("EVALSHA+NOSCRIPT reload after SCRIPT FLUSH still submits", async () => {
    await store.resetForTest();
    await client.sendCommand(["SCRIPT", "FLUSH"]);
    const req = "123e4567-e89b-12d3-a456-426614174007";
    const res = await serviceA.submit(userA, submitPayload(req));
    expect(res.ok).toBe(true);
  });
});
