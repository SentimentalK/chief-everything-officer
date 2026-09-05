import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getPackageVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(currentDir, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.2.0";
  } catch {
    return "0.2.0";
  }
}

export const BUILD_INFO = {
  version: getPackageVersion(),
  build: process.env.CEO_BUILD_SHA || "dev",
} as const;
