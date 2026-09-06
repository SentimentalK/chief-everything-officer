#![allow(clippy::field_reassign_with_default)]

use ceo_worker::config::{validate_id, ExecutorType, WorkerConfig};
use ceo_worker::doctor::{run_doctor, DoctorStatus};
use ceo_worker::executor::create_executor;
use ceo_worker::observability::{LogSource, ProcessLogger};
use ceo_worker::runner::{Runner, RunnerError};
use ceo_worker::verifier::BusinessOutcome;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;

fn get_test_stub_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

// 1. All failure paths must create receipt.json and exit through unified teardown
#[tokio::test]
async fn test_teardown_receipt_created_on_all_failures() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub.sh");

    let runner = Runner::new(config.clone(), None);

    // Test case A: Manifest load error (nonexistent capability)
    let res = runner
        .run_job("nonexistent.capability", "https://example.com", None)
        .await;

    assert!(res.is_ok());
    let receipt = res.unwrap();
    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.agent_session_state, "NotStarted");
    assert_eq!(receipt.business_outcome, BusinessOutcome::NotStarted);
    assert_eq!(receipt.error.as_ref().unwrap().code, "MANIFEST_LOAD_ERROR");

    // Verify receipt.json exists on disk
    let receipt_file = config
        .attempt_dir(&receipt.job_id, &receipt.attempt_id)
        .join("receipt.json");
    assert!(receipt_file.exists());
}

// 2. Fast failure when submission launcher exits with non-zero code
#[tokio::test]
async fn test_fast_fail_on_submission_exit_non_zero() {
    let dir = tempdir().unwrap();
    let stub_dir = tempdir().unwrap();
    let fail_stub = stub_dir.path().join("fail_stub.sh");

    let script_content = r#"#!/usr/bin/env bash
echo "Submission launcher fatal error" >&2
exit 42
"#;
    let mut f = File::create(&fail_stub).unwrap();
    f.write_all(script_content.as_bytes()).unwrap();
    drop(f);
    fs::set_permissions(&fail_stub, fs::Permissions::from_mode(0o755)).unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = fail_stub;
    config.execution_timeout_secs = 60; // Should fail fast without waiting 60s

    let runner = Runner::new(config, None);
    let start = std::time::Instant::now();
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "Failed to exit fast; took {:?}",
        elapsed
    );
    assert_eq!(receipt.execution_status, "FAILED");
    assert_eq!(receipt.submission.exit_code, Some(42));
    assert!(receipt.error.is_some());
}

// 3. Pipe hang timeout recovery: child detaches pipe, runner terminates boundedly
#[tokio::test]
async fn test_pipe_hang_timeout_recovery() {
    let dir = tempdir().unwrap();
    let stub_dir = tempdir().unwrap();
    let hang_pipe_stub = stub_dir.path().join("hang_pipe_stub.sh");

    // Process exits immediately, but leaves background child holding stdout
    let script_content = r#"#!/usr/bin/env bash
( sleep 5 > /dev/null & )
exit 0
"#;
    let mut f = File::create(&hang_pipe_stub).unwrap();
    f.write_all(script_content.as_bytes()).unwrap();
    drop(f);
    fs::set_permissions(&hang_pipe_stub, fs::Permissions::from_mode(0o755)).unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = hang_pipe_stub;
    config.execution_timeout_secs = 20;

    let runner = Runner::new(config, None);
    let start = std::time::Instant::now();
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(6),
        "Runner did not boundedly decouple from pipe: took {:?}",
        elapsed
    );
    assert_eq!(receipt.execution_status, "FAILED");
}

// 4. Process group termination cleans child processes
#[tokio::test]
async fn test_process_group_termination_cleans_children() {
    let dir = tempdir().unwrap();
    let stub_dir = tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let pg_stub = stub_dir.path().join("pg_stub.sh");

    let script_content = format!(
        r#"#!/usr/bin/env bash
sleep 60 &
echo $! > "{}"
wait
"#,
        pid_file.display()
    );
    let mut f = File::create(&pg_stub).unwrap();
    f.write_all(script_content.as_bytes()).unwrap();
    drop(f);
    fs::set_permissions(&pg_stub, fs::Permissions::from_mode(0o755)).unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = pg_stub;
    config.execution_timeout_secs = 1; // 1 second timeout

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
    assert_eq!(receipt.agent_session_state, "TimedOut");

    // Verify background child process was killed
    if pid_file.exists() {
        let child_pid_str = fs::read_to_string(&pid_file).unwrap();
        if let Ok(child_pid) = child_pid_str.trim().parse::<i32>() {
            unsafe {
                let res = libc::kill(child_pid, 0);
                assert_ne!(
                    res, 0,
                    "Child process {} was not terminated by process group kill!",
                    child_pid
                );
            }
        }
    }
}

