use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use thiserror::Error;
use url::Url;

const MAX_ARTIFACT_BYTES: u64 = 10 * 1024 * 1024; // 10 MB limit

#[derive(Error, Debug)]
pub enum VerificationError {
    #[error("Completion file missing or unreadable: {0}")]
    CompletionReadError(String),
    #[error("Completion JSON invalid: {0}")]
    CompletionParseError(String),
    #[error("Job ID or Attempt ID mismatch. Expected: ({expected_job}, {expected_attempt}), Found: ({found_job}, {found_attempt})")]
    ProvenanceMismatch {
        expected_job: String,
        expected_attempt: String,
        found_job: String,
        found_attempt: String,
    },
    #[error("Artifact path escapes attempt directory: {0}")]
    PathEscape(String),
    #[error("Artifact missing or unreadable: {0}")]
    ArtifactReadError(String),
    #[error("Artifact size ({size} bytes) exceeds 10MB limit")]
    ArtifactTooLarge { size: u64 },
    #[error("Artifact SHA256 mismatch. Expected {expected}, got {computed}")]
    Sha256Mismatch { expected: String, computed: String },
    #[error("Artifact schema validation failed: {0}")]
    SchemaValidationFailed(String),
    #[error("URL identity mismatch: requested '{requested_url}', but extracted '{extracted_id}' on platform '{platform}'")]
    UrlIdentityMismatch {
        requested_url: String,
        platform: String,
        extracted_id: String,
    },
    #[error("Unsupported platform domain for URL: {0}")]
    UnsupportedDomain(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionArtifact {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionError {
    pub stage: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionReport {
    pub job_id: String,
    pub attempt_id: String,
    pub requested_url: String,
    pub script_exit_code: i32,
    pub artifact: Option<CompletionArtifact>,
    pub business_status: Option<String>,
    pub error: Option<CompletionError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedMetadata {
    pub source_type: String,
    pub source_url: String,
    pub canonical_url: Option<String>,
    pub source_id: Option<String>,
    pub title: Option<String>,
    pub creator: Option<String>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawResolvedContent {
    pub metadata: ExtractedMetadata,
    pub transcript: Option<String>,
    pub transcript_status: String,
    pub transcript_method: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BusinessOutcome {
    TranscriptAvailable,
    TranscriptUnavailable,
    TranscriptFailed,
    ExtractionFailed,
    VerificationFailed,
    Interrupted,
    NotStarted,
}

impl BusinessOutcome {
    pub fn description(&self) -> &'static str {
        match self {
            BusinessOutcome::TranscriptAvailable => "已取得字幕",
            BusinessOutcome::TranscriptUnavailable => "未取得字幕",
            BusinessOutcome::TranscriptFailed => "字幕获取失败",
            BusinessOutcome::ExtractionFailed => "提取执行失败",
            BusinessOutcome::VerificationFailed => "产物校验失败",
            BusinessOutcome::Interrupted => "任务中断或未完成",
            BusinessOutcome::NotStarted => "任务未开始",
        }
    }
}

pub struct Verifier;

impl Verifier {
    pub fn verify_completion(
        attempt_dir: &Path,
        expected_job_id: &str,
        expected_attempt_id: &str,
        expected_url: &str,
        output_schema: &serde_json::Value,
    ) -> Result<
        (
            CompletionReport,
            Option<RawResolvedContent>,
            BusinessOutcome,
        ),
        VerificationError,
    > {
        let completion_path = attempt_dir.join("completion.json");
        if !completion_path.exists() {
            return Err(VerificationError::CompletionReadError(
                "completion.json not found".to_string(),
            ));
        }

        let completion_str = fs::read_to_string(&completion_path)
            .map_err(|e| VerificationError::CompletionReadError(e.to_string()))?;
        let completion: CompletionReport = serde_json::from_str(&completion_str)
            .map_err(|e| VerificationError::CompletionParseError(e.to_string()))?;

        // 1. Provenance check
        if completion.job_id != expected_job_id || completion.attempt_id != expected_attempt_id {
            return Err(VerificationError::ProvenanceMismatch {
                expected_job: expected_job_id.to_string(),
                expected_attempt: expected_attempt_id.to_string(),
                found_job: completion.job_id,
                found_attempt: completion.attempt_id,
            });
        }

        // 2. If script failed with non-zero exit code
        if completion.script_exit_code != 0 || completion.artifact.is_none() {
            return Ok((completion, None, BusinessOutcome::ExtractionFailed));
        }

        let artifact_meta = completion.artifact.as_ref().unwrap();

        // 3. Path safety and size limit
        let artifact_path = attempt_dir.join(&artifact_meta.file_name);
        if !artifact_path.exists() {
            return Err(VerificationError::ArtifactReadError(
                "Artifact file does not exist".to_string(),
            ));
        }

        let canonical_attempt = attempt_dir.canonicalize().map_err(|e| {
            VerificationError::ArtifactReadError(format!("Cannot canonicalize attempt dir: {}", e))
        })?;
        let canonical_artifact = artifact_path.canonicalize().map_err(|e| {
            VerificationError::ArtifactReadError(format!("Cannot canonicalize artifact: {}", e))
        })?;

        if !canonical_artifact.starts_with(&canonical_attempt) {
            return Err(VerificationError::PathEscape(format!(
                "Artifact path {:?} escapes attempt dir {:?}",
                canonical_artifact, canonical_attempt
            )));
        }

        let metadata = fs::metadata(&canonical_artifact).map_err(|e| {
            VerificationError::ArtifactReadError(format!("Failed to stat artifact: {}", e))
        })?;
        if metadata.len() > MAX_ARTIFACT_BYTES {
            return Err(VerificationError::ArtifactTooLarge {
                size: metadata.len(),
            });
        }

        // 4. SHA-256 Hash check
        let mut file = File::open(&canonical_artifact).map_err(|e| {
            VerificationError::ArtifactReadError(format!("Failed to open artifact: {}", e))
        })?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];
        loop {
            let n = file.read(&mut buffer).map_err(|e| {
                VerificationError::ArtifactReadError(format!("Failed to read artifact: {}", e))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        let computed_sha256 = format!("{:x}", hasher.finalize());

        if computed_sha256 != artifact_meta.sha256 {
            return Err(VerificationError::Sha256Mismatch {
                expected: artifact_meta.sha256.clone(),
                computed: computed_sha256,
            });
        }

        // 5. JSON Schema validation
        let raw_content_str = fs::read_to_string(&canonical_artifact).map_err(|e| {
            VerificationError::ArtifactReadError(format!("Failed to read artifact content: {}", e))
        })?;
        let content_json: serde_json::Value = serde_json::from_str(&raw_content_str)
            .map_err(|e| VerificationError::SchemaValidationFailed(e.to_string()))?;

        let validator = jsonschema::validator_for(output_schema).map_err(|e| {
            VerificationError::SchemaValidationFailed(format!("Invalid output schema: {}", e))
        })?;

        if let Err(error) = validator.validate(&content_json) {
            return Err(VerificationError::SchemaValidationFailed(error.to_string()));
        }

        let parsed: RawResolvedContent = serde_json::from_value(content_json)
            .map_err(|e| VerificationError::SchemaValidationFailed(e.to_string()))?;

        // 6. Platform-aware domain-first URL identity check
        Self::verify_url_identity(expected_url, &parsed.metadata)?;

        // 7. Business outcome classification
        let outcome = match parsed.transcript_status.as_str() {
            "available" => {
                if let Some(ref text) = parsed.transcript {
                    if !text.trim().is_empty() {
                        BusinessOutcome::TranscriptAvailable
                    } else {
                        BusinessOutcome::TranscriptUnavailable
                    }
                } else {
                    BusinessOutcome::TranscriptUnavailable
                }
            }
            "unavailable" => BusinessOutcome::TranscriptUnavailable,
            "failed" => BusinessOutcome::TranscriptFailed,
            _ => BusinessOutcome::ExtractionFailed,
        };

        Ok((completion, Some(parsed), outcome))
    }

    pub fn verify_url_identity(
        requested_url: &str,
        extracted_meta: &ExtractedMetadata,
    ) -> Result<(), VerificationError> {
        let parsed_url = Url::parse(requested_url)
            .map_err(|_| VerificationError::UnsupportedDomain(requested_url.to_string()))?;
        let host = parsed_url.host_str().unwrap_or("").to_lowercase();

        // 1. Bilibili (bilibili.com, www.bilibili.com)
        if host == "bilibili.com" || host.ends_with(".bilibili.com") {
            let path = parsed_url.path();
            let re_bv = Regex::new(r"(BV[a-zA-Z0-9]{10}|av[0-9]+)").unwrap();
            if let Some(caps) = re_bv.captures(path) {
                let req_id = caps.get(1).unwrap().as_str();
                let matches_source_id = extracted_meta.source_id.as_deref() == Some(req_id);
                let matches_canonical = extracted_meta
                    .canonical_url
                    .as_deref()
                    .map(|c| c.contains(req_id))
                    .unwrap_or(false);

                if !matches_source_id && !matches_canonical {
                    return Err(VerificationError::UrlIdentityMismatch {
                        requested_url: requested_url.to_string(),
                        platform: "bilibili".to_string(),
                        extracted_id: extracted_meta
                            .source_id
                            .clone()
                            .unwrap_or_else(|| "none".to_string()),
                    });
                }
                return Ok(());
            } else {
                return Err(VerificationError::UrlIdentityMismatch {
                    requested_url: requested_url.to_string(),
                    platform: "bilibili".to_string(),
                    extracted_id: "no_valid_bilibili_id_in_url".to_string(),
                });
            }
        }

        // 2. YouTube (youtube.com, www.youtube.com, m.youtube.com, youtu.be)
        if host == "youtu.be" {
            let path = parsed_url.path().trim_start_matches('/');
            let re_yt = Regex::new(r"^[a-zA-Z0-9_-]{11}$").unwrap();
            if re_yt.is_match(path) {
                if extracted_meta.source_id.as_deref() != Some(path) {
                    return Err(VerificationError::UrlIdentityMismatch {
                        requested_url: requested_url.to_string(),
                        platform: "youtube".to_string(),
                        extracted_id: extracted_meta
                            .source_id
                            .clone()
                            .unwrap_or_else(|| "none".to_string()),
                    });
                }
                return Ok(());
            }
        } else if host == "youtube.com" || host.ends_with(".youtube.com") {
            // check query param 'v' or path /shorts/<id>
            let mut yt_id: Option<String> = None;
            for (k, v) in parsed_url.query_pairs() {
                if k == "v" && v.len() == 11 {
                    yt_id = Some(v.to_string());
                    break;
                }
            }
            if yt_id.is_none() && parsed_url.path().starts_with("/shorts/") {
                let part = parsed_url
                    .path()
                    .trim_start_matches("/shorts/")
                    .trim_end_matches('/');
                if part.len() == 11 {
                    yt_id = Some(part.to_string());
                }
            }

            if let Some(ref expected_id) = yt_id {
                if extracted_meta.source_id.as_deref() != Some(expected_id) {
                    return Err(VerificationError::UrlIdentityMismatch {
                        requested_url: requested_url.to_string(),
                        platform: "youtube".to_string(),
                        extracted_id: extracted_meta
                            .source_id
                            .clone()
                            .unwrap_or_else(|| "none".to_string()),
                    });
                }
                return Ok(());
            } else {
                return Err(VerificationError::UrlIdentityMismatch {
                    requested_url: requested_url.to_string(),
                    platform: "youtube".to_string(),
                    extracted_id: "no_valid_youtube_video_id_in_url".to_string(),
                });
            }
        }

        // 3. WeChat Channels (channels.weixin.qq.com, finder.video.qq.com)
        if host == "channels.weixin.qq.com" || host == "finder.video.qq.com" {
            // Check source_id or canonical_url match
            if extracted_meta.source_type != "wechat_channels"
                && extracted_meta.source_type != "channels"
            {
                return Err(VerificationError::UrlIdentityMismatch {
                    requested_url: requested_url.to_string(),
                    platform: "wechat_channels".to_string(),
                    extracted_id: extracted_meta.source_type.clone(),
                });
            }
            return Ok(());
        }

        Err(VerificationError::UnsupportedDomain(host))
    }
}
