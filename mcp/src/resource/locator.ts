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
 * Finds an existing Resource by its deterministic source_identity or source_aliases.
 * Returns the LocatedResource including physical location for revisit flows.
 * Throws DUPLICATE_RESOURCE if multiple distinct resources match.
 */
export async function findResourceByIdentity(
  root: string,
  sourceIdentity: string,
): Promise<LocatedResource | null> {
  const all = await enumerateResources(root);
  const matches = all.filter(
    (r) =>
      r.meta.source_identity === sourceIdentity ||
      (r.meta.source_aliases && r.meta.source_aliases.includes(sourceIdentity)),
  );
  const uniqueIds = new Set(matches.map((m) => m.meta.resource_id));
  if (uniqueIds.size > 1) {
    throw new CeoError(
      "DUPLICATE_RESOURCE",
      `Identity conflict: multiple distinct resources match identity '${sourceIdentity}': ${Array.from(uniqueIds).join(", ")}.`,
      { matched_resource_ids: Array.from(uniqueIds) },
    );
  }
  return matches[0] ?? null;
}

export interface ResourceLookupCriteria {
  preferredIdentity?: string | null;
  baselineIdentity?: string | null;
  normalizedUrl?: string | null;
}

/**
 * Finds an existing Resource by preferred identity, baseline identity, source aliases,
 * or normalized URL references. Symmetrically finds existing resources across success/fail directions.
 * Throws DUPLICATE_RESOURCE fail-closed if matches point to multiple distinct resource_ids.
 */
export async function findResourceByUrlOrIdentities(
  root: string,
  criteria: ResourceLookupCriteria,
): Promise<LocatedResource | null> {
  const all = await enumerateResources(root);
  const matches: LocatedResource[] = [];

  for (const r of all) {
    let matched = false;

    if (
      criteria.preferredIdentity &&
      (r.meta.source_identity === criteria.preferredIdentity ||
        (r.meta.source_aliases && r.meta.source_aliases.includes(criteria.preferredIdentity)))
    ) {
      matched = true;
    }

    if (
      !matched &&
      criteria.baselineIdentity &&
      (r.meta.source_identity === criteria.baselineIdentity ||
        (r.meta.source_aliases && r.meta.source_aliases.includes(criteria.baselineIdentity)))
    ) {
      matched = true;
    }

    if (!matched && criteria.normalizedUrl && r.meta.source_type === "url") {
      if (r.meta.canonical_ref && r.meta.canonical_ref.trim() === criteria.normalizedUrl) {
        matched = true;
      } else if (r.meta.source_ref && r.meta.source_ref.trim() === criteria.normalizedUrl) {
        matched = true;
      }
    }

    if (matched) {
      matches.push(r);
    }
  }

  const uniqueIds = new Set(matches.map((m) => m.meta.resource_id));
  if (uniqueIds.size > 1) {
    throw new CeoError(
      "DUPLICATE_RESOURCE",
      `Identity conflict: multiple distinct resources match lookup criteria: ${Array.from(uniqueIds).join(", ")}.`,
      { matched_resource_ids: Array.from(uniqueIds) },
    );
  }

  return matches[0] ?? null;
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
