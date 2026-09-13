use ceo_worker::bridge::config::BridgeConfig;
use ceo_worker::bridge::protocol::ExecutionReportRequest;
use ceo_worker::bridge::report::{load_saved_report, ReportError};
use ceo_worker::bridge::state::{
    new_history_record, ActiveAttempt, BridgeBinding, BridgeState, LocalPhase,
    HISTORY_SCHEMA_VERSION,
};
use ceo_worker::receipt::{ExecutorInfo, LogSummary, ReceiptError, TaskReceipt, TimestampsInfo};
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

fn write_config(dir: &Path, workspace: &Path) -> (PathBuf, BridgeConfig) {
    let key = write_key(dir);
    let cfg_path = dir.join("bridge.json");
    let json = format!(
        r#"{{"schema_version":1,"server_url":"https://ceo.example.com","api_key_file":{:?},"expected_identity":{{"user_id":"usr_report","workspace_id":"ws_report"}},"workspaces":{{"tools":{:?}}}}}"#,
        key.display().to_string(),
        workspace.display().to_string()
    );
    std::fs::write(&cfg_path, json).unwrap();
    let cfg = BridgeConfig::load(&cfg_path).unwrap();
    (cfg_path, cfg)
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

fn receipt(workspace: &Path, patch_status: &str, outcome: BusinessOutcome) -> TaskReceipt {
    TaskReceipt {
        job_id: JOB.to_string(),
        attempt_id: ATT.to_string(),
        workspace: workspace.display().to_string(),
        prompt_file: workspace.join("prompt.md").display().to_string(),
        prompt_sha256: hex64(),
        execution_status: patch_status.to_string(),
        business_outcome: outcome,
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

fn persist_valid_fixture(workspace: &Path, receipt: &TaskReceipt) -> (BridgeConfig, Vec<u8>) {
    let parent = workspace.parent().unwrap();
    let (_, cfg) = write_config(parent, workspace);
    let canon = cfg.resolve_workspace("tools").cloned().unwrap();
    let bind = binding(&canon);
    let mut state = BridgeState::new(bind.clone());
    state.worker_id = WRK.to_string();
    state.persist(&canon).unwrap();

    let mut receipt = receipt.clone();
    receipt.workspace = canon.display().to_string();
    let attempt_dir = ceo_worker::config::safe_attempt_dir(&canon, JOB, ATT).unwrap();
    std::fs::create_dir_all(&attempt_dir).unwrap();
    let receipt_path = attempt_dir.join("receipt.json");
    receipt.persist_to_file(&receipt_path).unwrap();
    let receipt_bytes = std::fs::read(&receipt_path).unwrap();
    let rec_sha = sha256_hex(&receipt_bytes);

    let task_dispatch_intent = receipt
        .bridge_context
        .as_ref()
        .map(|b| b.task_dispatch_intent)
        .unwrap_or(true);
    let hist = new_history_record(
        &bind,
        WRK,
        JOB,
        ATT,
        &hex64(),
        &hex64(),
        &hex64(),
        &rec_sha,
        task_dispatch_intent,
        TOKEN,
    );
    hist.persist(&canon).unwrap();
    (cfg, receipt_bytes)
}

fn load_ok(cfg: &BridgeConfig) -> ExecutionReportRequest {
    load_saved_report(cfg, "tools", JOB, ATT).expect("valid local report")
}

#[test]
fn valid_bridge_receipt_projects_exact_request_fields() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    let (cfg, bytes) = persist_valid_fixture(&ws, &rec);
    let req = load_ok(&cfg);
    assert_eq!(req.worker_id, WRK);
    assert_eq!(req.attempt_id, ATT);
    assert_eq!(req.claim_token, TOKEN);
    assert_eq!(req.report.schema_version, 2);
    assert_eq!(req.report.execution_status, "COMPLETED");
    assert_eq!(req.report.business_outcome, "UNVERIFIED");
    assert!(req.report.task_dispatched);
    assert_eq!(req.report.finished_at_ms, FINISHED_MS);
    assert_eq!(req.report.duration_ms, 0);
    assert_eq!(req.report.executor.r#type, "test_stub");
    assert_eq!(req.report.executor.version, "test");
    assert_eq!(req.report.receipt_sha256, sha256_hex(&bytes));
    assert_eq!(req.report.error, None);
    let again = load_ok(&cfg);
    assert_eq!(
        serde_json::to_vec(&req).unwrap(),
        serde_json::to_vec(&again).unwrap()
    );
    let dbg = format!("{req:?}");
    assert!(dbg.contains("[redacted]"));
    assert!(!dbg.contains(TOKEN));
    assert!(!dbg.contains("secret prompt should not leak"));
}

#[test]
fn missing_history_or_hash_or_active_does_not_build_a_request() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    let (cfg, _) = persist_valid_fixture(&ws, &rec);

    let canon = cfg.resolve_workspace("tools").cloned().unwrap();
    let hist = ceo_worker::bridge::state::history_record_path(&canon, JOB, ATT);
    std::fs::remove_file(&hist).unwrap();
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "HISTORY_MISSING"),
        other => panic!("expected HISTORY_MISSING, got {other:?}"),
    }

    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    let canon = cfg.resolve_workspace("tools").cloned().unwrap();
    let attempt_dir = ceo_worker::config::safe_attempt_dir(&canon, JOB, ATT).unwrap();
    std::fs::write(attempt_dir.join("receipt.json"), b"{\"tampered\":true}").unwrap();
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "RECEIPT_HASH_MISMATCH"),
        other => panic!("expected RECEIPT_HASH_MISMATCH, got {other:?}"),
    }
}

