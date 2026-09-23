import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import {
  ConnectorControlStore,
  ConnectorControlError,
  ConnectorTargetConflictError,
  ConnectorValidationError,
  ConnectorNotFoundError,
} from "../src/connector/control-store.js";

const cleanupDirs: string[] = [];
let store: IdentityStore;
let connectorStore: ConnectorControlStore;
let dbPath: string;

let testUserId: string;
let testWorkspaceId: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-connector-store-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  store = IdentityStore.open(dbPath);
  connectorStore = new ConnectorControlStore(store);

  // Setup seed user and workspace
  testUserId = "usr_alice";
  testWorkspaceId = "ws_alice";
  store.withDb((db) => {
    db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(testUserId);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/alice/test-repo.git', 'main', 1000);").run(
      testWorkspaceId,
      testUserId,
    );
    db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_alice', ?, ?, 'owner', 1000);").run(
      testWorkspaceId,
      testUserId,
    );
  });
});

afterEach(async () => {
  store?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ConnectorControlStore - Devices", () => {
  it("creates, retrieves, lists, and revokes a device", () => {
    const dev = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Omen Gaming Rig",
      platform: "linux",
    });

    expect(dev.id).toMatch(/^dev_[0-9a-f-]{36}$/);
    expect(dev.display_name).toBe("Omen Gaming Rig");
    expect(dev.platform).toBe("linux");
    expect(dev.revoked_at_ms).toBeNull();

    const fetched = connectorStore.getDevice(dev.id);
    expect(fetched).toEqual(dev);

    const listActive = connectorStore.listDevicesForUser(testUserId);
    expect(listActive).toHaveLength(1);
    expect(listActive[0]?.id).toBe(dev.id);

    // Revoke
    const revoked = connectorStore.revokeDevice(dev.id);
    expect(revoked).toBe(true);

    const afterRevoke = connectorStore.getDevice(dev.id);
    expect(afterRevoke?.revoked_at_ms).toBeTypeOf("number");

    // Default list excludes revoked
    expect(connectorStore.listDevicesForUser(testUserId)).toHaveLength(0);
    // Explicit includeRevoked returns it
    expect(connectorStore.listDevicesForUser(testUserId, { includeRevoked: true })).toHaveLength(1);
  });

  it("rejects device creation for non-existent or disabled user", () => {
    expect(() =>
      connectorStore.createDevice({
        userId: "usr_nonexistent",
        displayName: "Laptop",
        platform: "macos",
      }),
    ).toThrow(ConnectorNotFoundError);
  });
});

describe("ConnectorControlStore - Credentials", () => {
  it("creates, retrieves by ID, and revokes credentials", () => {
    const dev = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Server Node",
      platform: "linux",
    });

    const digest = "a".repeat(64);
    const cred = connectorStore.createDeviceCredential({
      deviceId: dev.id,
      secretDigest: digest,
      issuedAtMs: 1000,
      expiresAtMs: 2000,
    });

    expect(cred.id).toMatch(/^dcr_[0-9a-f-]{36}$/);
    expect(cred.device_id).toBe(dev.id);
    expect(cred.secret_digest).toBe(digest);
    expect(cred.revoked_at_ms).toBeNull();

    const byId = connectorStore.getDeviceCredential(cred.id);
    expect(byId).toEqual(cred);

    const revoked = connectorStore.revokeDeviceCredential(cred.id);
    expect(revoked).toBe(true);

    const afterRevoke = connectorStore.getDeviceCredential(cred.id);
    expect(afterRevoke?.revoked_at_ms).toBeTypeOf("number");
  });

  it("rejects credential issuance for revoked device", () => {
    const dev = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Old Mac",
      platform: "macos",
    });
    connectorStore.revokeDevice(dev.id);

    expect(() =>
      connectorStore.createDeviceCredential({
        deviceId: dev.id,
        secretDigest: "b".repeat(64),
        expiresAtMs: Date.now() + 10000,
      }),
    ).toThrow(ConnectorValidationError);
  });
});

