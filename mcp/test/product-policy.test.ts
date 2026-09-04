import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { getPolicy, loadProductPolicy } from "../src/product-policy.js";

describe("product-policy", () => {
  it("loads bootstrap, task, personal, and journal policies at startup into memory cache", async () => {
    const policy = await loadProductPolicy();

    expect(policy.bootstrap).toContain("CEO State MCP 是用户拥有的长期个人状态与工作空间。");
    expect(policy.bootstrap).toContain("policy_read");
    expect(policy.bootstrap).toContain("personal/");
    expect(policy.bootstrap).toContain("tasks/");
    expect(policy.bootstrap).toContain("JOURNAL.md");
    expect(policy.bootstrap).not.toContain("TODO.md");

    const task = getPolicy(policy, "task");
    expect(task.name).toBe("task");
    expect(task.content).toContain("# Task Rule");
    expect(task.content).toContain("archive/<year>/");
    expect(task.bytes).toBeGreaterThan(100);

    const personal = getPolicy(policy, "personal");
    expect(personal.name).toBe("personal");
    expect(personal.content).toContain("# Personal Data Rule");
    expect(personal.content).toContain("Purpose:");
    expect(personal.bytes).toBeGreaterThan(100);

    const journal = getPolicy(policy, "journal");
    expect(journal.name).toBe("journal");
    expect(journal.content).toContain("# Journal Rule");
    expect(journal.content).toContain("append-only");
    expect(journal.bytes).toBeGreaterThan(100);
  });

  it("rejects unknown policy names including retired router with INVALID_OPERATION", async () => {
    const policy = await loadProductPolicy();

    expect(() => getPolicy(policy, "router")).toThrow(CeoError);
    expect(() => getPolicy(policy, "router")).toThrow(/Unknown product policy/);
    expect(() => getPolicy(policy, "unknown")).toThrow(CeoError);
    expect(() => getPolicy(policy, "system")).toThrow(CeoError);
  });

  it("strictly prevents path traversal and access outside policy allowlist", async () => {
    const policy = await loadProductPolicy();

    expect(() => getPolicy(policy, "../package.json")).toThrow(CeoError);
    expect(() => getPolicy(policy, "../../etc/passwd")).toThrow(CeoError);
    expect(() => getPolicy(policy, "TODO.md")).toThrow(CeoError);
  });
});
