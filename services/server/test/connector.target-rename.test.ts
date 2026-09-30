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
let foreignDevToken: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-rename-test-"));
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

    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/foreign/repo.git', 'main', 1000);").run(
      foreignWorkspaceId,
      userForeignId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_foreign', ?, ?, 'owner', 1000);").run(
      foreignWorkspaceId,
      userForeignId,
    );

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

  const now = Date.now();
  const secret1 = "a".repeat(64);
  const secretDigest1 = crypto.createHash("sha256").update(secret1, "utf8").digest("hex");
  const secret2 = "b".repeat(64);
  const secretDigest2 = crypto.createHash("sha256").update(secret2, "utf8").digest("hex");
  const secret3 = "c".repeat(64);
  const secretDigest3 = crypto.createHash("sha256").update(secret3, "utf8").digest("hex");

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

  const memberDeviceId = "dev_00000000-0000-0000-0000-000000000002";
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

  const foreignDeviceId = "dev_00000000-0000-0000-0000-000000000003";
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

  const app = express();
  app.use(express.json());

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

async function registerTarget(
  token: string,
  alias: string,
  kind: "coding" | "general_automation" = "general_automation",
  useWorkspaceRepository = false,
): Promise<{ id: string; alias: string }> {
  const res = await fetch(`${baseUrl}/api/connector/targets/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspace_id: workspaceId,
      alias,
      display_name: `Target ${alias}`,
      kind,
      repository: useWorkspaceRepository ? { source: "workspace_repository" } : null,
    }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  return { id: data.target.id, alias: data.target.alias };
}

async function listTargets(token: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/connector/targets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.targets;
}

async function renameTarget(
  token: string,
  targetId: string,
  alias: unknown,
  extraBody?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const body = extraBody ?? { alias };
  const res = await fetch(`${baseUrl}/api/connector/targets/${targetId}/rename`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe("POST /api/connector/targets/:target_id/rename", () => {
  it("renames a target keeping the immutable target_id and preserving relationships", async () => {
    const target = await registerTarget(ownerDevToken, "bill-laptop");

    // Attach relationships before rename: device binding + default runtime + repo metadata.
    const bindRes = await fetch(`${baseUrl}/api/connector/targets/${target.id}/bind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(bindRes.status).toBe(200);

    const defaultRes = await fetch(`${baseUrl}/api/connector/targets/${target.id}/default-runtime`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerDevToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(defaultRes.status).toBe(200);

    const before = (await listTargets(ownerDevToken)).find((t) => t.target?.id === target.id);
    expect(before).toBeTruthy();

    const { status, data } = await renameTarget(ownerDevToken, target.id, "bill-desk");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.target_id).toBe(target.id);
    expect(data.previous_alias).toBe("bill-laptop");
    expect(data.alias).toBe("bill-desk");
    expect(data.replayed).toBe(false);
    expect(typeof data.updated_at_ms).toBe("number");

    // Same immutable ID; relationships preserved and exposed on listing.
    const items = await listTargets(ownerDevToken);
    const after = items.find((t) => t.target?.id === target.id);
    expect(after).toBeTruthy();
    const afterTarget = after!.target as Record<string, unknown>;
    expect(afterTarget.alias).toBe("bill-desk");
    expect(afterTarget.kind).toBe(before!.target && (before!.target as Record<string, unknown>).kind);
    expect(afterTarget.repository).toEqual((before!.target as Record<string, unknown>).repository);
    expect(afterTarget.disabled).toBe(false);
    expect(afterTarget.is_default_agent_runtime).toBe(true);
    expect(after!.this_device_binding).toBeTruthy();
    expect(after!.active_binding_count).toBe(1);

    // Store-level: default-runtime relationship still attached to the same target.
    const resolution = controlStore.resolveDefaultAgentRuntimeTarget(workspaceId);
    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.target.id).toBe(target.id);
      expect(resolution.target.alias).toBe("bill-desk");
    }
  });

  it("preserves repository metadata, kind, and disabled state through rename", async () => {
    const target = await registerTarget(ownerDevToken, "repo-tgt", "coding", true);
    controlStore.disableExecutionTarget(target.id);

    const { status, data } = await renameTarget(ownerDevToken, target.id, "renamed-tgt");
    expect(status).toBe(200);

    const record = controlStore.getExecutionTarget(target.id)!;
    expect(record.id).toBe(target.id);
    expect(record.alias).toBe("renamed-tgt");
    expect(record.kind).toBe("coding");
    expect(record.repository_provider).toBe("github");
    expect(record.repository_external_id).toBe("987654");
    expect(record.repository_full_name).toBe("acme/main-repo");
    expect(record.disabled_at_ms).not.toBeNull();
    expect(data.replayed).toBe(false);
  });

  it("preserves job-history linkage by keeping the same target id (no delete/recreate)", async () => {
    const target = await registerTarget(ownerDevToken, "with-jobs");

    const { status, data } = await renameTarget(ownerDevToken, target.id, "with-jobs-2");
    expect(status).toBe(200);
    expect(data.target_id).toBe(target.id);

    // Job history in this architecture is keyed by the immutable target_id;
    // the renamed target must still resolve eligibility through the same row.
    const eligible = controlStore.resolveEligibleBinding(ownerDeviceId, target.id);
    expect(eligible.eligible).toBe(true);
    expect(eligible.target?.id).toBe(target.id);
  });

  it("fails atomically when the new alias is owned by another target (no partial mutation)", async () => {
    const first = await registerTarget(ownerDevToken, "target-one");
    const second = await registerTarget(ownerDevToken, "target-two");
    const firstBefore = controlStore.getExecutionTarget(first.id)!;

    const { status, data } = await renameTarget(ownerDevToken, first.id, "target-two");
    expect(status).toBe(409);
    expect(data.error).toBe("TARGET_ALIAS_CONFLICT");

    // No partial mutation: first target keeps its old alias, second untouched.
    expect(controlStore.getExecutionTarget(first.id)!.alias).toBe("target-one");
    expect(controlStore.getExecutionTarget(first.id)!.updated_at_ms).toBe(firstBefore.updated_at_ms);
    expect(controlStore.getExecutionTarget(second.id)!.alias).toBe("target-two");
  });

  it("renaming to the current alias is a safe idempotent replay", async () => {
    const target = await registerTarget(ownerDevToken, "steady-alias");
    const before = controlStore.getExecutionTarget(target.id)!;

    const { status, data } = await renameTarget(ownerDevToken, target.id, "steady-alias");
    expect(status).toBe(200);
    expect(data.replayed).toBe(true);
    expect(data.alias).toBe("steady-alias");
    expect(data.previous_alias).toBe("steady-alias");
    expect(data.updated_at_ms).toBe(before.updated_at_ms);
    expect(controlStore.getExecutionTarget(target.id)!.updated_at_ms).toBe(before.updated_at_ms);
  });

  it("releases the old alias immediately: listing shows the new alias and the old one no longer resolves", async () => {
    const target = await registerTarget(ownerDevToken, "old-alias");

    await renameTarget(ownerDevToken, target.id, "new-alias");

    const items = await listTargets(ownerDevToken);
    const aliases = items.map((t) => (t.target as Record<string, unknown>).alias);
    expect(aliases).toContain("new-alias");
    expect(aliases).not.toContain("old-alias");
    expect(controlStore.getExecutionTargetByAlias(workspaceId, "new-alias")!.id).toBe(target.id);
    expect(controlStore.getExecutionTargetByAlias(workspaceId, "old-alias")).toBeNull();
  });

  it("masks cross-workspace access as not-found", async () => {
    const target = await registerTarget(ownerDevToken, "private-tgt");
    const { status, data } = await renameTarget(foreignDevToken, target.id, "stolen-alias");
    expect(status).toBe(404);
    expect(data.error).toBe("TARGET_NOT_FOUND");
    expect(controlStore.getExecutionTarget(target.id)!.alias).toBe("private-tgt");
  });

  it("rejects non-owner members with 403", async () => {
    const target = await registerTarget(ownerDevToken, "owner-only-tgt");
    const { status, data } = await renameTarget(memberDevToken, target.id, "member-rename");
    expect(status).toBe(403);
    expect(data.error).toBe("DEVICE_NOT_ELIGIBLE");
    expect(controlStore.getExecutionTarget(target.id)!.alias).toBe("owner-only-tgt");
  });

  it("rejects invalid aliases and malformed bodies with 400", async () => {
    const target = await registerTarget(ownerDevToken, "valid-tgt");

    const invalid = await renameTarget(ownerDevToken, target.id, "Invalid Alias!");
    expect(invalid.status).toBe(400);
    expect(invalid.data.error).toBe("INVALID_REQUEST");

    const tooLong = await renameTarget(ownerDevToken, target.id, "a".repeat(65));
    expect(tooLong.status).toBe(400);

    const extraField = await renameTarget(ownerDevToken, target.id, undefined, {
      alias: "ok-alias",
      unexpected: true,
    });
    expect(extraField.status).toBe(400);

    const missingAlias = await renameTarget(ownerDevToken, target.id, undefined, {});
    expect(missingAlias.status).toBe(400);

    // No partial mutation from any rejected request.
    expect(controlStore.getExecutionTarget(target.id)!.alias).toBe("valid-tgt");
  });

  it("rejects unknown target ids with 404", async () => {
    const { status, data } = await renameTarget(ownerDevToken, "tgt_missing", "whatever");
    expect(status).toBe(404);
    expect(data.error).toBe("TARGET_NOT_FOUND");
  });
});
