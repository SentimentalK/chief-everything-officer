import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { openJobBridge } from "../src/jobs/bridge.js";
import { RedisJobStore } from "../src/jobs/redis-store.js";
import { RedisJobStoreV2 } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2 } from "../src/jobs/v2-service.js";
import { createConnectorJobsRouter } from "../src/jobs/v2-router.js";
import { createJobAssignmentRouter } from "../src/jobs/router.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";

const cleanupDirs: string[] = [];
const cleanupServers: http.Server[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.closeAllConnections?.();
    s.closeIdleConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("V2 Redis Decoupling & Legacy Compatibility Bootstrap", () => {
  let dbPath: string;
  let identityStore: IdentityStore;
  let controlStore: ConnectorControlStore;
  let devToken: string;
  let targetId: string;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-bootstrap-test-"));
    cleanupDirs.push(dir);
    dbPath = path.join(dir, "identity.sqlite");
    provisionEmptyControlPlaneDatabase(dbPath);

    identityStore = IdentityStore.open(dbPath);
    controlStore = new ConnectorControlStore(identityStore);

    identityStore.withDb((db) => {
      db.prepare("INSERT INTO users VALUES ('usr_alice', 1000, NULL, 0);").run();
      db.prepare("INSERT INTO workspaces VALUES ('ws_1', 'usr_alice', 'https://github.com/a/b.git', 'main', 1000);").run();
      db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_1', 'ws_1', 'usr_alice', 'owner', 1000);").run();
    });

    const target = controlStore.createExecutionTarget({
      workspaceId: "ws_1",
      alias: "default",
      displayName: "Default Target",
      kind: "general_automation",
    });
    targetId = target.id;

    const device = controlStore.createDevice({
      userId: "usr_alice",
      displayName: "Alice Laptop",
      platform: "linux",
    });
    const rawSecret = "a".repeat(64);
    const secretDigest = crypto.createHash("sha256").update(rawSecret, "utf8").digest("hex");
    const cred = controlStore.createDeviceCredential({
      deviceId: device.id,
      secretDigest,
      expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    controlStore.upsertDeviceTargetBinding({
      deviceId: device.id,
      targetId: target.id,
    });
    devToken = `ceo_dev1.${cred.id}.${rawSecret}`;
  });

  it("when legacy bridgeEnabled = false: legacy /api/worker/jobs is unavailable while V2 /api/connector/jobs is mounted and active", async () => {
    const fakeRunner = createFakeRedisRunner();

    // Emulate server.ts bootstrap logic:
    // 1. Shared neutral runner is present (Redis configured)
    const redisRunner = fakeRunner;

    // 2. Legacy bridge disabled
    const jobBridge = openJobBridge(
      { bridgeEnabled: false, redisUrl: "redis://dummy" },
      async () => true,
      redisRunner,
    );
    expect(jobBridge.service).toBeNull();

    // 3. V2 coordinator created whenever redisRunner is present
    const v2Store = new RedisJobStoreV2(redisRunner);
    const v2Coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
    });

    const app = express();
    app.use(express.json());

    // Legacy worker router only mounted if jobBridge.service exists
    if (jobBridge.service) {
      app.use("/api/worker/jobs", createJobAssignmentRouter(jobBridge.service));
    }

    // V2 connector jobs router mounted if v2Coordinator exists
    if (v2Coordinator) {
      app.use("/api/connector/jobs", createConnectorJobsRouter(v2Coordinator, controlStore, identityStore));
    }

    const server = app.listen(0);
    cleanupServers.push(server);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Legacy worker endpoint should 404 (not mounted)
    const legacyRes = await fetch(`${baseUrl}/api/worker/jobs/pending`);
    expect(legacyRes.status).toBe(404);

    // V2 connector jobs endpoint is mounted and functional
    const v2Res = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
      headers: { Authorization: `Bearer ${devToken}` },
    });
    expect(v2Res.status).toBe(200);
    const v2Data = await v2Res.json();
    expect(v2Data.jobs).toEqual([]);
  });

  it("when bridgeEnabled = true: both legacy worker and V2 connector coexist using separate key namespaces", async () => {
    const fakeRunner = createFakeRedisRunner();
    const redisRunner = fakeRunner;

    // Both enabled
    const jobBridge = openJobBridge(
      { bridgeEnabled: true, redisUrl: "redis://dummy" },
      async () => true,
      redisRunner,
    );
    expect(jobBridge.service).not.toBeNull();

    const v2Store = new RedisJobStoreV2(redisRunner);
    const v2Coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
    });

    const app = express();
    app.use(express.json());

    app.use("/api/worker/jobs", createJobAssignmentRouter(jobBridge.service!));
    app.use("/api/connector/jobs", createConnectorJobsRouter(v2Coordinator, controlStore, identityStore));

    const server = app.listen(0);
    cleanupServers.push(server);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Submit a V2 job
    const v2Job = await v2Coordinator.submit(
      { user_id: "usr_alice", workspace_id: "ws_1" },
      {
        request_id: "req-00000000-0000-0000-0000-000000000099",
        target_id: targetId,
        prompt: "v2 prompt",
        acceptance: "v2 ok",
        resource_id: null,
        execution_timeout_seconds: 120,
        result_target: "none",
      },
    );

    // Submit a legacy job directly via legacy store
    const legacyStore = new RedisJobStore(redisRunner);
    const legacyPrepared = {
      schema_version: 1,
      job_id: "job-legacy-001",
      user_id: "usr_alice",
      workspace_id: "ws_1",
      task_id: "task-001",
      prompt: "legacy prompt",
      acceptance: "legacy ok",
      resource_id: null,
      execution_timeout_seconds: 120,
      request_digest: "digest-legacy",
      status: "preparing" as const,
      created_at_ms: Date.now(),
    };
    await legacyStore.submit(
      { user_id: "usr_alice", workspace_id: "ws_1" },
      "req-legacy-001",
      legacyPrepared as any,
    );

    // Verify V2 keys
    const v2Record = await fakeRunner.get(`ceo:job:v2:${v2Job.job.job_id}`);
    expect(v2Record).not.toBeNull();
    const v2Req = await fakeRunner.get("ceo:request:v2:usr_alice:ws_1:req-00000000-0000-0000-0000-000000000099");
    expect(v2Req).toBe(v2Job.job.job_id);

    // Verify Legacy keys (completely distinct namespaces)
    const legacyRecord = await fakeRunner.get("ceo:job:job-legacy-001");
    expect(legacyRecord).not.toBeNull();
    const legacyReq = await fakeRunner.get("ceo:request:usr_alice:ws_1:req-legacy-001");
    expect(legacyReq).not.toBeNull();

    // Verify pending on V2 returns V2 job
    const v2Pending = await fetch(`${baseUrl}/api/connector/jobs/pending`, {
      headers: { Authorization: `Bearer ${devToken}` },
    });
    expect(v2Pending.status).toBe(200);
    const v2Data = await v2Pending.json();
    expect(v2Data.jobs.map((j: any) => j.job_id)).toContain(v2Job.job.job_id);
    expect(v2Data.jobs.map((j: any) => j.job_id)).not.toContain("job-legacy-001");
  });
});
