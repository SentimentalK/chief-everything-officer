import path from "node:path";
import { CeoError } from "../errors.js";
import type { CeoWorkspace } from "../workspace.js";
import type { JobCoordinatorV2, JobSubmitScopeV2 } from "../jobs/v2-service.js";
import { resolveResourceLocationAtSnapshot } from "./locator.js";
import { parseMetaMarkdown } from "./meta.js";
import { getTreeEntry, readBlobUtf8 } from "../git.js";
import type { SourceType } from "./types.js";

export interface ResourceAcquireInput {
  request_id: string;
  resource_id: string;
  target_id: string;
  mode?: "if_missing" | "refresh";
}

export type ResourceAcquireResult =
  | {
      status: "already_satisfied";
      resource_id: string;
      job_id: null;
    }
  | {
      status: "queued";
      resource_id: string;
      job_id: string;
    };

export interface AcquisitionDescriptor {
  resource_id: string;
  source_type: SourceType;
  source_ref: string | null;
  canonical_ref: string | null;
  content_available: boolean;
}

export async function getAcquisitionDescriptor(
  workspace: CeoWorkspace,
  resourceId: string,
): Promise<AcquisitionDescriptor | null> {
  const snapshot = await workspace.captureReadSnapshot();
  const located = await resolveResourceLocationAtSnapshot(
    workspace.config,
    workspace.config.repoDir,
    snapshot,
    resourceId,
  );
  if (!located) return null;

  const metaPath = path.posix.join(located.location.relative_path, "meta.md");
  const metaEntry = await getTreeEntry(
    workspace.config,
    workspace.config.repoDir,
    snapshot.commit,
    metaPath,
  );
  if (!metaEntry || metaEntry.type !== "blob") return null;

  const metaContent = await readBlobUtf8(
    workspace.config,
    workspace.config.repoDir,
    metaEntry.oid,
    metaPath,
  );
  const { meta } = parseMetaMarkdown(metaContent);

  const contentPath = path.posix.join(located.location.relative_path, "content.md");
  const contentEntry = await getTreeEntry(
    workspace.config,
    workspace.config.repoDir,
    snapshot.commit,
    contentPath,
  );

  return {
    resource_id: resourceId,
    source_type: meta.source_type,
    source_ref: meta.source_ref,
    canonical_ref: meta.canonical_ref,
    content_available: contentEntry !== null && contentEntry.type === "blob",
  };
}

export function buildCanonicalAcquisitionTask(url: string): {
  prompt: string;
  acceptance: string;
} {
  return {
    prompt: `CAPABILITY: content.extract_url

Acquire the full textual content for the Resource below.

Source URL:
${url}

Use the installed content.extract_url capability (e.g. ./capabilities/content.extract_url/run --url "${url}" --output-dir <tmpdir>).
Prefer authoritative/native subtitles when available.
Fall back to the capability's default behavior when required.

Do not modify the CEO workspace directly.
Do not call CEO APIs.
Return the extracted content through the managed-result contract.`,
    acceptance: `A valid managed result must contain a non-empty upsert_content operation representing the extracted transcript or content.`,
  };
}

export class ResourceAcquisitionService {
  constructor(
    private readonly workspace: CeoWorkspace,
    private readonly coordinator: JobCoordinatorV2,
  ) {}

  async acquire(
    scope: JobSubmitScopeV2,
    input: ResourceAcquireInput,
  ): Promise<ResourceAcquireResult> {
    const mode = input.mode ?? "if_missing";

    // 1. Idempotency check FIRST:
    // If request_id already corresponds to an existing Job, return that Job ID immediately.
    // This ensures consistent replay even if the Job has completed and content.md now exists.
    const existingJobId = await this.coordinator.getJobIdByRequestId(scope, input.request_id);
    if (existingJobId) {
      return {
        status: "queued",
        resource_id: input.resource_id,
        job_id: existingJobId,
      };
    }

    // 2. Read Resource acquisition descriptor via snapshot read
    const desc = await getAcquisitionDescriptor(this.workspace, input.resource_id);
    if (!desc) {
      throw new CeoError("NOT_FOUND", `Resource '${input.resource_id}' does not exist.`, {
        resource_id: input.resource_id,
      });
    }

    const targetUrl = desc.canonical_ref ?? desc.source_ref;
    if (
      desc.source_type !== "url" ||
      !targetUrl ||
      (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
    ) {
      throw new CeoError(
        "RESOURCE_NOT_ACQUIRABLE",
        `Resource '${input.resource_id}' is not an acquirable URL resource.`,
        {
          resource_id: input.resource_id,
          source_type: desc.source_type,
          source_ref: desc.source_ref,
          canonical_ref: desc.canonical_ref,
        },
      );
    }

    // 3. Satisfied check: mode=if_missing and content already exists
    if (mode === "if_missing" && desc.content_available) {
      return {
        status: "already_satisfied",
        resource_id: input.resource_id,
        job_id: null,
      };
    }

    // 4. Build canonical acquisition task
    const task = buildCanonicalAcquisitionTask(targetUrl);

    // 5. Submit canonical acquisition Job
    const submitRes = await this.coordinator.submit(scope, {
      request_id: input.request_id,
      target_id: input.target_id,
      prompt: task.prompt,
      acceptance: task.acceptance,
      resource_id: input.resource_id,
      execution_timeout_seconds: 3600,
      result_target: "resource",
    });

    return {
      status: "queued",
      resource_id: input.resource_id,
      job_id: submitRes.job.job_id,
    };
  }
}
