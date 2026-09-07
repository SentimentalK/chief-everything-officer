import path from "node:path";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CeoWorkspace } from "../src/workspace.js";
import { LIMITS } from "../src/limits.js";
import { fixture, git } from "./helpers.js";

// Test fixtures live under the workspace (.tmp is gitignored) so archive-layout
// tests never depend on the OS temp directory or repo-relative content rules.
const TEMP_ROOT = path.join(process.cwd(), ".tmp");

// Observes the single full-tree archive listing. listTrackedFiles runs
// `git ls-tree -r --name-only`; per-file blobOid calls use `ls-tree` without -r.
const fullTree = vi.hoisted(() => ({ listings: 0 }));
vi.mock("../src/git.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...original,
    runGit: (config: unknown, cwd: string, args: string[], allowFailure = false) => {
      if (args.includes("ls-tree") && args.includes("-r")) fullTree.listings += 1;
      return original.runGit(config as never, cwd, args, allowFailure);
    },
  };
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openWorkspace(item: Fixture): Promise<CeoWorkspace> {
  const workspace = new CeoWorkspace(item.config);
  await workspace.initialize();
  return workspace;
}

/** Write a repo-relative file into the workspace clone, commit, and push. */
async function commitFile(item: Fixture, rel: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(item.config.repoDir, rel);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  git(item.config.repoDir, "add", "-A");
  git(item.config.repoDir, "commit", "-m", `seed ${rel}`);
  git(item.config.repoDir, "push", "origin", "main");
}

async function readError(promise: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
}

/** Move tasks/<name>.md to archive/<year>/<name>.md through the real write path. */
async function archiveTask(workspace: CeoWorkspace, name: string, year = "2026"): Promise<void> {
  const read = (await workspace.readFiles([`tasks/${name}.md`])) as { base_commit: string; files: Array<{ blob_oid: string }> };
  const result = await workspace.applyChangeSet({
    base_commit: read.base_commit,
    summary: `Archive ${name}`,
    operations: [{
      op: "move",
      path: `tasks/${name}.md`,
      expected_blob_oid: read.files[0]!.blob_oid,
      target: `archive/${year}/${name}.md`,
    }],
  });
  expect(result.ok).toBe(true);
}