describe("ConnectorControlStore - Execution Targets", () => {
  it("creates general and git execution targets with alias normalization", () => {
    const general = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "TOOLS",
      displayName: "Tools Runtime",
      kind: "general_automation",
    });
    expect(general.id).toMatch(/^tgt_[0-9a-f-]{36}$/);
    expect(general.alias).toBe("tools"); // Normalized to lowercase
    expect(general.repository_provider).toBeNull();

    const gitTarget = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "ceo-main",
      displayName: "CEO Main App",
      kind: "coding",
      repositoryProvider: "github",
      repositoryExternalId: "987654321",
      repositoryFullName: "SentimentalK/chief-everything-officer",
    });
    expect(gitTarget.alias).toBe("ceo-main");
    expect(gitTarget.repository_provider).toBe("github");
    expect(gitTarget.repository_external_id).toBe("987654321");
  });

  it("permits multiple targets pointing to the same repository in the same workspace", () => {
    const targetA = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Dev Target",
      kind: "coding",
      repositoryProvider: "github",
      repositoryExternalId: "987654321",
      repositoryFullName: "SentimentalK/chief-everything-officer",
    });

    const targetB = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "ceo-tests",
      displayName: "CEO Tests Target",
      kind: "coding",
      repositoryProvider: "github",
      repositoryExternalId: "987654321",
      repositoryFullName: "SentimentalK/chief-everything-officer",
    });

    expect(targetA.id).not.toBe(targetB.id);
    expect(targetA.repository_external_id).toBe(targetB.repository_external_id);
  });

  it("rejects duplicate alias in the same workspace", () => {
    connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "my-target",
      displayName: "Target 1",
      kind: "general_automation",
    });

    expect(() =>
      connectorStore.createExecutionTarget({
        workspaceId: testWorkspaceId,
        alias: "MY-TARGET",
        displayName: "Target 2",
        kind: "general_automation",
      }),
    ).toThrow(ConnectorTargetConflictError);
  });

  it("rejects invalid alias pattern and unsupported V1 target kind", () => {
    expect(() =>
      connectorStore.createExecutionTarget({
        workspaceId: testWorkspaceId,
        alias: "-bad-start",
        displayName: "Bad",
        kind: "general_automation",
      }),
    ).toThrow(ConnectorValidationError);

    expect(() =>
      connectorStore.createExecutionTarget({
        workspaceId: testWorkspaceId,
        alias: "valid-alias",
        displayName: "Valid",
        kind: "unsupported_v2_kind",
      }),
    ).toThrow(ConnectorValidationError);
  });

  it("rejects incomplete repository triple", () => {
    expect(() =>
      connectorStore.createExecutionTarget({
        workspaceId: testWorkspaceId,
        alias: "incomplete-repo",
        displayName: "Incomplete",
        kind: "coding",
        repositoryProvider: "github",
        // repositoryExternalId is missing!
      }),
    ).toThrow(ConnectorValidationError);
  });
});

