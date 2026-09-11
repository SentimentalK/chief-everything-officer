#![allow(clippy::field_reassign_with_default)]

use ceo_worker::config::{ExecutorType, WorkerConfig};
use ceo_worker::doctor::{doctor_cache_file, load_cache, run_fast_local_precheck, save_cache};
use ceo_worker::runner::Runner;
use ceo_worker::verifier::BusinessOutcome;
use chrono::{Duration, Utc};
use std::fs;
use std::os::unix::fs::PermissionsExt;
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
async fn test_1_cache_hit_bypasses_turn_1_and_preserves_metrics() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C1", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);

    // Run 1: First execution on clean workspace -> Cache Miss
    let receipt1 = runner
        .run_task(&ws, &prompt_file, Some("job-c1-run1".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt1.execution_status, "COMPLETED");
    assert!(!receipt1.doctor_cache_hit);
    assert!(receipt1.doctor.is_some());
    let current_metrics1 = receipt1
        .current_doctor_metrics
        .clone()
        .expect("Should have current doctor metrics");
    assert!(current_metrics1.duration_ms > 0);
    assert!(current_metrics1.model_usage.is_some());
    assert!(receipt1.cached_doctor_metrics.is_none());

    // Verify cache file was written to <workspace>/.ceo/doctor/cache.json
    let cache_file = doctor_cache_file(&ws);
    assert!(cache_file.exists());

    // Run 2: Second execution on identical environment -> Cache Hit
    let receipt2 = runner
        .run_task(&ws, &prompt_file, Some("job-c1-run2".to_string()), None)
        .await
        .unwrap();

    assert_eq!(receipt2.execution_status, "COMPLETED");
    assert!(receipt2.doctor_cache_hit);
    assert!(receipt2.doctor.is_some());
    let current_metrics2 = receipt2
        .current_doctor_metrics
        .expect("Should have current doctor metrics");
    assert_eq!(current_metrics2.duration_ms, 0);
    assert!(current_metrics2.model_usage.is_none());

    let cached_metrics2 = receipt2
        .cached_doctor_metrics
        .expect("Should have cached doctor metrics");
    assert_eq!(cached_metrics2.duration_ms, current_metrics1.duration_ms);
    assert_eq!(cached_metrics2.model_usage, current_metrics1.model_usage);
}

#[tokio::test]
async fn test_2_content_change_triggers_miss_touch_and_canonical_json_hit() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C2", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);

    // Initial run to populate cache
    let r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c2-r1".to_string()), None)
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);

    // 1. Touch AGENTS.md (mtime change only, content identical)
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let agents_path = ws.join("AGENTS.md");
    let content = fs::read_to_string(&agents_path).unwrap();
    fs::write(&agents_path, &content).unwrap();

    let r2 = runner
        .run_task(&ws, &prompt_file, Some("job-c2-r2".to_string()), None)
        .await
        .unwrap();
    assert!(
        r2.doctor_cache_hit,
        "Touching file without content change must HIT cache"
    );

    // 2. Canonical JSON formatting / key ordering in .agents/mcp_config.json
    let agents_dir = ws.join(".agents");
    fs::create_dir_all(&agents_dir).unwrap();
    let mcp_path = agents_dir.join("mcp_config.json");
    fs::write(&mcp_path, r#"{"b_key": 2, "a_key": 1}"#).unwrap();

    let r3 = runner
        .run_task(&ws, &prompt_file, Some("job-c2-r3".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r3.doctor_cache_hit,
        "New MCP config added must trigger miss"
    );

    // Reorder keys and whitespace in mcp_config.json
    fs::write(
        &mcp_path,
        r#"{
        "a_key":   1,
        "b_key": 2
    }"#,
    )
    .unwrap();

    let r4 = runner
        .run_task(&ws, &prompt_file, Some("job-c2-r4".to_string()), None)
        .await
        .unwrap();
    assert!(
        r4.doctor_cache_hit,
        "Canonical JSON formatting/key reorder must HIT cache"
    );

    // 3. Modify content of AGENTS.md
    fs::write(
        &agents_path,
        format!("{}\n\n2. New requirement added.\n", content),
    )
    .unwrap();

    let r5 = runner
        .run_task(&ws, &prompt_file, Some("job-c2-r5".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r5.doctor_cache_hit,
        "Modifying rule content must trigger cache MISS"
    );
}

#[tokio::test]
async fn test_3_add_remove_rules_or_launch_config_change_triggers_miss() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C3", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);
    let r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c3-r1".to_string()), None)
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);

    // Add a new skill Markdown file in .agents/skills/
    let skills_dir = ws.join(".agents").join("skills");
    fs::create_dir_all(&skills_dir).unwrap();
    let new_skill = skills_dir.join("analytics.md");
    fs::write(&new_skill, "# Analytics Skill\nAnalyze reports.\n").unwrap();

    let r2 = runner
        .run_task(&ws, &prompt_file, Some("job-c3-r2".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r2.doctor_cache_hit,
        "Adding skill markdown file must trigger MISS"
    );

    // Run again with skill present -> Hit
    let r3 = runner
        .run_task(&ws, &prompt_file, Some("job-c3-r3".to_string()), None)
        .await
        .unwrap();
    assert!(r3.doctor_cache_hit);

    // Delete skill file -> Miss
    fs::remove_file(&new_skill).unwrap();
    let r4 = runner
        .run_task(&ws, &prompt_file, Some("job-c3-r4".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r4.doctor_cache_hit,
        "Removing skill file must trigger MISS"
    );

    // Launch config change: modify model
    let mut config_modified = config.clone();
    config_modified.agent_model = Some("gemini-1.5-pro".to_string());
    let runner_mod = Runner::new(config_modified, None);
    let r5 = runner_mod
        .run_task(&ws, &prompt_file, Some("job-c3-r5".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r5.doctor_cache_hit,
        "Changing launch model must trigger MISS"
    );
}

#[tokio::test]
async fn test_4_attempt_id_variation_preserves_cache() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C4", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);
    let r1 = runner
        .run_task(
            &ws,
            &prompt_file,
            Some("job-attempt-alpha".to_string()),
            None,
        )
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);

    // Second run with completely different job_id and attempt directory
    let r2 = runner
        .run_task(
            &ws,
            &prompt_file,
            Some("job-attempt-beta".to_string()),
            None,
        )
        .await
        .unwrap();
    assert!(
        r2.doctor_cache_hit,
        "Attempt ID variation must not invalidate cache"
    );
}

