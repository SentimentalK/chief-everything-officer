import { describe, expect, it } from "vitest";
import {
  getCanonicalSourcePath,
  isAllowedResourceSourcePath,
  validateSourceAsset,
} from "../src/resource/security.js";
import { CeoError } from "../src/errors.js";

describe("Resource Security & Source Asset Validation", () => {
  it("accepts valid PDF document bytes with correct MIME", () => {
    const data = Buffer.from("%PDF-1.4 test document");
    const result = validateSourceAsset("sample.pdf", "application/pdf", data);
    expect(result.ext).toBe(".pdf");
    expect(result.format).toBe("pdf");
    expect(result.media_type).toBe("application/pdf");
  });

  it("accepts valid docx document with correct MIME", () => {
    const data = Buffer.from("PK test docx");
    const result = validateSourceAsset(
      "proposal.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data,
    );
    expect(result.ext).toBe(".docx");
    expect(result.format).toBe("docx");
  });

  it("rejects media extensions (.mp4, .mp3, .mov)", () => {
    const data = Buffer.from("video bytes");
    expect(() => validateSourceAsset("video.mp4", "video/mp4", data)).toThrowError(
      CeoError,
    );
    expect(() => validateSourceAsset("audio.mp3", "audio/mpeg", data)).toThrowError(
      CeoError,
    );
  });

  it("rejects media MIME types even if extension looks allowed", () => {
    const data = Buffer.from("trick payload");
    expect(() => validateSourceAsset("test.pdf", "video/mp4", data)).toThrowError(
      CeoError,
    );
  });

  it("rejects MIME mismatch", () => {
    const data = Buffer.from("some text");
    expect(() => validateSourceAsset("data.csv", "application/pdf", data)).toThrowError(
      CeoError,
    );
  });

  it("rejects empty data", () => {
    expect(() => validateSourceAsset("empty.pdf", "application/pdf", Buffer.alloc(0))).toThrowError(
      CeoError,
    );
  });

  it("rejects oversized data (>25 MiB)", () => {
    const bigData = Buffer.alloc(26 * 1024 * 1024);
    expect(() => validateSourceAsset("big.pdf", "application/pdf", bigData)).toThrowError(
      CeoError,
    );
  });

  describe("Canonical path validation", () => {
    it("builds canonical source path", () => {
      const resId = "res-01234567-89ab-cdef-0123-456789abcdef";
      const canonical = getCanonicalSourcePath(resId, ".pdf");
      expect(canonical).toBe(`resources/${resId}/source/original.pdf`);
      expect(isAllowedResourceSourcePath(canonical)).toBe(true);
    });

    it("rejects non-canonical or media source paths", () => {
      expect(
        isAllowedResourceSourcePath(
          "resources/res-01234567-89ab-cdef-0123-456789abcdef/source/original.mp4",
        ),
      ).toBe(false);
      expect(
        isAllowedResourceSourcePath(
          "resources/res-01234567-89ab-cdef-0123-456789abcdef/arbitrary.pdf",
        ),
      ).toBe(false);
      expect(isAllowedResourceSourcePath("personal/test.pdf")).toBe(false);
    });
  });
});
