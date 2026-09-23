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
  ConnectorPermissionError,
  ConnectorTargetDisabledError,
  ConnectorTargetRepositoryNotFoundError,
  ConnectorDeviceRevokedError,
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

describe("ConnectorControlStore - Execution Target Registry & Device Bindings", () => {
  let dev1: { id: string };
  let dev2: { id: string };
  let memberUserId: string;

  beforeEach(() => {
    dev1 = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Omen Machine",
      platform: "linux",
    });
    dev2 = connectorStore.createDevice({
      userId: testUserId,
      displayName: "Windows Machine",
      platform: "windows",
    });

    memberUserId = "usr_bob";
    store.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(memberUserId);
      db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_bob', ?, ?, 'member', 1000);").run(
        testWorkspaceId,
        memberUserId,
      );
      // Setup github installation and repository binding on test workspace
      db.prepare(`
        INSERT INTO github_installations (
          id, github_installation_id, github_app_id, account_id, account_login, account_type,
          repository_selection, suspended_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('inst_row_1', 'inst_1', 'app_1', 'acc_1', 'alice', 'User', 'selected', NULL, 1000, 1000);
      `).run();
      db.prepare(`
        INSERT INTO github_repository_bindings (
          id, workspace_id, github_repository_id, github_installation_row_id,
          owner_account_id, owner_login, repository_name, full_name, branch, created_at_ms, updated_at_ms
        ) VALUES ('grb_1', ?, '123456', 'inst_row_1', 'acc_1', 'alice', 'test-repo', 'alice/test-repo', 'main', 1000, 1000);
      `).run(testWorkspaceId);
    });
  });

  it("owner registers target with repository = null", () => {
    const res = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });

    expect(res.targetCreated).toBe(true);
    expect(res.bindingCreated).toBe(true);
    expect(res.replayed).toBe(false);
    expect(res.target.alias).toBe("ceo-dev");
    expect(res.target.kind).toBe("coding");
    expect(res.target.repository_provider).toBeNull();
    expect(res.target.repository_external_id).toBeNull();
    expect(res.target.repository_full_name).toBeNull();

    expect(res.binding.device_id).toBe(dev1.id);
    expect(res.binding.target_id).toBe(res.target.id);
    expect(res.binding.disabled_at_ms).toBeNull();
  });

  it("owner registers target with repositorySource = 'workspace_repository'", () => {
    const res = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-main",
      displayName: "CEO Main",
      kind: "coding",
      repositorySource: "workspace_repository",
    });

    expect(res.targetCreated).toBe(true);
    expect(res.target.repository_provider).toBe("github");
    expect(res.target.repository_external_id).toBe("123456");
    expect(res.target.repository_full_name).toBe("alice/test-repo");
  });

  it("throws TARGET_REPOSITORY_NOT_FOUND when workspace has no repository binding", () => {
    const emptyWsId = "ws_empty";
    store.withDb((db) => {
      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/alice/empty.git', 'main', 1000);").run(
        emptyWsId,
        testUserId,
      );
      db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_empty', ?, ?, 'owner', 1000);").run(
        emptyWsId,
        testUserId,
      );
    });

    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: dev1.id,
        workspaceId: emptyWsId,
        alias: "empty-target",
        displayName: "Empty Target",
        kind: "coding",
        repositorySource: "workspace_repository",
      }),
    ).toThrow(ConnectorTargetRepositoryNotFoundError);
  });

  it("replays registration idempotently with exact match metadata", () => {
    const first = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });
    expect(first.targetCreated).toBe(true);
    expect(first.replayed).toBe(false);

    const second = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });
    expect(second.targetCreated).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.target.id).toBe(first.target.id);
    expect(second.binding.id).toBe(first.binding.id);
  });

  it("registration re-enables previously disabled binding for calling device", () => {
    const first = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });

    // Unbind dev1
    connectorStore.unbindTargetForDevice({ deviceId: dev1.id, targetId: first.target.id });

    // Re-register dev1
    const reRegister = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });
    expect(reRegister.targetCreated).toBe(false);
    expect(reRegister.bindingCreated).toBe(false);
    expect(reRegister.replayed).toBe(false); // Re-enabled
    expect(reRegister.binding.disabled_at_ms).toBeNull();
  });

  it("throws ConnectorTargetConflictError when metadata conflicts on existing alias", () => {
    connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });

    // Conflict: Different kind
    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: dev1.id,
        workspaceId: testWorkspaceId,
        alias: "ceo-dev",
        displayName: "CEO Development",
        kind: "general_automation",
        repositorySource: null,
      }),
    ).toThrow(ConnectorTargetConflictError);

    // Conflict: Different display_name
    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: dev1.id,
        workspaceId: testWorkspaceId,
        alias: "ceo-dev",
        displayName: "Different Name",
        kind: "coding",
        repositorySource: null,
      }),
    ).toThrow(ConnectorTargetConflictError);

    // Conflict: Different repository source
    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: dev1.id,
        workspaceId: testWorkspaceId,
        alias: "ceo-dev",
        displayName: "CEO Development",
        kind: "coding",
        repositorySource: "workspace_repository",
      }),
    ).toThrow(ConnectorTargetConflictError);
  });

  it("throws ConnectorTargetDisabledError when target is disabled", () => {
    const res = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-dev",
      displayName: "CEO Development",
      kind: "coding",
      repositorySource: null,
    });

    connectorStore.disableExecutionTarget(res.target.id);

    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: dev1.id,
        workspaceId: testWorkspaceId,
        alias: "ceo-dev",
        displayName: "CEO Development",
        kind: "coding",
        repositorySource: null,
      }),
    ).toThrow(ConnectorTargetDisabledError);
  });

  it("forbids non-owner from creating a new target, but allows binding to existing target", () => {
    const bobDev = connectorStore.createDevice({
      userId: memberUserId,
      displayName: "Bob Device",
      platform: "linux",
    });

    // Bob cannot create new target
    expect(() =>
      connectorStore.registerExecutionTargetForDevice({
        deviceId: bobDev.id,
        workspaceId: testWorkspaceId,
        alias: "bob-target",
        displayName: "Bob Target",
        kind: "coding",
        repositorySource: null,
      }),
    ).toThrow(ConnectorPermissionError);

    // Alice creates target
    const aliceRes = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "shared-target",
      displayName: "Shared Target",
      kind: "coding",
      repositorySource: null,
    });

    // Bob binds to existing target via register or bindTargetForDevice
    const bobBind = connectorStore.bindTargetForDevice({
      deviceId: bobDev.id,
      targetId: aliceRes.target.id,
    });
    expect(bobBind.binding.device_id).toBe(bobDev.id);
    expect(bobBind.binding.target_id).toBe(aliceRes.target.id);
    expect(bobBind.replayed).toBe(false);

    // Bob replaying bind returns replayed = true
    const bobReplay = connectorStore.bindTargetForDevice({
      deviceId: bobDev.id,
      targetId: aliceRes.target.id,
    });
    expect(bobReplay.replayed).toBe(true);
  });

  it("multi-device binding lifecycle: unbinding one device leaves other device and target active", () => {
    const reg = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "shared-env",
      displayName: "Shared Env",
      kind: "coding",
      repositorySource: null,
    });

    // Dev2 binds to same target
    connectorStore.bindTargetForDevice({
      deviceId: dev2.id,
      targetId: reg.target.id,
    });

    // Verify active count is 2
    let visible = connectorStore.listTargetsVisibleToDevice(dev1.id);
    expect(visible[0]!.activeBindingCount).toBe(2);

    // Dev1 unbinds
    connectorStore.unbindTargetForDevice({
      deviceId: dev1.id,
      targetId: reg.target.id,
    });

    // Target is still active, Dev2 is still active, Dev1 has no active binding
    visible = connectorStore.listTargetsVisibleToDevice(dev1.id);
    expect(visible[0]!.thisBinding?.disabled_at_ms).not.toBeNull();
    expect(visible[0]!.activeBindingCount).toBe(1);

    const dev2Visible = connectorStore.listTargetsVisibleToDevice(dev2.id);
    expect(dev2Visible[0]!.thisBinding?.disabled_at_ms).toBeNull();
    expect(dev2Visible[0]!.activeBindingCount).toBe(1);

    // Dev2 also unbinds -> target remains active with 0 active bindings
    connectorStore.unbindTargetForDevice({
      deviceId: dev2.id,
      targetId: reg.target.id,
    });
    const afterAllUnbind = connectorStore.listTargetsVisibleToDevice(dev1.id);
    expect(afterAllUnbind[0]!.target.disabled_at_ms).toBeNull();
    expect(afterAllUnbind[0]!.activeBindingCount).toBe(0);
  });

  it("global disable and enable lifecycle", () => {
    const reg = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "ceo-prod",
      displayName: "CEO Production",
      kind: "coding",
      repositorySource: null,
    });

    expect(connectorStore.resolveEligibleBinding(dev1.id, reg.target.id).eligible).toBe(true);

    // Global disable
    expect(connectorStore.disableExecutionTarget(reg.target.id)).toBe(true);
    expect(connectorStore.resolveEligibleBinding(dev1.id, reg.target.id).eligible).toBe(false);

    // Global enable
    expect(connectorStore.enableExecutionTarget(reg.target.id)).toBe(true);
    expect(connectorStore.resolveEligibleBinding(dev1.id, reg.target.id).eligible).toBe(true);
  });

  it("reconcileExecutionTargetRepositoryMetadata updates all matching targets", () => {
    const t1 = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev1.id,
      workspaceId: testWorkspaceId,
      alias: "t1",
      displayName: "Target 1",
      kind: "coding",
      repositorySource: "workspace_repository",
    });
    const t2 = connectorStore.registerExecutionTargetForDevice({
      deviceId: dev2.id,
      workspaceId: testWorkspaceId,
      alias: "t2",
      displayName: "Target 2",
      kind: "coding",
      repositorySource: "workspace_repository",
    });

    expect(t1.target.repository_full_name).toBe("alice/test-repo");
    expect(t2.target.repository_full_name).toBe("alice/test-repo");

    const updatedCount = connectorStore.reconcileExecutionTargetRepositoryMetadata({
      provider: "github",
      externalId: "123456",
      fullName: "alice/new-repo-name",
    });
    expect(updatedCount).toBe(2);

    expect(connectorStore.getExecutionTarget(t1.target.id)!.repository_full_name).toBe("alice/new-repo-name");
    expect(connectorStore.getExecutionTarget(t2.target.id)!.repository_full_name).toBe("alice/new-repo-name");
  });

  it("masks foreign target IDs as 404 in bind and unbind", () => {
    // Another user in foreign workspace
    const foreignUserId = "usr_charlie";
    const foreignWsId = "ws_foreign";
    store.withDb((db) => {
      db.prepare("INSERT INTO users VALUES (?, 1000, NULL, 0);").run(foreignUserId);
      db.prepare("INSERT INTO workspaces VALUES (?, ?, 'https://github.com/charlie/repo.git', 'main', 1000);").run(
        foreignWsId,
        foreignUserId,
      );
      db.prepare("INSERT INTO workspace_memberships VALUES ('wsm_charlie', ?, ?, 'owner', 1000);").run(
        foreignWsId,
        foreignUserId,
      );
    });
    const charlieDev = connectorStore.createDevice({
      userId: foreignUserId,
      displayName: "Charlie Device",
      platform: "linux",
    });

    const foreignTarget = connectorStore.registerExecutionTargetForDevice({
      deviceId: charlieDev.id,
      workspaceId: foreignWsId,
      alias: "charlie-target",
      displayName: "Charlie Target",
      kind: "coding",
      repositorySource: null,
    });

    // Alice dev1 tries to bind to Charlie's target
    expect(() =>
      connectorStore.bindTargetForDevice({
        deviceId: dev1.id,
        targetId: foreignTarget.target.id,
      }),
    ).toThrow(ConnectorNotFoundError);

    // Alice dev1 tries to unbind from Charlie's target
    expect(() =>
      connectorStore.unbindTargetForDevice({
        deviceId: dev1.id,
        targetId: foreignTarget.target.id,
      }),
    ).toThrow(ConnectorNotFoundError);
  });
});
