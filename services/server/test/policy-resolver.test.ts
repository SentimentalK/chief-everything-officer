import { afterEach, describe, expect, it } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, git } from "./helpers.js";
import { CeoWorkspace } from "../src/workspace.js";
import { loadProductPolicy } from "../src/product-policy.js";
import {
  parseWorkspaceRuleFrontmatter,
  resolveEffectivePolicy,
  WORKSPACE_EXTENSION_BANNER,
} from "../src/policy-resolver.js";
import { CeoError } from "../src/errors.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseWorkspaceRuleFrontmatter", () => {
  it("parses valid frontmatter with mode: extend and extracts body", () => {
    const raw = "---\nmode: extend\nauthor: test\n---\n\n# Extension Title\n\nSome body text.\n";
    const parsed = parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md");
    expect(parsed.mode).toBe("extend");
    expect(parsed.frontmatter).toMatchObject({ mode: "extend", author: "test" });
    expect(parsed.body).toBe("# Extension Title\n\nSome body text.");
  });

  it("parses valid frontmatter with mode: override and handles CRLF line endings", () => {
    const raw = "---\r\nmode: override\r\n---\r\n\r\n# Override Title\r\n\r\nOverride body.\r\n";
    const parsed = parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md");
    expect(parsed.mode).toBe("override");
    expect(parsed.body).toBe("# Override Title\r\n\r\nOverride body.");
  });

  it("handles UTF-8 BOM at start of file", () => {
    const raw = "\uFEFF---\nmode: extend\n---\n# Body after BOM\n";
    const parsed = parseWorkspaceRuleFrontmatter(raw, "rules/test.md");
    expect(parsed.mode).toBe("extend");
    expect(parsed.body).toBe("# Body after BOM");
  });

  it("throws VALIDATION_FAILED when frontmatter is missing at start of file", () => {
    const raw = "# Missing Frontmatter\n\nSome text.";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "MISSING_FRONTMATTER", path: "rules/tasks.md" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when frontmatter delimiter is unclosed", () => {
    const raw = "---\nmode: extend\n# Unclosed delimiter without closing dashes";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "MALFORMED_FRONTMATTER_DELIMITER" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when YAML frontmatter is malformed", () => {
    const raw = "---\nmode: [broken yaml\n---\n# Body";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "MALFORMED_YAML" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when YAML is not a mapping", () => {
    const raw = "---\n- item 1\n- item 2\n---\n# Body";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "INVALID_FRONTMATTER_SHAPE" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when mode is missing or not a string", () => {
    const raw = "---\nfoo: bar\n---\n# Body";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "MISSING_OR_INVALID_MODE" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when mode is unsupported (e.g. merge)", () => {
    const raw = "---\nmode: merge\n---\n# Body";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "UNSUPPORTED_MODE" }),
      }),
    );
  });

  it("throws VALIDATION_FAILED when markdown body is empty", () => {
    const raw = "---\nmode: override\n---\n   \n\t  \n";
    expect(() => parseWorkspaceRuleFrontmatter(raw, "rules/tasks.md")).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reason: "EMPTY_POLICY_BODY", path: "rules/tasks.md" }),
      }),
    );
  });
});

