export type BootstrapLocale = "en" | "zh";

export interface ResolveBootstrapLocaleInput {
  explicitLocale?: string | null;
  acceptLanguage?: string | null;
}

/**
 * Resolves the ephemeral bootstrap display language.
 *
 * Algorithm:
 * 1. If an explicit supported onboarding locale exists:
 *      zh* -> zh
 *      en* -> en
 * 2. Else inspect Accept-Language sorted by quality factor (q):
 *      first supported zh* candidate -> zh
 *      first supported en* candidate -> en
 * 3. Fallback: en
 */
export function resolveBootstrapLocale(
  input?: ResolveBootstrapLocaleInput | string | null,
): BootstrapLocale {
  let explicitLocale: string | null = null;
  let acceptLanguage: string | null = null;

  if (typeof input === "string") {
    explicitLocale = input;
  } else if (input && typeof input === "object") {
    explicitLocale = input.explicitLocale ?? null;
    acceptLanguage = input.acceptLanguage ?? null;
  }

  // 1. Explicit onboarding locale
  if (explicitLocale) {
    const trimmed = explicitLocale.trim().toLowerCase();
    if (trimmed.startsWith("zh")) {
      return "zh";
    }
    if (trimmed.startsWith("en")) {
      return "en";
    }
  }

  // 2. Inspect Accept-Language header
  if (acceptLanguage && typeof acceptLanguage === "string") {
    const candidates = parseAcceptLanguage(acceptLanguage);
    for (const tag of candidates) {
      if (tag.startsWith("zh")) {
        return "zh";
      }
      if (tag.startsWith("en")) {
        return "en";
      }
    }
  }

  // 3. Fallback
  return "en";
}

function parseAcceptLanguage(header: string): string[] {
  const entries: Array<{ tag: string; q: number }> = [];

  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawTag, rawQ] = trimmed.split(";");
    const tag = rawTag?.trim().toLowerCase();
    if (!tag) continue;

    let q = 1.0;
    if (rawQ) {
      const match = rawQ.match(/q=\s*([0-9.]+)/i);
      if (match && match[1]) {
        const parsedQ = parseFloat(match[1]);
        if (!isNaN(parsedQ)) {
          q = parsedQ;
        }
      }
    }
    entries.push({ tag, q });
  }

  // Stable sort descending by quality weight
  entries.sort((a, b) => b.q - a.q);
  return entries.map((e) => e.tag);
}
