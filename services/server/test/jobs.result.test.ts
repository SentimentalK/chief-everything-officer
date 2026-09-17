import { describe, it, expect, afterEach } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  canonicalResultPayloadDigest,
  workerResultPayloadSchema,
  workerResultRequestSchema,
} from "../src/jobs/result-schema.js";
import { assertWorkerResultReceipt } from "../src/resource/service.js";
import { createJobResultHandler } from "../src/jobs/result-service.js";
import { JobService } from "../src/jobs/service.js";
import { ResourceService } from "../src/resource/service.js";
import { createIdentityAuthMiddleware, createHostGuard, createOriginGuard } from "../src/auth.js";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture, createIdentityService } from "./helpers.js";
import type { AuditStore } from "../src/audit.js";

const API_KEY = "sk-test-ceo-result-1234567890abcdef";
const JOB = "job-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const WRK = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ATT = "123e4567-e89b-12d3-a456-4266141740aa";
const TOKEN = "a".repeat(64);
const RECEIVED_AT_MS = Date.parse("2026-09-13T10:00:00.000Z");
const RECEIVED_AT = "2026-09-13T10:00:00.000Z";

const cleanupServers: HttpServer[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupServers.length > 0) {
    const s = cleanupServers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop()!;
    const { rm } = await import("node:fs/promises");
    await rm(d, { recursive: true, force: true }).catch(() => void 0);
  }
});