#[test]
fn active_attempt_identity_mismatch_and_invalid_ids_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    let (cfg, _) = persist_valid_fixture(&ws, &rec);

    let canon = cfg.resolve_workspace("tools").cloned().unwrap();
    let bind = binding(&canon);
    let mut state = BridgeState::new(bind);
    state.worker_id = WRK.to_string();
    state.active = Some(ActiveAttempt {
        job_id: JOB.to_string(),
        attempt_id: ATT.to_string(),
        claim_token: TOKEN.to_string(),
        phase: LocalPhase::ClaimIntent,
        claim: None,
        runner_boot_id: None,
        process: None,
        task_dispatch_intent: false,
        stop_error: None,
    });
    state.persist(&canon).unwrap();
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "ACTIVE_ATTEMPT"),
        other => panic!("expected ACTIVE_ATTEMPT, got {other:?}"),
    }

    match load_saved_report(&cfg, "tools", "not-a-job", ATT) {
        Err(ReportError::InvalidId("job_id")) => {}
        other => panic!("expected invalid job_id, got {other:?}"),
    }
    match load_saved_report(&cfg, "tools", JOB, "not-a-uuid") {
        Err(ReportError::InvalidId("attempt_id")) => {}
        other => panic!("expected invalid attempt_id, got {other:?}"),
    }
}

#[test]
fn no_bridge_context_verified_and_illegal_status_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();

    let mut local_only = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    local_only.bridge_context = None;
    let (cfg, _) = persist_valid_fixture(&ws, &local_only);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "RECEIPT_INVALID"),
        other => panic!("expected RECEIPT_INVALID, got {other:?}"),
    }

    let verified = receipt(&ws, "COMPLETED", BusinessOutcome::Verified);
    let (cfg, _) = persist_valid_fixture(&ws, &verified);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "VERIFIED_REJECTED"),
        other => panic!("expected VERIFIED_REJECTED, got {other:?}"),
    }

    let unknown = receipt(&ws, "UNKNOWN_STATUS", BusinessOutcome::Unverified);
    let (cfg, _) = persist_valid_fixture(&ws, &unknown);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "UNSUPPORTED_STATUS"),
        other => panic!("expected UNSUPPORTED_STATUS, got {other:?}"),
    }
}

#[test]
fn oversized_or_blank_error_is_rejected_and_output_stays_safe() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let mut rec = receipt(&ws, "FAILED", BusinessOutcome::Failed);
    rec.error = Some(ReceiptError {
        stage: "task".to_string(),
        code: "STDIN_WRITE_FAILED".to_string(),
        message: "x".repeat(2 * 1024 + 1),
    });
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, message }) => {
            assert_eq!(code, "INVALID_REPORT");
            assert!(!message.contains("x".repeat(32).as_str()));
            assert!(!message.contains(TOKEN));
        }
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    rec.error = Some(ReceiptError {
        stage: "task".to_string(),
        code: "STDIN_WRITE_FAILED".to_string(),
        message: "   ".to_string(),
    });
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "INVALID_REPORT"),
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }
}

#[test]
fn recovery_receipts_cannot_be_reported() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();
    let mut rec = receipt(&ws, "INTERRUPTED", BusinessOutcome::Failed);
    rec.error = Some(ReceiptError {
        stage: "control".to_string(),
        code: "PROCESS_STOP_UNCONFIRMED".to_string(),
        message: "stop unconfirmed".to_string(),
    });
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "RECOVERY_REQUIRED"),
        other => panic!("expected RECOVERY_REQUIRED, got {other:?}"),
    }
}

