import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DisabledContentResolverClient,
  HttpContentResolverClient,
} from "../src/resource/resolver-client.js";

const servers: http.Server[] = [];

function createMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

describe("ContentResolverClient", () => {
  const SECRET_TOKEN = "super-secret-internal-bearer-token";

  it("sends schema_version: 1 and Bearer token, and parses valid V1 response", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let capturedBody: any = null;

    const { url } = await createMockServer((req, res, body) => {
      capturedHeaders = req.headers;
      capturedBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          schema_version: 1,
          source_type: "youtube",
          source_url: capturedBody.url,
          canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          source_id: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          creator: "Rick Astley",
          published_at: "2009-10-25T06:57:33Z",
          language: "en",
          captured_at: "2026-09-05T12:00:00Z",
          duration_seconds: 213,
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://youtu.be/dQw4w9WgXcQ");

    expect(capturedHeaders["authorization"]).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedBody).toEqual({
      schema_version: 1,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.metadata.source_type).toBe("youtube");
      expect(outcome.metadata.title).toBe("Never Gonna Give You Up");
      expect(outcome.metadata.creator).toBe("Rick Astley");
      expect(outcome.metadata.source_id).toBe("dQw4w9WgXcQ");
      expect(outcome.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("maps 400 unsupported_url to unsupported status", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "unsupported_url",
            message: "URL platform is not supported.",
          },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/unsupported");

    expect(outcome).toEqual({
      status: "unsupported",
      code: "unsupported_url",
      latency_ms: expect.any(Number),
    });
  });

  it("maps 401 to auth_failed", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "invalid_token", message: "Invalid authorization token." },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "auth_failed",
      latency_ms: expect.any(Number),
    });
  });

  it("maps 502 to resolve_failed", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "resolve_failed", message: "Upstream platform lookup failed." },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "resolve_failed",
      latency_ms: expect.any(Number),
    });
  });

  it("maps 500 to service_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal_error", message: "Boom" } }));
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "service_error",
      latency_ms: expect.any(Number),
    });
  });

  it("maps request timeout to timeout", async () => {
    const { url } = await createMockServer((_req, _res) => {
      // Deliberately do not reply to trigger client timeout
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 50);
    const outcome = await client.resolve("https://example.com/slow");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "timeout",
      latency_ms: expect.any(Number),
    });
  });

  it("maps network connection failure to network_error", async () => {
    // Unused port
    const client = new HttpContentResolverClient("http://127.0.0.1:59999", SECRET_TOKEN, 1000);
    const outcome = await client.resolve("https://example.com/dead");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "network_error",
      latency_ms: expect.any(Number),
    });
  });

  it("maps malformed 200 (schema mismatch) to contract_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Missing required source_type, schema_version is 2 instead of 1
      res.end(JSON.stringify({ schema_version: 2, title: "Bad wire" }));
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/bad");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "contract_error",
      latency_ms: expect.any(Number),
    });
  });

  it("maps invalid JSON on 200 to contract_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>Not JSON</html>");
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/html");

    expect(outcome).toEqual({
      status: "unavailable",
      code: "contract_error",
      latency_ms: expect.any(Number),
    });
  });

  it("guarantees secret token never appears in returned outcome", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("internal crash");
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/test");

    const json = JSON.stringify(outcome);
    expect(json).not.toContain(SECRET_TOKEN);
  });

  it("disabled client returns disabled status", async () => {
    const client = new DisabledContentResolverClient();
    const outcome = await client.resolve("https://example.com/any");
    expect(outcome).toEqual({ status: "disabled" });
  });
});
