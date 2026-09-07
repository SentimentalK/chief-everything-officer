import { CeoError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { validateContentPath } from "./security.js";

export { LIMITS } from "./limits.js";
export {
  assertNoSymlink,
  isAllowedTrackedPath,
  validateContentPath,
  validateContentPath as validatePath,
} from "./security.js";


export function assertContentSize(content: string): number {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LIMITS.maxFileWriteBytes) {
    throw new CeoError("VALIDATION_FAILED", `File content exceeds the ${Math.round(LIMITS.maxFileWriteBytes / (1024 * 1024))} MiB limit.`, { bytes });
  }
  return bytes;
}
