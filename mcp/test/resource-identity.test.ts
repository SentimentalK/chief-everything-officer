import { describe, expect, it } from "vitest";
import {
  computeFileIdentity,
  generateResourceId,
  normalizeUrlSource,
} from "../src/resource/identity.js";

describe("Resource Identity & Normalization", () => {
  it("generates valid resource_id format", () => {
    const id = generateResourceId();
    expect(id).toMatch(/^res-[0-9a-f-]{36}$/i);
  });

  describe("YouTube URL normalization", () => {
    it("normalizes standard watch URL and strips tracking parameters", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=twitter&t=42s&feature=share";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("youtube:dQw4w9WgXcQ");
      expect(result.canonical_ref).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.platform).toBe("youtube");
      expect(result.platform_id).toBe("dQw4w9WgXcQ");
      expect(result.resource_kind).toBe("video");
    });

    it("normalizes youtu.be short URL", () => {
      const url = "https://youtu.be/dQw4w9WgXcQ?si=abc123xyz";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("youtube:dQw4w9WgXcQ");
      expect(result.canonical_ref).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.platform_id).toBe("dQw4w9WgXcQ");
    });

    it("normalizes youtube.com/shorts/ URL", () => {
      const url = "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("youtube:dQw4w9WgXcQ");
      expect(result.canonical_ref).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.platform_id).toBe("dQw4w9WgXcQ");
    });

    it("normalizes youtube.com/live/ URL", () => {
      const url = "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("youtube:dQw4w9WgXcQ");
      expect(result.canonical_ref).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.platform_id).toBe("dQw4w9WgXcQ");
    });
  });

  describe("Bilibili URL normalization", () => {
    it("extracts BV ID from standard video URL", () => {
      const url = "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.337.0.0";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("bilibili:BV1xx411c7mD");
      expect(result.canonical_ref).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
      expect(result.platform).toBe("bilibili");
      expect(result.platform_id).toBe("BV1xx411c7mD");
      expect(result.resource_kind).toBe("video");
    });
  });

  describe("Generic Web URL normalization", () => {
    it("lowercases host, strips fragment, and removes tracking params", () => {
      const url = "https://EXAMPLE.COM:443/article?id=42&utm_medium=email#section2";
      const result = normalizeUrlSource(url);
      expect(result.source_identity).toBe("web:https://example.com/article?id=42");
      expect(result.canonical_ref).toBe("https://example.com/article?id=42");
      expect(result.platform).toBe("example.com");
      expect(result.resource_kind).toBe("webpage");
    });

    it("sorts query parameters deterministically", () => {
      const url1 = "https://example.com/search?b=2&a=1";
      const url2 = "https://example.com/search?a=1&b=2";
      expect(normalizeUrlSource(url1).source_identity).toBe(normalizeUrlSource(url2).source_identity);
    });
  });

  describe("File identity computation", () => {
    it("computes SHA-256 and deterministic file source_identity", () => {
      const buf = Buffer.from("CEO Resource Plane Test Content");
      const idInfo = computeFileIdentity(buf);
      expect(idInfo.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(idInfo.source_identity).toBe(`file:${idInfo.source_hash}`);
    });
  });
});
