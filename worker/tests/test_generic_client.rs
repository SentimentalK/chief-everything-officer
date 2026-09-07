#![allow(clippy::field_reassign_with_default)]

use ceo_worker::config::{safe_job_dir, ExecutorType, WorkerConfig};
use ceo_worker::runner::Runner;
use ceo_worker::verifier::BusinessOutcome;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn setup_test_workspace(temp_root: &Path, rule_marker: &str, mode: &str) -> (PathBuf, PathBuf) {
    let ws = temp_root.join("workspace");
    fs::create_dir_all(&ws).unwrap();

    let agents_content = format!(
        "# Guidelines\n\n<!-- ceo:metadata rule_marker: \"{}\" -->\n\n1. Respect boundaries.\n",
        rule_marker
    );
    fs::write(ws.join("AGENTS.md"), agents_content).unwrap();
    fs::write(ws.join(".stub_mode"), mode).unwrap();

    let prompt_file = temp_root.join("prompt.md");
    let prompt_content = "[Step 3 - Fully Autonomous Execution: Task Execution]\nCreate output_artifact.txt with content.";
    fs::write(&prompt_file, prompt_content).unwrap();

    (ws, prompt_file)
}

fn get_stub_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test_stub.sh")
}

#[tokio::test]
async fn test_1_doctor_agent_ignoring_boundary() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) =
        setup_test_workspace(temp.path(), "RULE-MARKER-TEST-1", "ignore_boundary");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();
    config.doctor_timeout_secs = 10;
    config.task_timeout_secs = 10;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(
            &ws,
            &prompt_file,
            Some("job-boundary-fail".to_string()),
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::NotStarted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "DOCTOR_VERIFICATION_FAILED");

    let doc = receipt.doctor.unwrap();
    assert!(!doc.ready);
    let boundary_check = doc
        .checks
        .iter()
        .find(|c| c.name == "agent_respects_boundary")
        .unwrap();
    assert!(!boundary_check.passed);
}

#[tokio::test]
async fn test_2_doctor_agent_verbal_write_without_file() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) =
        setup_test_workspace(temp.path(), "RULE-MARKER-TEST-2", "verbal_write_no_file");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();
    config.doctor_timeout_secs = 10;
    config.task_timeout_secs = 10;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-verbal-fail".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::NotStarted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "DOCTOR_VERIFICATION_FAILED");

    let doc = receipt.doctor.unwrap();
    assert!(!doc.ready);
    let write_check = doc
        .checks
        .iter()
        .find(|c| c.name == "workspace_write_operational")
        .unwrap();
    assert!(!write_check.passed);
}

#[tokio::test]
async fn test_3_doctor_deterministic_env_probe_denial() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-TEST-3", "wrong_marker");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();
    config.doctor_timeout_secs = 10;
    config.task_timeout_secs = 10;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-env-denial".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::NotStarted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "DOCTOR_VERIFICATION_FAILED");

    let doc = receipt.doctor.unwrap();
    assert!(!doc.ready);
    let marker_check = doc
        .checks
        .iter()
        .find(|c| c.name == "rule_marker_loaded")
        .unwrap();
    assert!(!marker_check.passed);
}

#[tokio::test]
async fn test_4_doctor_fail_fast_never_sends_task_prompt() {
    let temp = tempdir().unwrap();
    // Missing rule_marker in AGENTS.md
    let ws = temp.path().join("workspace");
    fs::create_dir_all(&ws).unwrap();
    fs::write(ws.join("AGENTS.md"), "# Guidelines without marker\n").unwrap();
    let prompt_file = temp.path().join("prompt.md");
    fs::write(&prompt_file, "task prompt").unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-fail-fast".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::NotStarted);
    let err = receipt.error.unwrap();
    assert_eq!(err.code, "DOCTOR_PREFLIGHT_FAILED");
}

#[tokio::test]
async fn test_5_bounded_termination_on_stdin_close() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-TEST-5", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();
    config.teardown_wait_secs = 3;

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-clean-term".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "COMPLETED");
    // Verify duration is small and process closed cleanly without waiting for timeout
    assert!(receipt.timestamps.duration_ms < 5000);
}

#[tokio::test]
async fn test_6_stale_artifacts_isolation() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-TEST-6", "no_artifacts");

    // Pre-create a stale artifact BEFORE the attempt runs
    let stale_artifact = ws.join("output_artifact.txt");
    fs::write(&stale_artifact, "Old pre-existing stale data").unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-stale-iso".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "COMPLETED");
    // Pre-existing file must not be verified as a newly created artifact!
    assert_eq!(receipt.business_outcome, BusinessOutcome::Unverified);
    assert!(receipt.artifacts.is_empty());
}

#[tokio::test]
async fn test_7_multi_turn_e2e() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-TEST-7", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(&ws, &prompt_file, Some("job-e2e-ok".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "COMPLETED");
    assert_eq!(receipt.business_outcome, BusinessOutcome::Verified);
    assert!(!receipt.artifacts.is_empty());
    assert_eq!(receipt.artifacts[0].path, "output_artifact.txt");

    // Verify status.json
    let job_dir = safe_job_dir(&ws, "job-e2e-ok").unwrap();
    let status = ceo_worker::observability::StatusTracker::load_status(&job_dir).unwrap();
    assert_eq!(status.stage, ceo_worker::observability::JobStage::Completed);

    // Verify events.jsonl contains both doctor and task stages
    let events_file = ws
        .join(".ceo")
        .join("jobs")
        .join("job-e2e-ok")
        .join("attempts")
        .join(&receipt.attempt_id)
        .join("events.jsonl");
    let events_content = fs::read_to_string(&events_file).unwrap();
    assert!(events_content.contains("\"stage\":\"doctor\""));
    assert!(events_content.contains("\"stage\":\"task\""));
    assert!(events_content.contains("\"event\":\"receipt_finalized\""));
}

#[test]
fn test_8_agy_headless_unattended_command_line_flags() {
    let adapter = ceo_worker::executor::AgyHeadlessAdapter::new(PathBuf::from("agy"));
    let ws = PathBuf::from("/tmp/test_ws");
    let attempt_dir = PathBuf::from("/tmp/test_ws/.ceo/attempts/att-1");
    let prompt_file = PathBuf::from("/tmp/test_ws/prompt.md");

    // Case 1: Default execution request with no model override
    let req_default = ceo_worker::executor::ExecutionRequest {
        job_id: "job-1",
        attempt_id: "att-1",
        workspace_dir: &ws,
        attempt_dir: &attempt_dir,
        prompt_file: &prompt_file,
        model: None,
    };
    let args_default = adapter.build_command_args(&req_default);
    assert!(args_default.contains(&"--input-format".to_string()));
    assert!(args_default.contains(&"--output-format".to_string()));
    assert!(args_default.contains(&"stream-json".to_string()));
    assert!(args_default.contains(&"--mode".to_string()));
    assert!(args_default.contains(&"accept-edits".to_string()));
    assert!(args_default.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(args_default.contains(&"--sandbox".to_string()));
    assert!(args_default.contains(&"--model".to_string()));
    assert!(args_default.contains(&"gemini-3.8-flash-medium".to_string()));

    // Case 2: Explicit model override
    let req_override = ceo_worker::executor::ExecutionRequest {
        job_id: "job-1",
        attempt_id: "att-1",
        workspace_dir: &ws,
        attempt_dir: &attempt_dir,
        prompt_file: &prompt_file,
        model: Some("gemini-1.5-pro"),
    };
    let args_override = adapter.build_command_args(&req_override);
    assert!(args_override.contains(&"gemini-1.5-pro".to_string()));
}
