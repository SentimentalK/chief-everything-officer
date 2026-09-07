import { describe, expect, it } from "vitest";
import { isPathIgnored, parseCeoIgnore } from "../src/ignore.js";

describe(".ceoignore V0 deterministic matcher", () => {
  const ignoreContent = `
# Ignore build artifacts and legacy tools
mcp/
generated/
cache/
vendor/

# Exact file ignore
secrets.md
notes/private.md
`;

  it("parses directory prefixes and exact files, ignoring comments and whitespace", () => {
    const matcher = parseCeoIgnore(ignoreContent);
    expect(matcher.directoryPrefixes).toEqual(["mcp/", "generated/", "cache/", "vendor/"]);
    expect(matcher.exactFiles.has("secrets.md")).toBe(true);
    expect(matcher.exactFiles.has("notes/private.md")).toBe(true);
  });

  it("correctly identifies ignored paths in directories", () => {
    const matcher = parseCeoIgnore(ignoreContent);
    expect(isPathIgnored(matcher, "mcp/src/server.ts")).toBe(true);
    expect(isPathIgnored(matcher, "mcp/README.md")).toBe(true);
    expect(isPathIgnored(matcher, "generated/schema.md")).toBe(true);
    expect(isPathIgnored(matcher, "cache/temp.md")).toBe(true);
    expect(isPathIgnored(matcher, "vendor/lib/pkg.md")).toBe(true);
  });

  it("correctly identifies exact ignored files", () => {
    const matcher = parseCeoIgnore(ignoreContent);
    expect(isPathIgnored(matcher, "secrets.md")).toBe(true);
    expect(isPathIgnored(matcher, "notes/private.md")).toBe(true);
    expect(isPathIgnored(matcher, "notes/public.md")).toBe(false);
  });

  it("allows unignored paths", () => {
    const matcher = parseCeoIgnore(ignoreContent);
    expect(isPathIgnored(matcher, "personal/profile.md")).toBe(false);
    expect(isPathIgnored(matcher, "tasks/TASK-001.md")).toBe(false);
    expect(isPathIgnored(matcher, "projects/new.md")).toBe(false);
    expect(isPathIgnored(matcher, "README.md")).toBe(false);
  });

  it("ignores negation patterns per V0 specification", () => {
    const matcher = parseCeoIgnore("mcp/\n!mcp/keep.md");
    expect(isPathIgnored(matcher, "mcp/keep.md")).toBe(true);
  });
});