describe("resolveEffectivePolicy", () => {
  it("returns runtime policy when no workspace rule exists (runtime only)", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "tasks");
    expect(result.ok).toBe(true);
    expect(result.name).toBe("tasks");
    expect(result.status).toBe("FOUND");
    expect(result.content).toBeTruthy();
    expect(result.resolution).toEqual({
      strategy: "runtime_only",
      runtime_policy: true,
      workspace_policy: false,
    });
  });

  it("composes runtime + workspace extension when mode: extend", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    // Commit workspace rule rules/tasks.md
    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    const extensionText = "## Custom Task Priorities\n\nAll tasks require status [TEST_EXT].";
    const ruleContent = `---\nmode: extend\n---\n\n${extensionText}\n`;
    await writeFile(path.join(seedRulesDir, "tasks.md"), ruleContent);
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add tasks extension");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "tasks");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("FOUND");
    expect(result.resolution).toEqual({
      strategy: "runtime_plus_workspace",
      workspace_mode: "extend",
      runtime_policy: true,
      workspace_policy: true,
    });

    // Effective contains runtime content
    const runtime = productPolicy.policies.get("tasks")!;
    expect(result.content).toContain(runtime.content);
    // Effective contains extension banner
    expect(result.content).toContain(WORKSPACE_EXTENSION_BANNER);
    // Effective contains extension body
    expect(result.content).toContain(extensionText);
    // Runtime appears before extension
    const runtimeIdx = result.content!.indexOf(runtime.content!);
    const extIdx = result.content!.indexOf(extensionText);
    expect(runtimeIdx).toBeLessThan(extIdx);
  });

  it("returns only workspace body when mode: override", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    const overrideText = "# Completely Custom Tasks\n\nTotal override content [TEST_OVERRIDE].";
    const ruleContent = `---\nmode: override\n---\n\n${overrideText}\n`;
    await writeFile(path.join(seedRulesDir, "tasks.md"), ruleContent);
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add tasks override");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "tasks");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("FOUND");
    expect(result.content).toBe(overrideText);
    expect(result.resolution).toEqual({
      strategy: "workspace_only",
      workspace_mode: "override",
      runtime_policy: true,
      workspace_policy: true,
    });

    // Unique runtime marker is NOT in result
    expect(result.content).not.toContain("tasks/");
  });

  it("resolves workspace-only policy with mode: extend when runtime policy absent", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    const recipeRule = "# Recipe Tracking Rule\n\nStore recipes under recipes/YYYY-QN.md.";
    await writeFile(path.join(seedRulesDir, "recipes.md"), `---\nmode: extend\n---\n\n${recipeRule}\n`);
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add recipes rule");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "recipes");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("FOUND");
    expect(result.content).toBe(recipeRule);
    expect(result.resolution).toEqual({
      strategy: "workspace_only",
      workspace_mode: "extend",
      runtime_policy: false,
      workspace_policy: true,
    });
  });

  it("resolves workspace-only policy with mode: override when runtime policy absent", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    const projectRule = "# Project Tracking Rule\n\nStore projects under projects/.";
    await writeFile(path.join(seedRulesDir, "projects.md"), `---\nmode: override\n---\n\n${projectRule}\n`);
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add projects rule");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "projects");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("FOUND");
    expect(result.content).toBe(projectRule);
    expect(result.resolution).toEqual({
      strategy: "workspace_only",
      workspace_mode: "override",
      runtime_policy: false,
      workspace_policy: true,
    });
  });

  it("returns NO_DEFAULT_POLICY when neither runtime nor workspace policy exists", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    const result = await resolveEffectivePolicy(productPolicy, workspace, "nonexistent");
    expect(result).toEqual({
      ok: true,
      name: "nonexistent",
      status: "NO_DEFAULT_POLICY",
      content: null,
      bytes: 0,
      message: "No effective policy is defined for 'nonexistent'.",
      resolution: {
        strategy: "none",
        runtime_policy: false,
        workspace_policy: false,
      },
    });
  });

  it("fails closed with VALIDATION_FAILED when workspace rule has invalid frontmatter", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);

    const seedRulesDir = path.join(item.root, "seed", "rules");
    await mkdir(seedRulesDir, { recursive: true });
    await writeFile(path.join(seedRulesDir, "tasks.md"), "# No frontmatter\nInvalid rule.\n");
    git(path.join(item.root, "seed"), "add", "-A");
    git(path.join(item.root, "seed"), "commit", "-m", "add invalid tasks rule");
    git(path.join(item.root, "seed"), "push", "origin", "main");

    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    await expect(resolveEffectivePolicy(productPolicy, workspace, "tasks")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({ reason: "MISSING_FRONTMATTER" }),
    });
  });

  it("rejects path traversal and invalid policy names", async () => {
    const item = await fixture();
    cleanupDirs.push(item.root);
    const workspace = new CeoWorkspace(item.config);
    await workspace.initialize();
    const productPolicy = await loadProductPolicy();

    await expect(resolveEffectivePolicy(productPolicy, workspace, "../passwd")).rejects.toThrow(CeoError);
    await expect(resolveEffectivePolicy(productPolicy, workspace, "tasks.md")).rejects.toThrow(CeoError);
    await expect(resolveEffectivePolicy(productPolicy, workspace, "")).rejects.toThrow(CeoError);
  });
});
