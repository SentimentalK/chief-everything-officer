import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  CeoWorkspace,
  PROCESS_INSTANCE_ID,
  ACTIVE_WORKSPACE_LOCKS,
  STALE_RECOVERY_BY_LOCK_DIR,
  type LockOwnerMetadata,
} from "../src/workspace.js";
import type { WorkspaceConfig } from "../src/git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("CeoWorkspace Lock Resilience & Stale Lock Auto-Healing", () => {
  let tempDir: string;
  let remoteDir: string;
  let localDir: string;
  let stateDir: string;
  let txnDir: string;
  let lockDir: string;
  let config: WorkspaceConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ceo-lock-test-"));
    remoteDir = path.join(tempDir, "remote.git");
    localDir = path.join(tempDir, "local");
    stateDir = path.join(tempDir, "state");
    txnDir = path.join(tempDir, "txn");
    lockDir = path.join(stateDir, "write.lock");

    // Initialize bare remote repo with a main branch
    git(tempDir, "init", "--bare", "--initial-branch=main", remoteDir);
    const seed = path.join(tempDir, "seed");
    await mkdir(seed, { recursive: true });
    git(seed, "init", "--initial-branch=main");
    git(seed, "config", "user.name", "Test");
    git(seed, "config", "user.email", "test@example.com");
    await writeFile(path.join(seed, "README.md"), "# Seed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "Initial commit");
    git(seed, "remote", "add", "origin", remoteDir);
    git(seed, "push", "origin", "main");

    config = {
      workspaceId: "ws_lock_test",
      remoteUrl: remoteDir,
      branch: "main",
      repoDir: localDir,
      dataRoot: tempDir,
      stateDir,
      txnDir,
      gitAuthorName: "CEO Bot",
      gitAuthorEmail: "bot@ceo.dev",
      gitCommitterName: "CEO Bot",
      gitCommitterEmail: "bot@ceo.dev",
    };
  });

  afterEach(async () => {
    ACTIVE_WORKSPACE_LOCKS.clear();
    STALE_RECOVERY_BY_LOCK_DIR.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("1. cleans up write.lock directory unconditionally in finally if owner.json write fails", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    // Verify lockDir does not exist initially
    const lockExistsBefore = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExistsBefore).toBe(false);

    // Call private acquireAndRunLock while simulating a failure on writeFile(owner.json)
    // We do this by making owner.json an unwriteable directory beforehand or intercepting
    // To cleanly test: create a workspace and spy or wrap private method
    const testWs = ws as any;

    // Simulate owner.json write failure by overriding writeOwnerJson
    const originalWriteOwnerJson = testWs.writeOwnerJson;
    testWs.writeOwnerJson = async () => {
      throw new Error("Disk quota exceeded during owner.json write");
    };

    try {
      await expect(testWs.withLock(async () => "ok")).rejects.toThrow("Disk quota exceeded during owner.json write");
    } finally {
      testWs.writeOwnerJson = originalWriteOwnerJson;
    }

    // Crucial assertion: the lock directory must have been removed in finally despite owner.json never being written!
    const lockExistsAfter = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExistsAfter).toBe(false);

    // Subsequent withLock must immediately succeed without NOT_READY!
    const result = await testWs.withLock(async () => "succeeded_immediately");
    expect(result).toBe("succeeded_immediately");
  });

  it("2. cleans up write.lock directory in finally if operation() throws", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    const testWs = ws as any;
    await expect(
      testWs.withLock(async () => {
        throw new Error("Business logic crashed inside lock");
      }),
    ).rejects.toThrow("Business logic crashed inside lock");

    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
    expect(ACTIVE_WORKSPACE_LOCKS.has(lockDir)).toBe(false);

    // Next lock succeeds
    const ok = await testWs.withLock(async () => "clean");
    expect(ok).toBe("clean");
  });

  it("3. fresh ownerless lock (<5s setup grace) is treated as busy and NOT deleted", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    // Manually create lockDir without owner.json (freshly created just now, age < 5000ms)
    await mkdir(lockDir, { recursive: true });

    const testWs = ws as any;
    await expect(testWs.withLock(async () => "should_not_run")).rejects.toMatchObject({
      name: "CeoError",
      code: "NOT_READY",
      details: { reason: "WORKSPACE_BUSY" },
    });

    // The lock directory was fresh, so it was NOT removed
    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);

    // Clean up manually for subsequent tests
    await rm(lockDir, { recursive: true, force: true });
  });

  it("4. stale ownerless lock (>5s) is safely reclaimed and operation succeeds on retry", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    // Create lockDir without owner.json and backdate mtime by 10 seconds
    await mkdir(lockDir, { recursive: true });
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    await utimes(lockDir, tenSecondsAgo, tenSecondsAgo);

    const testWs = ws as any;
    // Should detect orphan stale (>5s), remove it, and successfully acquire on retry!
    const result = await testWs.withLock(async () => "reclaimed_and_executed");
    expect(result).toBe("reclaimed_and_executed");

    // Lock is released after operation finishes
    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("5. active lock in same process fails closed with NOT_READY and is NOT deleted", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    const testWs = ws as any;

    let resolveHeldLock: () => void;
    const lockHeldPromise = new Promise<void>((resolve) => {
      resolveHeldLock = resolve;
    });

    let holdLockStartedResolve: () => void;
    const holdLockStarted = new Promise<void>((resolve) => {
      holdLockStartedResolve = resolve;
    });

    // Start operation 1 which holds the lock
    const op1 = testWs.withLock(async () => {
      holdLockStartedResolve();
      await lockHeldPromise;
      return "op1_done";
    });

    await holdLockStarted;

    // Operation 2 attempts to acquire lock while op1 is still actively running in the same process
    await expect(testWs.withLock(async () => "op2")).rejects.toMatchObject({
      name: "CeoError",
      code: "NOT_READY",
      details: { reason: "WORKSPACE_BUSY" },
    });

    // Lock directory must still be intact because op1 is alive
    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);

    // Release op1
    resolveHeldLock!();
    await op1;

    // Now lock is freed
    const lockExistsAfter = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExistsAfter).toBe(false);
  });

  it("6. orphan lock from same instance (not active in memory) is safely reclaimed", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    // Simulate an abandoned lock from the SAME process instance that is NOT in ACTIVE_WORKSPACE_LOCKS
    await mkdir(lockDir, { recursive: true });
    const abandonedMeta: LockOwnerMetadata = {
      lockId: "abandoned-uuid-123",
      instanceId: PROCESS_INSTANCE_ID,
      pid: process.pid,
      at: new Date().toISOString(),
      createdAtMs: Date.now() - 1000,
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(abandonedMeta));

    // ACTIVE_WORKSPACE_LOCKS does NOT have "abandoned-uuid-123"
    expect(ACTIVE_WORKSPACE_LOCKS.get(lockDir)).toBeUndefined();

    const testWs = ws as any;
    // Must recognize as same_instance_orphan, reclaim, and succeed!
    const result = await testWs.withLock(async () => "healed_same_instance_orphan");
    expect(result).toBe("healed_same_instance_orphan");

    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("7. lock with dead foreign PID (ESRCH) is reclaimed and operation succeeds", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    await mkdir(lockDir, { recursive: true });
    const deadPidMeta: LockOwnerMetadata = {
      lockId: "dead-foreign-lock-456",
      instanceId: "different-foreign-instance-id",
      pid: 99999999, // Unlikely to exist, triggers ESRCH
      at: new Date().toISOString(),
      createdAtMs: Date.now() - 2000,
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(deadPidMeta));

    const testWs = ws as any;
    const result = await testWs.withLock(async () => "healed_dead_pid");
    expect(result).toBe("healed_dead_pid");

    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("8. lock with living foreign PID fails closed with NOT_READY without deletion", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    await mkdir(lockDir, { recursive: true });
    const livingPidMeta: LockOwnerMetadata = {
      lockId: "living-foreign-lock-789",
      instanceId: "different-foreign-instance-id",
      pid: process.pid, // Our own PID is guaranteed to be alive
      at: new Date().toISOString(),
      createdAtMs: Date.now() - 1000,
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(livingPidMeta));

    const testWs = ws as any;
    await expect(testWs.withLock(async () => "should_fail")).rejects.toMatchObject({
      name: "CeoError",
      code: "NOT_READY",
      details: { reason: "WORKSPACE_BUSY" },
    });

    // Must NOT delete living lock
    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);

    await rm(lockDir, { recursive: true, force: true });
  });

  it("9. two CeoWorkspace instances on same lockDir share process-level recovery promise", async () => {
    const ws1 = new CeoWorkspace(config);
    const ws2 = new CeoWorkspace(config);
    await ws1.initialize();

    // Create dead PID lock
    await mkdir(lockDir, { recursive: true });
    const deadPidMeta: LockOwnerMetadata = {
      lockId: "concurrent-reclaim-lock",
      instanceId: "foreign-instance-xyz",
      pid: 99999999,
      at: new Date().toISOString(),
      createdAtMs: Date.now() - 2000,
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(deadPidMeta));

    const testWs1 = ws1 as any;
    const testWs2 = ws2 as any;

    // Both invoke recoverStaleLockSerialized concurrently
    const p1 = testWs1.recoverStaleLockSerialized();
    const p2 = testWs2.recoverStaleLockSerialized();

    // In process-level map, the in-flight promise is shared
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);

    // After completion, the map entry is cleaned up
    expect(STALE_RECOVERY_BY_LOCK_DIR.has(lockDir)).toBe(false);
  });

  it("10. releaseOwnedLock does not delete lock if lockId changed (TOCTOU guard)", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    await mkdir(lockDir, { recursive: true });
    const currentOwnerMeta: LockOwnerMetadata = {
      lockId: "new-owner-lock-id",
      instanceId: PROCESS_INSTANCE_ID,
      pid: process.pid,
      at: new Date().toISOString(),
      createdAtMs: Date.now(),
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(currentOwnerMeta));

    const testWs = ws as any;
    // Attempt to release with an old/mismatched lockId
    const released = await testWs.releaseOwnedLock("old-stale-lock-id");
    expect(released).toBe(false);

    // The lock directory is NOT deleted because lockId did not match
    const lockExists = await stat(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);

    await rm(lockDir, { recursive: true, force: true });
  });

  it("11. stale recovery retry is strictly capped at once (fails closed if busy again)", async () => {
    const ws = new CeoWorkspace(config);
    await ws.initialize();

    // Create a dead PID lock to trigger stale recovery
    await mkdir(lockDir, { recursive: true });
    const deadPidMeta: LockOwnerMetadata = {
      lockId: "dead-pid-lock",
      instanceId: "foreign-inst",
      pid: 99999999,
      at: new Date().toISOString(),
      createdAtMs: Date.now() - 2000,
    };
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(deadPidMeta));

    const testWs = ws as any;

    // Intercept createLockDir so that on retry, createLockDir throws EEXIST again
    let createCalls = 0;
    const originalCreateLockDir = testWs.createLockDir;
    testWs.createLockDir = async () => {
      createCalls++;
      if (createCalls > 1) {
        // Simulate race where another process grabbed lock right after stale was removed
        const err: any = new Error("EEXIST: file already exists");
        err.code = "EEXIST";
        throw err;
      }
      await originalCreateLockDir.call(testWs);
    };

    try {
      // Must fail closed with NOT_READY on second EEXIST without looping infinitely
      await expect(testWs.withLock(async () => "should_not_succeed")).rejects.toMatchObject({
        name: "CeoError",
        code: "NOT_READY",
      });
    } finally {
      testWs.createLockDir = originalCreateLockDir;
    }
  });
});
