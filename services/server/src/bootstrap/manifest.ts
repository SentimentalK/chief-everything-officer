import type { BootstrapLocale } from "./locale.js";
import { renderBootstrapReadme } from "./templates.js";

export interface BootstrapFile {
  path: string;
  content: string;
}

export function buildFreshWorkspaceManifest(locale: BootstrapLocale = "en"): BootstrapFile[] {
  return [
    {
      path: "README.md",
      content: renderBootstrapReadme(locale),
    },
    {
      path: ".ceoignore",
      content: "README.md\n",
    },
  ];
}
