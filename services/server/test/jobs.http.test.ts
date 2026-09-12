import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, type RedisClientType } from "redis";
import { createIdentityAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import { createJobAssignmentRouter } from "../src/jobs/router.js";
import { JobService, JobError, type AssignmentResult } from "../src/jobs/service.js";
import {
  RedisJobStore,
  StoreError,
  createRedisRunnerFromClient,
  type RedisRunner,
} from "../src/jobs/redis-store.js";
import {
  jobKey,
  requestKey,
  KEY_STREAM,
} from "../src/jobs/schema.js";
import { fixture, createIdentityService } from "./helpers.js";
import type { IdentityService } from "../src/identity/service.js";

const URL = process.env.CEO_REDIS_URL;
const API_KEY = "http-jobs-key";
const JOB = "job-123e4567-e89b-12d3-a456-426614174000";
const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ATT = "123e4567-e89b-12d3-a456-4266141740ab";
const TOKEN = "c".repeat(64);

const claimBody = () => ({ worker_id: WRK, attempt_id: ATT, workspace_ref: "tools", claim_token: TOKEN });

const cleanupDirs: string[] = [];
const cleanupServers: HttpServer[] = [];
const cleanupServices: IdentityService[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const svc of cleanupServices.splice(0)) svc.close();
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Thin test double standing in for the real JobService under test. */
function stubService(
  impl: {
    claim?: (scope: unknown, jobId: string, body: unknown) => Promise<AssignmentResult> | AssignmentResult;
    start?: (scope: unknown, jobId: string, body: unknown) => Promise<AssignmentResult> | AssignmentResult;
  },
): JobService {
  return {
    claim: async (s, j, b) => (impl.claim ? await impl.claim(s, j, b) : errCode("INVALID_INPUT")),
    start: async (s, j, b) => (impl.start ? await impl.start(s, j, b) : errCode("INVALID_INPUT")),
  } as unknown as JobService;
}

function okAssignment(patch: Record<string, unknown> = {}): AssignmentResult {
  return {
    ok: true,
    replayed: false,
    server_time: "2026-09-07T00:00:00.000Z",
    execution: {
      worker_id: WRK,
      attempt_id: ATT,
      phase: "claimed",
      claimed_at: "2026-09-07T00:00:00.000Z",
      started_at: null,
    },
    job: {
      job_id: JOB,
      workspace_ref: "tools",
      resource_id: null,
      prompt: "http prompt",
      acceptance: "http acceptance",
      timeout_seconds: 120,
    },
    ...patch,
  };
}

function errCode(code: string): never {
  throw new JobError(code as never, `boom ${code}`);
}

async function buildServer(
  service: JobService | null,
): Promise<{ baseUrl: string; identity: { user_id: string; workspace_id: string } }> {
  const item = await fixture();
  cleanupDirs.push(item.root);
  const identityService = createIdentityService(item.config, API_KEY);
  cleanupServices.push(identityService);

  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api/worker/jobs",
    createHostGuard(item.config.allowedHosts) as RequestHandler,
    createOriginGuard(item.config.allowedOrigins) as RequestHandler,
    createIdentityAuthMiddleware(identityService) as RequestHandler,
    createJobAssignmentRouter(service) as unknown as RequestHandler,
  );

  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanupServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, identity: identityService.workspaceIdentityValue };
}

async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const fake = (chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = fake as never;
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = orig as never;
  }
  return lines;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

describe("worker lease HTTP authentication", () => {
  it("rejects unauthenticated and wrong-key requests with 401 from the shared middleware", async () => {
    const { baseUrl } = await buildServer(stubService({}));
    const url = `${baseUrl}/api/worker/jobs/${JOB}/claim`;
    const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(claimBody()) });
    expect(noAuth.status).toBe(401);
    const badKey = await fetch(url, { method: "POST", headers: { Authorization: "Bearer not-the-key", "Content-Type": "application/json" }, body: JSON.stringify(claimBody()) });
    expect(badKey.status).toBe(401);
  });

  it("returns 503 when the bridge/service is disabled", async () => {
    const { baseUrl } = await buildServer(null);
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(claimBody()),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BRIDGE_DISABLED");
  });
});