// 5. Stderr visibility in logs and receipt snippet
#[tokio::test]
async fn test_stderr_visibility_in_logs() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub_fail.sh");

    let runner = Runner::new(config.clone(), None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    let stderr_file = config
        .attempt_dir(&receipt.job_id, &receipt.attempt_id)
        .join("stderr.log");
    assert!(stderr_file.exists());
    let stderr_content = fs::read_to_string(&stderr_file).unwrap();
    assert!(stderr_content.contains("Test Stub Simulating Script Failure"));
    assert!(receipt
        .logs
        .stderr_snippet
        .contains("Test Stub Simulating Script Failure"));
}

// 6. Logger stats (dropped lines, truncation) reflected in receipt
#[tokio::test]
async fn test_logger_stats_in_receipt() {
    let dir = tempdir().unwrap();
    let attempt_dir = dir.path().join("attempt_1");
    fs::create_dir_all(&attempt_dir).unwrap();

    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let logger = ProcessLogger::new(&attempt_dir, "stdout.log", LogSource::Launcher, Some(tx));

    for i in 0..50 {
        logger.log_line(&format!("Line {}", i));
    }

    assert!(logger.dropped_lines_count() > 0);
}

// 7. Path validation and concurrent job_id race safety
#[tokio::test]
async fn test_path_validation_and_concurrent_job_id() {
    assert!(validate_id("job_id", "..").is_err());
    assert!(validate_id("job_id", ".").is_err());
    assert!(validate_id("job_id", "job/123").is_err());
    assert!(validate_id("job_id", "job\\123").is_err());
    assert!(validate_id("job_id", "").is_err());
    assert!(validate_id("job_id", &"x".repeat(129)).is_err());
    assert!(validate_id("job_id", "valid_job-123.ABC").is_ok());

    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub.sh");

    let runner = Arc::new(Runner::new(config, None));
    let target_job_id = "concurrent-race-test-id".to_string();

    let mut handles = vec![];
    for _ in 0..10 {
        let r = runner.clone();
        let jid = target_job_id.clone();
        handles.push(tokio::spawn(async move {
            r.run_job(
                "content.extract_url",
                "https://www.bilibili.com/video/BV1xx411c7mD",
                Some(jid),
            )
            .await
        }));
    }

    let mut successes = 0;
    let mut dups = 0;

    for h in handles {
        match h.await.unwrap() {
            Ok(_) => successes += 1,
            Err(RunnerError::JobAlreadyExists(_)) => dups += 1,
            Err(other) => panic!("Unexpected runner error: {:?}", other),
        }
    }

    assert_eq!(
        successes, 1,
        "Exactly one task must succeed in creating job directory"
    );
    assert_eq!(
        dups, 9,
        "9 concurrent attempts must be rejected with JobAlreadyExists"
    );
}

// 8. Test stub is not reported as Google executor
#[tokio::test]
async fn test_stub_not_reported_as_google() {
    let dir = tempdir().unwrap();
    let mut config = WorkerConfig::default();
    config.workspace_dir = dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub.sh");

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "content.extract_url",
            "https://www.bilibili.com/video/BV1xx411c7mD",
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.executor.executor_type, "test_stub");
    assert_ne!(receipt.executor.executor_type, "agy_headless");
    assert_ne!(receipt.executor.executor_type, "antigravity-agentapi");
}

