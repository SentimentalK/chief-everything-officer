import { describe, expect, it } from "vitest";
import { CeoError } from "../src/errors.js";
import { getRuntimePolicy, loadProductPolicy } from "../src/product-policy.js";

describe("product-policy", () => {
  it("dynamically loads bootstrap, tasks, personal, journal, decision, resources, and well-being policies at startup", async () => {
    const policy = await loadProductPolicy();

    expect(policy.bootstrap).toBeTruthy();
    expect(policy.bootstrap.length).toBeGreaterThan(0);

    const areas = ["tasks", "personal", "journal", "decision", "resources", "well-being"] as const;
    for (const area of areas) {
      const doc = getRuntimePolicy(policy, area);
      expect(doc.ok).toBe(true);
      expect(doc.status).toBe("FOUND");
      expect(doc.name).toBe(area);
      expect(typeof doc.content).toBe("string");
      expect(doc.content!.length).toBeGreaterThan(0);
      expect(doc.bytes).toBeGreaterThan(100);
    }
  });

  it("returns NO_DEFAULT_POLICY gracefully without error for unknown semantic areas", async () => {
    const policy = await loadProductPolicy();

    const projectResult = getRuntimePolicy(policy, "projects");
    expect(projectResult).toEqual({
      ok: true,
      name: "projects",
      status: "NO_DEFAULT_POLICY",
      content: null,
      bytes: 0,
      message: "No runtime default policy for 'projects'.",
    });

    const unknownResult = getRuntimePolicy(policy, "custom_area");
    expect(unknownResult.ok).toBe(true);
    expect(unknownResult.status).toBe("NO_DEFAULT_POLICY");
    expect(unknownResult.content).toBeNull();
  });

  it("strictly prevents path traversal and malformed names with INVALID_PATH", async () => {
    const policy = await loadProductPolicy();

    expect(() => getRuntimePolicy(policy, "../package.json")).toThrow(CeoError);
    expect(() => getRuntimePolicy(policy, "../../etc/passwd")).toThrow(CeoError);
    expect(() => getRuntimePolicy(policy, "tasks/evil")).toThrow(CeoError);
    expect(() => getRuntimePolicy(policy, "tasks.md")).toThrow(CeoError);
    expect(() => getRuntimePolicy(policy, "")).toThrow(CeoError);
  });
});
