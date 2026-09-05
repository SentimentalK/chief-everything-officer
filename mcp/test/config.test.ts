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

  describe("Git Identity Attribution", () => {
    it("defaults author and committer to CEO State MCP when unconfigured", () => {
      const config = loadConfig({
        CEO_REMOTE: "git@github.com:foo/bar.git",
      } as any);
      expect(config.gitCommitterName).toBe("CEO State MCP");
      expect(config.gitCommitterEmail).toBe("ceo-mcp@users.noreply.github.com");
      expect(config.gitAuthorName).toBe("CEO State MCP");
      expect(config.gitAuthorEmail).toBe("ceo-mcp@users.noreply.github.com");
    });

    it("credits user as author while keeping CEO runtime as committer", () => {
      const config = loadConfig({
        CEO_REMOTE: "git@github.com:foo/bar.git",
        CEO_GIT_AUTHOR_NAME: "Xinghan Xu",
        CEO_GIT_AUTHOR_EMAIL: "kevinxu.senti@gmail.com",
      } as any);
      expect(config.gitAuthorName).toBe("Xinghan Xu");
      expect(config.gitAuthorEmail).toBe("kevinxu.senti@gmail.com");
      expect(config.gitCommitterName).toBe("CEO State MCP");
      expect(config.gitCommitterEmail).toBe("ceo-mcp@users.noreply.github.com");
    });

    it("allows independent customization of all four identity fields", () => {
      const config = loadConfig({
        CEO_REMOTE: "git@github.com:foo/bar.git",
        CEO_GIT_AUTHOR_NAME: "Author Name",
        CEO_GIT_AUTHOR_EMAIL: "author@example.com",
        CEO_GIT_COMMITTER_NAME: "Custom Committer",
        CEO_GIT_COMMITTER_EMAIL: "committer@example.com",
      } as any);
      expect(config.gitAuthorName).toBe("Author Name");
      expect(config.gitAuthorEmail).toBe("author@example.com");
      expect(config.gitCommitterName).toBe("Custom Committer");
      expect(config.gitCommitterEmail).toBe("committer@example.com");
    });
  });
});

