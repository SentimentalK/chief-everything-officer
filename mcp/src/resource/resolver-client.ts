import type { Config } from "../config.js";
import {
  type ContentMetadataV1,
  contentMetadataV1Schema,
  resolverErrorResponseSchema,
} from "./resolver-contract.js";

export type ResolveOutcome =
  | {
      status: "resolved";
      metadata: ContentMetadataV1;
      latency_ms: number;
    }
  | {
      status: "unsupported";
      code: "unsupported_url";
      latency_ms: number;
    }
  | {
      status: "unavailable";
      code:
        | "timeout"
        | "network_error"
        | "auth_failed"
        | "resolve_failed"
        | "service_error"
        | "contract_error";
      latency_ms: number;
    }
  | {
      status: "disabled";
    };

export interface UrlMetadataResolver {
  resolve(url: string): Promise<ResolveOutcome>;
}

export class HttpContentResolverClient implements UrlMetadataResolver {
  private readonly endpoint: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = 5000,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/resolve`;
  }

  async resolve(url: string): Promise<ResolveOutcome> {
    const start = performance.now();
    let res: Response;

    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          schema_version: 1,
          url,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const latency_ms = Math.round(performance.now() - start);
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        return { status: "unavailable", code: "timeout", latency_ms };
      }
      return { status: "unavailable", code: "network_error", latency_ms };
    }

    const latency_ms = Math.round(performance.now() - start);

    if (res.status === 200) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { status: "unavailable", code: "contract_error", latency_ms };
      }

      const parsed = contentMetadataV1Schema.safeParse(data);
      if (!parsed.success) {
        return { status: "unavailable", code: "contract_error", latency_ms };
      }

      return {
        status: "resolved",
        metadata: parsed.data,
        latency_ms,
      };
    }

    let errorCode: string | null = null;
    try {
      const body: unknown = await res.json();
      const parsedErr = resolverErrorResponseSchema.safeParse(body);
      if (parsedErr.success) {
        errorCode = parsedErr.data.error.code;
      }
    } catch {
      // Ignore JSON parse failure on error responses
    }

    if (res.status === 400) {
      if (errorCode === "unsupported_url") {
        return { status: "unsupported", code: "unsupported_url", latency_ms };
      }
      return { status: "unavailable", code: "contract_error", latency_ms };
    }

    if (res.status === 401) {
      return { status: "unavailable", code: "auth_failed", latency_ms };
    }

    if (res.status === 502) {
      return { status: "unavailable", code: "resolve_failed", latency_ms };
    }

    return { status: "unavailable", code: "service_error", latency_ms };
  }
}

export class DisabledContentResolverClient implements UrlMetadataResolver {
  async resolve(_url: string): Promise<ResolveOutcome> {
    return { status: "disabled" };
  }
}

export function createContentResolverClient(config: Config): UrlMetadataResolver {
  if (config.contentResolverUrl && config.contentResolverToken) {
    return new HttpContentResolverClient(
      config.contentResolverUrl,
      config.contentResolverToken,
      config.contentResolverTimeoutMs,
    );
  }
  return new DisabledContentResolverClient();
}
