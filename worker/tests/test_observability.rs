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

#[test]
fn test_tool_event_formatting() {
    use ceo_worker::observability::logger::format_tool_event;
    use serde_json::json;

    // 1. run_command ACTIVE
    let step_active_cmd = json!({
        "tool_name": "run_command",
        "state": "ACTIVE",
        "tool_info": {
            "parameters": {
                "CommandLine": "which pdfunite   pdfinfo\npython3"
            }
        }
    });
    let line1 = format_tool_event(&step_active_cmd, "run_command", "ACTIVE");
    assert_eq!(
        line1,
        "[tool:run_command] ACTIVE $ which pdfunite pdfinfo python3"
    );

    // 2. write_to_file ACTIVE
    let step_active_file = json!({
        "tool_name": "write_to_file",
        "state": "ACTIVE",
        "tool_info": {
            "parameters": {
                "TargetFile": "/tmp/my_ws/merge_pdfs.py"
            }
        }
    });
    let line2 = format_tool_event(&step_active_file, "write_to_file", "ACTIVE");
    assert_eq!(
        line2,
        "[tool:write_to_file] ACTIVE /tmp/my_ws/merge_pdfs.py"
    );

    // 3. DONE with duration
    let step_done = json!({
        "tool_name": "run_command",
        "state": "DONE",
        "duration_seconds": 0.0714
    });
    let line3 = format_tool_event(&step_done, "run_command", "DONE");
    assert_eq!(line3, "[tool:run_command] DONE (0.07s)");

    // 4. ERROR with error message and duration
    let step_error = json!({
        "tool_name": "run_command",
        "state": "ERROR",
        "duration_seconds": 0.0581,
        "tool_info": {
            "error": {
                "message": "sandbox configuration error: readwrite /tmp/*: globs not supported"
            }
        }
    });
    let line4 = format_tool_event(&step_error, "run_command", "ERROR");
    assert_eq!(
        line4,
        "[tool:run_command] ERROR: sandbox configuration error: readwrite /tmp/*: globs not supported (0.06s)"
    );
}