describe("read_files archive fallback for tasks/<name>.md", () => {
  it("reads the original when it exists, even if an archive copy also exists", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/TEST-001.md", "# ARCHIVED\n");

    const before = fullTree.listings;
    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as { files: Array<{ requested_path: string; path: string; content: string }> };
    expect(fullTree.listings - before).toBe(0); // original exists -> archive never enumerated
    expect(read.files.map((f) => ({ requested_path: f.requested_path, path: f.path, content: f.content }))).toEqual([
      { requested_path: "tasks/TEST-001.md", path: "tasks/TEST-001.md", content: "# TEST-001\n" },
    ]);
  });

  it("resolves the unique archive copy and reports requested_path + actual path", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await archiveTask(workspace, "TEST-001");

    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as {
      files: Array<{ requested_path: string; path: string; blob_oid: string; content: string }>;
    };
    const file = read.files[0]!;
    expect(file.requested_path).toBe("tasks/TEST-001.md");
    expect(file.path).toBe("archive/2026/TEST-001.md");
    expect(file.content).toBe("# TEST-001\n");

    // blob OID equals what a direct archive read returns.
    const direct = (await workspace.readFiles(["archive/2026/TEST-001.md"])) as { files: Array<{ blob_oid: string }> };
    expect(file.blob_oid).toBe(direct.files[0]!.blob_oid);
  });

  it("resolves several missing tasks in one batch, enumerating archive once", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "tasks/TEST-002.md", "# TEST-002\n");
    await archiveTask(workspace, "TEST-001");
    await archiveTask(workspace, "TEST-002");

    const before = fullTree.listings;
    const read = (await workspace.readFiles(["tasks/TEST-001.md", "tasks/TEST-002.md"])) as {
      files: Array<{ requested_path: string; path: string; content: string }>;
    };
    expect(fullTree.listings - before).toBe(1); // one listing for the whole batch
    expect(read.files.map((f) => ({ requested_path: f.requested_path, path: f.path, content: f.content }))).toEqual([
      { requested_path: "tasks/TEST-001.md", path: "archive/2026/TEST-001.md", content: "# TEST-001\n" },
      { requested_path: "tasks/TEST-002.md", path: "archive/2026/TEST-002.md", content: "# TEST-002\n" },
    ]);
  });

  it("rejects the whole batch with NOT_FOUND when nothing exists and echoes the full original input", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    const requested = ["TODO.md", "tasks/UNKNOWN.md"];

    const error = await readError(workspace.readFiles(requested));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({
      requested_paths: requested,
      failed_requested_path: "tasks/UNKNOWN.md",
      reason: "NOT_FOUND",
    });
    // The full batch context includes the valid prefix path too (never a
    // validated-prefix-only array), and no host absolute path leaks.
    expect(JSON.stringify(error.details)).not.toContain(item.root);
  });

  it("rejects with AMBIGUOUS_ARCHIVE_MATCH when the same name lives in multiple years", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2025/DUP.md", "# 2025\n");
    await commitFile(item, "archive/2026/DUP.md", "# 2026\n");

    const error = await readError(workspace.readFiles(["tasks/DUP.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({
      reason: "AMBIGUOUS_ARCHIVE_MATCH",
      failed_requested_path: "tasks/DUP.md",
      candidates: ["archive/2025/DUP.md", "archive/2026/DUP.md"],
    });
  });

  it("never guesses by task id/similarity: a near-miss filename is NOT_FOUND", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/TEST-999.md", "# TEST-999\n");

    const error = await readError(workspace.readFiles(["tasks/TEST-998.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({ reason: "NOT_FOUND" });
    expect(error.details.candidates).toBeUndefined();
  });

  it("ignores deep archive nesting and non-4-digit year directories", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/deep/X.md", "# deep\n");
    await commitFile(item, "archive/99/X.md", "# bad year\n");

    const error = await readError(workspace.readFiles(["tasks/X.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({ reason: "NOT_FOUND" });
  });

  it("does not bypass .ceoignore on the original path", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, ".ceoignore", "tasks/IGN.md\n");
    await commitFile(item, "archive/2026/IGN.md", "# archived\n");

    const error = await readError(workspace.readFiles(["tasks/IGN.md"]));
    expect(error.code).toBe("ACCESS_DENIED");
    expect(error.details).toMatchObject({ path: "tasks/IGN.md" });
  });

  it("excludes ignored archive candidates and never leaks their path", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, ".ceoignore", "archive/2026/HIDDEN.md\n");
    await commitFile(item, "archive/2026/HIDDEN.md", "# restricted\n");

    const error = await readError(workspace.readFiles(["tasks/HIDDEN.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({ reason: "NOT_FOUND" });
    expect(error.details.candidates).toBeUndefined();
    expect(JSON.stringify(error.details)).not.toContain("archive/2026/HIDDEN.md");
  });

  it("rejects a symlinked original even when an archive copy exists", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/SL.md", "# archived\n");

    const outsideTarget = path.join(item.root, "outside.md");
    await writeFile(outsideTarget, "symlink target\n");
    await symlink(outsideTarget, path.join(item.config.repoDir, "tasks", "SL.md"));
    git(item.config.repoDir, "add", "tasks/SL.md");
    git(item.config.repoDir, "commit", "-m", "seed symlinked task");
    git(item.config.repoDir, "push", "origin", "main");

    const error = await readError(workspace.readFiles(["tasks/SL.md"]));
    expect(error.code).toBe("INVALID_PATH");
  });

  it("rejects the chosen archive target when it is a symlink (no candidate swap)", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);

    const outsideTarget = path.join(item.root, "outside-archive.md");
    await writeFile(outsideTarget, "symlink target\n");
    await mkdir(path.join(item.config.repoDir, "archive", "2026"), { recursive: true });
    await symlink(outsideTarget, path.join(item.config.repoDir, "archive", "2026", "SL2.md"));
    git(item.config.repoDir, "add", "archive/2026/SL2.md");
    git(item.config.repoDir, "commit", "-m", "seed symlinked archive task");
    git(item.config.repoDir, "push", "origin", "main");

    const error = await readError(workspace.readFiles(["tasks/SL2.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({
      path: "archive/2026/SL2.md",
      failed_requested_path: "tasks/SL2.md",
    });
    expect(error.details.reason).toBeUndefined();
  });

  it("does not fall back when the original path is a directory", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/DIR.md", "# archived dir name\n");
    await commitFile(item, "tasks/DIR.md/keep.md", "# keep\n");

    const error = await readError(workspace.readFiles(["tasks/DIR.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details.reason).toBeUndefined();
  });

  it("rejects an archived file over the single-file size limit", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    const overCap = LIMITS.maxFileWriteBytes + 1;
    await commitFile(item, "archive/2026/BIG.md", Buffer.alloc(overCap, 0x78));

    const error = await readError(workspace.readFiles(["tasks/BIG.md"]));
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a batch whose resolved archive files exceed the total read budget", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    const each = Math.floor(LIMITS.maxReadResponseBytes / 2) + 1; // two of these exceed 1 MiB
    await commitFile(item, "archive/2026/F1.md", Buffer.alloc(each, 0x61));
    await commitFile(item, "archive/2026/F2.md", Buffer.alloc(each, 0x62));

    const error = await readError(workspace.readFiles(["tasks/F1.md", "tasks/F2.md"]));
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("does not fall back for a missing non-tasks path", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await commitFile(item, "archive/2026/ghost.md", "# archived ghost\n");

    const error = await readError(workspace.readFiles(["inbox/ghost.md"]));
    expect(error.code).toBe("INVALID_PATH");
    expect(error.details).toMatchObject({ reason: "NOT_FOUND" });
    // The archive file was never read.
    expect(JSON.stringify(error.details)).not.toContain("archive/2026/ghost.md");
  });

  it("reports requested_path on success and normal reads have requested_path === path", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);

    const normal = (await workspace.readFiles(["TODO.md"])) as { files: Array<{ requested_path: string; path: string }> };
    expect(normal.files[0]).toMatchObject({ requested_path: "TODO.md", path: "TODO.md" });

    await archiveTask(workspace, "TEST-001");
    const archived = (await workspace.readFiles(["archive/2026/TEST-001.md"])) as { files: Array<{ requested_path: string; path: string }> };
    expect(archived.files[0]).toMatchObject({ requested_path: "archive/2026/TEST-001.md", path: "archive/2026/TEST-001.md" });
  });

  it("supports replace against the returned archive path and blob OID", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await archiveTask(workspace, "TEST-001");

    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as { base_commit: string; files: Array<{ path: string; blob_oid: string }> };
    const file = read.files[0]!;
    expect(file.path).toBe("archive/2026/TEST-001.md");

    const replaced = await workspace.applyChangeSet({
      base_commit: read.base_commit,
      summary: "Update archived task",
      operations: [{
        op: "replace",
        path: file.path,
        expected_blob_oid: file.blob_oid,
        content: "# TEST-001 revised\n",
      }],
    });
    expect(replaced.ok).toBe(true);
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toContain("revised");
  });

  it("supports append against the returned archive path and blob OID", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await archiveTask(workspace, "TEST-001");

    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as { base_commit: string; files: Array<{ path: string; blob_oid: string }> };
    const file = read.files[0]!;
    const appended = await workspace.applyChangeSet({
      base_commit: read.base_commit,
      summary: "Append to archived task",
      operations: [{
        op: "append",
        path: file.path,
        expected_blob_oid: file.blob_oid,
        content: "## Outcome\nDone.\n",
      }],
    });
    expect(appended.ok).toBe(true);
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toContain("Done.");
  });

  it("does not redirect writes: creating at the old tasks path makes a new file and leaves archive intact", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await archiveTask(workspace, "TEST-001");

    const read = (await workspace.readFiles(["archive/2026/TEST-001.md"])) as { base_commit: string };
    const archiveBefore = git(item.remote, "show", "main:archive/2026/TEST-001.md");

    const created = await workspace.applyChangeSet({
      base_commit: read.base_commit,
      summary: "Revive task at old path",
      operations: [{
        op: "create",
        path: "tasks/TEST-001.md",
        content: "# TEST-001 revived\n",
      }],
    });
    expect(created.ok).toBe(true);
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toBe(archiveBefore);
    expect(git(item.remote, "show", "main:tasks/TEST-001.md")).toContain("revived");

    // The new original now shadows the archive: reads return it directly.
    const again = (await workspace.readFiles(["tasks/TEST-001.md"])) as { files: Array<{ path: string; content: string }> };
    expect(again.files[0]).toMatchObject({ path: "tasks/TEST-001.md", content: "# TEST-001 revived\n" });
  });

  it("fails replace/append against the old tasks path after archiving, leaving archive unchanged", async () => {
    const item = await fixture({ tempRoot: TEMP_ROOT });
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await archiveTask(workspace, "TEST-001");

    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as { base_commit: string; files: Array<{ blob_oid: string }> };
    const archiveOid = read.files[0]!.blob_oid;
    const originalContent = git(item.remote, "show", "main:archive/2026/TEST-001.md");

    // replace at the old tasks path must not silently modify the archive file.
    const replaceError = await readError(
      workspace.applyChangeSet({
        base_commit: read.base_commit,
        summary: "Naive replace at old path",
        operations: [{
          op: "replace",
          path: "tasks/TEST-001.md",
          expected_blob_oid: archiveOid,
          content: "# overwritten\n",
        }],
      }),
    );
    expect(replaceError.code).toBe("BLOB_MISMATCH");
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toBe(originalContent);

    // append at the old tasks path fails the same way.
    const appendError = await readError(
      workspace.applyChangeSet({
        base_commit: read.base_commit,
        summary: "Naive append at old path",
        operations: [{
          op: "append",
          path: "tasks/TEST-001.md",
          expected_blob_oid: archiveOid,
          content: "## hacked\n",
        }],
      }),
    );
    expect(appendError.code).toBe("BLOB_MISMATCH");
    expect(git(item.remote, "show", "main:archive/2026/TEST-001.md")).toBe(originalContent);
    expect(() => git(item.remote, "show", "main:tasks/TEST-001.md")).toThrow();
  });
});
