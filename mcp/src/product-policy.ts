import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LifeOSError } from "./errors.js";

export interface PolicyDocument {
  name: string;
  content: string;
  bytes: number;
  [key: string]: unknown;
}

export interface ProductPolicy {
  bootstrap: string;
  policies: Map<string, PolicyDocument>;
}

const ALLOWED_POLICIES = new Set(["router"]);

export function getPolicyDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../policy");
}

export async function loadProductPolicy(policyDir = getPolicyDir()): Promise<ProductPolicy> {
  const bootstrapPath = path.join(policyDir, "bootstrap.md");
  const routerPath = path.join(policyDir, "router.md");

  const [bootstrapRaw, routerRaw] = await Promise.all([
    readFile(bootstrapPath, "utf8"),
    readFile(routerPath, "utf8"),
  ]);

  const bootstrap = bootstrapRaw.trim();
  const routerDoc: PolicyDocument = {
    name: "router",
    content: routerRaw.trim(),
    bytes: Buffer.byteLength(routerRaw.trim(), "utf8"),
  };

  const policies = new Map<string, PolicyDocument>();
  policies.set("router", routerDoc);

  return {
    bootstrap,
    policies,
  };
}

export function getPolicy(productPolicy: ProductPolicy, name: string): PolicyDocument {
  if (!ALLOWED_POLICIES.has(name)) {
    throw new LifeOSError(
      "INVALID_OPERATION",
      `Unknown product policy '${name}'. Only 'router' is supported in V0.`,
      { name },
    );
  }
  const doc = productPolicy.policies.get(name);
  if (!doc) {
    throw new LifeOSError(
      "INTERNAL_ERROR",
      `Policy document '${name}' is missing from cache.`,
      { name },
    );
  }
  return doc;
}
