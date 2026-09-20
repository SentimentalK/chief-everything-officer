import { describe, it, expect } from "vitest";
import {
  buildFreshWorkspaceManifest,
  renderBootstrapReadme,
  README_EN,
  README_ZH,
} from "../src/bootstrap/index.js";

describe("Bootstrap templates and manifest", () => {
  it("renders correct README template for zh and en", () => {
    expect(renderBootstrapReadme("en")).toBe(README_EN);
    expect(renderBootstrapReadme("zh")).toBe(README_ZH);
  });

  it("builds fresh workspace manifest for en with README.md and .ceoignore", () => {
    const manifest = buildFreshWorkspaceManifest("en");
    expect(manifest).toHaveLength(2);

    const readme = manifest.find((f) => f.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.content).toBe(README_EN);
    expect(readme!.content).toContain("# Welcome to CEO");
    expect(readme!.content).toContain("## You do not need to configure anything first");

    const ceoignore = manifest.find((f) => f.path === ".ceoignore");
    expect(ceoignore).toBeDefined();
    expect(ceoignore!.content).toBe("README.md\n");
  });

  it("builds fresh workspace manifest for zh with README.md and .ceoignore", () => {
    const manifest = buildFreshWorkspaceManifest("zh");
    expect(manifest).toHaveLength(2);

    const readme = manifest.find((f) => f.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.content).toBe(README_ZH);
    expect(readme!.content).toContain("# Welcome to CEO");
    expect(readme!.content).toContain("## 你不需要先配置任何东西");

    const ceoignore = manifest.find((f) => f.path === ".ceoignore");
    expect(ceoignore).toBeDefined();
    expect(ceoignore!.content).toBe("README.md\n");
  });

  it("ensures .ceoignore ends with newline and strictly ignores README.md", () => {
    const manifestEn = buildFreshWorkspaceManifest("en");
    const manifestZh = buildFreshWorkspaceManifest("zh");

    const ignoreEn = manifestEn.find((f) => f.path === ".ceoignore")!.content;
    const ignoreZh = manifestZh.find((f) => f.path === ".ceoignore")!.content;

    expect(ignoreEn).toBe("README.md\n");
    expect(ignoreZh).toBe("README.md\n");
  });

  it("ensures human user guides do not contain AI runtime directives", () => {
    for (const content of [README_EN, README_ZH]) {
      expect(content).not.toContain("SYSTEM.md");
      expect(content).not.toContain("You are an AI");
      expect(content).not.toContain("System Prompt");
    }
  });

  it("explains YAML frontmatter and extend / override modes in both README locales", () => {
    // English README
    expect(README_EN).toContain("rules/<area>.md");
    expect(README_EN).toContain("mode: extend");
    expect(README_EN).toContain("extend` (normal / default choice)");
    expect(README_EN).toContain("override`: completely replace the built-in policy");

    // Chinese README
    expect(README_ZH).toContain("rules/<area>.md");
    expect(README_ZH).toContain("mode: extend");
    expect(README_ZH).toContain("extend`（常规/默认选择）");
    expect(README_ZH).toContain("override`：彻底废弃该领域的内置政策");
  });

  it("ensures AI bootstrap policy contains the separate rule authoring contract", async () => {
    const { loadProductPolicy } = await import("../src/product-policy.js");
    const policy = await loadProductPolicy();

    expect(policy.bootstrap).toBeDefined();
    // Preserves existing policy_read resolution requirement
    expect(policy.bootstrap).toContain('policy_read("<area>")');
    expect(policy.bootstrap).toContain("AI 不自行读取、解析或拼接 `rules/<area>.md` 来重建规则优先级");

    // Separate Rule Authoring Contract
    expect(policy.bootstrap).toContain("## 规则编写（Rule Authoring）");
    expect(policy.bootstrap).toContain("`rules/<area>.md`");
    expect(policy.bootstrap).toContain("mode: extend");
    expect(policy.bootstrap).toContain("`extend`：默认选择");
    expect(policy.bootstrap).toContain("`override`：仅当用户明确要求完全替换该领域的内置 policy 时使用");
    expect(policy.bootstrap).toContain("规则正文必须非空");
  });
});
