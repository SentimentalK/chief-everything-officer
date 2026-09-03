import path from "node:path";
import { lstat } from "node:fs/promises";
import { LifeOSError } from "./errors.js";

/**
 * Enforces the strict filesystem security boundary for LifeOS MCP.
 * Prevents AI from accessing infrastructure code (.github, mcp),
 * git metadata (.git), system secrets (.env), hidden files, symlinks,
 * and path traversal attempts.
 */
export function validateContentPath(candidate: string): string {
  if (
    !candidate ||
    candidate.length > 240 ||
    candidate.includes("\0") ||
    candidate.includes("\\") ||
    candidate.normalize("NFC") !== candidate ||
    /[\u0000-\u001f\u007f]/.test(candidate) ||
    path.posix.isAbsolute(candidate)
  ) {
    throw new LifeOSError("INVALID_PATH", "Path is not a valid repository-relative POSIX path.", { path: candidate });
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new LifeOSError("INVALID_PATH", "Path contains a forbidden or hidden segment.", { path: candidate });
  }
  const normalized = path.posix.normalize(candidate);
  const lower = normalized.toLowerCase();

  // Forbidden system directories, hidden files, secrets, and code paths
  if (
    lower.startsWith(".git/") || lower === ".git" ||
    lower.startsWith(".github/") ||
    lower.startsWith("mcp/") ||
    lower.startsWith(".env")
  ) {
    throw new LifeOSError("INVALID_PATH", "Code, workflows, and hidden metadata are outside the LifeOS content boundary.", { path: candidate });
  }

  // All Markdown (.md) files outside forbidden system paths are allowed
  if (!normalized.endsWith(".md")) {
    throw new LifeOSError("INVALID_PATH", "Only Markdown (.md) files are writable in LifeOS.", { path: candidate });
  }

  return normalized;
}

export async function assertNoSymlink(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new LifeOSError("INVALID_PATH", "Symlinks are forbidden in LifeOS content paths.", { path: relativePath });
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function isAllowedTrackedPath(candidate: string): boolean {
  try {
    validateContentPath(candidate);
    return true;
  } catch {
    return false;
  }
}
