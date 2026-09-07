import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CeoWorkspace, mapReadFsError } from "../src/workspace.js";
import { fixture, git } from "./helpers.js";

// Injects a filesystem error on the stat() of the ORIGINAL tasks path so the
// fallback decision (only ENOENT may consult archive) is exercised for real.
const fsFault = vi.hoisted(() => ({
  nextOriginalStat: null as { code: string; syscall: string } | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const faultStat: typeof actual.stat = (async (target, options) => {
    const failure = fsFault.nextOriginalStat;
    if (failure) {
      const pathText = String(target);
      if (pathText.includes("/tasks/") && !pathText.includes("/archive/")) {
        fsFault.nextOriginalStat = null; // fire once
        const error = new Error(`injected ${failure.code}`) as NodeJS.ErrnoException;
        error.code = failure.code;
        error.syscall = failure.syscall;
        throw error;
      }
    }
    return actual.stat(target, options);
  }) as typeof actual.stat;
  return { ...actual, stat: faultStat };
});

// Counts full-tree listings (`git ls-tree -r`) so tests can prove whether the
// archive was enumerated at all.
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

async function readError(promise: Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
}

/** readUtf8 throws a raw EACCES when asked to read the archived target. */
class ArchiveReadFaultWorkspace extends CeoWorkspace {
  async readUtf8(filePath: string, displayPath: string): Promise<string> {
    if (displayPath === "archive/2026/TEST-001.md") {
      const error = new Error("injected read EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      error.syscall = "read";
      throw error;
    }
    return super.readUtf8(filePath, displayPath);
  }
}

describe("mapReadFsError closed-union mapping", () => {
  it("maps permission errnos to ACCESS_DENIED", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const error = new Error("boom") as NodeJS.ErrnoException;
      error.code = code;
      const mapped = mapReadFsError(error, "tasks/X.md");
      expect(mapped.code).toBe("ACCESS_DENIED");
      expect(mapped.details).toEqual({ path: "tasks/X.md" });
    }
  });

  it("maps not-a-regular-file errnos to INVALID_PATH", () => {
    for (const code of ["EISDIR", "ENOTDIR", "ELOOP"]) {
      const error = new Error("boom") as NodeJS.ErrnoException;
      error.code = code;
      expect(mapReadFsError(error, "tasks/X.md").code).toBe("INVALID_PATH");
    }
  });

  it("maps unknown and code-less errors to INTERNAL_ERROR without leaking details", () => {
    const io = new Error("boom") as NodeJS.ErrnoException;
    io.code = "EIO";
    expect(mapReadFsError(io, "tasks/X.md")).toMatchObject({
      code: "INTERNAL_ERROR",
      details: { path: "tasks/X.md", error_code: "EIO" },
    });

    const noCode = new Error("boom");
    expect(mapReadFsError(noCode, "tasks/X.md")).toMatchObject({
      code: "INTERNAL_ERROR",
      details: { path: "tasks/X.md", error_code: "UNKNOWN" },
    });
  });
});

describe("read_files filesystem-error handling (no archive fallback)", () => {
  it("surfaces an EACCES on the original stat and never enumerates the archive", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    // A valid archive candidate exists, but the permission error on the ORIGINAL
    // path must surface instead of falling back to it.
    await writeArchivedCopy(item, "# ARCHIVED\n");

    fsFault.nextOriginalStat = { code: "EACCES", syscall: "stat" };
    const before = fullTree.listings;
    const error = await readError(workspace.readFiles(["tasks/TEST-001.md"]));
    expect(fullTree.listings - before).toBe(0); // archive never enumerated
    expect(error.code).toBe("ACCESS_DENIED");
    expect(error.details).toMatchObject({
      path: "tasks/TEST-001.md",
      failed_requested_path: "tasks/TEST-001.md",
    });
    expect(error.details.reason).toBeUndefined();
  });

  it("surfaces an EIO on the original stat as INTERNAL_ERROR and never enumerates the archive", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = await openWorkspace(item);
    await writeArchivedCopy(item, "# ARCHIVED\n");

    fsFault.nextOriginalStat = { code: "EIO", syscall: "stat" };
    const before = fullTree.listings;
    const error = await readError(workspace.readFiles(["tasks/TEST-001.md"]));
    expect(fullTree.listings - before).toBe(0);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.details).toMatchObject({ error_code: "EIO", failed_requested_path: "tasks/TEST-001.md" });
  });

  it("surfaces a read-phase EACCES on the chosen archive target as a whole-batch ACCESS_DENIED", async () => {
    const item = await fixture();
    cleanup.push(item.root);
    const workspace = new ArchiveReadFaultWorkspace(item.config);
    await workspace.initialize();

    const read = (await workspace.readFiles(["tasks/TEST-001.md"])) as { base_commit: string; files: Array<{ blob_oid: string }> };
    const moved = await workspace.applyChangeSet({
      base_commit: read.base_commit,
      summary: "Archive TEST-001",
      operations: [{
        op: "move",
        path: "tasks/TEST-001.md",
        expected_blob_oid: read.files[0]!.blob_oid,
        target: "archive/2026/TEST-001.md",
      }],
    });
    expect(moved.ok).toBe(true);

    const error = await readError(workspace.readFiles(["tasks/TEST-001.md"]));
    expect(error.code).toBe("ACCESS_DENIED");
    expect(error.details).toMatchObject({
      path: "archive/2026/TEST-001.md",
      failed_requested_path: "tasks/TEST-001.md",
    });
  });
});

async function writeArchivedCopy(item: Fixture, content: string): Promise<void> {
  const absolute = path.join(item.config.repoDir, "archive", "2026", "TEST-001.md");
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  git(item.config.repoDir, "add", "-A");
  git(item.config.repoDir, "commit", "-m", "seed archived copy");
  git(item.config.repoDir, "push", "origin", "main");
}
