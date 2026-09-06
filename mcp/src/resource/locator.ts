import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { parseMetaMarkdown, type ParsedMetaDocument } from "./meta.js";
import type { ResourceMeta } from "./types.js";
import { CeoError } from "../errors.js";

export interface ResourceLocation {
  resource_id: string;
  directory_name: string;
  relative_path: string; // e.g. "resources/CUDA生态与NVIDIA软件护城河"
}

export interface LocatedResource {
  location: ResourceLocation;
  meta: ResourceMeta;
  doc: ParsedMetaDocument;
}

/**
 * On-demand scanner for all Resource directories under root/resources.
 * Guarantees duplicate canonical ID detection: if two directories contain
 * the same meta.resource_id, throws CeoError("CORRUPTION").
 */
export async function enumerateResources(root: string): Promise<LocatedResource[]> {
  const resourcesRoot = path.join(root, "resources");
  const entries = await readdir(resourcesRoot, { withFileTypes: true }).catch(() => []);

  const results: LocatedResource[] = [];
  const seenIds = new Map<string, string>(); // resource_id -> directory_name

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const metaPath = path.join(resourcesRoot, entry.name, "meta.md");
    const metaContent = await readFile(metaPath, "utf8").catch(() => null);
    if (!metaContent) continue;

    let doc: ParsedMetaDocument;
    try {
      doc = parseMetaMarkdown(metaContent);
    } catch {
      continue;
    }

    const resId = doc.meta.resource_id;
    if (!resId) continue;

    // Detect duplicate canonical IDs across distinct directories
    const existingDir = seenIds.get(resId);
    if (existingDir && existingDir !== entry.name) {
      throw new CeoError(
        "CORRUPTION",
        `Multiple Resource directories share the same canonical resource_id '${resId}': '${existingDir}' and '${entry.name}'.`,
        {
          resource_id: resId,
          first_directory: existingDir,
          second_directory: entry.name,
        },
      );
    }

    seenIds.set(resId, entry.name);

    results.push({
      location: {
        resource_id: resId,
        directory_name: entry.name,
        relative_path: path.posix.join("resources", entry.name),
      },
      meta: doc.meta,
      doc,
    });
  }

  return results;
}

/**
 * Resolves a canonical resource_id to its physical ResourceLocation.
 * Validates metadata and checks for duplicate canonical IDs across the workspace.
 */
export async function resolveResourceLocation(
  root: string,
  resourceId: string,
): Promise<ResourceLocation | null> {
  const all = await enumerateResources(root);
  const found = all.find((r) => r.location.resource_id === resourceId);
  return found ? found.location : null;
}

/**
 * Finds an existing Resource by its deterministic source_identity.
 * Returns the LocatedResource including physical location for revisit flows.
 */
export async function findResourceByIdentity(
  root: string,
  sourceIdentity: string,
): Promise<LocatedResource | null> {
  const all = await enumerateResources(root);
  return all.find((r) => r.meta.source_identity === sourceIdentity) ?? null;
}

/**
 * Finds an existing Resource by source_hash (excluding a given resource_id).
 */
export async function findResourceByHash(
  root: string,
  hash: string,
  excludeResourceId?: string,
): Promise<LocatedResource | null> {
  const all = await enumerateResources(root);
  return (
    all.find(
      (r) =>
        r.meta.source_hash === hash &&
        (!excludeResourceId || r.location.resource_id !== excludeResourceId),
    ) ?? null
  );
}
