import YAML from "yaml";
import { CeoError } from "./errors.js";
import type { CeoWorkspace } from "./workspace.js";
import {
  type EffectivePolicyDocument,
  type ProductPolicy,
  getRuntimePolicy,
} from "./product-policy.js";

export const WORKSPACE_EXTENSION_BANNER = `---

## Workspace Extension

The following workspace-specific policy extends the runtime policy.
Where this extension explicitly defines different behavior for the same
workspace-specific concern, the workspace extension takes precedence.`;

export interface ParsedWorkspaceRule {
  mode: "extend" | "override";
  body: string;
  frontmatter: Record<string, unknown>;
}

export function parseWorkspaceRuleFrontmatter(
  rawContent: string,
  rulePath: string,
): ParsedWorkspaceRule {
  const content = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;

  if (!content.startsWith("---")) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' must declare YAML frontmatter at the beginning of the file.`,
      { path: rulePath, reason: "MISSING_FRONTMATTER" },
    );
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' has unclosed or malformed frontmatter delimiters.`,
      { path: rulePath, reason: "MALFORMED_FRONTMATTER_DELIMITER" },
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1]!);
  } catch {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' contains malformed YAML frontmatter.`,
      { path: rulePath, reason: "MALFORMED_YAML" },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' frontmatter must be a YAML mapping.`,
      { path: rulePath, reason: "INVALID_FRONTMATTER_SHAPE" },
    );
  }

  const fm = parsed as Record<string, unknown>;
  if (typeof fm.mode !== "string") {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' must specify a string 'mode' in frontmatter.`,
      { path: rulePath, reason: "MISSING_OR_INVALID_MODE" },
    );
  }

  if (fm.mode !== "extend" && fm.mode !== "override") {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' specifies unsupported mode '${fm.mode}'. Only 'extend' and 'override' are supported.`,
      { path: rulePath, reason: "UNSUPPORTED_MODE" },
    );
  }

  const body = match[2]!.trim();
  if (body.length === 0) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Workspace rule '${rulePath}' must have a non-empty markdown body.`,
      { path: rulePath, reason: "EMPTY_POLICY_BODY" },
    );
  }

  return {
    mode: fm.mode as "extend" | "override",
    body,
    frontmatter: fm,
  };
}

export async function resolveEffectivePolicy(
  productPolicy: ProductPolicy,
  workspace: CeoWorkspace,
  name: string,
): Promise<EffectivePolicyDocument> {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new CeoError(
      "INVALID_PATH",
      "Policy name contains invalid characters or traversal.",
      { name },
    );
  }

  const runtime = getRuntimePolicy(productPolicy, name);
  const hasRuntime = runtime.status === "FOUND" && typeof runtime.content === "string";

  const rulePath = `rules/${name}.md`;
  const workspaceDoc = await workspace.readOptionalMarkdown(rulePath);

  if (!workspaceDoc) {
    if (hasRuntime) {
      return {
        ok: true,
        name,
        status: "FOUND",
        content: runtime.content,
        bytes: runtime.bytes,
        resolution: {
          strategy: "runtime_only",
          runtime_policy: true,
          workspace_policy: false,
        },
      };
    }

    return {
      ok: true,
      name,
      status: "NO_DEFAULT_POLICY",
      content: null,
      bytes: 0,
      message: `No effective policy is defined for '${name}'.`,
      resolution: {
        strategy: "none",
        runtime_policy: false,
        workspace_policy: false,
      },
    };
  }

  const parsed = parseWorkspaceRuleFrontmatter(workspaceDoc.content, rulePath);

  if (parsed.mode === "override") {
    return {
      ok: true,
      name,
      status: "FOUND",
      content: parsed.body,
      bytes: Buffer.byteLength(parsed.body, "utf8"),
      resolution: {
        strategy: "workspace_only",
        workspace_mode: "override",
        runtime_policy: hasRuntime,
        workspace_policy: true,
      },
    };
  }

  // parsed.mode === "extend"
  if (hasRuntime) {
    const composed = `${runtime.content}\n\n${WORKSPACE_EXTENSION_BANNER}\n\n${parsed.body}`;
    return {
      ok: true,
      name,
      status: "FOUND",
      content: composed,
      bytes: Buffer.byteLength(composed, "utf8"),
      resolution: {
        strategy: "runtime_plus_workspace",
        workspace_mode: "extend",
        runtime_policy: true,
        workspace_policy: true,
      },
    };
  }

  return {
    ok: true,
    name,
    status: "FOUND",
    content: parsed.body,
    bytes: Buffer.byteLength(parsed.body, "utf8"),
    resolution: {
      strategy: "workspace_only",
      workspace_mode: "extend",
      runtime_policy: false,
      workspace_policy: true,
    },
  };
}
