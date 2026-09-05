import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Config Validation", () => {
  it("throws when CEO_REMOTE is missing", () => {
    expect(() => loadConfig({} as any)).toThrow("CEO_REMOTE is required");
  });

  it("throws when CEO_REMOTE is empty string", () => {
    expect(() => loadConfig({ CEO_REMOTE: "" } as any)).toThrow("CEO_REMOTE is required");
  });

  it("throws when CEO_REMOTE is whitespace only", () => {
    expect(() => loadConfig({ CEO_REMOTE: "   \t\n " } as any)).toThrow("CEO_REMOTE is required");
  });

  it("accepts valid CEO_REMOTE and trims whitespace", () => {
    const config = loadConfig({
      CEO_REMOTE: "  git@github.com:SentimentalK/LifeOS.git  ",
    } as any);
    expect(config.remoteUrl).toBe("git@github.com:SentimentalK/LifeOS.git");
    expect(config.branch).toBe("main");
  });

  it("validates PORT boundaries", () => {
    expect(() => loadConfig({ CEO_REMOTE: "git@github.com:foo/bar.git", PORT: "0" } as any)).toThrow("PORT must be an integer from 1 to 65535");
    expect(() => loadConfig({ CEO_REMOTE: "git@github.com:foo/bar.git", PORT: "70000" } as any)).toThrow("PORT must be an integer from 1 to 65535");
    expect(() => loadConfig({ CEO_REMOTE: "git@github.com:foo/bar.git", PORT: "abc" } as any)).toThrow("PORT must be an integer from 1 to 65535");
  });

  it("enforces MCP_API_KEY for non-loopback bind hosts", () => {
    expect(() => loadConfig({
      CEO_REMOTE: "git@github.com:foo/bar.git",
      BIND_HOST: "0.0.0.0",
    } as any)).toThrow("MCP_API_KEY is required when binding to a non-loopback address");

    const ok = loadConfig({
      CEO_REMOTE: "git@github.com:foo/bar.git",
      BIND_HOST: "0.0.0.0",
      MCP_API_KEY: "secret-key",
    } as any);
    expect(ok.bindHost).toBe("0.0.0.0");
    expect(ok.mcpApiKey).toBe("secret-key");
  });
});