describe("ConnectorControlStore - Bindings & Full Eligibility", () => {
  it("manages bindings and evaluates full authority eligibility predicate", () => {
    const dev = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Host Dev",
      platform: "linux",
    });

    const target = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "run-benchmarks",
      displayName: "Benchmarks",
      kind: "general_automation",
    });

    // Initial eligibility without binding
    const resNoBinding = connectorStore.resolveEligibleBinding(dev.id, target.id);
    expect(resNoBinding.eligible).toBe(false);

    // Create binding
    const binding = connectorStore.upsertDeviceTargetBinding({
      deviceId: dev.id,
      targetId: target.id,
    });
    expect(binding.id).toMatch(/^dtb_[0-9a-f-]{36}$/);

    // Full eligibility succeeds: device active, target active, binding active, membership active, user active
    const resEligible = connectorStore.resolveEligibleBinding(dev.id, target.id);
    expect(resEligible.eligible).toBe(true);
    expect(resEligible.device?.id).toBe(dev.id);
    expect(resEligible.target?.id).toBe(target.id);
    expect(resEligible.binding?.id).toBe(binding.id);

    const eligibleTargetIds = connectorStore.listEligibleTargetIdsForDevice(dev.id);
    expect(eligibleTargetIds).toEqual([target.id]);

    // Test 1: Binding disabled
    connectorStore.disableDeviceTargetBinding(dev.id, target.id);
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(false);
    expect(connectorStore.listEligibleTargetIdsForDevice(dev.id)).toHaveLength(0);

    // Re-enable binding via upsert
    connectorStore.upsertDeviceTargetBinding({ deviceId: dev.id, targetId: target.id });
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(true);

    // Test 2: Target disabled
    connectorStore.disableExecutionTarget(target.id);
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(false);

    // Re-enable target for next checks
    store.withDb((db) => db.prepare("UPDATE execution_targets SET disabled_at_ms = NULL WHERE id = ?;").run(target.id));
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(true);

    // Test 3: Device revoked
    connectorStore.revokeDevice(dev.id);
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(false);
  });

  it("revokes eligibility when workspace membership is lost or user is disabled", () => {
    const dev = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Host Dev 2",
      platform: "linux",
    });

    const target = connectorStore.createExecutionTarget({
      workspaceId: testWorkspaceId,
      alias: "run-worker",
      displayName: "Worker",
      kind: "coding",
      repositoryProvider: "github",
      repositoryExternalId: "123",
      repositoryFullName: "org/repo",
    });

    connectorStore.upsertDeviceTargetBinding({
      deviceId: dev.id,
      targetId: target.id,
    });
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(true);

    // Remove workspace membership for user
    store.withDb((db) =>
      db.prepare("DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?;").run(
        testWorkspaceId,
        testUserId,
      ),
    );
    const resNoMembership = connectorStore.resolveEligibleBinding(dev.id, target.id);
    expect(resNoMembership.eligible).toBe(false);
    expect(resNoMembership.reason).toMatch(/not a member/);

    // Restore membership
    store.withDb((db) =>
      db
        .prepare("INSERT INTO workspace_memberships VALUES (?, ?, ?, 'owner', 1000);")
        .run("wsm_restored", testWorkspaceId, testUserId),
    );
    expect(connectorStore.resolveEligibleBinding(dev.id, target.id).eligible).toBe(true);

    // Disable user (Point 5 verification)
    store.withDb((db) => db.prepare("UPDATE users SET disabled_at = 9999 WHERE id = ?;").run(testUserId));
    const resUserDisabled = connectorStore.resolveEligibleBinding(dev.id, target.id);
    expect(resUserDisabled.eligible).toBe(false);
    expect(resUserDisabled.reason).toMatch(/disabled/);
    expect(connectorStore.listEligibleTargetIdsForDevice(dev.id)).toHaveLength(0);
  });
});

