import path from "node:path";
import { CeoError } from "../errors.js";
import type { CeoWorkspace } from "../workspace.js";
import type { JobCoordinatorV2, JobSubmitScopeV2, SubmitJobInputV2 } from "../jobs/v2-service.js";
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

export function buildCanonicalAcquisitionTask(url: string, resourceId: string): {
  prompt: string;
  acceptance: string;
} {
  return {
    prompt: `TASK

Extract the spoken/textual content from this URL and return it to the attached CEO Resource through the managed-result contract.

SOURCE
URL: ${url}
Resource ID: ${resourceId}

EXECUTION ENVIRONMENT

Your working repository is:
{{WORKING_DIRECTORY}}

This repository contains capabilities specifically provided for autonomous Agent jobs.

1. Stay inside this repository for task execution.
2. Read the repository's AGENT.md / agent instructions first.
3. Use the repository-provided URL extraction capability: content.extract_url.
4. Prefer the repository capability over writing your own scraper, browsing unrelated repositories, or inspecting CEO/Connector implementation code.
5. Do NOT search outside this repository, the CEO repository, Connector state, or Resource Git to discover the source URL. The required URL is provided above.
6. If the declared capability is missing, broken, or its documented contract contradicts this task, STOP and report the concrete failure. Do not invent an alternative architecture.

Expected execution is equivalent to:
./capabilities/content.extract_url/run --url "${url}" --output-dir <temporary-output-dir>

Follow the capability's actual AGENT_GUIDE/contract if its exact CLI syntax differs.

OUTPUT REQUIREMENTS

On successful extraction:
- upsert_content: faithful transcript/extracted source content.
- upsert_summary: concise summary based on the extracted source content, with basis: "source_content".
- upsert_evidence: briefly record the extraction method, caption/transcription source, and material limitations.

Do not fabricate missing speech, captions, or metadata.
Do NOT modify CEO resources/** directly.
Do NOT call CEO Server APIs.
Do NOT commit anything to the CEO workspace.

Write the final structured result only to the managed-result path below.`,
    acceptance: `1. The attached Resource must be updated with transcript/subtitle-derived content via upsert_content when extraction succeeds.
2. A concise summary must be provided via upsert_summary based on the actual source content, not metadata alone.
3. Evidence must be provided via upsert_evidence stating the extraction method and limitations.
4. No fabricated transcript or captions.
5. If extraction fails, do not write a fake result; report the concrete failure.`,
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

    // 1. Read Resource acquisition descriptor via snapshot read
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

    // 2. Build canonical acquisition task + SubmitJobInput
    const task = buildCanonicalAcquisitionTask(targetUrl, input.resource_id);
    const submitInput: SubmitJobInputV2 = {
      request_id: input.request_id,
      target_id: input.target_id,
      prompt: task.prompt,
      acceptance: task.acceptance,
      resource_id: input.resource_id,
      execution_timeout_seconds: 3600,
      result_target: "resource",
    };

    // 3. Coordinator existing submission check FIRST (with business digest verification):
    // If request_id matches an existing submission:
    // - identical business request => returns existing Job (even if completed & content exists)
    // - different business request (different Resource, Target, etc.) => throws IDEMPOTENCY_CONFLICT
    const existingJob = await this.coordinator.checkExistingSubmission(scope, submitInput);
    if (existingJob) {
      return {
        status: "queued",
        resource_id: input.resource_id,
        job_id: existingJob.job_id,
      };
    }

    // 4. Satisfied check: mode=if_missing and content already exists
    if (mode === "if_missing" && desc.content_available) {
      return {
        status: "already_satisfied",
        resource_id: input.resource_id,
        job_id: null,
      };
    }

    // 5. Submit canonical acquisition Job
    const submitRes = await this.coordinator.submit(scope, submitInput);

    return {
      status: "queued",
      resource_id: input.resource_id,
      job_id: submitRes.job.job_id,
    };
  }
}
