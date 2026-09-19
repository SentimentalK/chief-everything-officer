import { describe, it, expect } from "vitest";
import { resolveBootstrapLocale } from "../src/bootstrap/locale.js";

describe("resolveBootstrapLocale", () => {
  it("defaults to 'en' when header is missing or empty", () => {
    expect(resolveBootstrapLocale({})).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "   " })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: undefined })).toBe("en");
  });

  it("resolves exact and regional Chinese tags to 'zh'", () => {
    expect(resolveBootstrapLocale({ acceptLanguage: "zh" })).toBe("zh");
    expect(resolveBootstrapLocale({ acceptLanguage: "zh-CN" })).toBe("zh");
    expect(resolveBootstrapLocale({ acceptLanguage: "zh-TW" })).toBe("zh");
    expect(resolveBootstrapLocale({ acceptLanguage: "zh-HK" })).toBe("zh");
    expect(resolveBootstrapLocale({ acceptLanguage: "zh-Hans" })).toBe("zh");
    expect(resolveBootstrapLocale({ acceptLanguage: "ZH-CN" })).toBe("zh");
  });

  it("resolves English tags to 'en'", () => {
    expect(resolveBootstrapLocale({ acceptLanguage: "en" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "en-US" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "en-GB" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "en-CA" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "EN" })).toBe("en");
  });

  it("falls back to 'en' for unsupported languages", () => {
    expect(resolveBootstrapLocale({ acceptLanguage: "fr-FR" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "ja-JP" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "de" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "es-ES" })).toBe("en");
  });

  it("honors quality weights when selecting best supported locale", () => {
    // Unsupported high weight, supported lower weight
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "fr-CA;q=1,zh-CN;q=0.9,en;q=0.8",
      }),
    ).toBe("zh");

    // en higher than zh
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "zh;q=0.5,en;q=0.8",
      }),
    ).toBe("en");

    // zh higher than en
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "en;q=0.5,zh;q=0.9",
      }),
    ).toBe("zh");

    // Implicit q=1.0 on zh, explicit q=0.9 on en
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "zh,en;q=0.9",
      }),
    ).toBe("zh");

    // Implicit q=1.0 on en, explicit q=0.9 on zh
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "en,zh;q=0.9",
      }),
    ).toBe("en");

    // Explicit q=0 means unacceptable per RFC 9110
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "fr;q=1,zh;q=0",
      }),
    ).toBe("en");
    expect(
      resolveBootstrapLocale({
        acceptLanguage: "zh;q=0,en;q=0.1",
      }),
    ).toBe("en");
  });

  it("handles malformed and edge-case header formats gracefully", () => {
    expect(resolveBootstrapLocale({ acceptLanguage: ";;;" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: ", , ," })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "*;q=0.5" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "invalid-tag;q=invalid" })).toBe("en");
    expect(resolveBootstrapLocale({ acceptLanguage: "zh;q=invalid,en;q=0.1" })).toBe("zh");
  });
});