#[tokio::test]
async fn test_5_fast_local_precheck_failure_blocks_without_agent_or_model() {
    let temp = tempdir().unwrap();

    // 1. Missing rule marker
    let ws1 = temp.path().join("ws_no_marker");
    fs::create_dir_all(&ws1).unwrap();
    fs::write(ws1.join("AGENTS.md"), "# Guidelines without rule marker\n").unwrap();
    let prompt_file = temp.path().join("prompt.md");
    fs::write(&prompt_file, "task prompt").unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws1.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner1 = Runner::new(config.clone(), None);
    let r1 = runner1
        .run_task(&ws1, &prompt_file, Some("job-c5-marker".to_string()), None)
        .await
        .unwrap();
    assert_eq!(r1.execution_status, "BLOCKED");
    assert_eq!(r1.error.as_ref().unwrap().code, "DOCTOR_PREFLIGHT_FAILED");
    assert_eq!(r1.business_outcome, BusinessOutcome::NotStarted);

    // 2. Non-executable agent executable
    let ws2 = temp.path().join("ws_bad_exe");
    fs::create_dir_all(&ws2).unwrap();
    let agents_content = "# Guidelines\n<!-- ceo:metadata rule_marker: \"MK\" -->\n";
    fs::write(ws2.join("AGENTS.md"), agents_content).unwrap();

    let unexecutable_script = temp.path().join("unexecutable_stub.sh");
    fs::write(&unexecutable_script, "#!/bin/bash\necho hello\n").unwrap();
    let mut perms = fs::metadata(&unexecutable_script).unwrap().permissions();
    perms.set_mode(0o644); // readable, not executable
    fs::set_permissions(&unexecutable_script, perms).unwrap();

    let mut config2 = WorkerConfig::default();
    config2.workspace_dir = ws2.clone();
    config2.executor_type = ExecutorType::TestStub;
    config2.agent_executable = unexecutable_script;

    let runner2 = Runner::new(config2, None);
    let r2 = runner2
        .run_task(&ws2, &prompt_file, Some("job-c5-unexec".to_string()), None)
        .await
        .unwrap();
    assert_eq!(r2.execution_status, "BLOCKED");
    assert_eq!(r2.error.as_ref().unwrap().code, "EXECUTOR_UNEXECUTABLE");

    // 3. Unwritable workspace directory checked directly via precheck
    let ws3 = temp.path().join("ws_unwritable");
    fs::create_dir_all(&ws3).unwrap();
    fs::write(ws3.join("AGENTS.md"), agents_content).unwrap();
    let mut ws3_perms = fs::metadata(&ws3).unwrap().permissions();
    ws3_perms.set_mode(0o555); // Read & execute only, no write
    fs::set_permissions(&ws3, ws3_perms).unwrap();

    let err = run_fast_local_precheck(&ws3, &config, None).unwrap_err();
    assert_eq!(err.error_code(), "WORKSPACE_UNUSABLE");

    // Restore permissions for tempdir cleanup
    let mut fix_perms = fs::metadata(&ws3).unwrap().permissions();
    fix_perms.set_mode(0o755);
    fs::set_permissions(&ws3, fix_perms).unwrap();
}

