import { LifeOSError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { validateContentPath } from "./security.js";

export { LIMITS } from "./limits.js";
export {
  assertNoSymlink,
  isAllowedTrackedPath,
  validateContentPath,
  validateContentPath as validatePath,
} from "./security.js";

export function validateArchive(source: string, target: string): void {
  const from = validateContentPath(source);
  const to = validateContentPath(target);
  if (!from.startsWith("tasks/")) {
    throw new LifeOSError(
      "INVALID_OPERATION",
      "Archive source must be inside tasks/.",
      { source, target },
    );
  }
  if (!to.startsWith("archive/")) {
    throw new LifeOSError(
      "INVALID_OPERATION",
      "Archive target must be inside archive/.",
      { source, target },
    );
  }
}

export function assertContentSize(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LIMITS.maxFileWriteBytes) {
    throw new LifeOSError("VALIDATION_FAILED", `File content exceeds the ${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB limit.`, { bytes });
  }
  return bytes;
}
