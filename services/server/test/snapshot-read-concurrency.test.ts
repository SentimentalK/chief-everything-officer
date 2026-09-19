import path from "node:path";
import { rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { fixture, git } from "./helpers.js";
import { loadProductPolicy } from "../src/product-policy.js";
import { resolveEffectivePolicy } from "../src/policy-resolver.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Snapshot Read Concurrency & Isolation", () => {
  it("1. Read/read concurrency: 20 parallel reads succeed with 0 WORKSPACE_BUSY errors", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Launch 20 concurrent reads across readFiles, listFiles, and searchText
    const tasks = Array.from({ length: 20 }, (_, index) => {
      const mode = index % 3;
      if (mode === 0) {
        return workspace.readFiles(["TODO.md"]);
      } else if (mode === 1) {
        return workspace.listFiles("", true);
      } else {
        return workspace.searchText("TODO", [], 10);
      }
    });

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(20);
    for (const res of results) {
      expect(res.ok).toBe(true);
      expect(res.workspace_state).toBe("READY");
    }
  });

  it("2. Read during write: reader holding snapshot A sees commit A data while writer pushes commit B", async () => {
    const item = await fixture();
    cleanup.push(item.root);

    const snapshotCaptured = createDeferred<void>();
    const writerFinished = createDeferred<void>();
    let hookEnabled = false;

    class BarrierReaderWorkspace extends CeoWorkspace {
      protected override async readBlob(oid: string, filePath: string): Promise<string> {
        if (hookEnabled && filePath === "TODO.md") {
          snapshotCaptured.resolve();
          await writerFinished.promise;
        }
        return super.readBlob(oid, filePath);
      }
    }

    const workspace = new BarrierReaderWorkspace(item.config);
    await workspace.initialize();

    const initialRead = (await workspace.readFiles(["TODO.md"])) as {
      base_commit: string;
      files: Array<{ blob_oid: string }>;
    };
    const commitA = initialRead.base_commit;
    const initialBlob = initialRead.files[0]!.blob_oid;

    // Enable barrier hook for the background reader
    hookEnabled = true;

    // Start reader in the background
    const readerPromise = workspace.readFiles(["TODO.md"]);

    // Wait until reader has captured snapshot A and entered readBlob
    await snapshotCaptured.promise;

    // Disable hook so writer operations do not block
    hookEnabled = false;

    // Writer performs mutation and pushes commit B
    const writeResult = await workspace.applyChangeSet({
      base_commit: commitA,
      summary: "Update TODO by writer",
      operations: [
        {
          op: "replace",
          path: "TODO.md",
          expected_blob_oid: initialBlob,
          content: "# TODO\n\n- Updated by writer\n",
        },
      ],
    });
    expect(writeResult.ok).toBe(true);
    const commitB = (writeResult as any).commit;
    expect(commitB).not.toBe(commitA);

    // Signal writer is finished so reader can proceed
    writerFinished.resolve();

    const readerResult = (await readerPromise) as {
      ok: boolean;
      base_commit: string;
      files: Array<{ path: string; content: string }>;
    };

    expect(readerResult.ok).toBe(true);
    expect(readerResult.base_commit).toBe(commitA);
    expect(readerResult.files[0]!.content).toBe("# TODO\n\n- Original\n");

    // A fresh read after writer completion sees commit B
    const freshRead = (await workspace.readFiles(["TODO.md"])) as {
      ok: boolean;
      base_commit: string;
      files: Array<{ path: string; content: string }>;
    };
    expect(freshRead.base_commit).toBe(commitB);
    expect(freshRead.files[0]!.content).toBe("# TODO\n\n- Updated by writer\n");
  });

  it("3. Stale write rejection: reader at snapshot A is rejected when base_commit is stale", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const read = (await workspace.readFiles(["TODO.md"])) as {
      base_commit: string;
      files: Array<{ blob_oid: string }>;
    };
    const commitA = read.base_commit;
    const originalBlob = read.files[0]!.blob_oid;

    // Writer advances HEAD
    await workspace.applyChangeSet({
      base_commit: commitA,
      summary: "Writer advance",
      operations: [
        {
          op: "create",
          path: "tasks/CONCURRENT-WRITER.md",
          content: "# Created by concurrent writer\n",
        },
      ],
    });

    // Stale writer attempts applyChangeSet with base_commit = commitA
    await expect(
      workspace.applyChangeSet({
        base_commit: commitA,
        summary: "Stale write attempt",
        operations: [
          {
            op: "replace",
            path: "TODO.md",
            expected_blob_oid: originalBlob,
            content: "# TODO\n\n- Stale\n",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
    });
  });

  it("4. .ceoignore snapshot consistency: snapshot A strictly enforces ignore rules from commit A", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Commit secret.md and .ceoignore ignoring secret.md via git
    const secretPath = path.join(item.config.repoDir, "secret.md");
    const ignorePath = path.join(item.config.repoDir, ".ceoignore");
    await writeFile(secretPath, "CLASSIFIED\n");
    await writeFile(ignorePath, "secret.md\n");
    git(item.config.repoDir, "add", "secret.md", ".ceoignore");
    git(item.config.repoDir, "commit", "-m", "Add secret and ignore it");
    git(item.config.repoDir, "push", "origin", "main");

    const snapshotA = await workspace.captureReadSnapshot();
    const commitA = snapshotA.commit;

    // Verify secret.md is ignored in snapshot A
    await expect(workspace.readFiles(["secret.md"])).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });

    // Commit B modifies .ceoignore to un-ignore secret.md
    await writeFile(ignorePath, "# empty\n");
    git(item.config.repoDir, "add", ".ceoignore");
    git(item.config.repoDir, "commit", "-m", "Un-ignore secret.md");
    git(item.config.repoDir, "push", "origin", "main");

    // Verify reader using snapshotA still evaluates .ceoignore at commit A
    const matcherA = await workspace.loadIgnoreMatcherAtCommit(commitA);
    expect(matcherA.exactFiles.has("secret.md")).toBe(true);

    // Fresh snapshot at commit B allows reading secret.md
    const readB = (await workspace.readFiles(["secret.md"])) as {
      files: Array<{ path: string; content: string }>;
    };
    expect(readB.files[0]!.content).toBe("CLASSIFIED\n");
  });

  it("5. Symlink tree mode rejection: symlinks in Git tree (mode 120000) are rejected with INVALID_PATH", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Create and commit a symlink into Git tree
    const targetFile = path.join(item.root, "target.md");
    const linkPath = path.join(item.config.repoDir, "tasks", "link.md");
    await symlink(targetFile, linkPath);
    git(item.config.repoDir, "add", "tasks/link.md");
    git(item.config.repoDir, "commit", "-m", "Commit symlink");
    git(item.config.repoDir, "push", "origin", "main");

    // readFiles on symlink
    await expect(workspace.readFiles(["tasks/link.md"])).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: "Symlinks are forbidden in CEO content paths.",
    });

    // searchText hitting symlink
    await expect(workspace.searchText("anything", ["tasks/"], 10)).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: "Symlinks are forbidden in CEO content paths.",
    });
  });

  it("6. Multi-file atomic view: concurrent reader sees atomic snapshot without torn multi-file reads", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    // Create a.md and b.md with v1
    const snapshotInit = await workspace.captureReadSnapshot();
    await workspace.applyChangeSet({
      base_commit: snapshotInit.commit,
      summary: "Init a and b at v1",
      operations: [
        { op: "create", path: "tasks/a.md", content: "VERSION_1\n" },
        { op: "create", path: "tasks/b.md", content: "VERSION_1\n" },
      ],
    });

    const snapshotV1 = await workspace.captureReadSnapshot();
    const commitV1 = snapshotV1.commit;

    const entryA = (await (workspace as any).getSnapshotTreeEntry(commitV1, "tasks/a.md"))!;
    const entryB = (await (workspace as any).getSnapshotTreeEntry(commitV1, "tasks/b.md"))!;

    // Advance to v2
    const updateResult = await workspace.applyChangeSet({
      base_commit: commitV1,
      summary: "Advance a and b to v2",
      operations: [
        {
          op: "replace",
          path: "tasks/a.md",
          expected_blob_oid: entryA.oid,
          content: "VERSION_2\n",
        },
        {
          op: "replace",
          path: "tasks/b.md",
          expected_blob_oid: entryB.oid,
          content: "VERSION_2\n",
        },
      ],
    });
    expect(updateResult.ok).toBe(true);

    // Reader using snapshot v1 reads both files
    // Even after v2 was committed and pushed to main, reader sees both as VERSION_1
    const targetA = await (workspace as any).resolveSnapshotReadTarget(snapshotV1, "tasks/a.md", async () => new Map());
    const targetB = await (workspace as any).resolveSnapshotReadTarget(snapshotV1, "tasks/b.md", async () => new Map());

    const contentA = await (workspace as any).readBlob(targetA.oid, targetA.path);
    const contentB = await (workspace as any).readBlob(targetB.oid, targetB.path);

    expect(contentA).toBe("VERSION_1\n");
    expect(contentB).toBe("VERSION_1\n");

    // Reader using current snapshot sees both as VERSION_2
    const currentRead = (await workspace.readFiles(["tasks/a.md", "tasks/b.md"])) as {
      files: Array<{ path: string; content: string }>;
    };
    expect(currentRead.files[0]!.content).toBe("VERSION_2\n");
    expect(currentRead.files[1]!.content).toBe("VERSION_2\n");
  });

  it("7. Policy update concurrency: policy resolution works concurrently with mutations without locks", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();

    const productPolicy = await loadProductPolicy();

    const lockEntered = createDeferred<void>();
    const readsCompleted = createDeferred<void>();

    // Start a long write mutation that holds the exclusive mutation lock
    const mutationPromise = workspace.withExclusiveWorkspaceMutation(async () => {
      lockEntered.resolve();
      // Wait while policy reads execute concurrently
      await readsCompleted.promise;
      return "mutation_done";
    });

    // Wait until the mutation has acquired the exclusive write lock
    await lockEntered.promise;

    // While the exclusive write lock is held, execute 10 concurrent policy reads!
    const policyResults = await Promise.all(
      Array.from({ length: 10 }, () => resolveEffectivePolicy(productPolicy, workspace, "tasks")),
    );

    // Release the write mutation lock
    readsCompleted.resolve();
    const mutationResult = await mutationPromise;
    expect(mutationResult).toBe("mutation_done");

    expect(policyResults).toHaveLength(10);
    for (const res of policyResults) {
      expect(res.ok).toBe(true);
      expect(res.status).toBe("FOUND");
    }
  });
});
