import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  IdentityStore,
  provisionEmptyControlPlaneDatabase,
} from "../src/identity/store.js";
import { ConnectorControlStore } from "../src/connector/control-store.js";

const cleanupDirs: string[] = [];
let store: IdentityStore;
let controlStore: ConnectorControlStore;
let dbPath: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ceo-reconcile-test-"));
  cleanupDirs.push(dir);
  dbPath = path.join(dir, "identity.sqlite");
  provisionEmptyControlPlaneDatabase(dbPath);

  store = IdentityStore.open(dbPath);
  controlStore = new ConnectorControlStore(store);
});

afterEach(async () => {
  store?.close();
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Repository Metadata Reconciliation with Execution Targets", () => {
  it("synchronously updates github_repository_bindings, workspaces.remote_url, and execution_targets", () => {
    const user = store.resolveOrCreateExternalUser({
      provider: "github",
      providerSubject: "gh_user_alice",
      providerLogin: "alice",
    });

    const inst = store.upsertGitHubInstallationWithUser({
      githubAppId: "123",
      githubInstallationId: "100",
      accountId: "654321",
      accountLogin: "alice",
      accountType: "User",
      repositorySelection: "selected",
      userId: user.user_id,
    });

    const bound = store.createWorkspaceWithRepositoryBinding({
      userId: user.user_id,
      installationRowId: inst.installation.id,
      githubRepositoryId: "999888",
      ownerAccountId: "654321",
      ownerLogin: "alice",
      repositoryName: "ceo-data",
      fullName: "alice/ceo-data",
      branch: "main",
    });

    const dev = controlStore.createDevice({
      userId: user.user_id,
      displayName: "Alice Dev",
      platform: "linux",
    });

    // Create two targets referencing this workspace's repository
    const t1 = controlStore.registerExecutionTargetForDevice({
      deviceId: dev.id,
      workspaceId: bound.workspace.id,
      alias: "ceo-dev",
      displayName: "CEO Dev",
      kind: "coding",
      repositorySource: "workspace_repository",
    });

    const t2 = controlStore.registerExecutionTargetForDevice({
      deviceId: dev.id,
      workspaceId: bound.workspace.id,
      alias: "ceo-test",
      displayName: "CEO Test",
      kind: "coding",
      repositorySource: "workspace_repository",
    });

    expect(t1.target.repository_full_name).toBe("alice/ceo-data");
    expect(t2.target.repository_full_name).toBe("alice/ceo-data");

    // Reconcile repository rename to alice/life-os
    const reconciled = store.reconcileRepositoryMetadataById({
      githubRepositoryId: "999888",
      ownerLogin: "alice",
      repositoryName: "life-os",
      fullName: "alice/life-os",
    });

    expect(reconciled.binding.full_name).toBe("alice/life-os");
    expect(reconciled.workspaceRemoteUrl).toBe("https://github.com/alice/life-os.git");

    // Verify workspace
    const ws = store.findWorkspaceById(bound.workspace.id)!;
    expect(ws.remote_url).toBe("https://github.com/alice/life-os.git");

    // Verify both execution targets were updated while target IDs remain stable
    const updatedT1 = controlStore.getExecutionTarget(t1.target.id)!;
    const updatedT2 = controlStore.getExecutionTarget(t2.target.id)!;

    expect(updatedT1.id).toBe(t1.target.id);
    expect(updatedT1.repository_external_id).toBe("999888");
    expect(updatedT1.repository_full_name).toBe("alice/life-os");

    expect(updatedT2.id).toBe(t2.target.id);
    expect(updatedT2.repository_external_id).toBe("999888");
    expect(updatedT2.repository_full_name).toBe("alice/life-os");
  });
});
