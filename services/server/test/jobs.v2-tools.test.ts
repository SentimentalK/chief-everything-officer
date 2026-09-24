import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { RedisJobStoreV2 } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2 } from "../src/jobs/v2-service.js";
import { registerConnectorJobTools } from "../src/jobs/v2-tools.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { AuditStore } from "../src/audit.js";

describe("Connector V1.5 Host MCP Job Tools", () => {
  const cleanupDirs: string[] = [];
  let identityStore: IdentityStore;
  let controlStore: ConnectorControlStore;
  let fakeRedis: ReturnType<typeof createFakeRedisRunner>;
  let v2Store: RedisJobStoreV2;
  let coordinator: JobCoordinatorV2;
  let auditStore: AuditStore;
  let dbPath: string;
  let auditDbPath: string;

  const userAliceId = "usr_alice";
  const userBobId = "usr_bob";
  const userInactiveId = "usr_inactive";
  const workspaceAId = "ws_alpha";
  const workspaceBId = "ws_beta";

  let targetA1: { id: string; alias: string };
  let targetA2Disabled: { id: string; alias: string };
  let targetB1: { id: string; alias: string };

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-v15-tools-test-"));
    cleanupDirs.push(dir);
    dbPath = path.join(dir, "identity.sqlite");
    auditDbPath = path.join(dir, "audit.sqlite");
    provisionEmptyControlPlaneDatabase(dbPath);

    identityStore = IdentityStore.open(dbPath);
    controlStore = new ConnectorControlStore(identityStore);
    auditStore = new AuditStore(auditDbPath);

    fakeRedis = createFakeRedisRunner();
    v2Store = new RedisJobStoreV2(fakeRedis);
    coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
    });

    // Populate users and workspaces
    identityStore.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userAliceId);
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userBobId);
      db.prepare("INSERT INTO users VALUES (?, 1000, 2000, 0);").run(userInactiveId); // disabled user

      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/alice/repo.git', 'main', 1000);").run(
        workspaceAId,
        userAliceId,
      );
      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/bob/repo.git', 'main', 1000);").run(
        workspaceBId,
        userBobId,
      );

      // Memberships
      db.prepare("INSERT INTO workspace_memberships VALUES ('wm_1', ?, ?, 'owner', 1000);").run(
        workspaceAId,
        userAliceId,
      );
      db.prepare("INSERT INTO workspace_memberships VALUES ('wm_2', ?, ?, 'member', 1000);").run(
        workspaceBId,
        userBobId,
      );
      // Inactive user in workspace A
      db.prepare("INSERT INTO workspace_memberships VALUES ('wm_3', ?, ?, 'member', 1000);").run(
        workspaceAId,
        userInactiveId,
      );
    });

    // Create execution targets
    targetA1 = controlStore.createExecutionTarget({
      workspaceId: workspaceAId,
      alias: "target-alpha-1",
      displayName: "Target Alpha 1",
      kind: "coding",
    });
    targetA2Disabled = controlStore.createExecutionTarget({
      workspaceId: workspaceAId,
      alias: "target-alpha-disabled",
      displayName: "Target Alpha Disabled",
      kind: "coding",
    });
    controlStore.disableExecutionTarget(targetA2Disabled.id, Date.now());

    targetB1 = controlStore.createExecutionTarget({
      workspaceId: workspaceBId,
      alias: "target-beta-1",
      displayName: "Target Beta 1",
      kind: "coding",
    });
  });

  afterEach(async () => {
    identityStore.close();
    auditStore.close();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  async function createConnectedClient(options: {
    userId: string;
    workspaceId: string;
    coordinatorOverride?: JobCoordinatorV2 | null;
  }) {
    const server = new McpServer({ name: "test-mcp-server", version: "1.0.0" });
    registerConnectorJobTools(server, {
      coordinator: options.coordinatorOverride !== undefined ? options.coordinatorOverride : coordinator,
      controlStore,
      identityStore,
      scope: { user_id: options.userId, workspace_id: options.workspaceId },
      auditStore,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-mcp-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return { client, server };
  }

  function getAuditTraces(workspaceId: string) {
    const summaries = auditStore.listSummaries(workspaceId);
    return summaries.map((s) => auditStore.getDetail(workspaceId, s.id)!);
  }

  describe("execution_targets tool", () => {
    it("lists targets available for authenticated workspace hiding disabled targets by default", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.targets).toHaveLength(1);
      expect(content.targets[0].target_id).toBe(targetA1.id);
      expect(content.targets[0].alias).toBe("target-alpha-1");
      expect(content.targets[0].disabled).toBe(false);
    });

    it("includes disabled targets when include_disabled is true", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: { include_disabled: true },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.targets).toHaveLength(2);
      const disabled = content.targets.find((t: any) => t.target_id === targetA2Disabled.id);
      expect(disabled).toBeDefined();
      expect(disabled.disabled).toBe(true);
      expect(disabled.disabled_at).toBeTruthy();
    });

    it("succeeds even when coordinator/Redis is unavailable", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
        coordinatorOverride: null, // Redis offline
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.targets).toHaveLength(1);
    });

    it("fails with WORKSPACE_ACCESS_DENIED when user lacks workspace membership", async () => {
      const { client } = await createConnectedClient({
        userId: userBobId,
        workspaceId: workspaceAId, // Bob is not in Workspace A
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });

      expect(res.isError).toBe(true);
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("WORKSPACE_ACCESS_DENIED");
    });

    it("fails with WORKSPACE_ACCESS_DENIED when user is inactive", async () => {
      const { client } = await createConnectedClient({
        userId: userInactiveId,
        workspaceId: workspaceAId,
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });

      expect(res.isError).toBe(true);
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("WORKSPACE_ACCESS_DENIED");
    });

    it("strictly rejects unknown fields with INVALID_INPUT and logs audit trace", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const res = await client.callTool({
        name: "execution_targets",
        arguments: { forged_workspace_id: "ws_injected" },
      });

      expect(res.isError).toBe(true);
      const traces = getAuditTraces(workspaceAId);
      expect(traces.length).toBeGreaterThan(0);
      const lastTrace = traces[0];
      expect(lastTrace.tool_name).toBe("execution_targets");
      expect(lastTrace.status).toBe("error");
      expect(lastTrace.error_message).toBe("INVALID_INPUT");
    });
  });

  describe("job_submit tool", () => {
    it("successfully submits job, enriches target_alias, and projects state", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const requestId = `req-${crypto.randomUUID()}`;
      const res = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: requestId,
          target_id: targetA1.id,
          prompt: "Run audit task",
          acceptance: "Exit code 0",
          execution_timeout_seconds: 120,
          result_target: "none",
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.job_id).toMatch(/^job-/);
      expect(content.target_id).toBe(targetA1.id);
      expect(content.target_alias).toBe("target-alpha-1");
      expect(content.state).toBe("queued");
      expect(content.replayed).toBe(false);

      // Verify audit redaction: prompt and acceptance text withheld
      const traces = getAuditTraces(workspaceAId);
      expect(traces.length).toBeGreaterThan(0);
      const trace = traces[0];
      expect(trace.tool_name).toBe("job_submit");
      expect(trace.status).toBe("success");
      expect(trace.input_json).not.toContain("Run audit task");
      expect(trace.output_json).not.toContain("Run audit task");
    });

    it("replays idempotently on identical request_id", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const requestId = `req-${crypto.randomUUID()}`;
      const args = {
        request_id: requestId,
        target_id: targetA1.id,
        prompt: "Run replay task",
        acceptance: "Pass criteria",
      };

      const res1 = await client.callTool({ name: "job_submit", arguments: args });
      const content1 = JSON.parse((res1.content as any)[0].text);
      expect(content1.ok).toBe(true);
      expect(content1.replayed).toBe(false);

      const res2 = await client.callTool({ name: "job_submit", arguments: args });
      const content2 = JSON.parse((res2.content as any)[0].text);
      expect(content2.ok).toBe(true);
      expect(content2.replayed).toBe(true);
      expect(content2.job_id).toBe(content1.job_id);
    });

    it("returns IDEMPOTENCY_CONFLICT when request_id is reused with different parameters", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const requestId = `req-${crypto.randomUUID()}`;
      await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: requestId,
          target_id: targetA1.id,
          prompt: "Initial prompt",
          acceptance: "Criteria 1",
        },
      });

      const resConflict = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: requestId,
          target_id: targetA1.id,
          prompt: "Different prompt",
          acceptance: "Criteria 2",
        },
      });

      expect(resConflict.isError).toBe(true);
      const content = JSON.parse((resConflict.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("returns QUEUE_UNAVAILABLE when coordinator is null", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
        coordinatorOverride: null,
      });

      const res = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task",
          acceptance: "Criteria",
        },
      });

      expect(res.isError).toBe(true);
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("QUEUE_UNAVAILABLE");
    });

    it("strictly rejects client-supplied user_id, workspace_id, or device_id", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const res = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task",
          acceptance: "Criteria",
          user_id: "forged_user",
        },
      });

      expect(res.isError).toBe(true);
      const traces = getAuditTraces(workspaceAId);
      const trace = traces[0];
      expect(trace.tool_name).toBe("job_submit");
      expect(trace.error_message).toBe("INVALID_INPUT");
    });
  });

  describe("job_get tool", () => {
    it("returns authoritative HostJobDetail and enforces include_task opt-in", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const subRes = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Secret Prompt Content",
          acceptance: "Secret Acceptance Content",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      // Call job_get with default include_task=false
      const getRes1 = await client.callTool({
        name: "job_get",
        arguments: { job_id: jobId },
      });
      expect(getRes1.isError).toBeFalsy();
      const content1 = JSON.parse((getRes1.content as any)[0].text);
      expect(content1.ok).toBe(true);
      expect(content1.job_id).toBe(jobId);
      expect(content1.target_id).toBe(targetA1.id);
      expect(content1.target_alias).toBe("target-alpha-1");
      expect(content1.state).toBe("queued");
      expect(content1.task).toBeUndefined();

      // Call job_get with include_task=true
      const getRes2 = await client.callTool({
        name: "job_get",
        arguments: { job_id: jobId, include_task: true },
      });
      expect(getRes2.isError).toBeFalsy();
      const content2 = JSON.parse((getRes2.content as any)[0].text);
      expect(content2.task).toBeDefined();
      expect(content2.task.prompt).toBe("Secret Prompt Content");
      expect(content2.task.acceptance).toBe("Secret Acceptance Content");

      // Verify audit redaction: prompt not stored in audit output even if include_task was requested
      const traces = getAuditTraces(workspaceAId);
      const lastTrace = traces[0];
      expect(lastTrace.tool_name).toBe("job_get");
      expect(lastTrace.input_json).not.toContain("Secret Prompt Content");
      expect(lastTrace.output_json).not.toContain("Secret Prompt Content");
    });

    it("masks cross-tenant job querying as JOB_NOT_FOUND", async () => {
      const { client: aliceClient } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });
      const { client: bobClient } = await createConnectedClient({
        userId: userBobId,
        workspaceId: workspaceBId,
      });

      // Alice submits job in workspace A
      const subRes = await aliceClient.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task in A",
          acceptance: "Criteria A",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      // Bob in workspace B attempts to get Alice's job
      const getRes = await bobClient.callTool({
        name: "job_get",
        arguments: { job_id: jobId },
      });
      expect(getRes.isError).toBe(true);
      const content = JSON.parse((getRes.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("JOB_NOT_FOUND");
    });

    it("preserves terminal state integrity (COMPLETED is unverified)", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      // Submit job
      const subRes = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task to complete",
          acceptance: "Acceptance",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      // Device enroll & claim & report terminal COMPLETED
      const device = controlStore.createDevice({
        userId: userAliceId,
        displayName: "Alice Device",
        platform: "linux",
      });
      const secret = "a".repeat(64);
      const secretDigest = crypto.createHash("sha256").update(secret).digest("hex");
      controlStore.createDeviceCredential({
        deviceId: device.id,
        secretDigest,
        expiresAtMs: Date.now() + 3600_000,
      });
      const binding = controlStore.upsertDeviceTargetBinding({ deviceId: device.id, targetId: targetA1.id });

      const attemptId = `att-${crypto.randomUUID()}`;
      const claimToken = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(device.id, jobId, attemptId, claimToken);
      await coordinator.startJob(device.id, jobId, attemptId, claimToken);
      await coordinator.reportJob(device.id, jobId, attemptId, claimToken, {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 500,
        executor: { type: "test", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
      });

      // Query via job_get
      const getRes = await client.callTool({
        name: "job_get",
        arguments: { job_id: jobId },
      });
      const content = JSON.parse((getRes.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.state).toBe("terminal");
      expect(content.report.execution_status).toBe("COMPLETED");
      expect(content.report.business_outcome).toBe("UNVERIFIED");
    });
  });

  describe("job_list tool", () => {
    it("returns jobs for authenticated workspace in reverse chronological order", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      // Submit two jobs
      const res1 = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "First Task",
          acceptance: "Criteria 1",
        },
      });
      const job1Id = JSON.parse((res1.content as any)[0].text).job_id;

      const res2 = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Second Task",
          acceptance: "Criteria 2",
        },
      });
      const job2Id = JSON.parse((res2.content as any)[0].text).job_id;

      const listRes = await client.callTool({
        name: "job_list",
        arguments: {},
      });
      expect(listRes.isError).toBeFalsy();
      const listContent = JSON.parse((listRes.content as any)[0].text);
      expect(listContent.ok).toBe(true);
      expect(listContent.jobs.length).toBe(2);
      // Newest first
      expect(listContent.jobs[0].job_id).toBe(job2Id);
      expect(listContent.jobs[1].job_id).toBe(job1Id);
    });

    it("returns QUEUE_UNAVAILABLE when coordinator is null", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
        coordinatorOverride: null,
      });

      const res = await client.callTool({
        name: "job_list",
        arguments: {},
      });

      expect(res.isError).toBe(true);
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("QUEUE_UNAVAILABLE");
    });
  });
});
