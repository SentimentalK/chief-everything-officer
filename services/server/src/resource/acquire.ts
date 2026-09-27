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
    prompt: `提取下面 URL 的完整来源内容。

来源：
URL: ${url}
Resource ID: ${resourceId}

执行要求：
1. 使用当前目标工作区提供的 content.extract_url capability。
2. 按 capability 自身说明执行，不要自行重新实现抓取、字幕下载或 ASR。
3. 成功后读取 capability 生成的 result.json。
4. 将真实 transcript/content 写入 upsert_content。
5. result.json 中存在可靠来源 metadata 时，通过 merge_source_metadata 返回（可包含 title、author、published_at、language）。
6. 不要根据自己的推断补全缺失 metadata。
7. 不要修改 display_name、topics、note、interactions 或其他用户语义信息。
8. 不要直接修改 CEO Git 仓库中的 resources/**，不要直接调用 CEO Server API。`,
    acceptance: `1. transcript/content 成功时必须有非空 upsert_content。
2. metadata 只能来自 capability 的实际 result.json。
3. 不伪造缺失内容或 metadata。
4. extraction 失败时允许无 managed result，以明确 FAILED/BLOCKED report 结束。`,
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
