import { describe, it, expect } from "vitest";
import { getToolBadgeClass } from "../lib/toolBadge";

describe("getToolBadgeClass", () => {
  it("returns cyan badge class for resource_* tools", () => {
    const cyanClass = "bg-cyan-950/60 text-cyan-300 border-cyan-800/50";
    expect(getToolBadgeClass("resource_capture")).toBe(cyanClass);
    expect(getToolBadgeClass("resource_get")).toBe(cyanClass);
    expect(getToolBadgeClass("resource_search")).toBe(cyanClass);
    expect(getToolBadgeClass("resource_apply")).toBe(cyanClass);
    expect(getToolBadgeClass("resource_list")).toBe(cyanClass);
  });

  it("returns specific badge class for known standard tools", () => {
    expect(getToolBadgeClass("policy_read")).toBe(
      "bg-purple-950/60 text-purple-300 border-purple-800/50"
    );
    expect(getToolBadgeClass("apply_change_set")).toBe(
      "bg-amber-950/60 text-amber-300 border-amber-800/50"
    );
    expect(getToolBadgeClass("workspace_status")).toBe(
      "bg-sky-950/60 text-sky-300 border-sky-800/50"
    );
    expect(getToolBadgeClass("search_text")).toBe(
      "bg-emerald-950/60 text-emerald-300 border-emerald-800/50"
    );
  });

  it("falls back to neutral badge class for other tools", () => {
    const neutralClass = "bg-neutral-900 text-neutral-300 border-neutral-800";
    expect(getToolBadgeClass("read_files")).toBe(neutralClass);
    expect(getToolBadgeClass("list_files")).toBe(neutralClass);
    expect(getToolBadgeClass("unknown_tool")).toBe(neutralClass);
  });
});
