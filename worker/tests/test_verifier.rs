use ceo_worker::verifier::{BusinessOutcome, ExtractedMetadata, VerificationError, Verifier};
use serde_json::json;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_url_identity_bilibili_match() {
    let meta = ExtractedMetadata {
        source_type: "bilibili".to_string(),
        source_url: "https://www.bilibili.com/video/BV1xx411c7mD".to_string(),
        canonical_url: Some("https://www.bilibili.com/video/BV1xx411c7mD".to_string()),
        source_id: Some("BV1xx411c7mD".to_string()),
        title: Some("Test".to_string()),
        creator: Some("Author".to_string()),
        duration_seconds: Some(100.0),
    };

    // Standard match
    assert!(Verifier::verify_url_identity(
        "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999",
        &meta
    )
    .is_ok());

    // Mismatch
    let err = Verifier::verify_url_identity("https://www.bilibili.com/video/BV1zz411c7mE", &meta);
    assert!(err.is_err());
    match err.unwrap_err() {
        VerificationError::UrlIdentityMismatch { platform, .. } => {
            assert_eq!(platform, "bilibili");
        }
        e => panic!("Unexpected error: {:?}", e),
    }
}

#[test]
fn test_url_identity_youtube_query_parameters() {
    let meta_1 = ExtractedMetadata {
        source_type: "youtube".to_string(),
        source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string(),
        canonical_url: None,
        source_id: Some("dQw4w9WgXcQ".to_string()),
        title: Some("Video 1".to_string()),
        creator: Some("Creator".to_string()),
        duration_seconds: Some(200.0),
    };

    // youtube.com with v parameter
    assert!(Verifier::verify_url_identity(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s",
        &meta_1
    )
    .is_ok());

    // youtu.be short link
    assert!(Verifier::verify_url_identity("https://youtu.be/dQw4w9WgXcQ", &meta_1).is_ok());

    // youtube shorts
    assert!(
        Verifier::verify_url_identity("https://www.youtube.com/shorts/dQw4w9WgXcQ", &meta_1)
            .is_ok()
    );

    // Different video ID in query parameter must NOT match!
    let err = Verifier::verify_url_identity("https://www.youtube.com/watch?v=99999999999", &meta_1);
    assert!(err.is_err());
}

#[test]
fn test_url_identity_unsupported_domain() {
    let meta = ExtractedMetadata {
        source_type: "other".to_string(),
        source_url: "https://example.com/video/123".to_string(),
        canonical_url: None,
        source_id: Some("123".to_string()),
        title: None,
        creator: None,
        duration_seconds: None,
    };

    let err = Verifier::verify_url_identity("https://example.com/video/123", &meta);
    assert!(matches!(err, Err(VerificationError::UnsupportedDomain(_))));
}

#[test]
fn test_verify_completion_success() {
    let dir = tempdir().unwrap();
    let attempt_dir = dir.path();
    let job_id = "job-123";
    let attempt_id = "att-456";
    let url = "https://www.bilibili.com/video/BV1xx411c7mD";

    let result_content = json!({
        "metadata": {
            "source_type": "bilibili",
            "source_url": url,
            "source_id": "BV1xx411c7mD",
            "title": "Valid Title"
        },
        "transcript": "Hello subtitles",
        "transcript_status": "available",
        "transcript_method": "subtitles"
    });

    let result_path = attempt_dir.join("result.json");
    fs::write(
        &result_path,
        serde_json::to_vec_pretty(&result_content).unwrap(),
    )
    .unwrap();

    let size = fs::metadata(&result_path).unwrap().len();
    use sha2::{Digest, Sha256};
    let sha256 = format!("{:x}", Sha256::digest(fs::read(&result_path).unwrap()));

    let completion = json!({
        "job_id": job_id,
        "attempt_id": attempt_id,
        "requested_url": url,
        "script_exit_code": 0,
        "artifact": {
            "file_name": "result.json",
            "size_bytes": size,
            "sha256": sha256
        },
        "business_status": "transcript_available",
        "error": null
    });

    fs::write(
        attempt_dir.join("completion.json"),
        serde_json::to_vec_pretty(&completion).unwrap(),
    )
    .unwrap();

    let schema = json!({
        "type": "object",
        "required": ["metadata", "transcript_status"],
        "properties": {
            "metadata": { "type": "object" },
            "transcript_status": { "type": "string" }
        }
    });

    let (comp, res, outcome) =
        Verifier::verify_completion(attempt_dir, job_id, attempt_id, url, &schema).unwrap();
    assert_eq!(comp.script_exit_code, 0);
    assert_eq!(outcome, BusinessOutcome::TranscriptAvailable);
    assert!(res.is_some());
    assert_eq!(res.unwrap().transcript.unwrap(), "Hello subtitles");
}

#[test]
fn test_verify_completion_sha256_mismatch() {
    let dir = tempdir().unwrap();
    let attempt_dir = dir.path();
    let job_id = "job-123";
    let attempt_id = "att-456";
    let url = "https://www.bilibili.com/video/BV1xx411c7mD";

    let result_content = json!({
        "metadata": { "source_type": "bilibili", "source_url": url, "source_id": "BV1xx411c7mD" },
        "transcript": "content",
        "transcript_status": "available"
    });

    fs::write(
        attempt_dir.join("result.json"),
        serde_json::to_vec(&result_content).unwrap(),
    )
    .unwrap();

    let completion = json!({
        "job_id": job_id,
        "attempt_id": attempt_id,
        "requested_url": url,
        "script_exit_code": 0,
        "artifact": {
            "file_name": "result.json",
            "size_bytes": 100,
            "sha256": "bad_sha256_hash"
        },
        "business_status": "transcript_available",
        "error": null
    });

    fs::write(
        attempt_dir.join("completion.json"),
        serde_json::to_vec(&completion).unwrap(),
    )
    .unwrap();

    let schema = json!({ "type": "object" });
    let err = Verifier::verify_completion(attempt_dir, job_id, attempt_id, url, &schema);
    assert!(matches!(err, Err(VerificationError::Sha256Mismatch { .. })));
}

#[test]
fn test_verify_completion_empty_transcript_unavailable() {
    let dir = tempdir().unwrap();
    let attempt_dir = dir.path();
    let job_id = "job-123";
    let attempt_id = "att-456";
    let url = "https://www.bilibili.com/video/BV1xx411c7mD";

    // transcript is whitespace only
    let result_content = json!({
        "metadata": { "source_type": "bilibili", "source_url": url, "source_id": "BV1xx411c7mD" },
        "transcript": "   \n  \t ",
        "transcript_status": "available"
    });

    let res_path = attempt_dir.join("result.json");
    fs::write(&res_path, serde_json::to_vec(&result_content).unwrap()).unwrap();
    let size = fs::metadata(&res_path).unwrap().len();
    use sha2::{Digest, Sha256};
    let sha256 = format!("{:x}", Sha256::digest(fs::read(&res_path).unwrap()));

    let completion = json!({
        "job_id": job_id,
        "attempt_id": attempt_id,
        "requested_url": url,
        "script_exit_code": 0,
        "artifact": {
            "file_name": "result.json",
            "size_bytes": size,
            "sha256": sha256
        }
    });

    fs::write(
        attempt_dir.join("completion.json"),
        serde_json::to_vec(&completion).unwrap(),
    )
    .unwrap();
    let schema = json!({ "type": "object" });

    let (_, _, outcome) =
        Verifier::verify_completion(attempt_dir, job_id, attempt_id, url, &schema).unwrap();
    // Must be classified as TranscriptUnavailable!
    assert_eq!(outcome, BusinessOutcome::TranscriptUnavailable);
}