function sha(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validPayload() {
  return {
    content: "## Transcribed Content\n\nHello world from worker.",
    metadata: {
      title: "Extracted Title",
      author: "Test Author",
      published_at: "2026-09-13T10:00:00.000Z",
      language: "en",
    },
    extraction: {
      method: "transcript_api",
      extracted_at: "2026-09-13T10:00:00.000Z",
    },
  };
}

describe("canonicalResultPayloadDigest", () => {
  it("produces deterministic sha256 regardless of object key order", () => {
    const p1 = {
      content: "test",
      metadata: { title: "T", author: "A" },
      extraction: { method: "m", extracted_at: "2026-09-13T10:00:00.000Z" },
    };
    const p2 = {
      extraction: { extracted_at: "2026-09-13T10:00:00.000Z", method: "m" },
      content: "test",
      metadata: { author: "A", title: "T" },
    };
    expect(canonicalResultPayloadDigest(p1)).toBe(canonicalResultPayloadDigest(p2));
  });
});

describe("workerResultPayloadSchema", () => {
  it("validates well-formed payload", () => {
    const parsed = workerResultPayloadSchema.safeParse(validPayload());
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid RFC3339 published_at", () => {
    const p = validPayload();
    p.metadata.published_at = "not-a-date";
    const parsed = workerResultPayloadSchema.safeParse(p);
    expect(parsed.success).toBe(false);
  });

  it("rejects content exceeding 8 MiB", () => {
    const p = validPayload();
    p.content = "x".repeat(8 * 1024 * 1024 + 1);
    const parsed = workerResultPayloadSchema.safeParse(p);
    expect(parsed.success).toBe(false);
  });
});

describe("assertWorkerResultReceipt", () => {
  it("succeeds when cached payload_sha256 matches", () => {
    const cached = {
      worker_result: {
        payload_sha256: "expected-sha",
        resource_id: "res-1",
      },
    };
    expect(() => assertWorkerResultReceipt(cached, "expected-sha")).not.toThrow();
  });

  it("throws when cached payload_sha256 differs", () => {
    const cached = {
      worker_result: {
        payload_sha256: "other-sha",
        resource_id: "res-1",
      },
    };
    expect(() => assertWorkerResultReceipt(cached, "expected-sha")).toThrowError(
      /Result payload does not match/,
    );
  });

  it("throws when cached result has no worker_result", () => {
    expect(() => assertWorkerResultReceipt({}, "expected-sha")).toThrowError(
      /Result payload does not match/,
    );
  });
});

describe("POST /api/worker/jobs/:job_id/result route", () => {
  async function buildTestApp() {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const identityService = createIdentityService(item.config, API_KEY);
    const resourceService = new ResourceService(workspace, item.config);

    let currentResourceId = "res-test-job-1";
    // Mock Redis resultAssignment: persist the durable receipt and keep
    // received_at_ms stable across replay (same as the Lua result operation).
    let storedResult: {
      target: "resource";
      attempt_id: string;
      payload_sha256: string;
      resource_id: string;
      commit: string;
      received_at_ms: number;
    } | null = null;
    const receiptRecord = () => ({
      job_id: JOB,
      result: storedResult,
    });
    const fakeStore = {
      resultAssignment: async (
        _scope: any,
        _jobId: string,
        input: any,
      ): Promise<
        | { ok: true; replayed: boolean; record: { job_id: string; result: typeof storedResult } }
        | { ok: false; code: string; reason: string }
      > => {
        if (storedResult) {
          if (storedResult.payload_sha256 !== input.result.payload_sha256) {
            return { ok: false, code: "RESULT_CONFLICT", reason: "conflicting result" };
          }
          return { ok: true, replayed: true, record: receiptRecord() };
        }
        storedResult = {
          target: "resource",
          attempt_id: input.attempt_id,
          payload_sha256: input.result.payload_sha256,
          resource_id: input.result.resource_id,
          commit: input.result.commit,
          received_at_ms: RECEIVED_AT_MS,
        };
        return { ok: true, replayed: false, record: receiptRecord() };
      },
      inspectAssignment: async () => ({
        ok: true as const,
        record: {
          schema_version: 5,
          job_id: JOB,
          workspace_id: "ws-test",
          user_id: "usr-test",
          workspace_ref: "ceo-agent-runtime",
          resource_id: currentResourceId,
          result_target: "resource" as const,
          prompt: "test",
          acceptance: "test",
          execution_timeout_seconds: 120,
          request_digest: "digest",
          status: "running" as const,
          stream_entry_id: "1-0",
          created_at_ms: Date.now(),
          claim_deadline_ms: Date.now() + 10000,
          execution: {
            worker_id: WRK,
            attempt_id: ATT,
            claim_token_sha256: sha(TOKEN),
            phase: "running" as const,
            claimed_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
          },
        },
        server_time_ms: Date.now(),
        state: "running" as const,
        replayed: false,
      }),
    };

    const fakeJobService = {
      store: fakeStore,
    } as unknown as JobService;

    const audit: AuditStore = {
      record: async () => void 0,
      recordSecurityEvent: async () => void 0,
      tail: async () => [],
    };

    const app: Express = express();
    // 9 MiB dedicated limit for result endpoint mounted FIRST
    app.post(
      "/api/worker/jobs/:job_id/result",
      express.json({ limit: "9mb" }),
      createHostGuard(item.config.allowedHosts) as RequestHandler,
      createOriginGuard(item.config.allowedOrigins) as RequestHandler,
      createIdentityAuthMiddleware(identityService) as RequestHandler,
      createJobResultHandler(fakeJobService, async () => resourceService),
    );

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanupServers.push(server);
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      resourceService,
      workspace,
      setResourceId: (id: string) => {
        currentResourceId = id;
      },
    };
  }

  it("returns 400 for invalid body schema", async () => {
    const { baseUrl } = await buildTestApp();
    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: WRK }), // missing required fields
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  it("successfully ingests valid result and updates resource", async () => {
    const { baseUrl, resourceService, setResourceId } = await buildTestApp();

    // Create resource first in git repo
    const capRes = await resourceService.capture({
      source: { type: "url", url: "https://example.com/video" },
    });
    const capturedResourceId = (capRes.resource as any)?.resource_id as string;
    expect(capturedResourceId).toBeDefined();
    setResourceId(capturedResourceId);

    const reqBody = {
      worker_id: WRK,
      attempt_id: ATT,
      claim_token: TOKEN,
      payload: validPayload(),
    };

    const res = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      job_id: JOB,
      attempt_id: ATT,
      result_received: true,
      resource_id: capturedResourceId,
      commit: body.commit,
      received_at: RECEIVED_AT,
      replayed: false,
    });
    expect(typeof body.commit).toBe("string");
    expect(body.commit.length).toBeGreaterThan(0);

    // Verify idempotent replay keeps the original receipt time and commit.
    const replayRes = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = await replayRes.json();
    expect(replayBody).toEqual({
      ...body,
      replayed: true,
    });

    // Verify conflicting payload fails with 409
    const conflictBody = {
      ...reqBody,
      payload: {
        ...reqBody.payload,
        content: "Conflicting content",
      },
    };
    const conflictRes = await fetch(`${baseUrl}/api/worker/jobs/${JOB}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(conflictBody),
    });
    expect(conflictRes.status).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.code).toBe("RESULT_CONFLICT");
  });
});
