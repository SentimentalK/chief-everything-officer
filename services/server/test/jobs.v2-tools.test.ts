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
import { installJobToolValidationAuditInterceptor } from "../src/jobs/tool-audit.js";
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
      repositoryProvider: "github",
      repositoryExternalId: "repo_123",
      repositoryFullName: "acme/repo-alpha",
    });

    // Bind a device to targetA1 to give it active_binding_count = 1
    const dev = controlStore.createDevice({
      userId: userAliceId,
      displayName: "Alice Dev",
      platform: "linux",
    });
    controlStore.upsertDeviceTargetBinding({
      deviceId: dev.id,
      targetId: targetA1.id,
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
    installJobToolValidationAuditInterceptor(server, auditStore, {
      user_id: options.userId,
      workspace_id: options.workspaceId,
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
      expect(content.targets[0].repository).toEqual({
        provider: "github",
        external_id: "repo_123",
        full_name: "acme/repo-alpha",
      });
      expect(content.targets[0].active_binding_count).toBe(1);
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
      expect(disabled.repository).toBeNull();
      expect(disabled.active_binding_count).toBe(0);
    });

    it("dynamically zeroes active_binding_count when target is disabled, and restores on re-enable", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      // 1. Before disable: targetA1 has active_binding_count = 1
      const res1 = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });
      const content1 = JSON.parse((res1.content as any)[0].text);
      const t1Before = content1.targets.find((t: any) => t.target_id === targetA1.id);
      expect(t1Before.disabled).toBe(false);
      expect(t1Before.active_binding_count).toBe(1);

      const rowsBefore = controlStore.listTargetsForUser(userAliceId, { workspaceId: workspaceAId });
      expect(rowsBefore.find((r) => r.target.id === targetA1.id)!.activeBindingCount).toBe(1);

      // 2. Disable targetA1
      controlStore.disableExecutionTarget(targetA1.id, Date.now());

      const res2 = await client.callTool({
        name: "execution_targets",
        arguments: { include_disabled: true },
      });
      const content2 = JSON.parse((res2.content as any)[0].text);
      const t1Disabled = content2.targets.find((t: any) => t.target_id === targetA1.id);
      expect(t1Disabled.disabled).toBe(true);
      expect(t1Disabled.active_binding_count).toBe(0);

      const rowsDisabled = controlStore.listTargetsForUser(userAliceId, { workspaceId: workspaceAId });
      expect(rowsDisabled.find((r) => r.target.id === targetA1.id)!.activeBindingCount).toBe(0);

      // 3. Re-enable targetA1 without recreating binding
      controlStore.enableExecutionTarget(targetA1.id, Date.now());

      const res3 = await client.callTool({
        name: "execution_targets",
        arguments: {},
      });
      const content3 = JSON.parse((res3.content as any)[0].text);
      const t1Reenabled = content3.targets.find((t: any) => t.target_id === targetA1.id);
      expect(t1Reenabled.disabled).toBe(false);
      expect(t1Reenabled.active_binding_count).toBe(1);

      const rowsReenabled = controlStore.listTargetsForUser(userAliceId, { workspaceId: workspaceAId });
      expect(rowsReenabled.find((r) => r.target.id === targetA1.id)!.activeBindingCount).toBe(1);
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
          timeout_seconds: 120,
          result_target: "none",
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse((res.content as any)[0].text);
      expect(content.ok).toBe(true);
      expect(content.job_id).toMatch(/^job-/);
      expect(content.request_id).toBe(requestId);
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

    it("strictly rejects internal execution_timeout_seconds with INVALID_INPUT", async () => {
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
          execution_timeout_seconds: 120,
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
      expect(content1.request_id).toBeTruthy();
      expect(content1.target_id).toBe(targetA1.id);
      expect(content1.target_alias).toBe("target-alpha-1");
      expect(content1.state).toBe("queued");
      expect(content1.expires_at).toBeTruthy();
      expect(content1.execution_timeout_seconds).toBe(3600);
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
      expect(content.expires_at).toBeNull();
      expect(content.execution).toEqual({
        attempt_id: attemptId,
        phase: "terminal",
        claimed_at: expect.any(String),
        started_at: expect.any(String),
      });
      expect((content.execution as any).claim_token).toBeUndefined();
      expect((content.execution as any).claim_token_sha256).toBeUndefined();
      expect((content.execution as any).target_binding_id).toBeUndefined();

      expect(content.report).toEqual({
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at: expect.any(String),
        duration_ms: 500,
        executor: { type: "test", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: null,
        received_at: expect.any(String),
      });
    });

    it("exposes complete durable result receipt in job_get while job_list remains lightweight", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const subRes = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task with result",
          acceptance: "Criteria",
          resource_id: "res-11111111-1111-1111-1111-111111111111",
          result_target: "resource",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      // Device enroll & claim & report
      const dev = controlStore.createDevice({ userId: userAliceId, displayName: "D-Res", platform: "linux" });
      controlStore.createDeviceCredential({
        deviceId: dev.id,
        secretDigest: crypto.createHash("sha256").update("c".repeat(64)).digest("hex"),
        expiresAtMs: Date.now() + 3600_000,
      });
      controlStore.upsertDeviceTargetBinding({ deviceId: dev.id, targetId: targetA1.id });

      const attemptId = `att-${crypto.randomUUID()}`;
      const claimToken = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(dev.id, jobId, attemptId, claimToken);
      await coordinator.startJob(dev.id, jobId, attemptId, claimToken);

      // In V1.8, result must exist before reportJob for result_target='resource'
      const attemptKey = `ceo:attempt:v1:${attemptId}`;
      const rawAttempt = JSON.parse((await fakeRedis.get(attemptKey))!);
      rawAttempt.result = {
        target: "resource",
        attempt_id: attemptId,
        payload_sha256: "2".repeat(64),
        resource_id: "res-11111111-1111-1111-1111-111111111111",
        commit: "abc123commit",
        received_at_ms: 1700000000000,
      };
      await fakeRedis.set(attemptKey, JSON.stringify(rawAttempt));

      await coordinator.reportJob(dev.id, jobId, attemptId, claimToken, {
        schema_version: 2,
        execution_status: "COMPLETED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 300,
        executor: { type: "orca", version: "2.0.0" },
        receipt_sha256: "1".repeat(64),
        error: null,
      });

      // 1. job_get exposes full result detail
      const getRes = await client.callTool({
        name: "job_get",
        arguments: { job_id: jobId },
      });
      const getContent = JSON.parse((getRes.content as any)[0].text);
      expect(getContent.ok).toBe(true);
      expect(getContent.result).toEqual({
        target: "resource",
        attempt_id: attemptId,
        payload_sha256: "2".repeat(64),
        resource_id: "res-11111111-1111-1111-1111-111111111111",
        commit: "abc123commit",
        received_at: new Date(1700000000000).toISOString(),
      });

      // 2. job_list remains lightweight and does NOT expose result receipt or report internals
      const listRes = await client.callTool({
        name: "job_list",
        arguments: {},
      });
      const listText = (listRes.content as any)[0].text;
      expect(listText).not.toContain("2".repeat(64)); // payload_sha256
      expect(listText).not.toContain("abc123commit"); // commit
      expect(listText).not.toContain("1".repeat(64)); // receipt_sha256
      expect(listText).not.toContain("orca"); // executor.type

      const listContent = JSON.parse(listText);
      const listItem = listContent.jobs.find((j: any) => j.job_id === jobId);
      expect(listItem).toBeDefined();
      expect(listItem.job_id).toBe(jobId);
      expect(listItem.state).toBe("terminal");
      expect(listItem.execution_status).toBe("COMPLETED");
      expect(listItem.business_outcome).toBe("UNVERIFIED");
      expect(listItem.result).toBeUndefined();
      expect(listItem.report).toBeUndefined();
      expect(listItem.execution).toBeUndefined();
      expect(listItem.task).toBeUndefined();

      // 3. Verify audit traces do not leak result or report internal payload
      const traces = getAuditTraces(workspaceAId);
      const getTrace = traces.find((t) => t.tool_name === "job_get");
      expect(getTrace).toBeDefined();
      expect(getTrace!.output_json).not.toContain("abc123commit");
      expect(getTrace!.output_json).not.toContain("2".repeat(64));
    });

    it("fails closed with QUEUE_UNAVAILABLE and CORRUPT_TARGET_STATE when target is deleted", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const subRes = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task",
          acceptance: "Criteria",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      identityStore.withDb((db) => {
        db.prepare("DELETE FROM execution_targets WHERE id = ?;").run(targetA1.id);
      });

      const getRes = await client.callTool({
        name: "job_get",
        arguments: { job_id: jobId },
      });
      expect(getRes.isError).toBe(true);
      const content = JSON.parse((getRes.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("QUEUE_UNAVAILABLE");
      expect(content.reason).toBe("CORRUPT_TARGET_STATE");
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
      expect(listContent.jobs[0].request_id).toBeTruthy();
      expect(listContent.jobs[0].target_alias).toBe("target-alpha-1");
      expect(listContent.jobs[0].state).toBe("queued");
      expect(listContent.jobs[0].expires_at).toBeTruthy();
      expect(listContent.jobs[0].task).toBeUndefined();
      expect(listContent.jobs[0].report).toBeUndefined();
      expect(listContent.jobs[0].execution).toBeUndefined();
      expect(listContent.jobs[1].job_id).toBe(job1Id);
    });

    it("withholds report and error message details from job_list summary", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      const subRes = await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Sensitive Task",
          acceptance: "Criteria",
        },
      });
      const jobId = JSON.parse((subRes.content as any)[0].text).job_id;

      // Claim and report error with sensitive message
      const dev = controlStore.createDevice({ userId: userAliceId, displayName: "D2", platform: "linux" });
      controlStore.createDeviceCredential({
        deviceId: dev.id,
        secretDigest: crypto.createHash("sha256").update("b".repeat(64)).digest("hex"),
        expiresAtMs: Date.now() + 3600_000,
      });
      controlStore.upsertDeviceTargetBinding({ deviceId: dev.id, targetId: targetA1.id });
      const attId = `att-${crypto.randomUUID()}`;
      const tok = crypto.randomBytes(32).toString("hex");
      await coordinator.claimJob(dev.id, jobId, attId, tok);
      await coordinator.startJob(dev.id, jobId, attId, tok);
      await coordinator.reportJob(dev.id, jobId, attId, tok, {
        schema_version: 2,
        execution_status: "FAILED",
        business_outcome: "UNVERIFIED",
        task_dispatched: true,
        finished_at_ms: Date.now(),
        duration_ms: 100,
        executor: { type: "test", version: "1.0.0" },
        receipt_sha256: "0".repeat(64),
        error: {
          stage: "execution",
          code: "COMMAND_FAILED",
          message: "SECRET_PASSWORD_OR_PATH_LEAK /secret/id_rsa failed",
        },
      });

      const listRes = await client.callTool({
        name: "job_list",
        arguments: {},
      });
      const text = (listRes.content as any)[0].text;
      expect(text).not.toContain("SECRET_PASSWORD_OR_PATH_LEAK");
      const listContent = JSON.parse(text);
      const item = listContent.jobs.find((j: any) => j.job_id === jobId);
      expect(item).toBeDefined();
      expect(item.state).toBe("terminal");
      expect(item.execution_status).toBe("FAILED");
      expect(item.business_outcome).toBe("UNVERIFIED");
      expect(item.expires_at).toBeNull();
      expect(item.report).toBeUndefined();
    });

    it("fails closed with QUEUE_UNAVAILABLE and CORRUPT_TARGET_STATE when target is deleted", async () => {
      const { client } = await createConnectedClient({
        userId: userAliceId,
        workspaceId: workspaceAId,
      });

      await client.callTool({
        name: "job_submit",
        arguments: {
          request_id: `req-${crypto.randomUUID()}`,
          target_id: targetA1.id,
          prompt: "Task",
          acceptance: "Criteria",
        },
      });

      identityStore.withDb((db) => {
        db.prepare("DELETE FROM execution_targets WHERE id = ?;").run(targetA1.id);
      });

      const listRes = await client.callTool({
        name: "job_list",
        arguments: {},
      });
      expect(listRes.isError).toBe(true);
      const content = JSON.parse((listRes.content as any)[0].text);
      expect(content.ok).toBe(false);
      expect(content.code).toBe("QUEUE_UNAVAILABLE");
      expect(content.reason).toBe("CORRUPT_TARGET_STATE");
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
