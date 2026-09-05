import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { getPolicy, loadProductPolicy } from "../src/product-policy.js";

describe("product-policy", () => {
  it("dynamically loads bootstrap, tasks, personal, and journal policies at startup", async () => {
    const policy = await loadProductPolicy();

    expect(policy.bootstrap).toContain("CEO State MCP 是用户拥有的长期个人工作空间与状态引擎。");
    expect(policy.bootstrap).toContain("policy_read");
    expect(policy.bootstrap).toContain("tasks/");
    expect(policy.bootstrap).toContain("personal/");
    expect(policy.bootstrap).toContain("JOURNAL.md");

    const tasks = getPolicy(policy, "tasks");
    expect(tasks.ok).toBe(true);
    expect(tasks.status).toBe("FOUND");
    expect(tasks.name).toBe("tasks");
    expect(tasks.content).toContain("# Task Rule");
    expect(tasks.bytes).toBeGreaterThan(100);

    const personal = getPolicy(policy, "personal");
    expect(personal.ok).toBe(true);
    expect(personal.status).toBe("FOUND");
    expect(personal.name).toBe("personal");
    expect(personal.content).toContain("# Personal Data Rule");
    expect(personal.bytes).toBeGreaterThan(100);

    const journal = getPolicy(policy, "journal");
    expect(journal.ok).toBe(true);
    expect(journal.status).toBe("FOUND");
    expect(journal.name).toBe("journal");
    expect(journal.content).toContain("# Journal Rule");
    expect(journal.bytes).toBeGreaterThan(100);
  });

  it("returns NO_DEFAULT_POLICY gracefully without error for unknown semantic areas", async () => {
    const policy = await loadProductPolicy();

    const projectResult = getPolicy(policy, "projects");
    expect(projectResult).toEqual({
      ok: true,
      name: "projects",
      status: "NO_DEFAULT_POLICY",
      content: null,
      bytes: 0,
      message: expect.stringContaining("No runtime default policy for 'projects'"),
    });

    const unknownResult = getPolicy(policy, "custom_area");
    expect(unknownResult.ok).toBe(true);
    expect(unknownResult.status).toBe("NO_DEFAULT_POLICY");
    expect(unknownResult.content).toBeNull();
  });

  it("strictly prevents path traversal and malformed names with INVALID_PATH", async () => {
    const policy = await loadProductPolicy();

    expect(() => getPolicy(policy, "../package.json")).toThrow(CeoError);
    expect(() => getPolicy(policy, "../../etc/passwd")).toThrow(CeoError);
    expect(() => getPolicy(policy, "tasks/evil")).toThrow(CeoError);
    expect(() => getPolicy(policy, "tasks.md")).toThrow(CeoError);
    expect(() => getPolicy(policy, "")).toThrow(CeoError);
  });
});
