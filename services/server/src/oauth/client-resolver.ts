import {
  resolveClientMetadata,
  validateClientIdUrl,
  type ClientMetadata,
  type ClientMetadataResolverOptions,
} from "./client-metadata.js";

export interface OAuthClientResolver {
  resolve(clientId: string): Promise<ClientMetadata>;
}

export class OAuthClientResolutionError extends Error {
  constructor(
    public readonly errorCode: "invalid_client" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OAuthClientResolutionError";
  }
}

export function isCimdClientId(
  clientId: string,
  options: { allowHttpForTest?: boolean } = {},
): boolean {
  try {
    validateClientIdUrl(clientId, options.allowHttpForTest ?? false);
    return true;
  } catch {
    return false;
  }
}

export class CimdClientResolver implements OAuthClientResolver {
  constructor(private readonly options: ClientMetadataResolverOptions = {}) {}

  async resolve(clientId: string): Promise<ClientMetadata> {
    try {
      return await resolveClientMetadata(clientId, this.options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OAuthClientResolutionError("invalid_client", message);
    }
  }
}

export interface CompositeClientResolverOptions {
  cimd: OAuthClientResolver;
  allowHttpForTest?: boolean;
}

export class CompositeClientResolver implements OAuthClientResolver {
  private readonly cimd: OAuthClientResolver;
  private readonly allowHttpForTest: boolean;

  constructor(options: CompositeClientResolverOptions) {
    this.cimd = options.cimd;
    this.allowHttpForTest = options.allowHttpForTest ?? false;
  }

  async resolve(clientId: string): Promise<ClientMetadata> {
    if (isCimdClientId(clientId, { allowHttpForTest: this.allowHttpForTest })) {
      return this.cimd.resolve(clientId);
    }

    throw new OAuthClientResolutionError("invalid_client", "Unknown OAuth client");
  }
}

export function createCimdOnlyClientResolver(
  options: ClientMetadataResolverOptions = {},
): OAuthClientResolver {
  return new CompositeClientResolver({
    cimd: new CimdClientResolver(options),
    allowHttpForTest: options.allowHttpForTest,
  });
}
