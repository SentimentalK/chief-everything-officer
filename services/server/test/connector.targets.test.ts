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
import { DeviceEnrollmentStore } from "../src/connector/enrollment-store.js";
import { createConnectorRouter } from "../src/connector/router.js";
import { createUserRouter } from "../src/auth/user-router.js";
import { UserSessionManager } from "../src/auth/user-session.js";
import { IdentityService } from "../src/identity/service.js";

const cleanupDirs: string[] = [];
let identityService: IdentityService;
let identityStore: IdentityStore;
let controlStore: ConnectorControlStore;
let enrollmentStore: DeviceEnrollmentStore;
let sessionManager: UserSessionManager;
let dbPath: string;

let userOwnerId: string;
let userMemberId: string;
let userForeignId: string;
let workspaceId: string;
let foreignWorkspaceId: string;

let server: http.Server;
let baseUrl: string;

let ownerDevToken: string;
let ownerDeviceId: string;
let memberDevToken: string;
let memberDeviceId: string;
let foreignDevToken: string;
let foreignDeviceId: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-targets-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  identityService = IdentityService.open(dbPath);
  identityStore = identityService.storeInstance;
  controlStore = new ConnectorControlStore(identityStore);
  enrollmentStore = new DeviceEnrollmentStore();
  sessionManager = new UserSessionManager({ secureCookies: false });

  userOwnerId = "usr_owner";
  userMemberId = "usr_member";
  userForeignId = "usr_foreign";
  workspaceId = "ws_primary";
  foreignWorkspaceId = "ws_foreign";

  identityStore.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userOwnerId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userMemberId);
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(userForeignId);

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/acme/main-repo.git', 'main', 1000);").run(
      workspaceId,
      userOwnerId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_owner', ?, ?, 'owner', 1000);").run(
      workspaceId,
      userOwnerId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_member', ?, ?, 'member', 1000);").run(
      workspaceId,
      userMemberId,
    );

    // Foreign workspace
    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/foreign/repo.git', 'main', 1000);").run(
      foreignWorkspaceId,
      userForeignId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_foreign', ?, ?, 'owner', 1000);").run(
      foreignWorkspaceId,
      userForeignId,
    );

    // Setup github installation and binding for primary workspace
    db.prepare(`
      INSERT INTO github_installations (
        id, github_installation_id, github_app_id, account_id, account_login, account_type,
        repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('inst_row_1', 'inst_100', 'app_1', 'acc_1', 'acme', 'Organization', 'selected', NULL, 1000, 1000);
    `).run();
    db.prepare(`
      INSERT INTO github_repository_bindings (
        id, workspace_id, github_repository_id, github_installation_row_id,
        owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
      ) VALUES ('grb_primary', ?, '987654', 'inst_row_1', 'acc_1', 'acme', 'main-repo', 'acme/main-repo', 'main', 1000, 1000);
    `).run(workspaceId);
  });

  // Create devices and credentials
  const now = Date.now();
  const secret1 = "a".repeat(64);
  const secretDigest1 = crypto.createHash("sha256").update(secret1, "utf8").digest("hex");
  const secret2 = "b".repeat(64);
  const secretDigest2 = crypto.createHash("sha256").update(secret2, "utf8").digest("hex");
  const secret3 = "c".repeat(64);
  const secretDigest3 = crypto.createHash("sha256").update(secret3, "utf8").digest("hex");

  // Owner device
  ownerDeviceId = "dev_00000000-0000-0000-0000-000000000001";
  const ownerCredId = "dcr_00000000-0000-0000-0000-000000000001";
  controlStore.finalizeDeviceEnrollment({
    deviceId: ownerDeviceId,
    credentialId: ownerCredId,
    userId: userOwnerId,
    displayName: "Owner Linux Workstation",
    platform: "linux",
    secretDigest: secretDigest1,
    issuedAtMs: now,
    expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
  });
  ownerDevToken = `ceo_dev1.${ownerCredId}.${secret1}`;

  // Member device
  memberDeviceId = "dev_00000000-0000-0000-0000-000000000002";
  const memberCredId = "dcr_00000000-0000-0000-0000-000000000002";
  controlStore.finalizeDeviceEnrollment({
    deviceId: memberDeviceId,
    credentialId: memberCredId,
    userId: userMemberId,
    displayName: "Member Laptop",
    platform: "macos",
    secretDigest: secretDigest2,
    issuedAtMs: now,
    expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
  });
  memberDevToken = `ceo_dev1.${memberCredId}.${secret2}`;

  // Foreign device
  foreignDeviceId = "dev_00000000-0000-0000-0000-000000000003";
  const foreignCredId = "dcr_00000000-0000-0000-0000-000000000003";
  controlStore.finalizeDeviceEnrollment({
    deviceId: foreignDeviceId,
    credentialId: foreignCredId,
    userId: userForeignId,
    displayName: "Foreign Server",
    platform: "linux",
    secretDigest: secretDigest3,
    issuedAtMs: now,
    expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
  });
  foreignDevToken = `ceo_dev1.${foreignCredId}.${secret3}`;

  // Express test server
  const app = express();
  app.use(express.json());

  app.use(
    "/api/user",
    createUserRouter({
      store: identityStore,
      sessionManager,
      controlStore,
    }),
  );

  app.use(
    createConnectorRouter({
      controlStore,
      enrollmentStore,
      identityStore,
      sessionManager,
      publicOrigin: "http://127.0.0.1:3000",
    }),
  );

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  identityService?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("GET /api/connector/workspaces", () => {
  it("returns workspaces with role and workspace_repository metadata", async () => {
    const res = await fetch(`${baseUrl}/api/connector/workspaces`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0]).toEqual({
      id: workspaceId,
      role: "owner",
      workspace_repository: {
        provider: "github",
        external_id: "987654",
        full_name: "acme/main-repo",
        branch: "main",
      },
    });
  });

  it("returns workspace_repository = null when workspace has no repository binding", async () => {
    const res = await fetch(`${baseUrl}/api/connector/workspaces`, {
      headers: { Authorization: `Bearer ${foreignDevToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].workspace_repository).toBeNull();
  });
});

describe("POST /api/connector/targets/register", () => {
  it("registers target with repository = null", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "ceo-dev",
        display_name: "CEO Development",
        kind: "coding",
        repository: null,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.target_created).toBe(true);
    expect(data.binding_created).toBe(true);
    expect(data.replayed).toBe(false);

    expect(data.target.alias).toBe("ceo-dev");
    expect(data.target.kind).toBe("coding");
    expect(data.target.repository).toBeNull();
    expect(data.target.disabled).toBe(false);

    expect(data.binding.enabled).toBe(true);
  });

  it("registers target with workspace_repository source", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "resource-repo",
        display_name: "Workspace Repo Target",
        kind: "coding",
        repository: {
          source: "workspace_repository",
        },
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.target.repository).toEqual({
      provider: "github",
      external_id: "987654",
      full_name: "acme/main-repo",
    });
  });

  it("strictly rejects unknown fields with 400 INVALID_REQUEST", async () => {
    // 1. Extraneous local_path
    const res1 = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "bad-target",
        display_name: "Bad Target",
        kind: "coding",
        local_path: "/home/sentimentalk/codes/ceo",
      }),
    });
    expect(res1.status).toBe(400);
    const data1 = await res1.json();
    expect(data1.error).toBe("INVALID_REQUEST");

    // 2. Extraneous external_id in repository
    const res2 = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "bad-target",
        display_name: "Bad Target",
        kind: "coding",
        repository: {
          source: "workspace_repository",
          external_id: "12345",
        },
      }),
    });
    expect(res2.status).toBe(400);
    const data2 = await res2.json();
    expect(data2.error).toBe("INVALID_REQUEST");
  });

  it("rejects non-owner target creation with 403 TARGET_CREATE_FORBIDDEN", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "member-forbidden",
        display_name: "Member Target",
        kind: "coding",
        repository: null,
      }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("TARGET_CREATE_FORBIDDEN");
  });

  it("replays registration idempotently with 200 OK", async () => {
    const payload = {
      workspace_id: workspaceId,
      alias: "ceo-dev",
      display_name: "CEO Development",
      kind: "coding",
      repository: null,
    };

    const first = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    const data = await second.json();
    expect(data.target_created).toBe(false);
    expect(data.replayed).toBe(true);
  });

  it("returns 409 TARGET_ALIAS_CONFLICT when metadata mismatches", async () => {
    await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "ceo-dev",
        display_name: "CEO Development",
        kind: "coding",
        repository: null,
      }),
    });

    const conflict = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "ceo-dev",
        display_name: "Different Name",
        kind: "coding",
        repository: null,
      }),
    });
    expect(conflict.status).toBe(409);
    const data = await conflict.json();
    expect(data.error).toBe("TARGET_ALIAS_CONFLICT");
  });
});

describe("Device Binding & Target Discovery", () => {
  let targetId: string;

  beforeEach(async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "shared-ceo",
        display_name: "Shared CEO Env",
        kind: "coding",
        repository: null,
      }),
    });
    const data = await res.json();
    targetId = data.target.id;
  });

  it("lists targets with active_binding_count and this_device_binding", async () => {
    // Owner sees binding enabled and count = 1
    const ownerRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(ownerRes.status).toBe(200);
    const ownerData = await ownerRes.json();
    expect(ownerData.targets).toHaveLength(1);
    expect(ownerData.targets[0].this_device_binding.enabled).toBe(true);
    expect(ownerData.targets[0].active_binding_count).toBe(1);

    // Member sees binding null and count = 1
    const memberRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${memberDevToken}` },
    });
    expect(memberRes.status).toBe(200);
    const memberData = await memberRes.json();
    expect(memberData.targets[0].this_device_binding).toBeNull();
    expect(memberData.targets[0].active_binding_count).toBe(1);
  });

  it("member binds to existing target", async () => {
    const bindRes = await fetch(`${baseUrl}/api/connector/targets/${targetId}/bind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberDevToken}` },
    });
    expect(bindRes.status).toBe(200);
    const bindData = await bindRes.json();
    expect(bindData.target_id).toBe(targetId);
    expect(bindData.enabled).toBe(true);
    expect(bindData.replayed).toBe(false);

    // active_binding_count is now 2
    const checkRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const checkData = await checkRes.json();
    expect(checkData.targets[0].active_binding_count).toBe(2);
  });

  it("unbind disables calling device binding; target survives", async () => {
    // Member binds
    await fetch(`${baseUrl}/api/connector/targets/${targetId}/bind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberDevToken}` },
    });

    // Owner unbinds
    const unbindRes = await fetch(`${baseUrl}/api/connector/targets/${targetId}/unbind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(unbindRes.status).toBe(200);

    // Owner sees its binding disabled, but active_binding_count is still 1 (member device)
    const ownerRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const ownerData = await ownerRes.json();
    expect(ownerData.targets[0].this_device_binding.enabled).toBe(false);
    expect(ownerData.targets[0].active_binding_count).toBe(1);
  });

  it("masks foreign target IDs as 404", async () => {
    // Foreign device tries to bind to primary target
    const bindRes = await fetch(`${baseUrl}/api/connector/targets/${targetId}/bind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${foreignDevToken}` },
    });
    expect(bindRes.status).toBe(404);
    const bindData = await bindRes.json();
    expect(bindData.error).toBe("TARGET_NOT_FOUND");

    // Foreign device tries to unbind from primary target
    const unbindRes = await fetch(`${baseUrl}/api/connector/targets/${targetId}/unbind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${foreignDevToken}` },
    });
    expect(unbindRes.status).toBe(404);
    const unbindData = await unbindRes.json();
    expect(unbindData.error).toBe("TARGET_NOT_FOUND");
  });
});

describe("Browser User API: Target Management", () => {
  let targetId: string;
  let ownerCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    // Register a target
    const regRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "ceo-core",
        display_name: "CEO Core",
        kind: "coding",
        repository: null,
      }),
    });
    const regData = await regRes.json();
    targetId = regData.target.id;

    // Create browser sessions
    const ownerSession = sessionManager.createSession({
      userId: userOwnerId,
      provider: "github",
      providerSubject: "sub_owner",
    });
    ownerCookie = `ceo_user_session=${ownerSession.sessionId}`;

    const memberSession = sessionManager.createSession({
      userId: userMemberId,
      provider: "github",
      providerSubject: "sub_member",
    });
    memberCookie = `ceo_user_session=${memberSession.sessionId}`;
  });

  it("lists targets for user via GET /api/user/targets", async () => {
    const res = await fetch(`${baseUrl}/api/user/targets`, {
      headers: { Cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.targets).toHaveLength(1);
    expect(data.targets[0].id).toBe(targetId);
    expect(data.targets[0].workspace_role).toBe("owner");
    expect(data.targets[0].disabled).toBe(false);
  });

  it("allows workspace owner to disable and enable target globally", async () => {
    // Owner disables
    const disRes = await fetch(`${baseUrl}/api/user/targets/${targetId}/disable`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    expect(disRes.status).toBe(200);

    const checkDis = controlStore.getExecutionTarget(targetId);
    expect(checkDis!.disabled_at_ms).not.toBeNull();

    // Owner enables
    const enRes = await fetch(`${baseUrl}/api/user/targets/${targetId}/enable`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    expect(enRes.status).toBe(200);

    const checkEn = controlStore.getExecutionTarget(targetId);
    expect(checkEn!.disabled_at_ms).toBeNull();
  });

  it("forbids non-owner from disabling or enabling target", async () => {
    const disRes = await fetch(`${baseUrl}/api/user/targets/${targetId}/disable`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    expect(disRes.status).toBe(403);

    const enRes = await fetch(`${baseUrl}/api/user/targets/${targetId}/enable`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    expect(enRes.status).toBe(403);
  });
});
