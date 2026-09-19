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
});
