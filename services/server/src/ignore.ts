import path from "node:path";

export interface CeoIgnoreMatcher {
  exactFiles: Set<string>;
  directoryPrefixes: string[];
}

/**
 * Parses .ceoignore content according to V0 deterministic rules:
 * - Empty lines and whitespace-only lines are ignored.
 * - Lines starting with '#' are ignored as comments.
 * - Directory entries end in '/' and exclude the entire subtree (e.g. 'mcp/', 'generated/').
 * - Other entries are treated as exact relative file paths.
 * - Does not support wildcards (*, **, ?) or negation (!).
 */
export function parseCeoIgnore(content: string): CeoIgnoreMatcher {
  const exactFiles = new Set<string>();
  const directoryPrefixes: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Reject negation patterns per specification
    if (line.startsWith("!")) continue;

    // Normalize POSIX path
    const isDir = line.endsWith("/");
    const clean = path.posix.normalize(line.replace(/^\/+/, "")).replace(/^(\.\/)+/, "");

    if (!clean || clean === "." || clean === "..") continue;

    if (isDir) {
      const prefix = clean.endsWith("/") ? clean : `${clean}/`;
      directoryPrefixes.push(prefix);
    } else {
      exactFiles.add(clean);
    }
  }

  return { exactFiles, directoryPrefixes };
}

/**
 * Checks if a POSIX relative path is excluded by .ceoignore.
 */
export function isPathIgnored(matcher: CeoIgnoreMatcher, relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath).replace(/^\/+/, "").replace(/^(\.\/)+/, "");
  if (matcher.exactFiles.has(normalized)) return true;
  for (const prefix of matcher.directoryPrefixes) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}
