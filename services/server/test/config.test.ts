import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEY = "test-mcp-key";

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MCP_API_KEY: KEY, ...extra };
}

describe("Config Validation", () => {
  it("throws when MCP_API_KEY is missing", () => {
    expect(() => loadConfig({} as any)).toThrow("MCP_API_KEY is required");
  });

  it("throws when MCP_API_KEY is empty", () => {
    expect(() => loadConfig(baseEnv({ MCP_API_KEY: "" }))).toThrow("MCP_API_KEY must not be empty");
  });

  it("rejects MCP_API_KEY with leading/trailing whitespace", () => {
    expect(() => loadConfig(baseEnv({ MCP_API_KEY: "  padded  " }))).toThrow(
      "MCP_API_KEY must not contain leading or trailing whitespace",
    );
  });

  it("throws when CEO_REMOTE is missing", () => {
    expect(() => loadConfig(baseEnv({ MCP_API_KEY: KEY }) as any)).toThrow("CEO_REMOTE is required");
  });

  it("throws when CEO_REMOTE is empty string", () => {
    expect(() => loadConfig(baseEnv({ CEO_REMOTE: "" }))).toThrow("CEO_REMOTE is required");
  });

  it("throws when CEO_REMOTE is whitespace only", () => {
    expect(() => loadConfig(baseEnv({ CEO_REMOTE: "   \t\n " }))).toThrow("CEO_REMOTE is required");
  });

  it("accepts valid CEO_REMOTE and trims whitespace", () => {
    const config = loadConfig(baseEnv({ CEO_REMOTE: "  git@github.com:SentimentalK/LifeOS.git  " }));
    expect(config.remoteUrl).toBe("git@github.com:SentimentalK/LifeOS.git");
    expect(config.branch).toBe("main");
  });

  it("validates PORT boundaries", () => {
    expect(() => loadConfig(baseEnv({ CEO_REMOTE: "repo.git", PORT: "0" }))).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
    expect(() => loadConfig(baseEnv({ CEO_REMOTE: "repo.git", PORT: "70000" }))).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
    expect(() => loadConfig(baseEnv({ CEO_REMOTE: "repo.git", PORT: "abc" }))).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
  });

  it("requires MCP_API_KEY regardless of bind host (loopback included)", () => {
    // Loopback without a key is still rejected.
    expect(() => loadConfig({ CEO_REMOTE: "repo.git", BIND_HOST: "127.0.0.1" })).toThrow(
      "MCP_API_KEY is required",
    );
    const ok = loadConfig(baseEnv({ CEO_REMOTE: "repo.git", BIND_HOST: "0.0.0.0" }));
    expect(ok.bindHost).toBe("0.0.0.0");
    expect(ok.mcpApiKey).toBe(KEY);
  });

  it("computes default identityDbPath under CEO_DATA_ROOT", () => {
    const config = loadConfig(baseEnv({ CEO_REMOTE: "repo.git", CEO_DATA_ROOT: "/custom/data" }));
    expect(config.identityDbPath).toBe("/custom/data/identity/identity.sqlite");
    expect(config.dataRoot).toBe("/custom/data");
  });

  describe("Git Identity Attribution", () => {
    it("defaults author and committer to CEO State MCP when unconfigured", () => {
      const config = loadConfig(baseEnv({ CEO_REMOTE: "repo.git" }));
      expect(config.gitCommitterName).toBe("CEO State MCP");
      expect(config.gitCommitterEmail).toBe("ceo-mcp@users.noreply.github.com");
      expect(config.gitAuthorName).toBe("CEO State MCP");
      expect(config.gitAuthorEmail).toBe("ceo-mcp@users.noreply.github.com");
    });

    it("credits user as author while keeping CEO runtime as committer", () => {
      const config = loadConfig(
        baseEnv({
          CEO_REMOTE: "repo.git",
          CEO_GIT_AUTHOR_NAME: "Xinghan Xu",
          CEO_GIT_AUTHOR_EMAIL: "kevinxu.senti@gmail.com",
        }),
      );
      expect(config.gitAuthorName).toBe("Xinghan Xu");
      expect(config.gitAuthorEmail).toBe("kevinxu.senti@gmail.com");
      expect(config.gitCommitterName).toBe("CEO State MCP");
      expect(config.gitCommitterEmail).toBe("ceo-mcp@users.noreply.github.com");
    });

    it("allows independent customization of all four identity fields", () => {
      const config = loadConfig(
        baseEnv({
          CEO_REMOTE: "repo.git",
          CEO_GIT_AUTHOR_NAME: "Author Name",
          CEO_GIT_AUTHOR_EMAIL: "author@example.com",
          CEO_GIT_COMMITTER_NAME: "Custom Committer",
          CEO_GIT_COMMITTER_EMAIL: "committer@example.com",
        }),
      );
      expect(config.gitAuthorName).toBe("Author Name");
      expect(config.gitAuthorEmail).toBe("author@example.com");
      expect(config.gitCommitterName).toBe("Custom Committer");
      expect(config.gitCommitterEmail).toBe("committer@example.com");
    });
  });

  describe("Content Resolver Configuration", () => {
    it("disables resolver when both URL and token are omitted", () => {
      const config = loadConfig(baseEnv({ CEO_REMOTE: "repo.git" }));
      expect(config.contentResolverUrl).toBeUndefined();
      expect(config.contentResolverToken).toBeUndefined();
      expect(config.contentResolverTimeoutMs).toBe(5000);
    });

    it("enables resolver when both URL and token are provided", () => {
      const config = loadConfig(
        baseEnv({
          CEO_REMOTE: "repo.git",
          CONTENT_RESOLVER_URL: "http://content-resolver.local:8000",
          CONTENT_RESOLVER_TOKEN: "internal-secret-token",
          CONTENT_RESOLVER_TIMEOUT_MS: "3000",
        }),
      );
      expect(config.contentResolverUrl).toBe("http://content-resolver.local:8000");
      expect(config.contentResolverToken).toBe("internal-secret-token");
      expect(config.contentResolverTimeoutMs).toBe(3000);
    });

    it("throws when only URL is provided", () => {
      expect(() =>
        loadConfig(
          baseEnv({ CEO_REMOTE: "repo.git", CONTENT_RESOLVER_URL: "http://content-resolver.local:8000" }),
        ),
      ).toThrow(
        "Invalid configuration: CONTENT_RESOLVER_URL and CONTENT_RESOLVER_TOKEN must both be set or both be omitted.",
      );
    });

    it("throws when only token is provided", () => {
      expect(() =>
        loadConfig(baseEnv({ CEO_REMOTE: "repo.git", CONTENT_RESOLVER_TOKEN: "internal-secret-token" })),
      ).toThrow(
        "Invalid configuration: CONTENT_RESOLVER_URL and CONTENT_RESOLVER_TOKEN must both be set or both be omitted.",
      );
    });

    it("throws when timeout is invalid", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_REMOTE: "repo.git",
            CONTENT_RESOLVER_URL: "http://content-resolver.local:8000",
            CONTENT_RESOLVER_TOKEN: "token",
            CONTENT_RESOLVER_TIMEOUT_MS: "-50",
          }),
        ),
      ).toThrow("CONTENT_RESOLVER_TIMEOUT_MS must be a positive integer");
    });
  });
});
