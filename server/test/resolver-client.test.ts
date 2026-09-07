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

describe("ContentResolverClient (PROJECT-023 Strict Contract)", () => {
  const SECRET_TOKEN = "super-secret-internal-bearer-token";

  it("sends schema_version: 1, Bearer token, and X-Request-ID, and parses valid ResolutionOutcome (resolved)", async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let capturedBody: any = null;

    const { url } = await createMockServer((req, res, body) => {
      capturedHeaders = req.headers;
      capturedBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "resolved",
          fields_resolved: ["title", "creator", "source_id", "canonical_url", "view_count"],
          metadata: {
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
            view_count: 1500000000,
          },
          diagnostics: {
            strategy: "youtube_oembed",
            fetch_status: "ok",
            http_status: 200,
          },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const customRequestId = "11111111-2222-3333-4444-555555555555";
    const outcome = await client.resolve("https://youtu.be/dQw4w9WgXcQ", customRequestId);

    expect(capturedHeaders["authorization"]).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["x-request-id"]).toBe(customRequestId);
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
      expect(outcome.metadata.view_count).toBe(1500000000);
      expect(outcome.fields_resolved).toContain("title");
      expect(outcome.diagnostics.strategy).toBe("youtube_oembed");
      expect(outcome.request_id).toBe(customRequestId);
      expect(outcome.attempted_at).toBeDefined();
      expect(outcome.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("parses 200 unavailable (e.g. 403 ACCESS_BLOCKED) as unavailable without contract_error", async () => {
    const { url } = await createMockServer((_req, res, body) => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "unavailable",
          fields_resolved: [],
          metadata: {
            schema_version: 1,
            source_type: "youtube",
            source_url: parsed.url,
            captured_at: "2026-09-05T12:00:00Z",
          },
          diagnostics: {
            strategy: "youtube_oembed",
            fetch_status: "blocked",
            http_status: 403,
            code: "ACCESS_BLOCKED",
          },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://www.youtube.com/watch?v=blocked");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("ACCESS_BLOCKED");
      expect(outcome.fields_resolved).toEqual([]);
      expect(outcome.diagnostics?.http_status).toBe(403);
      expect(outcome.diagnostics?.strategy).toBe("youtube_oembed");
    }
  });

  it("maps 400 unsupported_url to unsupported status (handling FastAPI detail object and error object)", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          detail: {
            code: "unsupported_url",
            message: "URL platform is not supported.",
          },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/unsupported");

    expect(outcome.status).toBe("unsupported");
    if (outcome.status === "unsupported") {
      expect(outcome.code).toBe("unsupported_url");
      expect(outcome.attempted_at).toBeDefined();
    }
  });

  it("maps 401 to auth_failed", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          detail: "Invalid authorization token.",
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("auth_failed");
    }
  });

  it("maps 502 to resolve_failed", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          detail: { code: "resolve_failed", message: "Upstream platform lookup failed." },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("resolve_failed");
    }
  });

  it("maps 500 to service_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal_error", message: "Boom" } }));
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/foo");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("service_error");
    }
  });

  it("maps request timeout to timeout", async () => {
    const { url } = await createMockServer((_req, _res) => {
      // Deliberately do not reply to trigger client timeout
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 50);
    const outcome = await client.resolve("https://example.com/slow");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("timeout");
    }
  });

  it("maps network connection failure to network_error", async () => {
    const client = new HttpContentResolverClient("http://127.0.0.1:59999", SECRET_TOKEN, 1000);
    const outcome = await client.resolve("https://example.com/dead");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("network_error");
    }
  });

  it("maps malformed 200 (missing fields_resolved) to contract_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Missing required fields_resolved
      res.end(
        JSON.stringify({
          status: "resolved",
          metadata: {
            schema_version: 1,
            source_type: "youtube",
            source_url: "https://example.com/bad",
            captured_at: "2026-09-05T12:00:00Z",
          },
          diagnostics: {
            strategy: "mock",
            fetch_status: "ok",
          },
        }),
      );
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/bad");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("contract_error");
    }
  });

  it("maps invalid JSON on 200 to contract_error", async () => {
    const { url } = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>Not JSON</html>");
    });

    const client = new HttpContentResolverClient(url, SECRET_TOKEN, 2000);
    const outcome = await client.resolve("https://example.com/html");

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe("contract_error");
    }
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
    expect(outcome.status).toBe("disabled");
  });
});
