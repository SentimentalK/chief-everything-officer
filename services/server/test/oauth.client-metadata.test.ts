import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  validateClientIdUrl,
  isPrivateOrSpecialIp,
  resolveClientMetadata,
  clearClientMetadataCache,
  ClientMetadataError,
} from "../src/oauth/client-metadata.js";

const cleanupServers: http.Server[] = [];

beforeEach(() => {
  clearClientMetadataCache();
});

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("Client ID Metadata Document (CIMD) Resolver", () => {
  describe("validateClientIdUrl", () => {
    it("accepts valid HTTPS URL with non-root path", () => {
      const parsed = validateClientIdUrl("https://chat.openai.com/oauth/mcp-client.json");
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname).toBe("chat.openai.com");
      expect(parsed.pathname).toBe("/oauth/mcp-client.json");
    });

    it("rejects non-https schemes", () => {
      expect(() => validateClientIdUrl("http://chat.openai.com/client.json")).toThrow(
        ClientMetadataError
      );
      expect(() => validateClientIdUrl("ftp://chat.openai.com/client.json")).toThrow(
        ClientMetadataError
      );
    });

    it("rejects URLs with user credentials", () => {
      expect(() => validateClientIdUrl("https://user:pass@example.com/client.json")).toThrow(
        ClientMetadataError
      );
    });

    it("rejects URLs with query strings or fragments", () => {
      expect(() => validateClientIdUrl("https://example.com/client.json?foo=bar")).toThrow(
        ClientMetadataError
      );
      expect(() => validateClientIdUrl("https://example.com/client.json#hash")).toThrow(
        ClientMetadataError
      );
    });

    it("rejects root-only path or empty path", () => {
      expect(() => validateClientIdUrl("https://example.com")).toThrow(ClientMetadataError);
      expect(() => validateClientIdUrl("https://example.com/")).toThrow(ClientMetadataError);
    });

    it("rejects dot segments (. or ..) in path", () => {
      expect(() => validateClientIdUrl("https://example.com/a/../b")).toThrow(ClientMetadataError);
      expect(() => validateClientIdUrl("https://example.com/a/./b")).toThrow(ClientMetadataError);
    });

    it("rejects IP literals in hostname", () => {
      expect(() => validateClientIdUrl("https://127.0.0.1/client.json")).toThrow(
        ClientMetadataError
      );
      expect(() => validateClientIdUrl("https://10.0.0.1/client.json")).toThrow(
        ClientMetadataError
      );
    });
  });

  describe("isPrivateOrSpecialIp", () => {
    it("correctly identifies private/restricted IPv4 addresses", () => {
      expect(isPrivateOrSpecialIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("127.0.1.5")).toBe(true);
      expect(isPrivateOrSpecialIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("10.254.1.2")).toBe(true);
      expect(isPrivateOrSpecialIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("172.31.255.255")).toBe(true);
      expect(isPrivateOrSpecialIp("192.168.1.1")).toBe(true);
      expect(isPrivateOrSpecialIp("169.254.169.254")).toBe(true);
      expect(isPrivateOrSpecialIp("100.64.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("0.0.0.0")).toBe(true);
      expect(isPrivateOrSpecialIp("224.0.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("240.0.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("255.255.255.255")).toBe(true);
    });

    it("correctly identifies public IPv4 addresses", () => {
      expect(isPrivateOrSpecialIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrSpecialIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrSpecialIp("93.184.216.34")).toBe(false);
      expect(isPrivateOrSpecialIp("172.15.0.1")).toBe(false);
      expect(isPrivateOrSpecialIp("172.32.0.1")).toBe(false);
    });

    it("correctly identifies private/restricted IPv6 addresses", () => {
      expect(isPrivateOrSpecialIp("::1")).toBe(true);
      expect(isPrivateOrSpecialIp("::")).toBe(true);
      expect(isPrivateOrSpecialIp("fe80::1")).toBe(true);
      expect(isPrivateOrSpecialIp("fc00::1")).toBe(true);
      expect(isPrivateOrSpecialIp("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateOrSpecialIp("ff02::1")).toBe(true);
      expect(isPrivateOrSpecialIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrSpecialIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("correctly identifies public IPv6 addresses", () => {
      expect(isPrivateOrSpecialIp("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateOrSpecialIp("2001:4860:4860::8888")).toBe(false);
    });
  });

  describe("SSRF and Connection Pinning Protection", () => {
    it("rejects resolution when DNS resolves to a private IP", async () => {
      await expect(
        resolveClientMetadata("https://malicious.example.com/client.json", {
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/private or restricted/);
    });

    it("rejects resolution when ANY of the resolved IPs is private", async () => {
      await expect(
        resolveClientMetadata("https://rebinding.example.com/client.json", {
          dnsLookup: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.5", family: 4 },
          ],
        })
      ).rejects.toThrow(/private or restricted/);
    });
  });

  describe("HTTP Document Retrieval & Schema Enforcement", () => {
    it("successfully fetches, validates, and caches valid client metadata", async () => {
      let requestCount = 0;
      const server = http.createServer((req, res) => {
        requestCount++;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            client_id: `http://localhost:${(server.address() as any).port}/oauth/client.json`,
            client_name: "Test GPT Client",
            redirect_uris: ["https://chatgpt.com/callback", "http://localhost:8080/callback"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          })
        );
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      const options = {
        allowHttpForTest: true,
        allowPrivateIpsForTest: true,
        dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
      };

      // First call fetches over network
      const metadata = await resolveClientMetadata(clientId, options);
      expect(metadata.client_id).toBe(clientId);
      expect(metadata.client_name).toBe("Test GPT Client");
      expect(metadata.redirect_uris).toHaveLength(2);
      expect(requestCount).toBe(1);

      // Second call hits in-memory cache
      const cached = await resolveClientMetadata(clientId, options);
      expect(cached.client_name).toBe("Test GPT Client");
      expect(requestCount).toBe(1);
    });

    it("rejects HTTP redirects (301/302)", async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(302, { Location: "/other" });
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      await expect(
        resolveClientMetadata(clientId, {
          allowHttpForTest: true,
          allowPrivateIpsForTest: true,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/Redirects are not permitted/);
    });

    it("rejects responses exceeding maximum allowed size (32 KiB)", async () => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        // Stream 40 KiB
        res.write(" ".repeat(40 * 1024));
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      await expect(
        resolveClientMetadata(clientId, {
          allowHttpForTest: true,
          allowPrivateIpsForTest: true,
          maxResponseBytes: 32768,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/exceeded maximum allowed size/);
    });

    it("rejects non-JSON Content-Type", async () => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("<html>Hello</html>");
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      await expect(
        resolveClientMetadata(clientId, {
          allowHttpForTest: true,
          allowPrivateIpsForTest: true,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/expected application\/json/);
    });

    it("rejects mismatched client_id in payload", async () => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            client_id: "https://different.example.com/client.json",
            client_name: "Mismatch",
            redirect_uris: ["https://different.example.com/cb"],
          })
        );
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      await expect(
        resolveClientMetadata(clientId, {
          allowHttpForTest: true,
          allowPrivateIpsForTest: true,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/does not match requested client_id/);
    });

    it("rejects unsupported token_endpoint_auth_method", async () => {
      const server = http.createServer((req, res) => {
        const port = (server.address() as any).port;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            client_id: `http://localhost:${port}/oauth/client.json`,
            client_name: "SecretClient",
            redirect_uris: ["https://example.com/cb"],
            token_endpoint_auth_method: "client_secret_basic",
          })
        );
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanupServers.push(server);
      const port = (server.address() as any).port;
      const clientId = `http://localhost:${port}/oauth/client.json`;

      await expect(
        resolveClientMetadata(clientId, {
          allowHttpForTest: true,
          allowPrivateIpsForTest: true,
          dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).rejects.toThrow(/Unsupported token_endpoint_auth_method/);
    });
  });
});
