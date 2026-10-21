import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { CeoError } from "./errors.js";
import { parseWorkspaceRuleFrontmatter, type ParsedWorkspaceRule } from "./policy-resolver.js";

/**
 * How an area's files hold their data:
 * - `state`: files carry current values that are rewritten in place; generic append is rejected.
 * - `stream`: files accumulate dated entries; append is allowed.
 */
export type WriteMode = "state" | "stream";

export const WRITE_MODES: readonly WriteMode[] = ["state", "stream"];

/** Runtime defaults used when `rules/<area>.md` does not declare a valid `write_mode`. */
export const RUNTIME_WRITE_MODE_DEFAULTS: Readonly<Record<string, WriteMode>> = Object.freeze({
  tasks: "state",
  personal: "state",
});

export const FALLBACK_WRITE_MODE: WriteMode = "stream";

function isWriteMode(value: unknown): value is WriteMode {
  return typeof value === "string" && (WRITE_MODES as readonly string[]).includes(value);
}

/** The first directory segment of a workspace path; root-level files have no area. */
export function areaOfPath(filePath: string): string | null {
  const slash = filePath.indexOf("/");
  return slash > 0 ? filePath.slice(0, slash) : null;
}

export function runtimeWriteMode(area: string | null): WriteMode {
  if (area === null) return FALLBACK_WRITE_MODE;
  return Object.hasOwn(RUNTIME_WRITE_MODE_DEFAULTS, area) ? RUNTIME_WRITE_MODE_DEFAULTS[area]! : FALLBACK_WRITE_MODE;
}

/** Parses a workspace rule and rejects an invalid optional `write_mode`. Used on every rule write. */
export function validateWorkspaceRuleContent(rawContent: string, rulePath: string): ParsedWorkspaceRule {
  const parsed = parseWorkspaceRuleFrontmatter(rawContent, rulePath);
  if (Object.hasOwn(parsed.frontmatter, "write_mode") && !isWriteMode(parsed.frontmatter.write_mode)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' specifies unsupported write_mode '${String(parsed.frontmatter.write_mode)}'. Only 'state' and 'stream' are supported.`,
      { path: rulePath, reason: "UNSUPPORTED_WRITE_MODE", allowed: [...WRITE_MODES] },
    );
  }
  return parsed;
}

/** Write mode declared by existing rule content; malformed rules and invalid values fall back to runtime defaults. */
export function declaredWriteMode(rawContent: string, rulePath: string): WriteMode | null {
  try {
    const value = parseWorkspaceRuleFrontmatter(rawContent, rulePath).frontmatter.write_mode;
    return isWriteMode(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolves area write modes against one worktree, reading each `rules/<area>.md` at most once.
 * Precedence: rule frontmatter `write_mode` > runtime default > `stream`.
 */
export class WriteModeResolver {
  private readonly cache = new Map<string, Promise<WriteMode>>();

  constructor(private readonly worktree: string) {}

  async resolve(area: string | null): Promise<WriteMode> {
    if (area === null) return FALLBACK_WRITE_MODE;
    let pending = this.cache.get(area);
    if (!pending) {
      pending = this.load(area);
      this.cache.set(area, pending);
    }
    return await pending;
  }

  private async load(area: string): Promise<WriteMode> {
    const rulePath = `rules/${area}.md`;
    const absolute = path.join(this.worktree, rulePath);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats?.isFile()) return runtimeWriteMode(area);
    const raw = await readFile(absolute, "utf8").catch(() => null);
    if (raw === null) return runtimeWriteMode(area);
    return declaredWriteMode(raw, rulePath) ?? runtimeWriteMode(area);
  }
}
