import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";
import { RedisJobStoreV2 } from "../src/jobs/v2-store.js";
import { JobCoordinatorV2 } from "../src/jobs/v2-service.js";
import { createFakeRedisRunner } from "./helpers/fake-redis-runner.js";
import { CeoWorkspace } from "../src/workspace.js";
import { ResourceService } from "../src/resource/service.js";
import {
  ResourceAcquisitionService,
  getAcquisitionDescriptor,
} from "../src/resource/acquire.js";
import { fixture } from "./helpers.js";
import { createMcpServer } from "../src/mcp.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { CeoError } from "../src/errors.js";

const cleanupDirs: string[] = [];

describe("ResourceAcquisitionService & resource_acquire MCP Tool", () => {
  let identityStore: IdentityStore;
  let controlStore: ConnectorControlStore;
  let v2Store: RedisJobStoreV2;
  let coordinator: JobCoordinatorV2;
  let workspace: CeoWorkspace;
  let resourceService: ResourceService;
  let acquisitionService: ResourceAcquisitionService;

  let userId: string;
  let workspaceId: string;
  let targetId: string;
  let urlResourceId: string;
  let fileResourceId: string;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-acquire-test-"));
    cleanupDirs.push(dir);

    // 1. Identity & Control Store
    const dbPath = path.join(dir, "identity.sqlite");
    provisionEmptyControlPlaneDatabase(dbPath);
    identityStore = IdentityStore.open(dbPath);
    controlStore = new ConnectorControlStore(identityStore);

    userId = "usr_alice";
    workspaceId = "ws_primary";
    identityStore.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userId);
      db.prepare(
        "INSERT INTO workspaces VALUES (?, ?, 'https://github.com/acme/main-repo.git', 'main', 1000);",
      ).run(workspaceId, userId);
      db.prepare(
        "INSERT INTO workspace_memberships VALUES ('wsm_alice', ?, ?, 'owner', 1000);",
      ).run(workspaceId, userId);
    });

    // 2. Git Workspace & ResourceService
    const fix = await fixture();
    cleanupDirs.push(fix.root);
    workspace = new CeoWorkspace(fix.config);
    await workspace.initialize();

    // Mock resolver client for URL capture
    const mockResolver = {
      resolve: async (url: string) => ({
        status: "resolved" as const,
        metadata: {
          canonical_url: url,
          title: "Test Video Title",
          author: "Test Author",
          resource_kind: "video" as const,
          source_type: "url" as const,
          platform: "youtube",
        },
      }),
    };
    resourceService = new ResourceService(workspace, { resolverClient: mockResolver });

    // Capture a URL resource
    const urlCapture = await resourceService.capture({
      source: {
        type: "url",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    });
    urlResourceId = String((urlCapture.resource as any).resource_id);

    // Capture a file resource (non-URL)
    const fileCapture = await resourceService.capture({
      source: {
        type: "raw_text",
        text: "Plain text local document",
        original_name: "local.txt",
      },
    });
    fileResourceId = String((fileCapture.resource as any).resource_id);

    // 3. Execution Target
    const target = controlStore.createExecutionTarget({
      workspaceId,
      alias: "target-main",
      displayName: "Target Main",
      kind: "coding",
    });
    targetId = target.id;

    // 4. Fake Redis & Coordinator
    const fakeRedis = createFakeRedisRunner();
    v2Store = new RedisJobStoreV2(fakeRedis);

    coordinator = new JobCoordinatorV2({
      store: v2Store,
      controlStore,
      identityStore,
      resourceService,
      resourceExists: async (_scope, resId) =>
        resId === urlResourceId || resId === fileResourceId,
    });

    acquisitionService = new ResourceAcquisitionService(workspace, coordinator);
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  it("fails with NOT_FOUND for non-existent resource", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };
    await expect(
      acquisitionService.acquire(scope, {
        request_id: crypto.randomUUID(),
        resource_id: "res-00000000-0000-0000-0000-000000000000",
        target_id: targetId,
        mode: "if_missing",
      }),
    ).rejects.toThrow("Resource 'res-00000000-0000-0000-0000-000000000000' does not exist.");
  });

  it("fails with RESOURCE_NOT_ACQUIRABLE for file/non-URL resource", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };
    await expect(
      acquisitionService.acquire(scope, {
        request_id: crypto.randomUUID(),
        resource_id: fileResourceId,
        target_id: targetId,
        mode: "if_missing",
      }),
    ).rejects.toThrow("is not an acquirable URL resource");
  });

  it("submits acquisition job when content is missing", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };
    const reqId = crypto.randomUUID();

    const res = await acquisitionService.acquire(scope, {
      request_id: reqId,
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });

    expect(res.status).toBe("queued");
    expect(res.resource_id).toBe(urlResourceId);
    expect(typeof res.job_id).toBe("string");

    // Inspect submitted Job details
    const hostJob = await coordinator.getJobForHost(scope, res.job_id!, { include_task: true });
    expect(hostJob.resource_id).toBe(urlResourceId);
    expect(hostJob.result_target).toBe("resource");
    expect(hostJob.task?.prompt).toContain("CAPABILITY: content.extract_url");
    expect(hostJob.task?.prompt).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(hostJob.task?.acceptance).toContain("upsert_content");
  });

  it("returns already_satisfied when content exists and mode is if_missing", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };

    // Apply content.md to the resource
    await resourceService.apply({
      resource_id: urlResourceId,
      base_commit: (await workspace.captureReadSnapshot()).commit,
      summary: "Add extracted transcript",
      operations: [
        {
          op: "upsert_content",
          provenance: "trusted_adapter",
          content: "# Video Transcript\nHere is the full transcript of the video.",
        },
      ],
    });

    // Check descriptor
    const desc = await getAcquisitionDescriptor(workspace, urlResourceId);
    expect(desc?.content_available).toBe(true);

    const res = await acquisitionService.acquire(scope, {
      request_id: crypto.randomUUID(),
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });

    expect(res.status).toBe("already_satisfied");
    expect(res.resource_id).toBe(urlResourceId);
    expect(res.job_id).toBeNull();
  });

  it("submits new job when content exists but mode is refresh", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };

    // Apply content.md to the resource
    await resourceService.apply({
      resource_id: urlResourceId,
      base_commit: (await workspace.captureReadSnapshot()).commit,
      summary: "Add initial transcript",
      operations: [
        {
          op: "upsert_content",
          provenance: "trusted_adapter",
          content: "Initial transcript",
        },
      ],
    });

    const res = await acquisitionService.acquire(scope, {
      request_id: crypto.randomUUID(),
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "refresh",
    });

    expect(res.status).toBe("queued");
    expect(typeof res.job_id).toBe("string");
  });

  it("enforces strict request_id idempotency: replaying same request_id returns same Job even if completed", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };
    const reqId = crypto.randomUUID();

    // 1. Initial acquire submits Job A
    const firstRes = await acquisitionService.acquire(scope, {
      request_id: reqId,
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });
    expect(firstRes.status).toBe("queued");
    const originalJobId = firstRes.job_id;
    expect(originalJobId).toBeTruthy();

    // 2. Now simulate Job A completing and writing content.md to workspace
    await resourceService.apply({
      resource_id: urlResourceId,
      base_commit: (await workspace.captureReadSnapshot()).commit,
      summary: "Completed Job A transcript write",
      operations: [
        {
          op: "upsert_content",
          provenance: "worker",
          content: "Transcript from Job A",
        },
      ],
    });

    // 3. Client retries with identical request_id
    // It MUST return Job A (idempotent replay), NOT already_satisfied!
    const replayRes = await acquisitionService.acquire(scope, {
      request_id: reqId,
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });

    expect(replayRes.status).toBe("queued");
    expect(replayRes.job_id).toBe(originalJobId);
  });

  it("rejects request_id reuse with conflicting business parameters with IDEMPOTENCY_CONFLICT", async () => {
    const scope = { user_id: userId, workspace_id: workspaceId };
    const reqId = crypto.randomUUID();

    // 1. Initial acquire for urlResourceId
    const firstRes = await acquisitionService.acquire(scope, {
      request_id: reqId,
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });
    expect(firstRes.status).toBe("queued");

    // 2. Capture a second URL resource
    const secondCapture = await resourceService.capture({
      source: {
        type: "url",
        url: "https://www.youtube.com/watch?v=differentVideoId",
      },
    });
    const secondResourceId = String((secondCapture.resource as any).resource_id);

    // 3. Reusing the SAME reqId with a different Resource must throw IDEMPOTENCY_CONFLICT
    await expect(
      acquisitionService.acquire(scope, {
        request_id: reqId,
        resource_id: secondResourceId,
        target_id: targetId,
        mode: "if_missing",
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT|Request digest mismatch/);
  });

  it("invokes resource_acquire through MCP server", async () => {
    const productPolicy = await loadProductPolicy();
    const server = createMcpServer(workspace, productPolicy, {
      identity: { user_id: userId, workspace_id: workspaceId },
      connectorJobs: {
        coordinator,
        controlStore,
        identityStore,
      },
      resourceService,
    });

    const reqId = crypto.randomUUID();
    // Call via registered tool handler
    const tools = (server as any)._registeredTools;
    expect(tools["resource_acquire"]).toBeDefined();

    const mcpHandler = tools["resource_acquire"].handler;
    const response = await mcpHandler({
      request_id: reqId,
      resource_id: urlResourceId,
      target_id: targetId,
      mode: "if_missing",
    });

    expect(response.isError).toBeFalsy();
    const structured = response.structuredContent;
    expect(structured.ok).toBe(true);
    expect(structured.status).toBe("queued");
    expect(structured.resource_id).toBe(urlResourceId);
    expect(typeof structured.job_id).toBe("string");
  });
});
