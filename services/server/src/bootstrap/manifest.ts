import type { BootstrapLocale } from "./locale.js";
import { renderBootstrapReadme } from "./templates.js";

export interface BootstrapFile {
  path: string;
  content: string;
}

export const DEFAULT_CEOIGNORE_CONTENT =
  "# Paths listed below are ignored by CEO when reading or searching this workspace.\n" +
  "# Add one relative file path per line, or a directory ending in /.\n";

export function buildFreshWorkspaceManifest(locale: BootstrapLocale = "en"): BootstrapFile[] {
  return [
    {
      path: "README.md",
      content: renderBootstrapReadme(locale),
    },
    {
      path: ".ceoignore",
      content: DEFAULT_CEOIGNORE_CONTENT,
    },
  ];
}

