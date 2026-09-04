import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { getPolicy, loadProductPolicy } from "../src/product-policy.js";

describe("product-policy", () => {
  it("loads bootstrap and router at process startup into memory cache", async () => {
    const policy = await loadProductPolicy();

    expect(policy.bootstrap).toContain("CEO State MCP provides access to the user's durable personal state.");
    expect(policy.bootstrap).toContain("policy_read");
    expect(policy.bootstrap).toContain('name="router"');
    expect(policy.bootstrap).not.toContain("TODO.md");

    const router = getPolicy(policy, "router");
    expect(router.name).toBe("router");
    expect(router.content).toContain("# CEO Workspace Router");
    expect(router.content).toContain("## Tasks");
    expect(router.content).toContain("## Context");
    expect(router.content).toContain("## Records");
    expect(router.content).toContain("## Journal");
    expect(router.bytes).toBeGreaterThan(100);
  });

  it("rejects unknown policy names with INVALID_OPERATION", async () => {
    const policy = await loadProductPolicy();

    expect(() => getPolicy(policy, "unknown")).toThrow(CeoError);
    expect(() => getPolicy(policy, "unknown")).toThrow(/Unknown product policy/);
    expect(() => getPolicy(policy, "system")).toThrow(CeoError);
  });

  it("strictly prevents path traversal and access outside policy allowlist", async () => {
    const policy = await loadProductPolicy();

    expect(() => getPolicy(policy, "../package.json")).toThrow(CeoError);
    expect(() => getPolicy(policy, "../../etc/passwd")).toThrow(CeoError);
    expect(() => getPolicy(policy, "TODO.md")).toThrow(CeoError);
  });
});