describe("worker assignment HTTP input and routing", () => {
  it("returns INVALID_INPUT for a malformed job_id in the URL path", async () => {
    let called = false;
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => {
          called = true;
          return okAssignment();
        },
      }),
    );
    const res = await fetch(`${baseUrl}/api/worker/jobs/not-a-job/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(claimBody()),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
    expect(called).toBe(false);
  });

});

/** A real JobService whose Redis is never reachable (parse rejects first). */
function deadStoreService(): JobService {
  const runner = createRedisRunnerFromClient(
    () => {
      throw new Error("never connect");
    },
    { opTimeoutMs: 50 },
  );
  return new JobService({ store: new RedisJobStore(runner) }, () => true);
}

describe("worker assignment HTTP strict input validation (real schema, not a throw-all mock)", () => {
  // These drive the real workerClaimSchema / workerStartSchema through
  // an actual JobService. Because schema rejection happens before any backend
  // access, an invalid body must yield INVALID_INPUT (400) even though the
  // store is never reachable - never a QUEUE_UNAVAILABLE (503).
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "forged user_id (unknown field)", body: { ...claimBody(), user_id: "usr_evil" } },
    { name: "forged workspace_id (unknown field)", body: { ...claimBody(), workspace_id: "ws_evil" } },
    { name: "missing attempt_id", body: { worker_id: WRK, workspace_ref: "tools", claim_token: TOKEN } },
    { name: "malformed worker_id", body: { ...claimBody(), worker_id: "wrk-NOTHEX" } },
    { name: "malformed claim_token", body: { ...claimBody(), claim_token: "not-hex" } },
    { name: "legacy lease_token rejected", body: { worker_id: WRK, attempt_id: ATT, workspace_ref: "tools", lease_token: TOKEN } },
    { name: "malformed workspace_ref", body: { ...claimBody(), workspace_ref: "tools/../evil" } },
  ];
  for (const c of cases) {
    it(`rejects claim with ${c.name} as INVALID_INPUT via the real schema`, async () => {
      const { baseUrl } = await buildServer(deadStoreService());
      const lines = await captureStderr(async () => {
        const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(c.body),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
      });
      const joined = lines.join("");
      expect(joined).not.toContain("usr_evil");
      expect(joined).not.toContain(TOKEN);
    });
  }

  it("rejects unknown fields on start (real schema)", async () => {
    const { baseUrl } = await buildServer(deadStoreService());
    const body = { worker_id: WRK, attempt_id: ATT, claim_token: TOKEN, lease_duration_ms: 1234 };
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/start`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("rejects legacy lease_token on start (real schema)", async () => {
    const { baseUrl } = await buildServer(deadStoreService());
    const body = { worker_id: WRK, attempt_id: ATT, lease_token: TOKEN };
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/start`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("a schema-valid claim on an unreachable backend is QUEUE_UNAVAILABLE, not a validation error", async () => {
    // Proves the real service validated the body successfully and only then hit
    // the (never-ready) backend - distinguishing validation from availability.
    const { baseUrl } = await buildServer(deadStoreService());
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(claimBody()),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("QUEUE_UNAVAILABLE");
  });
});

describe("worker discovery HTTP (GET /pending)", () => {
  const JOB2 = "job-123e4567-e89b-12d3-a456-426614174001";

  it("requires authentication (401)", async () => {
    const { baseUrl } = await buildServer(stubService({}));
    const res = await fetch(`${baseUrl}/api/worker/jobs/pending?workspace_ref=tools`);
    expect(res.status).toBe(401);
  });

  it("validates query parameters through the real schema (never QUEUE_UNAVAILABLE)", async () => {
    const { baseUrl } = await buildServer(deadStoreService());
    const bad: Array<[string, number]> = [
      [`?workspace_ref=tools&after=not-a-cursor`, 400],
      [`?workspace_ref=tools&extra=1`, 400], // unknown param
      [`?workspace_ref=`, 400], // missing/empty required alias
      [`?after=0-0`, 400], // missing workspace_ref
    ];
    for (const [qs, expected] of bad) {
      const res = await fetch(`${baseUrl}/api/worker/jobs/pending${qs}`, { headers: authHeaders() });
      expect(res.status).toBe(expected);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
    }
  });

  it("a schema-valid pending query on an unreachable backend is QUEUE_UNAVAILABLE", async () => {
    const { baseUrl } = await buildServer(deadStoreService());
    const res = await fetch(`${baseUrl}/api/worker/jobs/pending?workspace_ref=tools`, { headers: authHeaders() });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("QUEUE_UNAVAILABLE");
  });

  it("returns a strict discovery envelope and no-store without leaking task content", async () => {
    const service = {
      pending: async () => ({
        ok: true as const,
        jobs: [
          {
            job_id: JOB2,
            workspace_ref: "tools",
            resource_id: null,
            created_at: "2026-09-07T00:00:00.000Z",
            expires_at: "2026-09-14T00:00:00.000Z",
          },
        ],
        next_cursor: "1788816855488-0",
        has_more: true,
      }),
    } as unknown as JobService;
    const { baseUrl } = await buildServer(service);
    const res = await fetch(`${baseUrl}/api/worker/jobs/pending?workspace_ref=tools`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect((body.jobs as Array<Record<string, unknown>>)[0]!.job_id).toBe(JOB2);
    expect(body.next_cursor).toBe("1788816855488-0");
    expect(body.has_more).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("acceptance");
  });
});

describe("worker assignment HTTP success output whitelist + no-store", () => {
  it("returns claim output that is a strict whitelist (no token/hash/secret extras)", async () => {
    const secretMarker = "TOP_SECRET_MARKER";
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => {
          const result = okAssignment();
          (result as unknown as Record<string, unknown>).secret = secretMarker;
          return result;
        },
      }),
    );
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(claimBody()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.job).toBeTruthy();
    expect(body.execution).toBeTruthy();
    // Whitelist: raw token never appears and the injected secret marker is dropped.
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(secretMarker);
    expect(text).not.toContain("claim_token_sha256");
    expect(text).not.toContain("lease_expires_at");
    expect(text).not.toContain("start_deadline");
    expect(text).not.toContain("execution_deadline");
    // Full prompt IS returned for claim (job target), but never the token.
    expect((body.job as Record<string, unknown>).prompt).toBeTruthy();
  });

  it("successful calls log only allow-listed fields, never the token", async () => {
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => okAssignment(),
      }),
    );
    const lines = await captureStderr(async () => {
      const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(200);
    });
    const joined = lines.join("");
    expect(joined).not.toContain(TOKEN);
    expect(joined).toContain("job-assignment");
    expect(joined).toContain(JOB);
    expect(joined).toContain(WRK);
  });
});

describe("worker assignment HTTP error mapping", () => {
  const cases: Array<{ code: string; status: number }> = [
    { code: "JOB_NOT_FOUND", status: 404 },
    { code: "JOB_EXPIRED", status: 409 },
    { code: "JOB_ALREADY_CLAIMED", status: 409 },
    { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    { code: "JOB_NOT_CLAIMED", status: 409 },
    { code: "ASSIGNMENT_MISMATCH", status: 409 },
    { code: "WORKSPACE_MISMATCH", status: 409 },
    { code: "QUEUE_UNAVAILABLE", status: 503 },
  ];
  for (const c of cases) {
    it(`maps ${c.code} to HTTP ${c.status}`, async () => {
      const { baseUrl } = await buildServer(
        stubService({
          start: async () => {
            throw new JobError(c.code as never, "msg");
          },
        }),
      );
      const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, claim_token: TOKEN }),
      });
      expect(res.status).toBe(c.status);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(c.code);
      expect(typeof body.message).toBe("string");
    });
  }

  it("includes a details.reason only when a diagnostic reason is present", async () => {
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => {
          throw new JobError("QUEUE_UNAVAILABLE", "corrupt", { reason: "CORRUPT_RECORD" });
        },
      }),
    );
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(claimBody()),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; details?: { reason?: string } };
    expect(body.code).toBe("QUEUE_UNAVAILABLE");
    expect(body.details?.reason).toBe("CORRUPT_RECORD");
  });

  it("start success carries replayed and phase running", async () => {
    const { baseUrl } = await buildServer(
      stubService({
        start: async () =>
          okAssignment({ replayed: true, execution: { ...okAssignment().execution, phase: "running" } }),
      }),
    );
    const start = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/start`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, claim_token: TOKEN }),
    });
    const startBody = (await start.json()) as { replayed: boolean; execution: { phase: string } };
    expect(start.status).toBe(200);
    expect(startBody.replayed).toBe(true);
    expect(startBody.execution.phase).toBe("running");
  });

  it("heartbeat endpoint returns 404 (removed from router)", async () => {
    const { baseUrl } = await buildServer(stubService({}));
    const hb = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/heartbeat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, claim_token: TOKEN }),
    });
    expect(hb.status).toBe(404);
  });
});

