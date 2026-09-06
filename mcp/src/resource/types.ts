import type { ChangeOperation } from "../workspace.js";

export type ResourceId = `res-${string}`;

export type ResourceKind =
  | "document"
  | "video"
  | "audio"
  | "image"
  | "webpage"
  | "dataset"
  | "code"
  | "message"
  | "other";

export type SourceType = "url" | "file" | "external_ref";

export type ResourceStage =
  | "CAPTURED"
  | "EXTRACTED"
  | "NORMALIZED"
  | "READY_FOR_DISCUSSION"
  | "DISCUSSED";

export type Provenance =
  | "host_exact"
  | "host_semantic"
  | "trusted_adapter"
  | "worker";

export type NamingSource = "explicit" | "id";

export type MetadataAttemptStatus =
  | "resolved"
  | "unavailable"
  | "unsupported"
  | "disabled";

export interface MetadataAttemptRecord {
  attempted_at: string;
  status: MetadataAttemptStatus;
  code: string | null;
  fields_resolved: string[];
  strategy: string | null;
  http_status: number | null;
  request_id: string | null;
}

export interface ResourceMeta {
  schema_version: 1;
  resource_id: string;
  display_name: string;
  naming_source: NamingSource;
  source_aliases: string[];
  last_metadata_attempt: MetadataAttemptRecord | null;
  resource_kind: ResourceKind;
  source_type: SourceType;
  source_identity: string | null;
  source_ref: string | null;
  canonical_ref: string | null;
  platform: string | null;
  platform_id: string | null;
  original_name: string | null;
  media_type: string | null;
  format: string | null;
  asset_ref: string | null;
  source_hash: string | null;
  title: string | null;
  author: string | null;
  published_at: string | null;
  first_captured_at: string;
  language: string | null;
  topics: string[];
  metadata_method: "deterministic_adapter" | "user_provided" | "mixed" | null;
  metadata_fetched_at: string | null;
  capture_surface: string;
}

export type ResourceSourceInput =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "file_descriptor";
      filename: string;
      mime_type?: string | null;
      host_ref?: string | null;
    }
  | {
      type: "file_inline";
      filename: string;
      mime_type: string;
      data_base64: string;
    }
  | {
      type: "external_ref";
      provider: string;
      ref: string;
      canonical_ref?: string | null;
    };

export type ResourceApplyOperation =
  | {
      op: "attach_source_asset";
      filename: string;
      mime_type: string;
      data_base64: string;
    }
  | {
      op: "upsert_evidence";
      provenance: Exclude<Provenance, "host_semantic">;
      content: string;
    }
  | {
      op: "upsert_content";
      provenance: Exclude<Provenance, "host_semantic">;
      content: string;
    }
  | {
      op: "upsert_summary";
      provenance: Provenance;
      content: string;
    }
  | {
      op: "append_interaction";
      provenance: Provenance;
      entry: string;
    }
  | {
      op: "patch_topics";
      add?: string[];
      remove?: string[];
      set?: string[];
    }
  | {
      op: "rename";
      display_name: string;
    };

export type ResourceCaptureInitialOperation = Exclude<ResourceApplyOperation, { op: "rename" }>;

export interface ResourceCaptureInput {
  request_id?: string;
  source: ResourceSourceInput;
  note?: string;
  topics?: string[];
  initial_operations?: ResourceCaptureInitialOperation[];
  state_changes?: ChangeOperation[];
  summary?: string;
}

export interface ResourceApplyInput {
  request_id?: string;
  resource_id: string;
  base_commit: string;
  summary: string;
  operations: ResourceApplyOperation[];
  state_changes?: ChangeOperation[];
}

export interface ResourceSearchInput {
  query?: string;
  topics?: string[];
  resource_kind?: ResourceKind;
  source_type?: SourceType;
  platform?: string;
  captured_from?: string;
  captured_to?: string;
  stage?: ResourceStage;
  sort?: "newest" | "oldest";
  limit?: number;
}

export interface ResourceCard {
  resource_id: string;
  display_name: string;
  naming_source: NamingSource;
  relative_path: string;
  title: string | null;
  stage: ResourceStage;
  resource_kind: ResourceKind;
  source_type: SourceType;
  source_identity: string | null;
  canonical_ref: string | null;
  platform: string | null;
  topics: string[];
  first_captured_at: string;
  source_asset_available: boolean;
  capture_note?: string | null;
  original_name?: string | null;
}

export type ResourceGetView =
  | "metadata"
  | "summary"
  | "content"
  | "evidence"
  | "interactions"
  | "source";

export interface ResourceGetInput {
  resource_id: string;
  view?: ResourceGetView;
  section_ids?: string[];
  start_line?: number;
  line_count?: number;
}