#[tokio::test]
async fn test_6_inconsistent_doctor_f_before_f_after_mismatch_aborts() {
    let temp = tempdir().unwrap();
    // Stub mode "modify_agents_in_doctor" modifies AGENTS.md during Turn 1
    let (ws, prompt_file) =
        setup_test_workspace(temp.path(), "RULE-MARKER-C6", "modify_agents_in_doctor");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config, None);
    let receipt = runner
        .run_task(
            &ws,
            &prompt_file,
            Some("job-c6-inconsistent".to_string()),
            None,
        )
        .await
        .unwrap();

    assert_eq!(receipt.execution_status, "BLOCKED");
    let err = receipt.error.expect("Should have error");
    assert_eq!(err.code, "CONFIG_CHANGED_DURING_DOCTOR");

    // Must NOT create cache file
    let cache_file = doctor_cache_file(&ws);
    assert!(
        !cache_file.exists(),
        "Cache file must not be created on F_before != F_after"
    );
}

#[tokio::test]
async fn test_7_ttl_expiration_and_clock_rollback() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C7", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);
    let r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c7-r1".to_string()), None)
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);

    let cache_file = doctor_cache_file(&ws);
    assert!(cache_file.exists());

    // 1. Manually expire cache (> 86400 seconds)
    let mut cache_record = load_cache(&ws).unwrap();
    cache_record.checked_at = Utc::now() - Duration::seconds(86405);
    save_cache(&ws, &cache_record).unwrap();

    let r2 = runner
        .run_task(&ws, &prompt_file, Some("job-c7-r2".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r2.doctor_cache_hit,
        "Cache older than 24h must expire and trigger MISS"
    );

    // 2. Simulate clock rollback (checked_at in future relative to now)
    let mut cache_record2 = load_cache(&ws).unwrap();
    cache_record2.checked_at = Utc::now() + Duration::seconds(300);
    save_cache(&ws, &cache_record2).unwrap();

    let r3 = runner
        .run_task(&ws, &prompt_file, Some("job-c7-r3".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r3.doctor_cache_hit,
        "Clock rollback (now < checked_at) must trigger MISS"
    );
}

#[tokio::test]
async fn test_8_selective_invalidation() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C8", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);

    // Initial run populates cache
    let r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c8-r1".to_string()), None)
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);
    let cache_file = doctor_cache_file(&ws);
    assert!(cache_file.exists());

    // Switch mode to business_failure
    fs::write(ws.join(".stub_mode"), "business_failure").unwrap();
    let r2 = runner
        .run_task(&ws, &prompt_file, Some("job-c8-r2".to_string()), None)
        .await
        .unwrap();
    assert!(r2.doctor_cache_hit, "Should still hit cache on start");
    assert_eq!(r2.execution_status, "FAILED");
    assert_eq!(r2.business_outcome, BusinessOutcome::Failed);
    // Cache must BE PRESERVED despite business failure!
    assert!(
        cache_file.exists(),
        "Business failure must NOT invalidate doctor cache"
    );

    // Switch mode to permission_error_in_task (authorized path denied)
    fs::write(ws.join(".stub_mode"), "permission_error_in_task").unwrap();
    let r3 = runner
        .run_task(&ws, &prompt_file, Some("job-c8-r3".to_string()), None)
        .await
        .unwrap();
    assert_eq!(r3.execution_status, "FAILED");
    // Cache MUST BE INVALIDATED due to permission denial on workspace path!
    assert!(
        !cache_file.exists(),
        "Workspace permission failure must INVALIDATE doctor cache"
    );

    // Next run must re-execute Doctor
    fs::write(ws.join(".stub_mode"), "normal").unwrap();
    let r4 = runner
        .run_task(&ws, &prompt_file, Some("job-c8-r4".to_string()), None)
        .await
        .unwrap();
    assert!(
        !r4.doctor_cache_hit,
        "Run after invalidation must execute full doctor"
    );
}

