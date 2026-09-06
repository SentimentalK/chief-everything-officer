import path from "node:path";
import { CeoError } from "../errors.js";

export const MAX_SOURCE_ASSET_BYTES = 25 * 1024 * 1024; // 25 MiB

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".docx",
  ".xlsx",
  ".pptx",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".m4a",
  ".exe",
  ".sh",
  ".bin",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
]);

const EXTENSION_MIME_MAP: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain", "text/x-markdown"],
  ".csv": ["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/octet-stream",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/octet-stream",
  ],
  ".pptx": [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint",
    "application/octet-stream",
  ],
};

export function validateSourceAsset(
  filename: string,
  mimeType: string,
  data: Buffer,
): { ext: string; format: string; media_type: string } {
  if (data.length === 0) {
    throw new CeoError("INVALID_SOURCE_ASSET", "Source asset cannot be empty.");
  }
  if (data.length > MAX_SOURCE_ASSET_BYTES) {
    throw new CeoError(
      "INVALID_SOURCE_ASSET",
      `Source asset exceeds maximum size of 25 MiB (${data.length} bytes).`,
    );
  }

  const cleanFilename = path.basename(filename).trim();
  if (!cleanFilename || cleanFilename.startsWith(".")) {
    throw new CeoError("INVALID_SOURCE_ASSET", "Source asset filename is invalid.", {
      filename,
    });
  }

  const ext = path.extname(cleanFilename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new CeoError(
      "INVALID_SOURCE_ASSET",
      `Media and executable files (${ext}) are not supported in CEO Resource Plane.`,
      { ext },
    );
  }

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new CeoError(
      "INVALID_SOURCE_ASSET",
      `File extension '${ext}' is not in the allowed document list (.pdf, .txt, .md, .csv, .docx, .xlsx, .pptx).`,
      { ext },
    );
  }

  const cleanMime = (mimeType.trim().toLowerCase().split(";")[0] ?? "").trim();
  if (cleanMime.startsWith("video/") || cleanMime.startsWith("audio/")) {
    throw new CeoError(
      "INVALID_SOURCE_ASSET",
      `Media MIME types (${cleanMime}) are rejected by CEO Resource Plane.`,
      { mimeType: cleanMime },
    );
  }

  const allowedMimes = EXTENSION_MIME_MAP[ext];
  if (allowedMimes && !allowedMimes.includes(cleanMime)) {
    throw new CeoError(
      "INVALID_SOURCE_ASSET",
      `MIME type '${cleanMime}' is incompatible with file extension '${ext}'.`,
      { ext, mimeType: cleanMime },
    );
  }

  return {
    ext,
    format: ext.slice(1),
    media_type: cleanMime,
  };
}

export function isAllowedResourceSourcePath(filePath: string): boolean {
  const normalized = path.posix.normalize(filePath);
  const match = normalized.match(/^resources\/([^/]+)\/source\/original(\.[a-z0-9]+)$/i);
  if (!match || !match[1] || !match[2]) return false;
  const dirName = match[1];
  if (dirName === "." || dirName === ".." || dirName.startsWith(".") || dirName.includes("\\")) {
    return false;
  }
  const ext = match[2].toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}
