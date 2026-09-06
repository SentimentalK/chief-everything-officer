import path from "node:path";
import { access } from "node:fs/promises";

export const MAX_DIRECTORY_BYTES = 180;
export const MAX_DISPLAY_NAME_CHARS = 160;

/**
 * Strips superficial provider prefixes (e.g. "Bilibili - ", "YouTube - ") and collapses whitespace.
 */
export function cleanDisplayName(candidate: string): string {
  let cleaned = candidate.trim();
  // Strip known provider prefix patterns
  cleaned = cleaned.replace(/^(?:bilibili|youtube|web|pdf|resource)\s*[-:—]\s*/i, "");
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Bound characters
  const codePoints = Array.from(cleaned);
  if (codePoints.length > MAX_DISPLAY_NAME_CHARS) {
    cleaned = codePoints.slice(0, MAX_DISPLAY_NAME_CHARS).join("").trim();
  }
  return cleaned;
}

/**
 * Transforms display_name into a filesystem-safe directory name:
 * - Unicode NFC normalization (preserves Chinese and international characters)
 * - Replaces path separators and forbidden/control characters
 * - Strips leading dots (avoids hidden directories), avoids '.' and '..'
 * - Bounded by UTF-8 bytes (<= maxBytes), never splitting Unicode code points
 * - Leaves room for collision suffixes under standard limits
 */
export function toSafeDirectoryName(displayName: string, maxBytes = MAX_DIRECTORY_BYTES): string {
  if (!displayName || !displayName.trim()) {
    return "Untitled Resource";
  }

  let normalized = displayName.normalize("NFC").trim();

  // Replace path separators and forbidden/control characters with a single space
  // Forbidden across POSIX/Windows: / \ : * ? " < > | null, and control chars 0x00-0x1f, 0x7f
  normalized = normalized.replace(/[/\\:*?"<>|\x00-\x1f\x7f]+/g, " ");

  // Collapse repeated whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  // Strip leading dots and spaces to avoid hidden files or relative path traps
  normalized = normalized.replace(/^[.\s]+/, "");
  // Strip trailing dots and spaces (Windows/Git compatibility)
  normalized = normalized.replace(/[.\s]+$/, "");

  if (!normalized || normalized === "." || normalized === "..") {
    return "Untitled Resource";
  }

  // Enforce UTF-8 byte boundary <= maxBytes without splitting code points
  let bounded = "";
  for (const codePoint of normalized) {
    const candidate = bounded + codePoint;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      break;
    }
    bounded = candidate;
  }

  bounded = bounded.trim().replace(/[.\s]+$/, "");

  return bounded || "Untitled Resource";
}

/**
 * Allocates a unique directory name inside resourcesRoot (e.g. worktree/resources).
 * - If candidate matches currentDirName, returns currentDirName (no-op, avoids adding -2).
 * - Bounded strictly to MAX_DIRECTORY_BYTES (180 bytes) including suffix.
 * - Sequentially probes candidate, candidate-2, candidate-3, etc.
 */
export async function allocateUniqueDirectoryName(
  resourcesRoot: string,
  baseDisplayName: string,
  currentDirName?: string,
): Promise<string> {
  const safeBase = toSafeDirectoryName(baseDisplayName, MAX_DIRECTORY_BYTES);

  if (currentDirName && safeBase === currentDirName) {
    return safeBase;
  }

  const initialPath = path.join(resourcesRoot, safeBase);
  const initialExists = await access(initialPath).then(() => true).catch(() => false);
  if (!initialExists) {
    return safeBase;
  }

  let counter = 2;
  while (counter < 10000) {
    const suffix = `-${counter}`;
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const allowedBaseBytes = Math.max(10, MAX_DIRECTORY_BYTES - suffixBytes);
    const truncatedBase = toSafeDirectoryName(baseDisplayName, allowedBaseBytes);
    const candidateName = `${truncatedBase}${suffix}`;

    if (currentDirName && candidateName === currentDirName) {
      return candidateName;
    }

    const candidatePath = path.join(resourcesRoot, candidateName);
    const candidateExists = await access(candidatePath).then(() => true).catch(() => false);
    if (!candidateExists) {
      return candidateName;
    }
    counter++;
  }

  throw new Error(`Exceeded maximum directory collision attempts for '${safeBase}'.`);
}
