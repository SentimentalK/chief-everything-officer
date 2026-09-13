use ceo_worker::bridge::controller::ensure_pending_and_clear_active;
use ceo_worker::bridge::outbox::{list_pending, PendingReportRecord, OUTBOX_SCHEMA_VERSION};
use ceo_worker::bridge::protocol::ExecutionReportRequest;
use ceo_worker::bridge::report::{
    load_saved_report, validate_pending_against_evidence, ReportError,
};
use ceo_worker::bridge::state::{
    self, new_history_record, ActiveAttempt, BridgeBinding, BridgeState, LocalPhase,
};
use ceo_worker::receipt::{ExecutorInfo, LogSummary, TaskReceipt, TimestampsInfo};
use ceo_worker::runner::control::BridgeReceiptContext;
use ceo_worker::verifier::BusinessOutcome;
use chrono::{TimeZone, Utc};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const JOB: &str = "job-123e4567-e89b-12d3-a456-426614174002";
const ATT: &str = "123e4567-e89b-12d3-a456-4266141740cc";
const WRK: &str = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FINISHED_MS: i64 = 1_780_000_000_000;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn hex64() -> String {
    "ab".repeat(32)
}

fn write_key(dir: &Path) -> PathBuf {
    let p = dir.join("key");
    std::fs::write(&p, "test-secret-key\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    p
}

fn write_config(dir: &Path, workspace: &Path) -> ceo_worker::bridge::config::BridgeConfig {
    let key = write_key(dir);
    let cfg_path = dir.join("bridge.json");
    let json = format!(
        r#"{{"schema_version":1,"server_url":"https://ceo.example.com","api_key_file":{:?},"expected_identity":{{"user_id":"usr_report","workspace_id":"ws_report"}},"workspaces":{{"tools":{:?}}}}}"#,
        key.display().to_string(),
        workspace.display().to_string()
    );
    std::fs::write(&cfg_path, json).unwrap();
    ceo_worker::bridge::config::BridgeConfig::load(&cfg_path).unwrap()
}

fn binding(workspace: &Path) -> BridgeBinding {
    BridgeBinding {
        server_origin: "https://ceo.example.com".to_string(),
        user_id: "usr_report".to_string(),
        workspace_id: "ws_report".to_string(),
        workspace_ref: "tools".to_string(),
        canonical_workspace: workspace.to_path_buf(),
    }
}

fn finished_at() -> chrono::DateTime<Utc> {
    Utc.timestamp_millis_opt(FINISHED_MS).unwrap()
}

fn receipt_template(workspace: &Path) -> TaskReceipt {
    TaskReceipt {
        job_id: JOB.to_string(),
        attempt_id: ATT.to_string(),
        workspace: workspace.display().to_string(),
        prompt_file: workspace.join("prompt.md").display().to_string(),
        prompt_sha256: hex64(),
        execution_status: "COMPLETED".to_string(),
        business_outcome: BusinessOutcome::Unverified,
        executor: ExecutorInfo {
            executor_type: "test_stub".to_string(),
            version: "test".to_string(),
            conversation_id: None,
        },
        doctor: None,
        doctor_cache_hit: false,
        local_check_duration_ms: 0,
        current_doctor_metrics: None,
        cached_doctor_metrics: None,
        timestamps: TimestampsInfo {
            started_at: finished_at(),
            finished_at: finished_at(),
            duration_ms: 0,
        },
        artifacts: Vec::new(),
        logs: LogSummary {
            events_path: "events.jsonl".to_string(),
            stdout_path: "stdout.log".to_string(),
            stderr_path: "stderr.log".to_string(),
            stdout_snippet: "secret prompt should not leak".to_string(),
            stderr_snippet: String::new(),
            dropped_lines_count: 0,
            log_truncated: false,
        },
        error: None,
        bridge_context: Some(BridgeReceiptContext {
            server_origin: "https://ceo.example.com".to_string(),
            user_id: "usr_report".to_string(),
            workspace_id: "ws_report".to_string(),
            workspace_ref: "tools".to_string(),
            worker_id: WRK.to_string(),
            job_id: JOB.to_string(),
            attempt_id: ATT.to_string(),
            source_prompt_sha256: hex64(),
            acceptance_sha256: hex64(),
            task_dispatch_intent: true,
            stop_reason: None,
        }),
    }
}

fn persist_valid_fixture(workspace: &Path) -> (BridgeBinding, ExecutionReportRequest, Vec<u8>) {
    let parent = workspace.parent().unwrap();
    let cfg = write_config(parent, workspace);
    let canon = cfg.resolve_workspace("tools").cloned().unwrap();
    let bind = binding(&canon);
    let mut state = BridgeState::new(bind.clone());
    state.worker_id = WRK.to_string();
    state.persist(&canon).unwrap();

    let mut receipt = receipt_template(&canon);
    receipt.workspace = canon.display().to_string();
    let attempt_dir = ceo_worker::config::safe_attempt_dir(&canon, JOB, ATT).unwrap();
    std::fs::create_dir_all(&attempt_dir).unwrap();
    let receipt_path = attempt_dir.join("receipt.json");
    receipt.persist_to_file(&receipt_path).unwrap();
    let receipt_bytes = std::fs::read(&receipt_path).unwrap();
    let rec_sha = sha256_hex(&receipt_bytes);

    let hist = new_history_record(
        &bind,
        WRK,
        JOB,
        ATT,
        &hex64(),
        &hex64(),
        &hex64(),
        &rec_sha,
        true,
        TOKEN,
    );
    hist.persist(&canon).unwrap();
    let req = load_saved_report(&cfg, "tools", JOB, ATT).unwrap();
    (bind, req, receipt_bytes)
}

fn canon_workspace(root: &Path) -> PathBuf {
    let ws = root.join("tools");
    std::fs::create_dir(&ws).unwrap();
    persist_valid_fixture(&ws);
    write_config(root, &ws)
        .resolve_workspace("tools")
        .cloned()
        .unwrap()
}

#[test]
fn valid_outbox_round_trip_is_0600() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    let pending = PendingReportRecord::from_request(&bind, JOB, req.clone()).unwrap();
    pending.persist(&canon).unwrap();
    let loaded = PendingReportRecord::load(&canon, JOB, ATT, &bind).unwrap();
    assert_eq!(loaded.schema_version, OUTBOX_SCHEMA_VERSION);
    assert_eq!(loaded.request, req);
    assert_eq!(loaded.receipt_sha256, req.report.receipt_sha256);
    let path = state::outbox_record_path(&canon, JOB, ATT);
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let dbg = format!("{loaded:?}");
    assert!(dbg.contains("[redacted]"));
    assert!(!dbg.contains(TOKEN));
    assert!(!dbg.contains("secret prompt should not leak"));
}