describe("ConnectorControlStore - finalizeDeviceEnrollment", () => {
  const secretDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("atomically creates both device and credential", () => {
    const deviceId = "dev_11111111-1111-1111-1111-111111111111";
    const credentialId = "dcr_11111111-1111-1111-1111-111111111111";
    const now = 1700000000000;
    const expiresAt = now + 365 * 24 * 60 * 60 * 1000;

    const result = connectorStore.finalizeDeviceEnrollment({
      deviceId,
      credentialId,
      userId: testUserId,
      displayName: "Omen Gaming Rig",
      platform: "linux",
      secretDigest,
      issuedAtMs: now,
      expiresAtMs: expiresAt,
    });

    expect(result.replayed).toBe(false);
    expect(result.device.id).toBe(deviceId);
    expect(result.device.display_name).toBe("Omen Gaming Rig");
    expect(result.device.platform).toBe("linux");
    expect(result.device.user_id).toBe(testUserId);
    expect(result.device.created_at_ms).toBe(now);

    expect(result.credential.id).toBe(credentialId);
    expect(result.credential.device_id).toBe(deviceId);
    expect(result.credential.secret_digest).toBe(secretDigest);
    expect(result.credential.expires_at_ms).toBe(expiresAt);

    // Verify stored
    const dev = connectorStore.getDevice(deviceId);
    expect(dev).toEqual(result.device);
    const cred = connectorStore.getDeviceCredential(credentialId);
    expect(cred).toEqual(result.credential);
  });

  it("idempotently replays with exact match metadata", () => {
    const deviceId = "dev_22222222-2222-2222-2222-222222222222";
    const credentialId = "dcr_22222222-2222-2222-2222-222222222222";
    const now = 1700000000000;
    const expiresAt = now + 365 * 24 * 60 * 60 * 1000;

    const first = connectorStore.finalizeDeviceEnrollment({
      deviceId,
      credentialId,
      userId: testUserId,
      displayName: "Laptop",
      platform: "macos",
      secretDigest,
      issuedAtMs: now,
      expiresAtMs: expiresAt,
    });
    expect(first.replayed).toBe(false);

    const second = connectorStore.finalizeDeviceEnrollment({
      deviceId,
      credentialId,
      userId: testUserId,
      displayName: "Laptop",
      platform: "macos",
      secretDigest,
      issuedAtMs: now,
      expiresAtMs: expiresAt,
    });
    expect(second.replayed).toBe(true);
    expect(second.device.id).toBe(deviceId);
    expect(second.credential.id).toBe(credentialId);
  });

  it("fails closed on conflicting metadata for existing IDs", () => {
    const deviceId = "dev_33333333-3333-3333-3333-333333333333";
    const credentialId = "dcr_33333333-3333-3333-3333-333333333333";
    const now = 1700000000000;
    const expiresAt = now + 365 * 24 * 60 * 60 * 1000;

    connectorStore.finalizeDeviceEnrollment({
      deviceId,
      credentialId,
      userId: testUserId,
      displayName: "Workstation",
      platform: "linux",
      secretDigest,
      issuedAtMs: now,
      expiresAtMs: expiresAt,
    });

    // Conflict: Different display_name
    expect(() =>
      connectorStore.finalizeDeviceEnrollment({
        deviceId,
        credentialId,
        userId: testUserId,
        displayName: "Different Name",
        platform: "linux",
        secretDigest,
        issuedAtMs: now,
        expiresAtMs: expiresAt,
      }),
    ).toThrow(ConnectorControlError);

    // Conflict: Different secret digest
    const otherDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(() =>
      connectorStore.finalizeDeviceEnrollment({
        deviceId,
        credentialId,
        userId: testUserId,
        displayName: "Workstation",
        platform: "linux",
        secretDigest: otherDigest,
        issuedAtMs: now,
        expiresAtMs: expiresAt,
      }),
    ).toThrow(ConnectorControlError);
  });

  it("fails closed on partial existing state", () => {
    const deviceId = "dev_44444444-4444-4444-4444-444444444444";
    const credentialId = "dcr_44444444-4444-4444-4444-444444444444";
    const now = 1700000000000;
    const expiresAt = now + 365 * 24 * 60 * 60 * 1000;

    // Create device alone first
    connectorStore.createDevice({
      userId: testUserId,
      displayName: "Pre-existing Device",
      platform: "linux",
    });

    // Now try to finalize with an existing device ID but new credential ID
    const preExistingDev = connectorStore.listDevicesForUser(testUserId)[0]!;
    expect(() =>
      connectorStore.finalizeDeviceEnrollment({
        deviceId: preExistingDev.id,
        credentialId,
        userId: testUserId,
        displayName: "Pre-existing Device",
        platform: "linux",
        secretDigest,
        issuedAtMs: now,
        expiresAtMs: expiresAt,
      }),
    ).toThrow(ConnectorControlError);
  });
});
