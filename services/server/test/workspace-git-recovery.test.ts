import { randomUUID } from "node:crypto";
import { chmod, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture, git } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CeoWorkspace Git Sync & Recovery Semantics", () => {
  it("synchronizes clean local checkout when behind remote and returns READY", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Advance remote by 2 commits externally
    const other = path.join(item.root, "other");
    git(item.root, "clone", item.remote, other);
    await writeFile(path.join(other, "TODO.md"), "# TODO\n\n- Behind update 1\n");
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "advance 1");
    await writeFile(path.join(other, "TODO.md"), "# TODO\n\n- Behind update 2\n");
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "advance 2");
    git(other, "push", "origin", "main");

    const remoteSha = git(item.remote, "rev-parse", "main");
    const status = await workspace.workspaceStatus();

    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(remoteSha);
    expect(status.remote_commit).toBe(remoteSha);

    const read = await workspace.readFiles(["TODO.md"]);
    expect((read.files as any[])[0].content).toBe("# TODO\n\n- Behind update 2\n");
  });

  it("synchronizes clean local checkout when ahead of force-reset remote and returns READY", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // 1. Advance workspace with a commit
    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as any[])[0];
    await workspace.applyChangeSet({
      base_commit: read.base_commit as string,
      summary: "First local commit",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# TODO\n\n- Local advanced\n" }],
    });

    const pushedSha = git(item.remote, "rev-parse", "main");

    // 2. Externally force-reset remote to initial commit (local checkout is now ahead of remote)
    const initialSha = git(item.remote, "rev-parse", "main~1");
    git(item.remote, "update-ref", "refs/heads/main", initialSha);
    expect(git(item.remote, "rev-parse", "main")).toBe(initialSha);

    // 3. Workspace status should reset local checkout back to remote HEAD without error
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(initialSha);
    expect(status.remote_commit).toBe(initialSha);

    const readAfter = await workspace.readFiles(["TODO.md"]);
    expect((readAfter.files as any[])[0].content).toBe("# TODO\n\n- Original\n");
  });

  it("non-fast-forward remote rewrite with no pending transaction no longer yields WORKSPACE_DIVERGED", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Clone and create an alternate divergent history, then force-push to remote
    const other = path.join(item.root, "other");
    git(item.root, "clone", item.remote, other);
    git(other, "checkout", "--orphan", "rewritten-branch");
    await writeFile(path.join(other, "TODO.md"), "# TODO\n\n- Force rewritten root\n");
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "force rewrite root");
    git(other, "push", "--force", "origin", "rewritten-branch:main");

    const newRemoteHead = git(item.remote, "rev-parse", "main");

    // workspaceStatus must self-heal cleanly to the rewritten remote HEAD
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(newRemoteHead);
    expect(status.remote_commit).toBe(newRemoteHead);

    // Subsequent read and write succeed from the new remote head
    const read = await workspace.readFiles(["TODO.md"]);
    expect(read.base_commit).toBe(newRemoteHead);
    expect((read.files as any[])[0].content).toBe("# TODO\n\n- Force rewritten root\n");

    const writeRes = await workspace.applyChangeSet({
      base_commit: newRemoteHead,
      summary: "Write on top of rewritten history",
      operations: [{
        op: "replace",
        path: "TODO.md",
        expected_blob_oid: (read.files as any[])[0].blob_oid,
        content: "# TODO\n\n- After rewrite\n",
      }],
    });
    expect(writeRes.ok).toBe(true);
    expect(writeRes.workspace_state).toBe("READY");
  });

  it("stale pending + incompatible remote rewrite is archived/terminalized, active pending is cleared, local cache resets to remote, and subsequent operations succeed", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as any[])[0];
    const initialBaseCommit = read.base_commit as string;

    // 1. Simulate push failure via remote pre-receive hook to leave a pending transaction
    const hook = path.join(item.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const pendingRequestId = randomUUID();
    await expect(workspace.applyChangeSet({
      request_id: pendingRequestId,
      base_commit: initialBaseCommit,
      summary: "Pending commit that will fail to push",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# Pending Content\n" }],
    })).rejects.toMatchObject({ code: "PUSH_PENDING" });

    // Verify pending.json exists
    const pendingJsonPath = path.join(item.config.stateDir, "pending.json");
    const rawPending = JSON.parse(await readFile(pendingJsonPath, "utf8"));
    expect(rawPending.request_id).toBe(pendingRequestId);
    const pendingCommitSha = rawPending.commit;

    // 2. Remove hook and rewrite remote history externally (non-fast-forward force push)
    await unlink(hook);
    const other = path.join(item.root, "other");
    git(item.root, "clone", item.remote, other);
    git(other, "checkout", "--orphan", "diverged-history");
    await writeFile(path.join(other, "TODO.md"), "# Authoritative Rewrite\n");
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "authoritative rewrite");
    git(other, "push", "--force", "origin", "diverged-history:main");
    const rewrittenRemoteHead = git(item.remote, "rev-parse", "main");

    // 3. Trigger recovery via workspaceStatus()
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(rewrittenRemoteHead);
    expect(status.remote_commit).toBe(rewrittenRemoteHead);
    expect(status.pending_commit).toBeNull();

    // 4. Verify durable terminal record in completedDir
    const completedFile = path.join(item.config.stateDir, "completed", `${pendingRequestId}.json`);
    const completedRecord = JSON.parse(await readFile(completedFile, "utf8"));
    expect(completedRecord).toMatchObject({
      request_id: pendingRequestId,
      base_commit: initialBaseCommit,
      commit: pendingCommitSha,
      remote_head: rewrittenRemoteHead,
      pushed: false,
      outcome: "STALE_REVISION",
      reason: "REMOTE_HISTORY_REWRITTEN",
      changed_files: ["TODO.md"],
    });
    expect(completedRecord.diff_stat).toBeTruthy();
    expect(completedRecord.archived_at).toBeTruthy();

    // 5. Verify active pending is cleared and worktree discarded
    await expect(readFile(pendingJsonPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const txnWorktree = path.join(item.config.txnDir, pendingRequestId);
    await expect(readFile(path.join(txnWorktree, "TODO.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // 6. Verify retrying the exact same request_id clearly fails as STALE_REVISION
    await expect(workspace.applyChangeSet({
      request_id: pendingRequestId,
      base_commit: initialBaseCommit,
      summary: "Retry stale request",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# Pending Content\n" }],
    })).rejects.toMatchObject({
      code: "STALE_REVISION",
    });

    // 7. Verify subsequent read and fresh write succeed from rewritten remote truth
    const readAfter = await workspace.readFiles(["TODO.md"]);
    expect(readAfter.base_commit).toBe(rewrittenRemoteHead);
    const rewrittenFile = (readAfter.files as any[])[0];

    const freshWrite = await workspace.applyChangeSet({
      base_commit: rewrittenRemoteHead,
      summary: "Fresh write on rewritten remote",
      operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: rewrittenFile.blob_oid, content: "# Fresh Write\n" }],
    });
    expect(freshWrite.ok).toBe(true);
    expect(freshWrite.pushed).toBe(true);
    expect(git(item.remote, "show", "main:TODO.md")).toBe("# Fresh Write");
  });

  describe("Safely recoverable pending cases A, B, and C", () => {
    it("Case A: recovers and finalizes when remote == pending.commit", async () => {
      const item = await fixture();
      cleanup.push(item.root);
      const workspace = new CeoWorkspace(item.config);
      await workspace.initialize();

      const read = await workspace.readFiles(["TODO.md"]);
      const file = (read.files as any[])[0];

      // Simulate a scenario where commit was pushed to remote, but pending.json was not cleared
      // 1. Create a commit on remote externally
      const other = path.join(item.root, "other");
      git(item.root, "clone", item.remote, other);
      await writeFile(path.join(other, "TODO.md"), "# Case A\n");
      git(other, "add", "TODO.md");
      git(other, "commit", "-m", "remote accepted commit");
      git(other, "push", "origin", "main");
      const remoteSha = git(item.remote, "rev-parse", "main");

      // 2. Synthesize pending.json matching remote commit
      const requestId = randomUUID();
      const worktree = path.join(item.config.txnDir, requestId);
      const pending = {
        request_id: requestId,
        base_commit: read.base_commit as string,
        commit: remoteSha,
        worktree,
        changed_files: ["TODO.md"],
        diff_stat: " 1 file changed\n",
      };
      await writeFile(path.join(item.config.stateDir, "pending.json"), JSON.stringify(pending));

      // 3. workspaceStatus should classify as Case A, finalize normally
      const status = await workspace.workspaceStatus();
      expect(status.workspace_state).toBe("READY");
      expect(status.local_commit).toBe(remoteSha);
      expect(status.pending_commit).toBeNull();

      // Verify completed record
      const completed = JSON.parse(await readFile(path.join(item.config.stateDir, "completed", `${requestId}.json`), "utf8"));
      expect(completed.pushed).toBe(true);
      expect(completed.outcome).toBe("COMMITTED");
      expect(completed.commit).toBe(remoteSha);
    });

    it("Case B: recovers and finalizes when pending.commit is ancestor of remote", async () => {
      const item = await fixture();
      cleanup.push(item.root);
      const workspace = new CeoWorkspace(item.config);
      await workspace.initialize();

      const read = await workspace.readFiles(["TODO.md"]);
      const file = (read.files as any[])[0];

      // 1. Create commit 1 (pending) and commit 2 on top of it on remote
      const other = path.join(item.root, "other");
      git(item.root, "clone", item.remote, other);
      await writeFile(path.join(other, "TODO.md"), "# Pending Step\n");
      git(other, "add", "TODO.md");
      git(other, "commit", "-m", "pending ancestor");
      const pendingSha = git(other, "rev-parse", "HEAD");

      await writeFile(path.join(other, "TODO.md"), "# Advanced Step\n");
      git(other, "add", "TODO.md");
      git(other, "commit", "-m", "advanced further");
      git(other, "push", "origin", "main");
      const advancedSha = git(item.remote, "rev-parse", "main");

      // 2. Synthesize pending.json with pendingSha
      const requestId = randomUUID();
      const worktree = path.join(item.config.txnDir, requestId);
      const pending = {
        request_id: requestId,
        base_commit: read.base_commit as string,
        commit: pendingSha,
        worktree,
        changed_files: ["TODO.md"],
        diff_stat: " 1 file changed\n",
      };
      await writeFile(path.join(item.config.stateDir, "pending.json"), JSON.stringify(pending));

      // 3. workspaceStatus should classify as Case B, finalize against remote
      const status = await workspace.workspaceStatus();
      expect(status.workspace_state).toBe("READY");
      expect(status.local_commit).toBe(advancedSha);
      expect(status.pending_commit).toBeNull();

      const completed = JSON.parse(await readFile(path.join(item.config.stateDir, "completed", `${requestId}.json`), "utf8"));
      expect(completed.pushed).toBe(true);
      expect(completed.outcome).toBe("COMMITTED");
      expect(completed.commit).toBe(pendingSha);
    });

    it("Case C: retries pushing pending commit when remote == pending.base_commit", async () => {
      const item = await fixture();
      cleanup.push(item.root);
      const workspace = new CeoWorkspace(item.config);
      await workspace.initialize();

      const read = await workspace.readFiles(["TODO.md"]);
      const file = (read.files as any[])[0];

      // 1. Install hook to block push
      const hook = path.join(item.remote, "hooks", "pre-receive");
      await writeFile(hook, "#!/bin/sh\nexit 1\n");
      await chmod(hook, 0o755);

      const requestId = randomUUID();
      await expect(workspace.applyChangeSet({
        request_id: requestId,
        base_commit: read.base_commit as string,
        summary: "Case C pending push",
        operations: [{ op: "replace", path: "TODO.md", expected_blob_oid: file.blob_oid, content: "# Case C Content\n" }],
      })).rejects.toMatchObject({ code: "PUSH_PENDING" });

      // 2. Remove hook while remote is still at base_commit
      await unlink(hook);

      // 3. workspaceStatus retries pushing and reaches READY
      const status = await workspace.workspaceStatus();
      expect(status.workspace_state).toBe("READY");
      expect(status.pending_commit).toBeNull();
      expect(git(item.remote, "show", "main:TODO.md")).toBe("# Case C Content");

      const completed = JSON.parse(await readFile(path.join(item.config.stateDir, "completed", `${requestId}.json`), "utf8"));
      expect(completed.pushed).toBe(true);
      expect(completed.outcome).toBe("COMMITTED");
    });
  });

  it("dirty main checkout still fails closed as WORKSPACE_DIRTY and is not reset", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Introduce unexpected uncommitted changes in the managed main checkout
    const dirtyFile = path.join(item.config.repoDir, "unexpected_untracked.txt");
    await writeFile(dirtyFile, "manual edit");

    // workspaceStatus must fail closed with WORKSPACE_DIRTY
    await expect(workspace.workspaceStatus()).rejects.toMatchObject({
      code: "WORKSPACE_DIRTY",
      message: "Main working copy contains uncommitted changes.",
    });

    // The uncommitted change must NOT be deleted or reset
    expect(await readFile(dirtyFile, "utf8")).toBe("manual edit");

    // Also test modified tracked file
    await rm(dirtyFile, { force: true });
    await writeFile(path.join(item.config.repoDir, "TODO.md"), "# Modified without commit\n");

    await expect(workspace.workspaceStatus()).rejects.toMatchObject({
      code: "WORKSPACE_DIRTY",
    });

    expect(await readFile(path.join(item.config.repoDir, "TODO.md"), "utf8")).toBe("# Modified without commit\n");
  });

  it("configured non-main branch is respected throughout sync and recovery", async () => {
    const branchName = "release/v1.0";
    const item = await fixture({ branch: branchName });
    cleanup.push(item.root);

    expect(item.config.branch).toBe(branchName);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const status = await workspace.workspaceStatus();
    expect(status.branch).toBe(branchName);
    expect(status.workspace_state).toBe("READY");

    // Perform an external non-fast-forward rewrite on the custom branch
    const other = path.join(item.root, "other");
    git(item.root, "clone", "--branch", branchName, item.remote, other);
    git(other, "checkout", "--orphan", "custom-rewrite");
    await writeFile(path.join(other, "TODO.md"), "# Custom Branch Rewritten\n");
    git(other, "add", "TODO.md");
    git(other, "commit", "-m", "rewrite on custom branch");
    git(other, "push", "--force", "origin", `custom-rewrite:${branchName}`);

    const newRemoteSha = git(item.remote, "rev-parse", branchName);

    // Sync must work on the custom branch without reference to main
    const syncStatus = await workspace.workspaceStatus();
    expect(syncStatus.workspace_state).toBe("READY");
    expect(syncStatus.branch).toBe(branchName);
    expect(syncStatus.local_commit).toBe(newRemoteSha);
    expect(syncStatus.remote_commit).toBe(newRemoteSha);

    const read = await workspace.readFiles(["TODO.md"]);
    expect((read.files as any[])[0].content).toBe("# Custom Branch Rewritten\n");

    // Apply a change set on the custom branch
    const writeResult = await workspace.applyChangeSet({
      base_commit: newRemoteSha,
      summary: "Commit on custom branch",
      operations: [{
        op: "replace",
        path: "TODO.md",
        expected_blob_oid: (read.files as any[])[0].blob_oid,
        content: "# Updated on Custom Branch\n",
      }],
    });
    expect(writeResult.ok).toBe(true);
    expect(git(item.remote, "show", `${branchName}:TODO.md`)).toBe("# Updated on Custom Branch");
  });

  it("racing write request with remote rewrite fails clearly as STALE_REVISION, archives terminal record, and self-heals", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const read = await workspace.readFiles(["TODO.md"]);
    const file = (read.files as any[])[0];
    const baseCommit = read.base_commit as string;

    // Mutator races with external force push to remote
    const requestId = randomUUID();
    let hasRewritten = false;

    await expect((workspace as any).withAtomicWorkspaceTransaction({
      requestId,
      baseCommit,
      commitMessage: "Racing transaction",
      mutator: async (worktree: string) => {
        // While transaction is mutating, an external writer force-pushes a rewrite
        if (!hasRewritten) {
          const other = path.join(item.root, "other");
          git(item.root, "clone", item.remote, other);
          git(other, "checkout", "--orphan", "racing-rewrite");
          await writeFile(path.join(other, "TODO.md"), "# Rewritten In Race\n");
          git(other, "add", "TODO.md");
          git(other, "commit", "-m", "racing rewrite commit");
          git(other, "push", "--force", "origin", "racing-rewrite:main");
          hasRewritten = true;
        }
        await writeFile(path.join(worktree, "TODO.md"), "# Racing local change\n");
      },
    })).rejects.toMatchObject({
      code: "STALE_REVISION",
    });

    const latestRemote = git(item.remote, "rev-parse", "main");

    // Terminal record must exist in completedDir
    const completedRecord = JSON.parse(await readFile(path.join(item.config.stateDir, "completed", `${requestId}.json`), "utf8"));
    expect(completedRecord).toMatchObject({
      request_id: requestId,
      base_commit: baseCommit,
      remote_head: latestRemote,
      pushed: false,
      outcome: "STALE_REVISION",
      reason: "REMOTE_HISTORY_REWRITTEN",
    });

    // Workspace must self-heal to READY immediately, without operator repair
    const status = await workspace.workspaceStatus();
    expect(status.workspace_state).toBe("READY");
    expect(status.local_commit).toBe(latestRemote);
    expect(status.pending_commit).toBeNull();
  });
});
