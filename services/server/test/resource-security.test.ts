import { describe, expect, it } from "vitest";
import {
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

  describe("Canonical source path validation", () => {
    it("validates allowed source paths across readable and legacy UUID directory names", () => {
      const legacyPath = "resources/res-01234567-89ab-cdef-0123-456789abcdef/source/original.pdf";
      const readablePath = "resources/CUDA生态与NVIDIA软件护城河/source/original.pdf";
      expect(isAllowedResourceSourcePath(legacyPath)).toBe(true);
      expect(isAllowedResourceSourcePath(readablePath)).toBe(true);
    });

    it("rejects non-canonical, media, unsafe, or non-resource paths", () => {
      expect(
        isAllowedResourceSourcePath(
          "resources/res-01234567-89ab-cdef-0123-456789abcdef/source/original.mp4",
        ),
      ).toBe(false);
      expect(
        isAllowedResourceSourcePath(
          "resources/CUDA/arbitrary.pdf",
        ),
      ).toBe(false);
      expect(
        isAllowedResourceSourcePath(
          "resources/../source/original.pdf",
        ),
      ).toBe(false);
      expect(
        isAllowedResourceSourcePath(
          "resources/.hidden/source/original.pdf",
        ),
      ).toBe(false);
      expect(isAllowedResourceSourcePath("personal/test.pdf")).toBe(false);
    });
  });
});
