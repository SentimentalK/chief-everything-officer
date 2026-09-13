//! Managed result types and validation for CEO-owned resource ingress.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use thiserror::Error;

pub const MANAGED_RESULT_FILENAME: &str = "managed-result.json";
pub const MAX_MANAGED_RESULT_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB
pub const MAX_RESULT_METADATA_STR_BYTES: usize = 1024;
pub const MAX_RESULT_LANGUAGE_BYTES: usize = 64;
pub const MAX_RESULT_METHOD_BYTES: usize = 128;

/// Requirement placed on the attempt by the claimed job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedResultRequirement {
    None,
    Resource { resource_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedResultMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedResultExtraction {
    pub method: String,
    pub extracted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedResourceResult {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ManagedResultMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction: Option<ManagedResultExtraction>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManagedResultError {
    #[error("Managed result file is missing")]
    Missing,
    #[error("Managed result file exceeds 8 MiB limit")]
    TooLarge,
    #[error("Managed result file is invalid: {0}")]
    Invalid(String),
}

impl ManagedResultError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Missing => "RESULT_MISSING",
            Self::TooLarge => "RESULT_TOO_LARGE",
            Self::Invalid(_) => "RESULT_INVALID",
        }
    }
}

fn is_valid_rfc3339(ts: &str) -> bool {
    DateTime::parse_from_rfc3339(ts).is_ok()
}