#[test]
fn history_schema_constant_is_current() {
    assert_eq!(HISTORY_SCHEMA_VERSION, 2);
}

#[test]
fn terminal_status_matrix_coverage() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();

    let non_success_statuses = [
        ("FAILED", BusinessOutcome::Failed),
        ("TIMED_OUT", BusinessOutcome::Failed),
        ("BLOCKED", BusinessOutcome::Failed),
        ("CANCELLED", BusinessOutcome::Failed),
        ("INTERRUPTED", BusinessOutcome::Failed),
    ];

    for (status, outcome) in non_success_statuses {
        let mut rec = receipt(&ws, status, outcome);
        rec.timestamps.duration_ms = 4321;
        rec.error = Some(ReceiptError {
            stage: "task".to_string(),
            code: "TASK_FAILED".to_string(),
            message: format!("{status} occurred"),
        });
        rec.executor.executor_type = "agy".to_string();
        rec.executor.version = "Antigravity CLI 1.2.3 (build abc-123)".to_string();

        let (cfg, _) = persist_valid_fixture(&ws, &rec);
        let req = load_ok(&cfg);
        assert_eq!(req.report.schema_version, 2);
        assert_eq!(req.report.execution_status, status);
        assert_eq!(req.report.business_outcome, "FAILED");
        assert!(req.report.task_dispatched);
        assert_eq!(req.report.duration_ms, 4321);
        assert_eq!(req.report.executor.r#type, "agy");
        assert_eq!(
            req.report.executor.version,
            "Antigravity CLI 1.2.3 (build abc-123)"
        );
        assert!(req.report.error.is_some());
        assert_eq!(req.report.error.as_ref().unwrap().code, "TASK_FAILED");
    }
}

#[test]
fn report_v2_invariants_and_executor_bounds() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("tools");
    std::fs::create_dir(&ws).unwrap();

    // 1. COMPLETED + error must be rejected
    let mut rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    rec.error = Some(ReceiptError {
        stage: "task".to_string(),
        code: "UNEXPECTED".to_string(),
        message: "unexpected".to_string(),
    });
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, message }) => {
            assert_eq!(code, "INVALID_REPORT");
            assert!(message.contains("completed report must not have error"));
        }
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    // 2. FAILED + null error must be rejected
    let mut rec = receipt(&ws, "FAILED", BusinessOutcome::Failed);
    rec.error = None;
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, message }) => {
            assert_eq!(code, "INVALID_REPORT");
            assert!(message.contains("non-completed report must include error"));
        }
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    // 3. task_dispatched=false + UNVERIFIED must be rejected
    let mut rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    if let Some(bc) = rec.bridge_context.as_mut() {
        bc.task_dispatch_intent = false;
    }
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "INVALID_REPORT"),
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    // 4. task_dispatched=false + NOT_STARTED is accepted
    let mut rec = receipt(&ws, "FAILED", BusinessOutcome::NotStarted);
    if let Some(bc) = rec.bridge_context.as_mut() {
        bc.task_dispatch_intent = false;
    }
    rec.error = Some(ReceiptError {
        stage: "preflight".to_string(),
        code: "DOCTOR_PREFLIGHT_FAILED".to_string(),
        message: "doctor failed".to_string(),
    });
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    let req = load_ok(&cfg);
    assert!(!req.report.task_dispatched);
    assert_eq!(req.report.business_outcome, "NOT_STARTED");

    // 5. executor bounds: invalid type rejected
    let mut rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    rec.executor.executor_type = "bad@type".to_string();
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "INVALID_REPORT"),
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    // 6. executor bounds: version > 256 bytes rejected
    let mut rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    rec.executor.version = "v".repeat(257);
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "INVALID_REPORT"),
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }

    // 7. executor bounds: whitespace-only version rejected
    let mut rec = receipt(&ws, "COMPLETED", BusinessOutcome::Unverified);
    rec.executor.version = "   ".to_string();
    let (cfg, _) = persist_valid_fixture(&ws, &rec);
    match load_saved_report(&cfg, "tools", JOB, ATT) {
        Err(ReportError::Local { code, .. }) => assert_eq!(code, "INVALID_REPORT"),
        other => panic!("expected INVALID_REPORT, got {other:?}"),
    }
}
