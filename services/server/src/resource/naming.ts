import path from "node:path";
import { access, readdir } from "node:fs/promises";
import { CeoError } from "../errors.js";

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

const WINDOWS_RESERVED_STEM_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "¹": "1", // ¹
  "²": "2", // ²
  "³": "3", // ³
};

/**
 * Matches Windows reserved device names on the stem before the FIRST dot,
 * case-insensitively and including superscript-digit variants:
 * CON, PRN, AUX, NUL, COM1-9, LPT1-9, COM¹-COM³, LPT¹-LPT³ (with or without an
 * extension, e.g. "CON.md"). "CONS", "COM0" or "CON-2" are not reserved.
 */
export function isWindowsReservedName(name: string): boolean {
  const stem = name.split(".")[0] ?? "";
  const folded = stem
    .normalize("NFC")
    .replace(/[¹²³]/g, (ch) => SUPERSCRIPT_DIGITS[ch] ?? ch)
    .toUpperCase();
  return WINDOWS_RESERVED_STEM_RE.test(folded);
}

/**
 * Deterministic case/NFC-insensitive directory comparison key. This is this
 * project's comparison rule only — it does not claim to emulate the Unicode
 * behavior of every filesystem. Historical directories are not re-scanned.
 */
export function directoryComparisonKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Builds the final directory candidate for a display name and collision suffix:
 * - Truncates the base to fit `suffix` (suffix bytes are never cut) within maxBytes.
 * - Prefixes an underscore when the FINAL candidate is a Windows reserved name,
 *   re-truncating the base by one byte so `_` never exceeds the byte budget.
 * - Never splits Unicode code points (toSafeDirectoryName is code-point-safe).
 * The semantic display name is never altered; only the physical directory is.
 */
function buildDirectoryCandidate(displayName: string, suffix: string, maxBytes: number): string {
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const baseMax = maxBytes - suffixBytes;

  const candidate = `${toSafeDirectoryName(displayName, baseMax)}${suffix}`;

  if (!isWindowsReservedName(candidate)) {
    return candidate;
  }

  if (baseMax <= 1) {
    // No room for the underscore prefix under an extreme budget; keep the raw name.
    return candidate;
  }
  return `_${toSafeDirectoryName(displayName, baseMax - 1)}${suffix}`;
}

/**
 * Allocates a unique directory name inside resourcesRoot (e.g. worktree/resources).
 * - Collision set = ALL existing entries (files, dirs, symlinks), compared by the
 *   case/NFC-insensitive directoryComparisonKey. readdir failures propagate as
 *   INTERNAL_ERROR — an unreadable resources/ is never treated as empty.
 * - The resource's own current directory is excluded by EXACT original name only,
 *   so other same-key entries still count as collisions.
 * - If the candidate's key equals the current directory's key with no other
 *   occupant, the current physical directory is returned (display-only rename);
 *   with another occupant, an explicit RESOURCE_NAME_CONFLICT is raised.
 * - Bounded strictly to MAX_DIRECTORY_BYTES (180 bytes) including suffix.
 * - Sequentially probes candidate, candidate-2, candidate-3, etc.
 * Callers must ensure resourcesRoot already exists before calling.
 */
export async function allocateUniqueDirectoryName(
  resourcesRoot: string,
  baseDisplayName: string,
  currentDirName?: string,
): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(resourcesRoot);
  } catch (error) {
    throw new CeoError("INTERNAL_ERROR", `Cannot list resource directories under '${resourcesRoot}'.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  // key -> original entry names occupying it (excluding this resource's own dir).
  const occupied = new Map<string, string[]>();
  const currentKey = currentDirName ? directoryComparisonKey(currentDirName) : null;
  for (const entry of entries) {
    if (currentDirName && entry === currentDirName) continue;
    const key = directoryComparisonKey(entry);
    const list = occupied.get(key);
    if (list) {
      list.push(entry);
    } else {
      occupied.set(key, [entry]);
    }
  }

  const isOccupied = (candidateName: string): boolean => {
    const key = directoryComparisonKey(candidateName);
    const list = occupied.get(key);
    if (list && list.length > 0) return true;
    return false;
  };

  // If the candidate only differs from the current directory by case/NFC, keep
  // the physical directory (display_name updates only) — unless another object
  // already occupies that key, which is an explicit ambiguity, not a suffix case.
  const resolveOwnKeyMatch = (candidateName: string): string | null => {
    if (currentKey === null) return null;
    if (directoryComparisonKey(candidateName) !== currentKey) return null;
    const sameKeyEntries = occupied.get(currentKey);
    if (sameKeyEntries && sameKeyEntries.length > 0) {
      throw new CeoError(
        "RESOURCE_NAME_CONFLICT",
        `Directory '${candidateName}' collides by case/NFC-insensitive key with the resource's current directory '${currentDirName}', which is also occupied by another entry '${sameKeyEntries[0]}'. Choose a different display name.`,
        {
          candidate: candidateName,
          current_directory: currentDirName,
          conflicting_entry: sameKeyEntries[0],
          comparison_key: currentKey,
        },
      );
    }
    return currentDirName as string;
  };

  const exists = async (candidateName: string): Promise<boolean> => {
    if (isOccupied(candidateName)) return true;
    return access(path.join(resourcesRoot, candidateName))
      .then(() => true)
      .catch(() => false);
  };

  const baseCandidate = buildDirectoryCandidate(baseDisplayName, "", MAX_DIRECTORY_BYTES);

  const ownBaseMatch = resolveOwnKeyMatch(baseCandidate);
  if (ownBaseMatch !== null) return ownBaseMatch;

  if (!(await exists(baseCandidate))) {
    return baseCandidate;
  }

  let counter = 2;
  while (counter < 10000) {
    const candidateName = buildDirectoryCandidate(baseDisplayName, `-${counter}`, MAX_DIRECTORY_BYTES);

    const ownMatch = resolveOwnKeyMatch(candidateName);
    if (ownMatch !== null) return ownMatch;

    if (!(await exists(candidateName))) {
      return candidateName;
    }
    counter++;
  }

  throw new Error(`Exceeded maximum directory collision attempts for '${baseCandidate}'.`);
}
