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

  it("registers target with remote_url source and persists normalized repository metadata", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "fresh-add",
        display_name: "Fresh Add",
        kind: "coding",
        repository: {
          source: "remote_url",
          provider: "github",
          full_name: "Acme/Other-Repo.git",
        },
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.target_created).toBe(true);
    expect(data.target.repository).toEqual({
      provider: "github",
      // Binding full_name does not match: normalized full_name is persisted
      // as the deterministic external identifier.
      external_id: "acme/other-repo",
      full_name: "acme/other-repo",
    });
  });

  it("rejects remote_url full_name that is not a normalized repository name with 400", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "bad-repo-name",
        display_name: "Bad Repo Name",
        kind: "coding",
        repository: {
          source: "remote_url",
          provider: "github",
          full_name: "https://github.com/acme/main-repo",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("INVALID_REQUEST");
  });

  it("remote_url register is repository-first: fresh device with different human name reuses the target without rename", async () => {
    const first = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "device-a-custom-name",
        display_name: "Device A Custom Name",
        kind: "coding",
        repository: {
          source: "remote_url",
          provider: "github",
          full_name: "acme/identity-repo",
        },
      }),
    });
    expect(first.status).toBe(201);
    const firstData = await first.json();

    // Fresh device (different device token), default repo-derived human
    // name, same Git repository identity.
    const second = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "identity-repo",
        display_name: "Identity Repo",
        kind: "coding",
        repository: {
          source: "remote_url",
          provider: "github",
          full_name: "acme/identity-repo",
        },
      }),
    });

    expect(second.status).toBe(200);
    const secondData = await second.json();
    expect(secondData.target_created).toBe(false);
    expect(secondData.target.id).toBe(firstData.target.id);
    // Names never decide identity: the existing Server Target keeps its
    // original alias/display_name (no implicit rename).
    expect(secondData.target.alias).toBe("device-a-custom-name");
    expect(secondData.target.display_name).toBe("Device A Custom Name");
    // The fresh device got its own binding to the reused target.
    expect(secondData.binding_created).toBe(true);
    expect(secondData.target.repository).toEqual({
      provider: "github",
      external_id: "acme/identity-repo",
      full_name: "acme/identity-repo",
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

describe("POST /api/connector/targets/:target_id/default-runtime (workspace default Agent Runtime target)", () => {
  let targetAId: string;
  let targetBId: string;

  beforeEach(async () => {
    for (const alias of ["runtime-a", "runtime-b"]) {
      const regRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerDevToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          alias,
          display_name: `Runtime ${alias}`,
          kind: "general_automation",
          repository: null,
        }),
      });
      expect(regRes.status).toBe(201);
      const data = await regRes.json();
      if (alias === "runtime-a") targetAId = data.target.id;
      else targetBId = data.target.id;
    }
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("rejects unexpected fields in the request body", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("INVALID_REQUEST");
  });

  it("owner sets an enabled same-workspace target as default runtime", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.workspace_id).toBe(workspaceId);
    expect(data.target_id).toBe(targetAId);
    expect(data.is_default_agent_runtime).toBe(true);
    expect(data.replayed).toBe(false);
    expect(typeof data.updated_at_ms).toBe("number");

    // Target catalogue marks the default target.
    const listRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const listData = await listRes.json();
    for (const item of listData.targets) {
      expect(item.target.is_default_agent_runtime).toBe(item.target.id === targetAId);
    }

    // Setting the same target again is an idempotent replay.
    const replayRes = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(replayRes.status).toBe(200);
    const replayData = await replayRes.json();
    expect(replayData.replayed).toBe(true);
    expect(replayData.target_id).toBe(targetAId);

    // Switching to another target moves the single workspace default.
    const switchRes = await fetch(`${baseUrl}/api/connector/targets/${targetBId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(switchRes.status).toBe(200);
    const switched = await switchRes.json();
    expect(switched.target_id).toBe(targetBId);
    expect(switched.replayed).toBe(false);

    const listRes2 = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const listData2 = await listRes2.json();
    for (const item of listData2.targets) {
      expect(item.target.is_default_agent_runtime).toBe(item.target.id === targetBId);
    }
  });

  it("forbids non-owner members from setting the default runtime", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberDevToken}` },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("DEVICE_NOT_ELIGIBLE");

    // No default was created.
    const listRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const listData = await listRes.json();
    expect(listData.targets.every((i: any) => i.target.is_default_agent_runtime === false)).toBe(true);
  });

  it("masks foreign targets as 404", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${foreignDevToken}` },
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("TARGET_NOT_FOUND");
  });

  it("returns 404 for a missing target", async () => {
    const res = await fetch(
      `${baseUrl}/api/connector/targets/tgt_00000000-0000-0000-0000-00000000dead/default-runtime`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDevToken}` },
      },
    );
    expect(res.status).toBe(404);
  });

  it("refuses to set a disabled target as default runtime", async () => {
    const disRes = await fetch(`${baseUrl}/api/user/targets/${targetAId}/disable`, {
      method: "POST",
      headers: { Cookie: `ceo_user_session=${sessionManager.createSession({ userId: userOwnerId, provider: "github", providerSubject: "sub_owner2" }).sessionId}` },
    });
    expect(disRes.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/connector/targets/${targetAId}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("TARGET_DISABLED");

    // No default exists for the workspace.
    const listRes = await fetch(`${baseUrl}/api/connector/targets`, {
      headers: { Authorization: `Bearer ${ownerDevToken}` },
    });
    const listData = await listRes.json();
    expect(listData.targets.every((i: any) => i.target.is_default_agent_runtime === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded legacy repository-identity backfill: POST /api/connector/targets/:target_id/attach-repository
// ---------------------------------------------------------------------------

describe("POST /api/connector/targets/:target_id/attach-repository (legacy backfill)", () => {
  let legacyTargetId: string;

  const attach = (token: string, targetId: string, fullName: string, provider = "github") =>
    fetch(`${baseUrl}/api/connector/targets/${targetId}/attach-repository`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        repository: {
          source: "remote_url",
          provider,
          full_name: fullName,
        },
      }),
    });

  beforeEach(async () => {
    // Legacy production shape: an active coding Target with NULL repository
    // metadata, created via the repository-less register path.
    const regRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "legacy-app",
        display_name: "Legacy App",
        kind: "coding",
        repository: null,
      }),
    });
    expect(regRes.status).toBe(201);
    const data = await regRes.json();
    legacyTargetId = data.target.id;
    expect(data.target.repository).toBeNull();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/connector/targets/${legacyTargetId}/attach-repository`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        repository: { source: "remote_url", provider: "github", full_name: "acme/main-repo" },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("attaches normalized repository identity to the exact legacy target_id without renaming", async () => {
    const res = await attach(ownerDevToken, legacyTargetId, "Acme/Main-Repo.git");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.replayed).toBe(false);
    expect(data.target.id).toBe(legacyTargetId);
    // No implicit rename: the legacy alias/display_name are untouched.
    expect(data.target.alias).toBe("legacy-app");
    expect(data.target.display_name).toBe("Legacy App");
    expect(data.target.kind).toBe("coding");
    expect(data.target.disabled).toBe(false);
    // Workspace binding full_name matches => external_id enriched to the
    // numeric binding id, exactly like the remote_url register path.
    expect(data.target.repository).toEqual({
      provider: "github",
      external_id: "987654",
      full_name: "acme/main-repo",
    });

    const stored = controlStore.getExecutionTarget(legacyTargetId);
    expect(stored!.repository_provider).toBe("github");
    expect(stored!.repository_external_id).toBe("987654");
    expect(stored!.repository_full_name).toBe("acme/main-repo");
  });

  it("falls back to the normalized full_name as external_id when the workspace binding does not match", async () => {
    const res = await attach(ownerDevToken, legacyTargetId, "acme/other-repo");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.target.repository).toEqual({
      provider: "github",
      external_id: "acme/other-repo",
      full_name: "acme/other-repo",
    });
  });

  it("is idempotent when the exact same identity is attached again", async () => {
    const first = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(first.status).toBe(200);

    const second = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(second.status).toBe(200);
    const data = await second.json();
    expect(data.replayed).toBe(true);
    expect(data.target.id).toBe(legacyTargetId);
    expect(data.target.repository).toEqual({
      provider: "github",
      external_id: "987654",
      full_name: "acme/main-repo",
    });
  });

  it("fails closed when the target already owns a DIFFERENT repository identity (never overwrites)", async () => {
    const first = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(first.status).toBe(200);

    const second = await attach(ownerDevToken, legacyTargetId, "acme/other-repo");
    expect(second.status).toBe(409);
    const data = await second.json();
    expect(data.error).toBe("TARGET_REPOSITORY_CONFLICT");

    // The original identity is preserved untouched.
    const stored = controlStore.getExecutionTarget(legacyTargetId);
    expect(stored!.repository_full_name).toBe("acme/main-repo");
  });

  it("fails closed when another active target already owns the same repository identity", async () => {
    // A different active target owns the identity first.
    const ownerRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "identity-owner",
        display_name: "Identity Owner",
        kind: "coding",
        repository: { source: "remote_url", provider: "github", full_name: "acme/main-repo" },
      }),
    });
    expect(ownerRes.status).toBe(201);

    const res = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("TARGET_REPOSITORY_CONFLICT");

    // The legacy target stays repository-null (never auto-merged).
    const stored = controlStore.getExecutionTarget(legacyTargetId);
    expect(stored!.repository_provider).toBeNull();
  });

  it("rejects a disabled target with 409 TARGET_DISABLED", async () => {
    const disRes = await fetch(`${baseUrl}/api/user/targets/${legacyTargetId}/disable`, {
      method: "POST",
      headers: { Cookie: `ceo_user_session=${sessionManager.createSession({ userId: userOwnerId, provider: "github", providerSubject: "sub_owner_disable" }).sessionId}` },
    });
    expect(disRes.status).toBe(200);

    const res = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("TARGET_DISABLED");
  });

  it("rejects a non-coding target", async () => {
    const regRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "automation-target",
        display_name: "Automation Target",
        kind: "general_automation",
        repository: null,
      }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();

    const res = await attach(ownerDevToken, regData.target.id, "acme/main-repo");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("TARGET_REPOSITORY_CONFLICT");
  });

  it("masks targets of another workspace as 404", async () => {
    const foreignRes = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${foreignDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: foreignWorkspaceId,
        alias: "foreign-legacy",
        display_name: "Foreign Legacy",
        kind: "coding",
        repository: null,
      }),
    });
    expect(foreignRes.status).toBe(201);
    const foreignData = await foreignRes.json();

    // Owner device claims its own workspace, but the target belongs to the
    // foreign workspace => masked as not-found.
    const res = await attach(ownerDevToken, foreignData.target.id, "acme/main-repo");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("TARGET_NOT_FOUND");
  });

  it("rejects callers outside the workspace with 403", async () => {
    const res = await attach(foreignDevToken, legacyTargetId, "acme/main-repo");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("DEVICE_NOT_ELIGIBLE");
  });

  it("rejects invalid full_name forms with 400", async () => {
    for (const badName of [
      "https://github.com/acme/main-repo",
      "not-a-repo-name",
      "",
    ]) {
      const res = await attach(ownerDevToken, legacyTargetId, badName);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("INVALID_REQUEST");
    }
  });

  it("rejects workspace_repository source and unexpected fields with 400", async () => {
    const res1 = await fetch(`${baseUrl}/api/connector/targets/${legacyTargetId}/attach-repository`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        repository: { source: "workspace_repository" },
      }),
    });
    expect(res1.status).toBe(400);
    expect((await res1.json()).error).toBe("INVALID_REQUEST");

    const res2 = await fetch(`${baseUrl}/api/connector/targets/${legacyTargetId}/attach-repository`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        repository: { source: "remote_url", provider: "github", full_name: "acme/main-repo" },
        alias: "sneaky-rename",
      }),
    });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toBe("INVALID_REQUEST");
  });

  it("after backfill, a fresh device register with a different human name resolves the same target (repository-first)", async () => {
    const backfill = await attach(ownerDevToken, legacyTargetId, "acme/main-repo");
    expect(backfill.status).toBe(200);

    // Fresh device (member), different requested alias/display_name, same
    // normalized Git repository identity.
    const fresh = await fetch(`${baseUrl}/api/connector/targets/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberDevToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        alias: "fresh-name-after-backfill",
        display_name: "Fresh Name After Backfill",
        kind: "coding",
        repository: { source: "remote_url", provider: "github", full_name: "acme/main-repo" },
      }),
    });
    expect(fresh.status).toBe(200);
    const freshData = await fresh.json();
    expect(freshData.target_created).toBe(false);
    expect(freshData.target.id).toBe(legacyTargetId);
    // No implicit rename.
    expect(freshData.target.alias).toBe("legacy-app");
  });
});
