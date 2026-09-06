import path from "node:path";
import { access } from "node:fs/promises";
import type { ResourceSourceInput } from "./types.js";

export const MAX_DIRECTORY_BYTES = 180;
export const MAX_DISPLAY_NAME_CHARS = 160;

export interface DetermineDisplayNameOptions {
  inputDisplayName?: string | null;
  resolverTitle?: string | null;
  source: ResourceSourceInput;
  sourceIdentity?: string | null;
  originalName?: string | null;
  canonicalRef?: string | null;
}

/**
 * Derives initial display_name during capture using the priority cascade:
 * 1. explicit input.display_name
 * 2. deterministic resolver title
 * 3. original filename stem
 * 4. meaningful external reference label
 * 5. deterministic source identifier / useful URL path segment
 * 6. "Untitled Resource"
 *
 * Provider prefixes (e.g. "YouTube -", "Bilibili -") are strictly avoided.
 */
export function determineInitialDisplayName(options: DetermineDisplayNameOptions): string {
  // 1. Explicit input.display_name
  if (options.inputDisplayName && options.inputDisplayName.trim()) {
    const trimmed = cleanDisplayName(options.inputDisplayName);
    if (trimmed) return trimmed;
  }

  // 2. Deterministic resolver title
  if (options.resolverTitle && options.resolverTitle.trim()) {
    const cleaned = cleanDisplayName(options.resolverTitle);
    if (cleaned) return cleaned;
  }

  // 3. Original filename stem
  if (options.originalName && options.originalName.trim()) {
    const parsed = path.parse(options.originalName.trim());
    const stem = cleanDisplayName(parsed.name || options.originalName.trim());
    if (stem) return stem;
  }

  // 4. External reference label
  if (options.source.type === "external_ref" && options.source.ref) {
    const cleaned = cleanDisplayName(options.source.ref);
    if (cleaned) return cleaned;
  }

  // 5. Deterministic source identifier / URL path segment
  if (options.sourceIdentity && options.sourceIdentity.trim()) {
    const idParts = options.sourceIdentity.trim().split(":");
    const ident = idParts.length > 1 ? idParts.slice(1).join(":") : idParts[0]!;
    if (ident && !ident.startsWith("http://") && !ident.startsWith("https://")) {
      const cleaned = cleanDisplayName(ident);
      if (cleaned) return cleaned;
    }
  }

  if (options.source.type === "url" && options.source.url) {
    try {
      const parsedUrl = new URL(options.source.url);
      const segments = parsedUrl.pathname.split("/").map((s) => decodeURIComponent(s).trim()).filter(Boolean);
      if (segments.length > 0) {
        const last = segments[segments.length - 1]!;
        const cleaned = cleanDisplayName(last);
        if (cleaned) return cleaned;
      }
    } catch {}
  }

  // 6. Final fallback
  return "Untitled Resource";
}

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
