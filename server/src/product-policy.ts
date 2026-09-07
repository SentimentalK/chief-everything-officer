import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CeoError } from "./errors.js";

export interface PolicyDocument {
  ok: boolean;
  name: string;
  status: "FOUND" | "NO_DEFAULT_POLICY";
  content: string | null;
  bytes: number;
  message?: string;
  [key: string]: unknown;
}

export interface ProductPolicy {
  bootstrap: string;
  policies: Map<string, PolicyDocument>;
}

export function getPolicyDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../policy");
}

export async function loadProductPolicy(policyDir = getPolicyDir()): Promise<ProductPolicy> {
  const bootstrapPath = path.join(policyDir, "bootstrap.md");
  const bootstrapRaw = await readFile(bootstrapPath, "utf8");
  const bootstrap = bootstrapRaw.trim();

  const policies = new Map<string, PolicyDocument>();
  const entries = await readdir(policyDir).catch(() => []);

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "bootstrap.md") continue;
    const name = entry.replace(/\.md$/, "");
    const filePath = path.join(policyDir, entry);
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    policies.set(name, {
      ok: true,
      name,
      status: "FOUND",
      content: trimmed,
      bytes: Buffer.byteLength(trimmed, "utf8"),
    });
  }

  return {
    bootstrap,
    policies,
  };
}

export function getPolicy(productPolicy: ProductPolicy, name: string): PolicyDocument {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new CeoError(
      "INVALID_PATH",
      "Policy name contains invalid characters or traversal.",
      { name },
    );
  }

  const found = productPolicy.policies.get(name);
  if (found) {
    return found;
  }

  return {
    ok: true,
    name,
    status: "NO_DEFAULT_POLICY",
    content: null,
    bytes: 0,
    message: `No runtime default policy for '${name}'. Check for workspace-specific rules in rules/${name}.md or reason from workspace context.`,
  };
}
