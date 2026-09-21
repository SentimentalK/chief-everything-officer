import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...extra };
}

describe("Config Validation", () => {
  it("does not require MCP_API_KEY, CEO_REMOTE, or CEO_BRANCH", () => {
    const config = loadConfig({});
    expect(config.dataRoot).toBe("/data");
    expect((config as any).mcpApiKey).toBeUndefined();
    expect((config as any).remoteUrl).toBeUndefined();
    expect((config as any).branch).toBeUndefined();
    expect((config as any).repoDir).toBeUndefined();
    expect((config as any).txnDir).toBeUndefined();
    expect((config as any).stateDir).toBeUndefined();
  });

  it("validates PORT boundaries", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
    expect(() => loadConfig({ PORT: "70000" })).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
    expect(() => loadConfig({ PORT: "abc" })).toThrow(
      "PORT must be an integer from 1 to 65535",
    );
  });

  it("sets bind host appropriately", () => {
    const ok = loadConfig({ BIND_HOST: "0.0.0.0" });
    expect(ok.bindHost).toBe("0.0.0.0");
  });

  it("computes default identityDbPath under CEO_DATA_ROOT", () => {
    const config = loadConfig({ CEO_DATA_ROOT: "/custom/data" });
    expect(config.identityDbPath).toBe("/custom/data/identity/identity.sqlite");
    expect(config.dataRoot).toBe("/custom/data");
  });

  describe("Git Identity Attribution", () => {
    it("defaults committer to CEO State MCP when unconfigured", () => {
      const config = loadConfig(baseEnv({}));
      expect(config.gitCommitterName).toBe("CEO State MCP");
      expect(config.gitCommitterEmail).toBe("ceo-mcp@users.noreply.github.com");
      expect((config as any).gitAuthorName).toBeUndefined();
      expect((config as any).gitAuthorEmail).toBeUndefined();
    });

    it("allows customization of committer identity", () => {
      const config = loadConfig(
        baseEnv({
          CEO_GIT_COMMITTER_NAME: "Custom Committer",
          CEO_GIT_COMMITTER_EMAIL: "committer@example.com",
        }),
      );
      expect(config.gitCommitterName).toBe("Custom Committer");
      expect(config.gitCommitterEmail).toBe("committer@example.com");
    });
  });

  describe("Content Resolver Configuration", () => {
    it("disables resolver when both URL and token are omitted", () => {
      const config = loadConfig(baseEnv({}));
      expect(config.contentResolverUrl).toBeUndefined();
      expect(config.contentResolverToken).toBeUndefined();
      expect(config.contentResolverTimeoutMs).toBe(5000);
    });

    it("enables resolver when both URL and token are provided", () => {
      const config = loadConfig(
        baseEnv({
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
          baseEnv({ CONTENT_RESOLVER_URL: "http://content-resolver.local:8000" }),
        ),
      ).toThrow(
        "Invalid configuration: CONTENT_RESOLVER_URL and CONTENT_RESOLVER_TOKEN must both be set or both be omitted.",
      );
    });

    it("throws when only token is provided", () => {
      expect(() =>
        loadConfig(baseEnv({ CONTENT_RESOLVER_TOKEN: "internal-secret-token" })),
      ).toThrow(
        "Invalid configuration: CONTENT_RESOLVER_URL and CONTENT_RESOLVER_TOKEN must both be set or both be omitted.",
      );
    });

    it("throws when timeout is invalid", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CONTENT_RESOLVER_URL: "http://content-resolver.local:8000",
            CONTENT_RESOLVER_TOKEN: "token",
            CONTENT_RESOLVER_TIMEOUT_MS: "-50",
          }),
        ),
      ).toThrow("CONTENT_RESOLVER_TIMEOUT_MS must be a positive integer");
    });
  });

  describe("OAuth Configuration & CEO_PUBLIC_ORIGIN Validation", () => {
    it("allows missing or non-https publicOrigin when OAuth is disabled", () => {
      const config1 = loadConfig(baseEnv({ CEO_OAUTH_ENABLED: "false" }));
      expect(config1.oauthEnabled).toBe(false);
      expect(config1.publicOrigin).toBeUndefined();

      const config2 = loadConfig(
        baseEnv({ CEO_OAUTH_ENABLED: "false", CEO_PUBLIC_ORIGIN: "http://insecure.local" }),
      );
      expect(config2.oauthEnabled).toBe(false);
      expect(config2.publicOrigin).toBe("http://insecure.local");
    });

    it("throws when CEO_OAUTH_ENABLED is true but CEO_PUBLIC_ORIGIN is missing", () => {
      expect(() =>
        loadConfig(baseEnv({ CEO_OAUTH_ENABLED: "true" })),
      ).toThrow("CEO_PUBLIC_ORIGIN is required when CEO_OAUTH_ENABLED is true");
    });

    it("throws when CEO_PUBLIC_ORIGIN is not a valid URL", () => {
      expect(() =>
        loadConfig(baseEnv({ CEO_OAUTH_ENABLED: "true", CEO_PUBLIC_ORIGIN: "not-a-url" })),
      ).toThrow("CEO_PUBLIC_ORIGIN must be a valid URL");
    });

    it("throws when CEO_PUBLIC_ORIGIN uses http: scheme", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_ENABLED: "true",
            CEO_PUBLIC_ORIGIN: "http://ceo.sentimentalk.com",
          }),
        ),
      ).toThrow("CEO_PUBLIC_ORIGIN must use https: scheme when CEO_OAUTH_ENABLED is true");
    });

    it("throws when CEO_PUBLIC_ORIGIN contains credentials", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_ENABLED: "true",
            CEO_PUBLIC_ORIGIN: "https://user:pass@ceo.sentimentalk.com",
          }),
        ),
      ).toThrow("CEO_PUBLIC_ORIGIN must not contain credentials");
    });

    it("throws when CEO_PUBLIC_ORIGIN contains path segments", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_ENABLED: "true",
            CEO_PUBLIC_ORIGIN: "https://ceo.sentimentalk.com/subpath",
          }),
        ),
      ).toThrow("CEO_PUBLIC_ORIGIN must be an origin only without path segments");
    });

    it("throws when CEO_PUBLIC_ORIGIN contains query parameters or fragments", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_ENABLED: "true",
            CEO_PUBLIC_ORIGIN: "https://ceo.sentimentalk.com?query=1",
          }),
        ),
      ).toThrow("CEO_PUBLIC_ORIGIN must not contain query or fragment");

      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_ENABLED: "true",
            CEO_PUBLIC_ORIGIN: "https://ceo.sentimentalk.com#fragment",
          }),
        ),
      ).toThrow("CEO_PUBLIC_ORIGIN must not contain query or fragment");
    });

    it("accepts valid https origin and normalizes trailing slash", () => {
      const config = loadConfig(
        baseEnv({
          CEO_OAUTH_ENABLED: "true",
          CEO_PUBLIC_ORIGIN: "https://ceo.sentimentalk.com/",
        }),
      );
      expect(config.oauthEnabled).toBe(true);
      expect(config.publicOrigin).toBe("https://ceo.sentimentalk.com");
    });

    it("accepts valid https origin with custom port", () => {
      const config = loadConfig(
        baseEnv({
          CEO_OAUTH_ENABLED: "true",
          CEO_PUBLIC_ORIGIN: "https://localhost:8443",
        }),
      );
      expect(config.oauthEnabled).toBe(true);
      expect(config.publicOrigin).toBe("https://localhost:8443");
    });
  });

  describe("OAuth DCR Configuration", () => {
    it("defaults DCR to disabled with oauth-dcr.sqlite under identity/", () => {
      const config = loadConfig(baseEnv({ CEO_DATA_ROOT: "/custom/data" }));
      expect(config.oauthDcrEnabled).toBe(false);
      expect(config.oauthDcrDbPath).toBe("/custom/data/identity/oauth-dcr.sqlite");
    });

    it("throws when DCR is enabled without OAuth", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_OAUTH_DCR_ENABLED: "true",
          }),
        ),
      ).toThrow("CEO_OAUTH_DCR_ENABLED=true requires CEO_OAUTH_ENABLED=true");
    });

    it("accepts DCR when OAuth is enabled", () => {
      const config = loadConfig(
        baseEnv({
          CEO_OAUTH_ENABLED: "true",
          CEO_OAUTH_DCR_ENABLED: "true",
          CEO_PUBLIC_ORIGIN: "https://ceo.sentimentalk.com",
        }),
      );
      expect(config.oauthDcrEnabled).toBe(true);
    });
  });

  describe("Protocol Origin Configuration", () => {
    it("defaults protocol origins to empty and independent of ALLOWED_ORIGINS", () => {
      const config = loadConfig(
        baseEnv({
          ALLOWED_ORIGINS: "https://ceo-web.example",
        }),
      );
      expect(config.allowedOrigins).toEqual(["https://ceo-web.example"]);
      expect(config.protocolAllowedOrigins).toEqual([]);
    });

    it("parses CEO_PROTOCOL_ALLOWED_ORIGINS without changing product origins", () => {
      const config = loadConfig(
        baseEnv({
          ALLOWED_ORIGINS: "https://ceo-web.example",
          CEO_PROTOCOL_ALLOWED_ORIGINS: "https://gemini.google.com, https://future-host.example",
        }),
      );
      expect(config.allowedOrigins).toEqual(["https://ceo-web.example"]);
      expect(config.protocolAllowedOrigins).toEqual([
        "https://gemini.google.com",
        "https://future-host.example",
      ]);
    });
  });

  describe("GitHub App Configuration", () => {
    it("defaults to disabled when omitted and preserves old deployment config", () => {
      const config = loadConfig(baseEnv({}));
      expect(config.githubAppEnabled).toBe(false);
      expect(config.githubAppClientId).toBeUndefined();
    });

    it("requires CLIENT_ID when enabled", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_GITHUB_APP_ENABLED: "true",
          }),
        ),
      ).toThrow("CEO_GITHUB_APP_CLIENT_ID is required when CEO_GITHUB_APP_ENABLED is true");
    });

    it("requires CLIENT_SECRET when enabled", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_GITHUB_APP_ENABLED: "true",
            CEO_GITHUB_APP_CLIENT_ID: "Iv1.test",
          }),
        ),
      ).toThrow("CEO_GITHUB_APP_CLIENT_SECRET is required when CEO_GITHUB_APP_ENABLED is true");
    });

    it("requires SLUG when enabled", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_GITHUB_APP_ENABLED: "true",
            CEO_GITHUB_APP_CLIENT_ID: "Iv1.test",
            CEO_GITHUB_APP_CLIENT_SECRET: "secret",
          }),
        ),
      ).toThrow("CEO_GITHUB_APP_SLUG is required when CEO_GITHUB_APP_ENABLED is true");
    });

    it("requires PRIVATE_KEY_PATH when enabled", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_GITHUB_APP_ENABLED: "true",
            CEO_GITHUB_APP_CLIENT_ID: "Iv1.test",
            CEO_GITHUB_APP_CLIENT_SECRET: "secret",
            CEO_GITHUB_APP_SLUG: "my-app",
          }),
        ),
      ).toThrow("CEO_GITHUB_APP_PRIVATE_KEY_PATH is required when CEO_GITHUB_APP_ENABLED is true");
    });

    it("requires PRIVATE_KEY_PATH file to exist", () => {
      expect(() =>
        loadConfig(
          baseEnv({
            CEO_GITHUB_APP_ENABLED: "true",
            CEO_GITHUB_APP_CLIENT_ID: "Iv1.test",
            CEO_GITHUB_APP_CLIENT_SECRET: "secret",
            CEO_GITHUB_APP_SLUG: "my-app",
            CEO_GITHUB_APP_PRIVATE_KEY_PATH: "/non/existent/path/key.pem",
          }),
        ),
      ).toThrow("CEO_GITHUB_APP_PRIVATE_KEY_PATH file not found");
    });

    it("accepts valid GitHub App configuration", () => {
      // package.json exists and can be used as a stand-in existing file
      const config = loadConfig(
        baseEnv({
          CEO_GITHUB_APP_ENABLED: "true",
          CEO_GITHUB_APP_CLIENT_ID: "Iv1.test",
          CEO_GITHUB_APP_CLIENT_SECRET: "secret123",
          CEO_GITHUB_APP_SLUG: "my-app",
          CEO_GITHUB_APP_PRIVATE_KEY_PATH: "package.json",
          CEO_GITHUB_APP_CALLBACK_URL: "https://example.com/callback",
        }),
      );
      expect(config.githubAppEnabled).toBe(true);
      expect(config.githubAppClientId).toBe("Iv1.test");
      expect(config.githubAppClientSecret).toBe("secret123");
      expect(config.githubAppSlug).toBe("my-app");
      expect(config.githubAppPrivateKeyPath).toBe("package.json");
      expect(config.githubAppCallbackUrl).toBe("https://example.com/callback");
    });
  });
});
