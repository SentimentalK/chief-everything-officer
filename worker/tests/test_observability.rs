use ceo_worker::observability::logger::{LogSource, ProcessLogger};
use ceo_worker::observability::status::{JobStage, StatusTracker};
use std::collections::HashMap;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_logger_redaction_and_ansi_strip() {
    let dir = tempdir().unwrap();
    let logger = ProcessLogger::new(dir.path(), "test.log", LogSource::Launcher, None);

    let raw = "\x1b[32m[SUCCESS]\x1b[0m User Authorization: Bearer secret_token_1234567890! Google API Key: AIzaSyD98765432101234567890123456789012";
    let sanitized = logger.sanitize(raw);

    assert!(!sanitized.contains("\x1b[32m"));
    assert!(!sanitized.contains("secret_token_1234567890"));
    assert!(sanitized.contains("Bearer [REDACTED]"));
    assert!(sanitized.contains("AIza[REDACTED]"));
}

#[tokio::test]
async fn test_logger_drain_bounded_stream() {
    let dir = tempdir().unwrap();
    let logger = ProcessLogger::new(dir.path(), "stdout.log", LogSource::Script, None);

    // Create a 50KB un-linebroken stream
    let big_data = vec![b'X'; 50000];
    logger.drain_stream(&big_data[..]).await;

    let log_content = fs::read_to_string(dir.path().join("stdout.log")).unwrap();
    assert!(log_content.contains("[LINE_TRUNCATED]"));
}

#[test]
fn test_status_tracker_crash_detection() {
    let dir = tempdir().unwrap();
    let job_dir = dir.path();

    // Create status tracker and manually persist an Execution stage with a non-existent PID
    let tracker = StatusTracker::new(job_dir, "job-crash-test", "att-1");
    let mut log_paths = HashMap::new();
    log_paths.insert("stdout".to_string(), "/tmp/stdout.log".to_string());

    // Update stage to Execution
    tracker
        .update_stage(JobStage::Execution, None, log_paths, vec![])
        .unwrap();

    // Read raw status and corrupt PID to a dead process (e.g. 99999999)
    let status_path = job_dir.join("status.json");
    let mut status_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&status_path).unwrap()).unwrap();
    status_json["runner_pid"] = serde_json::json!(99999999);
    fs::write(&status_path, serde_json::to_string(&status_json).unwrap()).unwrap();

    // Now call load_status: should detect that pid 99999999 is not alive and report UnknownInterrupted!
    let loaded = StatusTracker::load_status(job_dir).unwrap();
    assert_eq!(loaded.stage, JobStage::UnknownInterrupted);
    assert!(loaded.latest_error.is_some());
    assert!(loaded
        .latest_error
        .unwrap()
        .contains("terminated unexpectedly"));
}
