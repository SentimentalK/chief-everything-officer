import { afterEach, describe, expect, it } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import { rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createIdentityAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import { createJobLeaseRouter } from "../src/jobs/router.js";
import { JobService, JobError, type LeaseResult } from "../src/jobs/service.js";
import { RedisJobStore, createRedisRunnerFromClient } from "../src/jobs/redis-store.js";
import { fixture, createIdentityService } from "./helpers.js";
import type { IdentityService } from "../src/identity/service.js";

const API_KEY = "http-jobs-key";
const JOB = "job-123e4567-e89b-12d3-a456-426614174000";
const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ATT = "123e4567-e89b-12d3-a456-4266141740ab";
const TOKEN = "c".repeat(64);

const claimBody = () => ({ worker_id: WRK, attempt_id: ATT, workspace_ref: "tools", lease_token: TOKEN });

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
  impl: { claim?: (scope: unknown, jobId: string, body: unknown) => Promise<LeaseResult> | LeaseResult; start?: (scope: unknown, jobId: string, body: unknown) => Promise<LeaseResult> | LeaseResult; heartbeat?: (scope: unknown, jobId: string, body: unknown) => Promise<LeaseResult> | LeaseResult },
): JobService {
  return {
    claim: async (s, j, b) => (impl.claim ? await impl.claim(s, j, b) : errCode("INVALID_INPUT")),
    start: async (s, j, b) => (impl.start ? await impl.start(s, j, b) : errCode("INVALID_INPUT")),
    heartbeat: async (s, j, b) => (impl.heartbeat ? await impl.heartbeat(s, j, b) : errCode("INVALID_INPUT")),
  } as unknown as JobService;
}

function okLease(patch: Record<string, unknown> = {}): LeaseResult {
  return {
    ok: true,
    replayed: false,
    server_time: "2026-09-07T00:00:00.000Z",
    execution: {
      worker_id: WRK,
      attempt_id: ATT,
      phase: "claimed",
      claimed_at: "2026-09-07T00:00:00.000Z",
      start_deadline: "2026-09-07T00:05:00.000Z",
      started_at: null,
      lease_expires_at: "2026-09-07T00:01:30.000Z",
      execution_deadline: null,
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

async function buildServer(service: JobService | null): Promise<{ baseUrl: string }> {
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
    createJobLeaseRouter(service) as unknown as RequestHandler,
  );

  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  cleanupServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}` };
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

describe("worker lease HTTP input and routing", () => {
  it("returns INVALID_INPUT for a malformed job_id in the URL path", async () => {
    let called = false;
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => {
          called = true;
          return okLease();
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

describe("worker lease HTTP strict input validation (real schema, not a throw-all mock)", () => {
  // These drive the real workerClaimSchema / workerLeaseOperationSchema through
  // an actual JobService. Because schema rejection happens before any backend
  // access, an invalid body must yield INVALID_INPUT (400) even though the
  // store is never reachable - never a QUEUE_UNAVAILABLE (503).
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "forged user_id (unknown field)", body: { ...claimBody(), user_id: "usr_evil" } },
    { name: "forged workspace_id (unknown field)", body: { ...claimBody(), workspace_id: "ws_evil" } },
    { name: "missing attempt_id", body: { worker_id: WRK, workspace_ref: "tools", lease_token: TOKEN } },
    { name: "malformed worker_id", body: { ...claimBody(), worker_id: "wrk-NOTHEX" } },
    { name: "malformed lease_token", body: { ...claimBody(), lease_token: "not-hex" } },
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

  it("rejects unknown fields on start/heartbeat too (real schema)", async () => {
    const { baseUrl } = await buildServer(deadStoreService());
    const body = { worker_id: WRK, attempt_id: ATT, lease_token: TOKEN, lease_duration_ms: 1234 };
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

describe("worker lease HTTP success output whitelist + no-store", () => {
  it("returns claim output that is a strict whitelist (no token/hash/secret extras)", async () => {
      const secretMarker = "TOP_SECRET_MARKER";
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => {
          const result = okLease();
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
    // Full prompt IS returned for claim (job target), but never the token.
    expect((body.job as Record<string, unknown>).prompt).toBeTruthy();
  });

  it("successful calls log only allow-listed fields, never the token", async () => {
    const { baseUrl } = await buildServer(
      stubService({
        claim: async () => okLease(),
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
    expect(joined).toContain("job-lease");
    expect(joined).toContain(JOB);
    expect(joined).toContain(WRK);
  });
});

describe("worker lease HTTP error mapping", () => {
  const cases: Array<{ code: string; status: number }> = [
    { code: "JOB_NOT_FOUND", status: 404 },
    { code: "JOB_EXPIRED", status: 409 },
    { code: "JOB_ALREADY_CLAIMED", status: 409 },
    { code: "IDEMPOTENCY_CONFLICT", status: 409 },
    { code: "JOB_NOT_CLAIMED", status: 409 },
    { code: "LEASE_MISMATCH", status: 409 },
    { code: "LEASE_EXPIRED", status: 409 },
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
        body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, lease_token: TOKEN }),
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

  it("start success carries replayed and heartbeat success omits it", async () => {
    const { baseUrl } = await buildServer(
      stubService({
        start: async () => okLease({ replayed: true, execution: { ...okLease().execution, phase: "running" } }),
        heartbeat: async () => okLease(),
      }),
    );
    const start = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/start`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, lease_token: TOKEN }),
    });
    const startBody = (await start.json()) as { replayed: boolean; execution: { phase: string } };
    expect(start.status).toBe(200);
    expect(startBody.replayed).toBe(true);
    expect(startBody.execution.phase).toBe("running");

    const hb = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/heartbeat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ worker_id: WRK, attempt_id: ATT, lease_token: TOKEN }),
    });
    const hbBody = (await hb.json()) as Record<string, unknown>;
    expect(hb.status).toBe(200);
    expect("replayed" in hbBody).toBe(false);
  });
});
