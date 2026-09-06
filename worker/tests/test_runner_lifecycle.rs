#![allow(clippy::field_reassign_with_default)]

use ceo_worker::config::WorkerConfig;
use ceo_worker::runner::{Runner, RunnerError};
use ceo_worker::verifier::BusinessOutcome;
use std::path::PathBuf;
use tempfile::tempdir;

fn get_test_stub_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[tokio::test]
async fn test_adapter_unsupported_preflight_rejection() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    // Explicitly set agent_executable to agentapi
    config.agent_executable = PathBuf::from("/home/sentimentalk/.gemini/antigravity/bin/agentapi");
    config.execution_timeout_secs = 5;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.agent_session_state, "Unsupported");
    assert_eq!(receipt.business_outcome, BusinessOutcome::Interrupted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "ADAPTER_UNSUPPORTED");
    assert!(err.message.contains("lacks workspace binding"));
}

#[tokio::test]
async fn test_duplicate_job_id_rejection() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.agent_executable = get_test_stub_path("test_stub.sh");
    config.execution_timeout_secs = 5;

    let runner = Runner::new(config, None);
    let job_id = "test-atomic-dup-job".to_string();

    // First run
    let res1 = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            Some(job_id.clone()),
        )
        .await;
    assert!(res1.is_ok());

    // Second run with same job_id must fail immediately
    let res2 = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            Some(job_id.clone()),
        )
        .await;

    assert!(matches!(res2, Err(RunnerError::JobAlreadyExists(_))));
}

#[tokio::test]
async fn test_normal_execution_with_test_stub() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.agent_executable = get_test_stub_path("test_stub.sh");
    config.execution_timeout_secs = 5;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "COMPLETED");
    assert_eq!(
        receipt.business_outcome,
        BusinessOutcome::TranscriptAvailable
    );
    assert_eq!(receipt.submission.exit_code, Some(0));
    assert_eq!(receipt.script.exit_code, Some(0));
    assert_eq!(receipt.artifacts.len(), 1);
    assert_eq!(receipt.artifacts[0].name, "result.json");
    assert!(receipt.verification.is_some());
    assert!(receipt.verification.unwrap().valid);
}

#[tokio::test]
async fn test_script_failure_with_completion_report() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.agent_executable = get_test_stub_path("test_stub_fail.sh");
    config.execution_timeout_secs = 5;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "FAILED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::ExtractionFailed);
    assert_eq!(receipt.script.exit_code, Some(1));
    assert!(receipt.artifacts.is_empty());
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "EXTRACTION_NETWORK_ERROR");
}

#[tokio::test]
async fn test_half_write_file_timeout_protection() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.agent_executable = get_test_stub_path("test_stub_half_write.sh");
    config.execution_timeout_secs = 2; // short timeout for testing

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "FAILED");
    assert_eq!(receipt.agent_session_state, "TimeoutBackgroundActive");
    assert_eq!(receipt.business_outcome, BusinessOutcome::Interrupted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "TIMEOUT");
}
