import yaml from "yaml";
import { CeoError } from "../errors.js";
import type { Provenance, SummaryBasis } from "./types.js";
import { PROVENANCE_VALUES, SUMMARY_BASIS_VALUES } from "./types.js";

export interface ParsedSummary {
  provenance: Provenance;
  basis: SummaryBasis;
  content: string;
  raw: string;
}

export function formatSummaryDocument(
  provenance: unknown,
  basis: unknown,
  content: unknown,
): string {
  if (typeof provenance !== "string" || !PROVENANCE_VALUES.includes(provenance as Provenance)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Invalid summary provenance: '${provenance}'. Must be one of: ${PROVENANCE_VALUES.join(", ")}`,
      { provenance },
    );
  }

  if (typeof basis !== "string" || !SUMMARY_BASIS_VALUES.includes(basis as SummaryBasis)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Invalid or missing summary basis: '${basis}'. Must be one of: ${SUMMARY_BASIS_VALUES.join(", ")}`,
      { basis },
    );
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    throw new CeoError("VALIDATION_FAILED", "Summary content cannot be empty.");
  }

  const frontmatterStr = yaml.stringify({
    provenance,
    basis,
  });

  return `---\n${frontmatterStr}---\n\n${content.trim()}\n`;
}

export function parseSummaryDocument(rawText: string, filePath?: string): ParsedSummary {
  const fileContext = filePath ? ` in ${filePath}` : "";

  if (typeof rawText !== "string") {
    throw new CeoError("VALIDATION_FAILED", `Summary content must be a string${fileContext}.`);
  }

  const match = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || match[1] == null || match[2] == null) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Summary document${fileContext} is missing required YAML frontmatter with provenance and basis.`,
      { filePath },
    );
  }

  const frontmatterText = match[1];
  const bodyText = match[2];

  let data: Record<string, unknown>;
  try {
    data = yaml.parse(frontmatterText) ?? {};
  } catch (err) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Failed to parse YAML frontmatter${fileContext}: ${err instanceof Error ? err.message : String(err)}`,
      { filePath },
    );
  }

  if (!data || typeof data !== "object") {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Invalid frontmatter structure${fileContext}: expected key-value mapping.`,
      { filePath },
    );
  }

  const provenance = data.provenance;
  if (typeof provenance !== "string" || !PROVENANCE_VALUES.includes(provenance as Provenance)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Invalid or missing summary provenance: '${provenance}'${fileContext}. Must be one of: ${PROVENANCE_VALUES.join(", ")}`,
      { filePath, provenance },
    );
  }

  const basis = data.basis;
  if (typeof basis !== "string" || !SUMMARY_BASIS_VALUES.includes(basis as SummaryBasis)) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Invalid or missing summary basis: '${basis}'${fileContext}. Must be one of: ${SUMMARY_BASIS_VALUES.join(", ")}`,
      { filePath, basis },
    );
  }

  const body = bodyText.trim();
  if (body.length === 0) {
    throw new CeoError(
      "VALIDATION_FAILED",
      `Summary body content cannot be empty${fileContext}.`,
      { filePath },
    );
  }

  return {
    provenance: provenance as Provenance,
    basis: basis as SummaryBasis,
    content: body,
    raw: rawText,
  };
}
