import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  CimdClientResolver,
  CompositeClientResolver,
  OAuthClientResolutionError,
  createCimdOnlyClientResolver,
  isCimdClientId,
  isDcrClientId,
} from "../src/oauth/client-resolver.js";
import { clearClientMetadataCache } from "../src/oauth/client-metadata.js";

const cleanupServers: http.Server[] = [];

const testResolverOptions = {
  allowHttpForTest: true,
  allowPrivateIpsForTest: true,
  dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
};

beforeEach(() => {
  clearClientMetadataCache();
});

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("OAuthClientResolver (CIMD-only)", () => {
  it("isCimdClientId accepts valid HTTPS CIMD URLs", () => {
    expect(isCimdClientId("https://chat.openai.com/oauth/mcp-client.json")).toBe(true);
  });

  it("isCimdClientId rejects opaque non-URL client IDs", () => {
    expect(isCimdClientId("dcr_abc123")).toBe(false);
    expect(isCimdClientId("some-random-client")).toBe(false);
  });

  it("isCimdClientId rejects malformed URLs without falling through", () => {
    expect(isCimdClientId("https://example.com")).toBe(false);
    expect(isCimdClientId("not-a-url")).toBe(false);
  });

  it("CompositeClientResolver routes HTTPS CIMD IDs through CimdClientResolver", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          client_id: "https://chat.example.com/oauth/client.json",
          client_name: "Test Client",
          redirect_uris: ["https://chat.example.com/callback"],
        }),
      );
    });

    // CIMD resolver uses HTTPS fetch; this test verifies routing only via mock DNS failure path.
    const resolver = createCimdOnlyClientResolver({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    await expect(
      resolver.resolve("https://chat.example.com/oauth/client.json"),
    ).rejects.toBeInstanceOf(OAuthClientResolutionError);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    cleanupServers.push(server);
  });

  it("CompositeClientResolver resolves loopback CIMD via CimdClientResolver", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          client_id: `http://localhost:${(server.address() as { port: number }).port}/oauth/client.json`,
          client_name: "Loopback Client",
          redirect_uris: ["http://127.0.0.1:8080/callback"],
        }),
      );
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanupServers.push(server);
    const port = (server.address() as { port: number }).port;
    const clientId = `http://localhost:${port}/oauth/client.json`;

    const resolver = createCimdOnlyClientResolver(testResolverOptions);
    const metadata = await resolver.resolve(clientId);

    expect(metadata.client_name).toBe("Loopback Client");
    expect(metadata.redirect_uris).toContain("http://127.0.0.1:8080/callback");
  });

  it("CompositeClientResolver rejects unknown opaque IDs without network fetch", async () => {
    let fetchAttempted = false;
    const cimd = new CimdClientResolver({
      ...testResolverOptions,
      dnsLookup: async () => {
        fetchAttempted = true;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const resolver = new CompositeClientResolver({
      cimd,
      allowHttpForTest: true,
    });

    await expect(resolver.resolve("opaque-unknown-client-id")).rejects.toMatchObject({
      errorCode: "invalid_client",
      message: "Unknown OAuth client",
    });
    expect(fetchAttempted).toBe(false);
  });

  it("CompositeClientResolver does not fall back when CIMD URL is syntactically valid but unreachable", async () => {
    const cimd = new CimdClientResolver({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const resolver = new CompositeClientResolver({ cimd });

    await expect(
      resolver.resolve("https://unreachable.example.com/oauth/client.json"),
    ).rejects.toMatchObject({
      errorCode: "invalid_client",
    });
  });
});

describe("OAuthClientResolver DCR routing", () => {
  const sampleDcrId = `dcr_${"A".repeat(43)}`;

  it("isDcrClientId accepts 32-byte base64url DCR IDs", () => {
    expect(isDcrClientId(sampleDcrId)).toBe(true);
    expect(isDcrClientId("dcr_short")).toBe(false);
  });

  it("routes dcr_ IDs to the DCR resolver and never fetches CIMD", async () => {
    let cimdCalled = false;
    let dcrCalled = false;
    const resolver = new CompositeClientResolver({
      cimd: {
        resolve: async () => {
          cimdCalled = true;
          throw new Error("CIMD should not be called");
        },
      },
      dcr: {
        resolve: async (clientId) => {
          dcrCalled = true;
          return {
            client_id: clientId,
            client_name: "DCR",
            redirect_uris: ["http://127.0.0.1:1/cb"],
          };
        },
      },
    });
    const metadata = await resolver.resolve(sampleDcrId);
    expect(metadata.client_name).toBe("DCR");
    expect(dcrCalled).toBe(true);
    expect(cimdCalled).toBe(false);
  });

  it("does not fall back to DCR when a CIMD URL fails", async () => {
    let dcrCalled = false;
    const resolver = new CompositeClientResolver({
      cimd: {
        resolve: async () => {
          throw new OAuthClientResolutionError("invalid_client", "CIMD failed");
        },
      },
      dcr: {
        resolve: async () => {
          dcrCalled = true;
          return {
            client_id: "x",
            client_name: "DCR",
            redirect_uris: ["http://127.0.0.1:1/cb"],
          };
        },
      },
    });
    await expect(
      resolver.resolve("https://unreachable.example.com/oauth/client.json"),
    ).rejects.toMatchObject({ errorCode: "invalid_client", message: "CIMD failed" });
    expect(dcrCalled).toBe(false);
  });

  it("rejects dcr_ IDs when DCR is not composed", async () => {
    const resolver = new CompositeClientResolver({
      cimd: {
        resolve: async () => {
          throw new Error("CIMD should not be called");
        },
      },
    });
    await expect(resolver.resolve(sampleDcrId)).rejects.toMatchObject({
      errorCode: "invalid_client",
      message: "Unknown OAuth client",
    });
  });
});