/// Validates the file at `path` against the CEO managed-result specification.
/// Enforces symlink rejection, byte limits, UTF-8 parsing, and schema bounds.
pub fn validate_managed_result_file(
    path: &Path,
) -> Result<ManagedResourceResult, ManagedResultError> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ManagedResultError::Missing);
        }
        Err(e) => {
            return Err(ManagedResultError::Invalid(format!(
                "failed to read metadata: {e}"
            )));
        }
    };

    if meta.file_type().is_symlink() {
        return Err(ManagedResultError::Invalid(
            "symlinks are forbidden".to_string(),
        ));
    }
    if !meta.file_type().is_file() {
        return Err(ManagedResultError::Invalid(
            "must be a regular file".to_string(),
        ));
    }
    if meta.len() > MAX_MANAGED_RESULT_BYTES {
        return Err(ManagedResultError::TooLarge);
    }
    if meta.len() == 0 {
        return Err(ManagedResultError::Invalid("file is empty".to_string()));
    }

    let mut file = File::open(path)
        .map_err(|e| ManagedResultError::Invalid(format!("failed to open file: {e}")))?;

    // Bounded read: take up to MAX + 1 to prevent unbounded memory read
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_MANAGED_RESULT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ManagedResultError::Invalid(format!("read error: {e}")))?;

    if bytes.len() as u64 > MAX_MANAGED_RESULT_BYTES {
        return Err(ManagedResultError::TooLarge);
    }

    let result: ManagedResourceResult = serde_json::from_slice(&bytes)
        .map_err(|e| ManagedResultError::Invalid(format!("JSON parse error: {e}")))?;

    // Content bounds
    if result.content.trim().is_empty() {
        return Err(ManagedResultError::Invalid(
            "content must not be empty or whitespace-only".to_string(),
        ));
    }
    if result.content.len() as u64 > MAX_MANAGED_RESULT_BYTES {
        return Err(ManagedResultError::TooLarge);
    }

    // Metadata bounds
    if let Some(ref m) = result.metadata {
        if let Some(ref t) = m.title {
            if t.trim().is_empty() {
                return Err(ManagedResultError::Invalid(
                    "title must not be whitespace-only".to_string(),
                ));
            }
            if t.len() > MAX_RESULT_METADATA_STR_BYTES {
                return Err(ManagedResultError::Invalid(
                    "title exceeds 1 KiB".to_string(),
                ));
            }
        }
        if let Some(ref a) = m.author {
            if a.trim().is_empty() {
                return Err(ManagedResultError::Invalid(
                    "author must not be whitespace-only".to_string(),
                ));
            }
            if a.len() > MAX_RESULT_METADATA_STR_BYTES {
                return Err(ManagedResultError::Invalid(
                    "author exceeds 1 KiB".to_string(),
                ));
            }
        }
        if let Some(ref p) = m.published_at {
            if !is_valid_rfc3339(p) {
                return Err(ManagedResultError::Invalid(
                    "published_at must be RFC3339 format".to_string(),
                ));
            }
        }
        if let Some(ref l) = m.language {
            if l.trim().is_empty() {
                return Err(ManagedResultError::Invalid(
                    "language must not be whitespace-only".to_string(),
                ));
            }
            if l.len() > MAX_RESULT_LANGUAGE_BYTES {
                return Err(ManagedResultError::Invalid(
                    "language exceeds 64 bytes".to_string(),
                ));
            }
        }
    }

    // Extraction bounds
    if let Some(ref ext) = result.extraction {
        if ext.method.trim().is_empty() {
            return Err(ManagedResultError::Invalid(
                "extraction method must not be whitespace-only".to_string(),
            ));
        }
        if ext.method.len() > MAX_RESULT_METHOD_BYTES {
            return Err(ManagedResultError::Invalid(
                "extraction method exceeds 128 bytes".to_string(),
            ));
        }
        if !is_valid_rfc3339(&ext.extracted_at) {
            return Err(ManagedResultError::Invalid(
                "extraction extracted_at must be RFC3339 format".to_string(),
            ));
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_file(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn test_valid_minimal_result() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("managed-result.json");
        write_file(&file, r###"{"content": "## Subtitles\n\nHello world"}"###);

        let res = validate_managed_result_file(&file).unwrap();
        assert_eq!(res.content, "## Subtitles\n\nHello world");
        assert!(res.metadata.is_none());
        assert!(res.extraction.is_none());
    }

    #[test]
    fn test_valid_full_result() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("managed-result.json");
        let json = r#"{
            "content": "Full content",
            "metadata": {
                "title": "A Great Video",
                "author": "Alice",
                "published_at": "2026-09-13T10:00:00Z",
                "language": "en"
            },
            "extraction": {
                "method": "transcript_api",
                "extracted_at": "2026-09-13T12:00:00Z"
            }
        }"#;
        write_file(&file, json);

        let res = validate_managed_result_file(&file).unwrap();
        assert_eq!(res.content, "Full content");
        let meta = res.metadata.unwrap();
        assert_eq!(meta.title.as_deref(), Some("A Great Video"));
        assert_eq!(meta.language.as_deref(), Some("en"));
        let ext = res.extraction.unwrap();
        assert_eq!(ext.method, "transcript_api");
    }

    #[test]
    fn test_missing_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("non-existent.json");
        assert_eq!(
            validate_managed_result_file(&file),
            Err(ManagedResultError::Missing)
        );
    }

    #[test]
    fn test_symlink_rejected() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target.json");
        write_file(&target, r#"{"content": "target"}"#);
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(
            validate_managed_result_file(&link),
            Err(ManagedResultError::Invalid(
                "symlinks are forbidden".to_string()
            ))
        );
    }

    #[test]
    fn test_deny_unknown_fields() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("managed-result.json");
        write_file(&file, r#"{"content": "ok", "unexpected_field": 123}"#);

        assert!(matches!(
            validate_managed_result_file(&file),
            Err(ManagedResultError::Invalid(_))
        ));
    }

    #[test]
    fn test_empty_or_whitespace_content() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("managed-result.json");
        write_file(&file, r#"{"content": "   \n\t  "}"#);

        assert_eq!(
            validate_managed_result_file(&file),
            Err(ManagedResultError::Invalid(
                "content must not be empty or whitespace-only".to_string()
            ))
        );
    }

    #[test]
    fn test_invalid_rfc3339() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("managed-result.json");
        write_file(
            &file,
            r#"{"content": "ok", "extraction": {"method": "api", "extracted_at": "not-a-date"}}"#,
        );

        assert_eq!(
            validate_managed_result_file(&file),
            Err(ManagedResultError::Invalid(
                "extraction extracted_at must be RFC3339 format".to_string()
            ))
        );
    }
}