#[test]
fn malformed_schema_and_binding_and_identity_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    let pending = PendingReportRecord::from_request(&bind, JOB, req).unwrap();
    pending.persist(&canon).unwrap();
    let path = state::outbox_record_path(&canon, JOB, ATT);
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v["schema_version"] = serde_json::json!(99);
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    assert!(PendingReportRecord::load(&canon, JOB, ATT, &bind).is_err());

    pending.persist(&canon).unwrap();
    let mut other = bind.clone();
    other.user_id = "usr_other".to_string();
    assert!(PendingReportRecord::load(&canon, JOB, ATT, &other).is_err());
}

#[test]
fn request_identity_and_receipt_hash_mismatch_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    let pending = PendingReportRecord::from_request(&bind, JOB, req).unwrap();
    pending.persist(&canon).unwrap();
    let path = state::outbox_record_path(&canon, JOB, ATT);
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v["request"]["attempt_id"] = serde_json::json!("123e4567-e89b-12d3-a456-4266141740dd");
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    assert!(PendingReportRecord::load(&canon, JOB, ATT, &bind).is_err());

    pending.persist(&canon).unwrap();
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v["receipt_sha256"] = serde_json::json!("ff".repeat(32));
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    assert!(PendingReportRecord::load(&canon, JOB, ATT, &bind).is_err());
}

#[test]
fn verified_request_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let mut req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    req.report.business_outcome = "VERIFIED".to_string();
    assert!(PendingReportRecord::from_request(&bind, JOB, req).is_err());
}

#[test]
fn symlink_ancestor_rejects_outbox_persist() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    let pending = PendingReportRecord::from_request(&bind, JOB, req).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let ceo = canon.join(".ceo");
    std::fs::remove_dir_all(&ceo).ok();
    symlink(outside.path(), &ceo).unwrap();
    assert!(pending.persist(&canon).is_err());
}

#[test]
fn corrupt_pending_is_not_skipped_by_list() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    state::ensure_control_dirs(&canon).unwrap();
    std::fs::write(state::outbox_dir(&canon).join("not-a-record.json"), b"{").unwrap();
    assert!(list_pending(&canon, &bind).is_err());
}

#[test]
fn evidence_mismatch_rejects_tampered_status() {
    let root = tempfile::tempdir().unwrap();
    let canon = canon_workspace(root.path());
    let bind = binding(&canon);
    let req = load_saved_report(&write_config(root.path(), &canon), "tools", JOB, ATT).unwrap();
    let pending = PendingReportRecord::from_request(&bind, JOB, req).unwrap();
    pending.persist(&canon).unwrap();
    let path = state::outbox_record_path(&canon, JOB, ATT);
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    v["request"]["report"]["execution_status"] = serde_json::json!("FAILED");
    v["request"]["report"]["business_outcome"] = serde_json::json!("FAILED");
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
    let loaded = PendingReportRecord::load(&canon, JOB, ATT, &bind).unwrap();
    let err = validate_pending_against_evidence(&canon, &bind, WRK, &loaded).unwrap_err();
    match err {
        ReportError::Local { code, .. } => assert_eq!(code, "OUTBOX_EVIDENCE_MISMATCH"),
        other => panic!("expected evidence mismatch, got {other}"),
    }
}

#[test]
fn outbox_write_failure_leaves_active() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let (bind, req, receipt_bytes) = persist_valid_fixture(&ws);
    let canon = bind.canonical_workspace.clone();
    let hist = state::AttemptHistoryRecord::load(&canon, JOB, ATT)
        .unwrap()
        .unwrap();
    let mut state = BridgeState::load(&state::state_path(&canon), &bind).unwrap();
    state.active = Some(ActiveAttempt {
        job_id: JOB.to_string(),
        attempt_id: ATT.to_string(),
        claim_token: TOKEN.to_string(),
        phase: LocalPhase::DispatchIntent,
        claim: None,
        runner_boot_id: None,
        process: None,
        task_dispatch_intent: true,
        stop_error: None,
    });
    state.persist(&canon).unwrap();

    let outbox = state::outbox_dir(&canon);
    std::fs::remove_dir_all(&outbox).ok();
    std::fs::write(&outbox, b"not-a-dir").unwrap();
    let err = ensure_pending_and_clear_active(
        &canon,
        &bind,
        WRK,
        &mut state,
        JOB,
        ATT,
        &hist,
        &receipt_bytes,
    );
    assert!(err.is_err());
    assert!(state.active.is_some());
    let reloaded = BridgeState::load(&state::state_path(&canon), &bind).unwrap();
    assert!(reloaded.active.is_some());
    let _ = req;
}