#[tokio::test]
async fn test_9_ineligible_fingerprint_runs_without_caching() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C9", "normal");

    // Create an unreadable file in .agents/skills/
    let skills_dir = ws.join(".agents").join("skills");
    fs::create_dir_all(&skills_dir).unwrap();
    let unreadable_skill = skills_dir.join("unreadable.md");
    fs::write(&unreadable_skill, "# Unreadable Skill\n").unwrap();
    let mut perms = fs::metadata(&unreadable_skill).unwrap().permissions();
    perms.set_mode(0o000); // completely unreadable
    fs::set_permissions(&unreadable_skill, perms).unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);
    let _r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c9-r1".to_string()), None)
        .await
        .unwrap();

    // Doctor ran, task completed, but because cache_eligible == false, no cache is persisted
    let cache_file = doctor_cache_file(&ws);
    assert!(
        !cache_file.exists(),
        "Ineligible fingerprint must NOT persist cache"
    );

    // Subsequent run still misses cache
    let r2 = runner
        .run_task(&ws, &prompt_file, Some("job-c9-r2".to_string()), None)
        .await
        .unwrap();
    assert!(!r2.doctor_cache_hit);

    // Restore permissions for tempdir cleanup
    let mut fix_perms = fs::metadata(&unreadable_skill).unwrap().permissions();
    fix_perms.set_mode(0o644);
    fs::set_permissions(&unreadable_skill, fix_perms).unwrap();
}

#[tokio::test]
async fn test_10_force_doctor_flag() {
    let temp = tempdir().unwrap();
    let (ws, prompt_file) = setup_test_workspace(temp.path(), "RULE-MARKER-C10", "normal");

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = get_stub_bin();

    let runner = Runner::new(config.clone(), None);

    // Run 1: caches
    let r1 = runner
        .run_task(&ws, &prompt_file, Some("job-c10-r1".to_string()), None)
        .await
        .unwrap();
    assert!(!r1.doctor_cache_hit);

    // Run 2 with force_doctor = true
    let r2 = runner
        .run_task_with_options(
            &ws,
            &prompt_file,
            Some("job-c10-r2".to_string()),
            None,
            true, // force_doctor
        )
        .await
        .unwrap();

    assert!(
        !r2.doctor_cache_hit,
        "force_doctor must bypass cache hit and run full probe"
    );
    assert!(r2.doctor.is_some());
    assert!(r2.current_doctor_metrics.is_some());

    // Run 3 without force_doctor -> Hit
    let r3 = runner
        .run_task(&ws, &prompt_file, Some("job-c10-r3".to_string()), None)
        .await
        .unwrap();
    assert!(
        r3.doctor_cache_hit,
        "Subsequent run without force_doctor must HIT cache"
    );
}

#[tokio::test]
async fn test_11_standalone_doctor_stdin_write_failure_reports_not_ready() {
    let temp = tempdir().unwrap();
    let (ws, _prompt) = setup_test_workspace(temp.path(), "RULE-MARKER-C11", "normal");
    // Create an executable that exits immediately without reading stdin
    let exit_bin = temp.path().join("exit_stub.sh");
    fs::write(&exit_bin, "#!/bin/sh\nexit 1\n").unwrap();
    let mut perms = fs::metadata(&exit_bin).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&exit_bin, perms).unwrap();

    let mut config = WorkerConfig::default();
    config.workspace_dir = ws.clone();
    config.executor_type = ExecutorType::TestStub;
    config.agent_executable = exit_bin;

    let runner = Runner::new(config, None);
    let report = runner.run_standalone_doctor(&ws).await.unwrap();

    assert!(!report.ready);
    let err = report.error.expect("error message present");
    assert!(
        err.contains("Failed to send doctor message to child stdin"),
        "error must point to stdin write failure: {err}"
    );
    let stdin_check = report
        .checks
        .iter()
        .find(|c| c.name == "stdin_write")
        .expect("stdin_write check item must be present");
    assert!(!stdin_check.passed);
    assert!(
        !doctor_cache_file(&ws).exists(),
        "cache must not be updated on stdin failure"
    );
}