async function pendingJobs(baseUrl: string) {
  const response = await fetch(
    `${baseUrl}/api/worker/jobs/pending?workspace_ref=tools&after=0-0`,
    { headers: authHeaders() },
  );

  expect(response.status).toBe(200);
  return (await response.json()) as {
    ok: boolean;
    jobs: Array<{
      job_id: string;
      workspace_ref: string;
      resource_id: string | null;
      prompt: string;
      acceptance: string;
      timeout_seconds: number;
      created_at: string;
      expires_at: string;
    }>;
    next_cursor: string | null;
    has_more: boolean;
  };
}

describe.skipIf(!URL)("worker assignment HTTP integration (real Redis, CI-gated)", () => {
  let client: RedisClientType;
  let runner: RedisRunner & { dispose(): Promise<void> };
  let store: RedisJobStore;
  let service: JobService;

  beforeAll(async () => {
    client = createClient({ url: URL, socket: { reconnectStrategy: false } });
    client.on("error", () => void 0);
    await client.connect();

    runner = createRedisRunnerFromClient(
      () =>
        createClient({
          url: URL,
          socket: { reconnectStrategy: false },
          disableOfflineQueue: true,
        }),
      { opTimeoutMs: 2500 },
    );

    const waitForReady = (ms = 5000) =>
      new Promise<void>((resolve, reject) => {
        const s = Date.now();
        const tick = () => {
          if (runner.ready()) return resolve();
          if (Date.now() - s > ms) return reject(new Error("runner not ready"));
          setTimeout(tick, 20);
        };
        tick();
      });

    try {
      await waitForReady();
      store = new RedisJobStore(runner);
      service = new JobService({ store }, () => true);
    } catch (err) {
      await runner.dispose();
      throw err;
    }
  });

  afterAll(async () => {
    await runner?.dispose();
    if (client?.isOpen) await client.quit();
  });

  it("completes full assignment protocol lifecycle: submit, claim, start, replays, and persists status", async () => {
    const { baseUrl, identity } = await buildServer(service);
    const requestId = "123e4567-e89b-12d3-a456-426614174101";
    let jobId = "";
    const promptText = "integration prompt text";
    const acceptanceText = "integration acceptance text";

    try {
      // 1. Submit job
      const submitRes = await service.submit(identity, {
        request_id: requestId,
        workspace_ref: "tools",
        prompt: promptText,
        acceptance: acceptanceText,
        timeout_seconds: 120,
      });
      expect(submitRes.ok).toBe(true);
      jobId = submitRes.view!.job_id;

      // Dedupe and stream snapshot before claim
      const dedupeKey = requestKey(identity.user_id, identity.workspace_id, requestId);
      const dedupeBeforeClaim = await client.get(dedupeKey);
      const streamBeforeClaim = await store.readStreamEntries("0-0", 100);

      // 2. Confirmed in pending queue via HTTP helper
      const pending1 = await pendingJobs(baseUrl);
      expect(pending1.jobs.some((j) => j.job_id === jobId)).toBe(true);

      const EXPECTED_EXECUTION_KEYS = ["attempt_id", "claimed_at", "phase", "started_at", "worker_id"];

      let firstClaimedAt = "";
      let firstStartedAt = "";

      const logs = await captureStderr(async () => {
        // 3. HTTP claim with valid claim_token
        const claimRes = await fetch(`${baseUrl}/api/worker/jobs/${jobId}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            worker_id: WRK,
            attempt_id: ATT,
            workspace_ref: "tools",
            claim_token: TOKEN,
          }),
        });
        expect(claimRes.status).toBe(200);
        const claimBody = (await claimRes.json()) as {
          ok: boolean;
          replayed: boolean;
          execution: {
            phase: string;
            worker_id: string;
            attempt_id: string;
            claimed_at: string;
            started_at: string | null;
          };
          job: Record<string, unknown>;
        };
        expect(claimBody.ok).toBe(true);
        expect(claimBody.replayed).toBe(false);
        expect(claimBody.execution.phase).toBe("claimed");
        expect(claimBody.execution.worker_id).toBe(WRK);
        expect(claimBody.execution.attempt_id).toBe(ATT);
        expect(claimBody.execution.started_at).toBeNull();
        expect(claimBody.execution.claimed_at).toBeTruthy();
        firstClaimedAt = claimBody.execution.claimed_at;

        // Check exact execution keys
        expect(Object.keys(claimBody.execution).sort()).toEqual(EXPECTED_EXECUTION_KEYS);

        // Verify returned job fields whitelist
        const jobKeys = Object.keys(claimBody.job).sort();
        expect(jobKeys).toEqual(["acceptance", "job_id", "prompt", "resource_id", "timeout_seconds", "workspace_ref"]);
        expect(claimBody.job.job_id).toBe(jobId);
        expect(claimBody.job.workspace_ref).toBe("tools");
        expect(claimBody.job.prompt).toBe(promptText);
        expect(claimBody.job.acceptance).toBe(acceptanceText);
        expect(claimBody.job.timeout_seconds).toBe(120);
        expect(claimBody.job.resource_id).toBeNull();
        expect(claimBody.job).not.toHaveProperty("user_id");
        expect(claimBody.job).not.toHaveProperty("workspace_id");
        expect(claimBody.job).not.toHaveProperty("claim_token");
        expect(claimBody.job).not.toHaveProperty("claim_token_sha256");

        // Verify SHA-256 hash in Redis, no plaintext token
        const rawInRedis = JSON.parse((await client.get(jobKey(jobId)))!);
        const expectedTokenHash = createHash("sha256").update(TOKEN, "utf8").digest("hex");
        expect(rawInRedis.execution.claim_token_sha256).toBe(expectedTokenHash);
        expect(JSON.stringify(rawInRedis)).not.toContain(TOKEN);

        // Dedupe and stream after claim: verify no duplicate queueing or dedupe mutation
        const dedupeAfterClaim = await client.get(dedupeKey);
        const streamAfterClaim = await store.readStreamEntries("0-0", 100);
        expect(dedupeAfterClaim).toBe(dedupeBeforeClaim);
        expect(streamAfterClaim).toEqual(streamBeforeClaim);

        // 4. Replay identical claim request
        const replayClaimRes = await fetch(`${baseUrl}/api/worker/jobs/${jobId}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            worker_id: WRK,
            attempt_id: ATT,
            workspace_ref: "tools",
            claim_token: TOKEN,
          }),
        });
        expect(replayClaimRes.status).toBe(200);
        const replayClaimBody = (await replayClaimRes.json()) as {
          ok: boolean;
          replayed: boolean;
          execution: {
            phase: string;
            worker_id: string;
            attempt_id: string;
            claimed_at: string;
            started_at: string | null;
          };
        };
        expect(replayClaimBody.ok).toBe(true);
        expect(replayClaimBody.replayed).toBe(true);
        expect(replayClaimBody.execution.phase).toBe("claimed");
        expect(replayClaimBody.execution.worker_id).toBe(WRK);
        expect(replayClaimBody.execution.attempt_id).toBe(ATT);
        expect(replayClaimBody.execution.claimed_at).toBe(firstClaimedAt);
        expect(replayClaimBody.execution.started_at).toBeNull();
        expect(Object.keys(replayClaimBody.execution).sort()).toEqual(EXPECTED_EXECUTION_KEYS);

        // 5. HTTP start
        const startRes = await fetch(`${baseUrl}/api/worker/jobs/${jobId}/start`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            worker_id: WRK,
            attempt_id: ATT,
            claim_token: TOKEN,
          }),
        });
        expect(startRes.status).toBe(200);
        const startBody = (await startRes.json()) as {
          ok: boolean;
          replayed: boolean;
          execution: {
            phase: string;
            worker_id: string;
            attempt_id: string;
            claimed_at: string;
            started_at: string | null;
          };
        };
        expect(startBody.ok).toBe(true);
        expect(startBody.replayed).toBe(false);
        expect(startBody.execution.phase).toBe("running");
        expect(startBody.execution.claimed_at).toBe(firstClaimedAt);
        expect(startBody.execution.started_at).not.toBeNull();
        firstStartedAt = startBody.execution.started_at!;
        expect(Object.keys(startBody.execution).sort()).toEqual(EXPECTED_EXECUTION_KEYS);

        // 6. Replay HTTP start
        const replayStartRes = await fetch(`${baseUrl}/api/worker/jobs/${jobId}/start`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            worker_id: WRK,
            attempt_id: ATT,
            claim_token: TOKEN,
          }),
        });
        expect(replayStartRes.status).toBe(200);
        const replayStartBody = (await replayStartRes.json()) as {
          ok: boolean;
          replayed: boolean;
          execution: {
            phase: string;
            worker_id: string;
            attempt_id: string;
            claimed_at: string;
            started_at: string | null;
          };
        };
        expect(replayStartBody.ok).toBe(true);
        expect(replayStartBody.replayed).toBe(true);
        expect(replayStartBody.execution.phase).toBe("running");
        expect(replayStartBody.execution.claimed_at).toBe(firstClaimedAt);
        expect(replayStartBody.execution.started_at).toBe(firstStartedAt);
        expect(Object.keys(replayStartBody.execution).sort()).toEqual(EXPECTED_EXECUTION_KEYS);

        // 7. Replay HTTP claim after start
        const claimAfterStartRes = await fetch(`${baseUrl}/api/worker/jobs/${jobId}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            worker_id: WRK,
            attempt_id: ATT,
            workspace_ref: "tools",
            claim_token: TOKEN,
          }),
        });
        expect(claimAfterStartRes.status).toBe(200);
        const claimAfterStartBody = (await claimAfterStartRes.json()) as {
          ok: boolean;
          replayed: boolean;
          execution: {
            phase: string;
            worker_id: string;
            attempt_id: string;
            claimed_at: string;
            started_at: string | null;
          };
        };
        expect(claimAfterStartBody.ok).toBe(true);
        expect(claimAfterStartBody.replayed).toBe(true);
        expect(claimAfterStartBody.execution.phase).toBe("running");
        expect(claimAfterStartBody.execution.claimed_at).toBe(firstClaimedAt);
        expect(claimAfterStartBody.execution.started_at).toBe(firstStartedAt);
        expect(Object.keys(claimAfterStartBody.execution).sort()).toEqual(EXPECTED_EXECUTION_KEYS);
      });

      // Confirm logs don't leak token, prompt, or acceptance
      const joinedLogs = logs.join("");
      expect(joinedLogs).not.toContain(TOKEN);
      expect(joinedLogs).not.toContain(promptText);
      expect(joinedLogs).not.toContain(acceptanceText);

      // 8. Service get confirms running state and execution keys/timestamps
      const getRes = await service.get(identity, { job_id: jobId });
      expect(getRes.ok).toBe(true);
      expect(getRes.view?.state).toBe("running");
      expect(getRes.view?.execution?.claimed_at).toBe(firstClaimedAt);
      expect(getRes.view?.execution?.started_at).toBe(firstStartedAt);
      expect(Object.keys(getRes.view!.execution!).sort()).toEqual(EXPECTED_EXECUTION_KEYS);

      // 9. Pending list no longer contains this job
      const pendingAfter = await pendingJobs(baseUrl);
      expect(pendingAfter.jobs.some((j) => j.job_id === jobId)).toBe(false);
    } finally {
      if (jobId) await client.del(jobKey(jobId));
      await client.del(requestKey(identity.user_id, identity.workspace_id, requestId));
      await client.del(KEY_STREAM);
    }
  });

  it("first-claim deadline expires unclaimed jobs but never restricts execution of claimed jobs", async () => {
    const { baseUrl, identity } = await buildServer(service);
    const reqA = "123e4567-e89b-12d3-a456-426614174201";
    const reqB = "123e4567-e89b-12d3-a456-426614174202";
    let jobIdA = "";
    let jobIdB = "";

    try {
      // Scenario A: Unclaimed task past claim_deadline
      const submitA = await service.submit(identity, {
        request_id: reqA,
        workspace_ref: "tools",
        prompt: "task A prompt",
        acceptance: "task A acceptance",
        timeout_seconds: 60,
      });
      expect(submitA.ok).toBe(true);
      jobIdA = submitA.view!.job_id;

      const now = Date.now();
      const rawA = JSON.parse((await client.get(jobKey(jobIdA)))!);
      rawA.created_at_ms = now - 600_000;
      rawA.claim_deadline_ms = now - 300_000;
      await client.set(jobKey(jobIdA), JSON.stringify(rawA));

      // Filtered out from pending via HTTP helper
      const pendingA = await pendingJobs(baseUrl);
      expect(pendingA.jobs.some((j) => j.job_id === jobIdA)).toBe(false);

      // Claim rejected with 409 JOB_EXPIRED
      const claimResA = await fetch(`${baseUrl}/api/worker/jobs/${jobIdA}/claim`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          workspace_ref: "tools",
          claim_token: TOKEN,
        }),
      });
      expect(claimResA.status).toBe(409);
      const claimBodyA = (await claimResA.json()) as { code: string };
      expect(claimBodyA.code).toBe("JOB_EXPIRED");

      // Scenario B: Claimed task execution with historical claim_deadline
      const submitB = await service.submit(identity, {
        request_id: reqB,
        workspace_ref: "tools",
        prompt: "task B prompt",
        acceptance: "task B acceptance",
        timeout_seconds: 60,
      });
      expect(submitB.ok).toBe(true);
      jobIdB = submitB.view!.job_id;

      const claimResB = await fetch(`${baseUrl}/api/worker/jobs/${jobIdB}/claim`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          workspace_ref: "tools",
          claim_token: TOKEN,
        }),
      });
      expect(claimResB.status).toBe(200);

      // Tamper timestamps to 8 days ago:
      // maintaining: created_at < claimed_at < claim_deadline < now
      const rawB = JSON.parse((await client.get(jobKey(jobIdB)))!);
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      rawB.created_at_ms = eightDaysAgo - 20_000;
      rawB.execution.claimed_at_ms = eightDaysAgo - 10_000;
      rawB.claim_deadline_ms = eightDaysAgo;
      await client.set(jobKey(jobIdB), JSON.stringify(rawB));

      // Start succeeds despite expired claim_deadline
      const startResB = await fetch(`${baseUrl}/api/worker/jobs/${jobIdB}/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          claim_token: TOKEN,
        }),
      });
      expect(startResB.status).toBe(200);
      const startBodyB = (await startResB.json()) as { execution: { phase: string } };
      expect(startBodyB.execution.phase).toBe("running");

      // Replay start succeeds
      const replayStartResB = await fetch(`${baseUrl}/api/worker/jobs/${jobIdB}/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          claim_token: TOKEN,
        }),
      });
      expect(replayStartResB.status).toBe(200);
      const replayStartBodyB = (await replayStartResB.json()) as { replayed: boolean; execution: { phase: string } };
      expect(replayStartBodyB.replayed).toBe(true);
      expect(replayStartBodyB.execution.phase).toBe("running");
    } finally {
      if (jobIdA) await client.del(jobKey(jobIdA));
      await client.del(requestKey(identity.user_id, identity.workspace_id, reqA));
      if (jobIdB) await client.del(jobKey(jobIdB));
      await client.del(requestKey(identity.user_id, identity.workspace_id, reqB));
      await client.del(KEY_STREAM);
    }
  });

  it("rejects unsupported schema version records without silent conversion or migration hints", async () => {
    const { baseUrl, identity } = await buildServer(service);
    const reqV1 = "123e4567-e89b-12d3-a456-426614174301";
    const payloadV1 = {
      request_id: reqV1,
      workspace_ref: "tools",
      prompt: "v1 test prompt",
      acceptance: "v1 test acceptance",
      timeout_seconds: 60,
    };
    let jobIdV1 = "";

    try {
      // 1. Submit normal job with real service.submit
      const submitRes = await service.submit(identity, payloadV1);
      expect(submitRes.ok).toBe(true);
      jobIdV1 = submitRes.view!.job_id;

      // 2. Read full JobRecord
      const rawRec = JSON.parse((await client.get(jobKey(jobIdV1)))!);

      // 3. Only change schema_version to 1 and write back
      rawRec.schema_version = 1;
      await client.set(jobKey(jobIdV1), JSON.stringify(rawRec));

      // 4. Save snapshots
      const jobKeyV1 = jobKey(jobIdV1);
      const dedupeKeyV1 = requestKey(identity.user_id, identity.workspace_id, reqV1);
      const recordSnapshot = await client.get(jobKeyV1);
      const dedupeSnapshot = await client.get(dedupeKeyV1);
      const streamSnapshot = await store.readStreamEntries("0-0", 100);

      // 5. service.get throws UNSUPPORTED_SCHEMA_VERSION with exact sanitized message
      await expect(service.get(identity, { job_id: jobIdV1 })).rejects.toMatchObject({
        code: "QUEUE_UNAVAILABLE",
        message: "Job record schema version is not supported by this server.",
        details: { reason: "UNSUPPORTED_SCHEMA_VERSION" },
      });

      // 6. Replaying submit throws same UNSUPPORTED_SCHEMA_VERSION error
      await expect(service.submit(identity, payloadV1)).rejects.toMatchObject({
        code: "QUEUE_UNAVAILABLE",
        message: "Job record schema version is not supported by this server.",
        details: { reason: "UNSUPPORTED_SCHEMA_VERSION" },
      });

      // 7. HTTP claim returns 503 UNSUPPORTED_SCHEMA_VERSION
      const claimRes = await fetch(`${baseUrl}/api/worker/jobs/${jobIdV1}/claim`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          workspace_ref: "tools",
          claim_token: TOKEN,
        }),
      });
      expect(claimRes.status).toBe(503);
      const claimBody = (await claimRes.json()) as { code: string; message: string; details?: { reason?: string } };
      expect(claimBody.code).toBe("QUEUE_UNAVAILABLE");
      expect(claimBody.message).toBe("Job record schema version is not supported by this server.");
      expect(claimBody.details?.reason).toBe("UNSUPPORTED_SCHEMA_VERSION");

      // 8. HTTP start returns 503 UNSUPPORTED_SCHEMA_VERSION
      const startRes = await fetch(`${baseUrl}/api/worker/jobs/${jobIdV1}/start`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          worker_id: WRK,
          attempt_id: ATT,
          claim_token: TOKEN,
        }),
      });
      expect(startRes.status).toBe(503);
      const startBody = (await startRes.json()) as { code: string; message: string; details?: { reason?: string } };
      expect(startBody.code).toBe("QUEUE_UNAVAILABLE");
      expect(startBody.message).toBe("Job record schema version is not supported by this server.");
      expect(startBody.details?.reason).toBe("UNSUPPORTED_SCHEMA_VERSION");

      // 9. Discovery pending ignores v1 job via HTTP helper
      const pendingRes = await pendingJobs(baseUrl);
      expect(pendingRes.jobs.some((j) => j.job_id === jobIdV1)).toBe(false);

      // 10. Data unchanged: JobRecord, dedupe, and stream match snapshot; no second job created
      const recordAfter = await client.get(jobKeyV1);
      const dedupeAfter = await client.get(dedupeKeyV1);
      const streamAfter = await store.readStreamEntries("0-0", 100);

      expect(recordAfter).toBe(recordSnapshot);
      expect(dedupeAfter).toBe(dedupeSnapshot);
      expect(streamAfter).toEqual(streamSnapshot);
    } finally {
      if (jobIdV1) await client.del(jobKey(jobIdV1));
      await client.del(requestKey(identity.user_id, identity.workspace_id, reqV1));
      await client.del(KEY_STREAM);
    }
  });

  it("preserves safe diagnostic store reasons and withholds unknown internal messages across real Service and HTTP", async () => {
    const makeFaultRunner = (errorToThrow: unknown): RedisRunner => ({
      ready: () => true,
      get: async () => null,
      set: async () => {},
      xaddStream: async () => "1-0",
      xlen: async () => 0,
      xrange: async () => [],
      scriptLoad: async () => "dummy_sha",
      evalsha: async () => {
        throw errorToThrow;
      },
      scriptExists: async () => true,
      flush: async () => {},
    });

    const secretMarker1 = "mock_bad_lua_output_secret_details_marker";
    const secretMarker2 = "sensitive_internal_db_message_marker";
    const secretMarker3 = "unexpected_connection_failure_marker";

    // 1. Safe diagnostic reason preserved, internal message sanitized
    {
      const runner = makeFaultRunner(
        new StoreError("QUEUE_UNAVAILABLE", secretMarker1, {
          reason: "INVALID_SCRIPT_RESPONSE",
        }),
      );
      const faultStore = new RedisJobStore(runner);
      const faultService = new JobService({ store: faultStore }, () => true);
      const { baseUrl } = await buildServer(faultService);

      const logs = await captureStderr(async () => {
        const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(claimBody()),
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string; message: string; details?: { reason?: string } };
        expect(body.code).toBe("QUEUE_UNAVAILABLE");
        expect(body.message).toBe("Queue backend is not available.");
        expect(body.message).not.toContain(secretMarker1);
        expect(body.details?.reason).toBe("INVALID_SCRIPT_RESPONSE");
      });
      const joinedLogs = logs.join("");
      expect(joinedLogs).not.toContain(secretMarker1);
    }

    // 2. Unknown reason is withheld
    {
      const runner = makeFaultRunner(
        new StoreError("QUEUE_UNAVAILABLE", secretMarker2, {
          reason: "INTERNAL_SECRET_REASON",
        }),
      );
      const faultStore = new RedisJobStore(runner);
      const faultService = new JobService({ store: faultStore }, () => true);
      const { baseUrl } = await buildServer(faultService);

      const logs = await captureStderr(async () => {
        const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(claimBody()),
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string; message: string; details?: { reason?: string } };
        expect(body.code).toBe("QUEUE_UNAVAILABLE");
        expect(body.message).toBe("Queue backend is not available.");
        expect(body.message).not.toContain(secretMarker2);
        expect(body.details?.reason).toBeUndefined();
      });
      const joinedLogs = logs.join("");
      expect(joinedLogs).not.toContain(secretMarker2);
    }

    // 3. Plain unexpected Error is withheld
    {
      const runner = makeFaultRunner(new Error(secretMarker3));
      const faultStore = new RedisJobStore(runner);
      const faultService = new JobService({ store: faultStore }, () => true);
      const { baseUrl } = await buildServer(faultService);

      const logs = await captureStderr(async () => {
        const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/claim`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(claimBody()),
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string; message: string; details?: { reason?: string } };
        expect(body.code).toBe("QUEUE_UNAVAILABLE");
        expect(body.message).toBe("Queue backend is not available.");
        expect(body.message).not.toContain(secretMarker3);
        expect(body.details?.reason).toBeUndefined();
      });
      const joinedLogs = logs.join("");
      expect(joinedLogs).not.toContain(secretMarker3);
    }
  });
});