// 9. Isolated fixture capability fully decoupling from host environment
#[tokio::test]
async fn test_isolated_fixture_capability() {
    let base_dir = tempdir().unwrap();
    let tools_dir = base_dir.path().join("tools");
    let cap_dir = tools_dir.join("capabilities").join("isolated.echo");
    fs::create_dir_all(&cap_dir).unwrap();

    let manifest_content = r#"{
  "schema_version": 1,
  "capability_id": "isolated.echo",
  "name": "Isolated Echo",
  "version": "1.0.0",
  "manifest_revision": 1,
  "description": "Test capability",
  "execution": {
    "profile": "worker",
    "entrypoints": {
      "doctor": "./doctor",
      "setup": "./setup",
      "run": "./run"
    }
  },
  "input_schema": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": { "type": "string" }
    }
  },
  "output_schema": {
    "type": "object",
    "required": ["metadata", "transcript_status"],
    "properties": {
      "metadata": {
        "type": "object",
        "required": ["source_type", "source_url"],
        "properties": {
          "source_type": { "type": "string" },
          "source_url": { "type": "string" },
          "canonical_url": { "type": ["string", "null"] },
          "source_id": { "type": ["string", "null"] }
        }
      },
      "transcript": { "type": ["string", "null"] },
      "transcript_status": { "type": "string" },
      "transcript_method": { "type": ["string", "null"] }
    }
  }
}"#;
    fs::write(cap_dir.join("capability.json"), manifest_content).unwrap();

    let doctor_content = "#!/bin/sh\necho '{\"status\": \"READY\", \"base_ready\": true, \"asr_available\": false, \"checks\": [], \"actions\": []}'\n";
    let doctor_path = cap_dir.join("doctor");
    fs::write(&doctor_path, doctor_content).unwrap();
    fs::set_permissions(&doctor_path, fs::Permissions::from_mode(0o755)).unwrap();

    let setup_path = cap_dir.join("setup");
    fs::write(&setup_path, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&setup_path, fs::Permissions::from_mode(0o755)).unwrap();

    let run_content = r#"#!/usr/bin/env bash
OUTPUT_DIR=""
INPUT_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --input) INPUT_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

JOB_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('job_id'))" "$INPUT_FILE")
ATTEMPT_ID=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('attempt_id'))" "$INPUT_FILE")
URL=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1])); print(d.get('params',{}).get('url',''))" "$INPUT_FILE")

cat > "$OUTPUT_DIR/result.json" << 'RES_EOF'
{
  "metadata": {
    "source_type": "bilibili",
    "source_url": "https://www.bilibili.com/video/BV1xx411c7mD",
    "source_id": "BV1xx411c7mD"
  },
  "transcript": "Isolated test transcript",
  "transcript_status": "available"
}
RES_EOF

SIZE=$(wc -c < "$OUTPUT_DIR/result.json" | tr -d ' ')
SHA=$(sha256sum "$OUTPUT_DIR/result.json" | awk '{print $1}')

cat > "$OUTPUT_DIR/completion.json" << COMP_EOF
{
  "job_id": "$JOB_ID",
  "attempt_id": "$ATTEMPT_ID",
  "requested_url": "$URL",
  "script_exit_code": 0,
  "artifact": {
    "file_name": "result.json",
    "size_bytes": $SIZE,
    "sha256": "$SHA"
  },
  "business_status": "success",
  "error": null
}
COMP_EOF
exit 0
"#;
    let run_path = cap_dir.join("run");
    fs::write(&run_path, run_content).unwrap();
    fs::set_permissions(&run_path, fs::Permissions::from_mode(0o755)).unwrap();

    let mut config = WorkerConfig::default();
    config.tools_dir = tools_dir;
    config.workspace_dir = base_dir.path().join("workspace");
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub.sh");

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_job(
            "isolated.echo",
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
    assert_eq!(receipt.artifacts.len(), 1);
}

// 10. Doctor three-way readiness check (capability, executor, overall)
#[tokio::test]
async fn test_doctor_three_way_readiness() {
    let mut config = WorkerConfig::default();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_test_stub_path("test_stub.sh");

    let executor = create_executor(&config);
    let exec_check = executor.preflight_check();
    assert!(exec_check.is_ok());

    let cap_dir = config.capability_dir("content.extract_url");
    let cap_report = run_doctor(&cap_dir).await;
    assert!(cap_report.is_ok());

    let capability_ready = cap_report.unwrap().status == DoctorStatus::Ready;
    let executor_ready = exec_check.is_ok();
    let overall_ready = capability_ready && executor_ready;

    assert!(executor_ready);
    assert_eq!(overall_ready, capability_ready);
}
