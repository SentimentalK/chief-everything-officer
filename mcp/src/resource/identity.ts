import crypto, { randomUUID } from "node:crypto";
import type { ResourceId, ResourceKind } from "./types.js";

export function generateResourceId(): ResourceId {
  return `res-${randomUUID()}`;
}

export interface NormalizedUrlResult {
  source_identity: string;
  canonical_ref: string;
  platform: string;
  platform_id: string | null;
  resource_kind: ResourceKind;
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "spm_id_from",
  "from_source",
  "from",
  "si",
  "ref",
  "feature",
  "_hsenc",
  "_hsmi",
  "mc_cid",
  "mc_eid",
]);

export function normalizeUrlSource(rawUrl: string): NormalizedUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // YouTube normalization
  if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtu.be"
  ) {
    let videoId: string | null = null;
    if (hostname === "youtu.be") {
      videoId = parsed.pathname.slice(1).split("/")[0] || null;
    } else if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    } else if (parsed.pathname.startsWith("/shorts/")) {
      videoId = parsed.pathname.split("/")[2] || null;
    } else if (parsed.pathname.startsWith("/live/")) {
      videoId = parsed.pathname.split("/")[2] || null;
    }

    if (videoId && /^[0-9a-zA-Z_-]{10,12}$/.test(videoId)) {
      return {
        source_identity: `youtube:${videoId}`,
        canonical_ref: `https://www.youtube.com/watch?v=${videoId}`,
        platform: "youtube",
        platform_id: videoId,
        resource_kind: "video",
      };
    }
  }

  // Bilibili normalization
  if (
    hostname === "bilibili.com" ||
    hostname === "www.bilibili.com" ||
    hostname === "m.bilibili.com"
  ) {
    const bvMatch = parsed.pathname.match(/(BV[0-9a-zA-Z]{10})/i);
    if (bvMatch && bvMatch[1]) {
      const bvid = bvMatch[1];
      return {
        source_identity: `bilibili:${bvid}`,
        canonical_ref: `https://www.bilibili.com/video/${bvid}`,
        platform: "bilibili",
        platform_id: bvid,
        resource_kind: "video",
      };
    }
  }

  // Generic Web normalization
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = hostname;
  parsed.hash = "";

  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  // Filter tracking parameters
  const keysToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    parsed.searchParams.delete(key);
  }

  // Sort remaining query parameters deterministically
  parsed.searchParams.sort();

  // Strip trailing slash if path is just / and there are no params
  let normalizedUrl = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search) {
    normalizedUrl = `${parsed.protocol}//${parsed.host}`;
  }

  return {
    source_identity: `web:${normalizedUrl}`,
    canonical_ref: normalizedUrl,
    platform: hostname,
    platform_id: null,
    resource_kind: "webpage",
  };
}

export function computeFileIdentity(data: Buffer): {
  source_hash: string;
  source_identity: string;
} {
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  return {
    source_hash: `sha256:${hash}`,
    source_identity: `file:sha256:${hash}`,
  };
}
