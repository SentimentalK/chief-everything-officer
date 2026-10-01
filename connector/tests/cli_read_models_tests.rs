//! Wave 2A read-side UX tests: human output contracts, JSON machine
//! contracts, job list/show read models, and CLI parsing.

mod common;

use ceo_connector::cli::{Cli, Commands, JobSubcommands};
use ceo_connector::client::{
    ConnectorClient, JobDetail, JobExecutionPart, JobListResponse, JobReportErrorPart,
    JobReportExecutorPart, JobReportPart, JobResultMetaPart, JobSummaryItem, JobTaskPart,
};
use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{DiagnosticCheck, DiagnosticSeverity, DoctorReport};
use ceo_connector::jobs::{
    parse_state_filter, render_job_detail, render_job_list, JOB_STATE_FILTERS,
};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::status::{get_status, render_status_human};
use ceo_connector::targets::{build_target_display_items, render_target_blocks};
use clap::Parser;
use common::mock_server::{MockResponse, MockServer};

const LONG_TARGET_ID: &str = "tgt_327cac97b3764b3789751a55e7062c5d";
const LONG_PATH: &str = "/home/sentimentalk/codes/chief-everything-officer-sentimentalk-worktree-abc123/deeply/nested/workspace/dir";

fn sample_item() -> ceo_connector::targets::TargetDisplayItem {
    ceo_connector::targets::TargetDisplayItem {
        target_id: LONG_TARGET_ID.into(),
        alias: Some("chief-everything-officer".into()),
        kind: Some("coding".into()),
        local_path: Some(LONG_PATH.into()),
        status: "READY".into(),
        disabled: false,
        is_default_agent_runtime: true,
        active_binding_count: 1,
        repository: Some("SentimentalK/chief-everything-officer".into()),
        agent_id: Some("cursor".into()),
        agent_command: Some("/home/sentimentalk/.local/bin/agent".into()),
        model: None,
    }
}

// ---------------------------------------------------------------------------
// 1. Target list human output
// ---------------------------------------------------------------------------

#[test]
fn target_list_human_is_vertical_block_oriented() {
    let mut unbound = sample_item();
    unbound.target_id = "tgt_ffffffffffffffffffffffffffffffff".into();
    unbound.alias = Some("unbound-target".into());
    unbound.local_path = None;
    unbound.status = "UNBOUND".into();
    unbound.is_default_agent_runtime = false;
    unbound.agent_id = None;
    unbound.agent_command = None;

    let items = vec![sample_item(), unbound];
    let out = render_target_blocks(&items);

    // Block headers and vertical fields, each on their own line.
    assert!(out.contains("Target: chief-everything-officer\n"));
    assert!(out.contains("  ID: tgt_327cac97b3764b3789751a55e7062c5d\n"));
    assert!(out.contains("  Kind: coding\n"));
    assert!(out.contains("  Status: READY\n"));
    assert!(out.contains("  Default runtime: yes\n"));
    assert!(out.contains(&format!("  Path: {LONG_PATH}\n")));
    assert!(out.contains("  Agent: cursor\n"));
    assert!(out.contains("  Command: /home/sentimentalk/.local/bin/agent\n"));

    // Unbound target: no local path, no executor, default runtime off.
    assert!(out.contains("  Path: <not bound locally>\n"));
    assert!(out.contains("  Agent: <not configured>\n"));
    assert!(out.contains("  Status: UNBOUND\n"));

    // No fixed-width table header or separator rows.
    assert!(!out.contains("TARGET_ID"));
    assert!(!out.contains("LOCAL_PATH"));
    assert!(!out.contains("---"));

    // Long lines must never be padded to a table column: each field line
    // ends immediately after its value.
    for line in out.lines() {
        if let Some(value) = line.strip_prefix("  Path: ") {
            assert_eq!(value.trim_end(), value, "path line must not be padded");
        }
    }
}

#[test]
fn target_list_human_empty_state() {
    let out = render_target_blocks(&[]);
    assert!(out.contains("No targets configured."));
}

#[tokio::test]
async fn target_list_json_emits_valid_json_with_expected_fields() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_json",
                            "workspace_id": "ws_1",
                            "alias": "json-target",
                            "display_name": "JSON Target",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": true
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 2
                    }]
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    let local_dir = temp.path().join("json-target-dir");
    std::fs::create_dir_all(&local_dir).unwrap();
    config.targets.insert(
        "tgt_json".into(),
        LocalTarget {
            local_path: local_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new("cursor".into(), "/bin/agent".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let items = build_target_display_items(&paths).await.unwrap();
    assert_eq!(items.len(), 1);

    // The --json contract: parseable JSON with the documented fields.
    let json = serde_json::to_string_pretty(&items).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let first = parsed
        .as_array()
        .unwrap()
        .first()
        .unwrap()
        .as_object()
        .unwrap();
    assert_eq!(first["target_id"], "tgt_json");
    assert_eq!(first["alias"], "json-target");
    assert_eq!(first["kind"], "coding");
    assert_eq!(first["status"], "READY");
    assert_eq!(first["is_default_agent_runtime"], true);
    assert_eq!(first["active_binding_count"], 2);
    assert_eq!(first["agent_id"], "cursor");
    assert_eq!(first["agent_command"], "/bin/agent");
    assert_eq!(first["local_path"], local_dir.display().to_string());
}

// ---------------------------------------------------------------------------
// 3. Status human + JSON
// ---------------------------------------------------------------------------

#[test]
fn status_human_and_json_preserve_facts_and_expose_connector_root() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let status = get_status(&paths).unwrap();

    // JSON: parseable, preserves existing facts, exposes connector root.
    let json = serde_json::to_string_pretty(&status).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["logged_in"], false);
    assert_eq!(parsed["daemon_running"], false);
    assert_eq!(parsed["paused"], false);
    assert_eq!(parsed["target_count"], 0);
    assert_eq!(parsed["outbox_pending_count"], 0);
    assert_eq!(
        parsed["connector_root"],
        temp.path().join("root").display().to_string()
    );
    assert_eq!(parsed["connector_version"], env!("CARGO_PKG_VERSION"));

    // Human: compact vertical block exposing connector root.
    let human = render_status_human(&status);
    assert!(human.contains("Logged in: false"));
    assert!(human.contains("Daemon running: false"));
    assert!(human.contains("Paused: false"));
    assert!(human.contains("Local targets: 0"));
    assert!(human.contains("Active attempt: <none>"));
    assert!(human.contains("Outbox pending: 0"));
    assert!(human.contains(&format!(
        "Connector root: {}",
        temp.path().join("root").display()
    )));
    assert!(!human.contains("==="));
}

// ---------------------------------------------------------------------------
// 4. Doctor human + JSON
// ---------------------------------------------------------------------------

fn sample_report() -> DoctorReport {
    DoctorReport {
        checks: vec![
            DiagnosticCheck {
                name: "Connector Root".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Valid (0700) at {LONG_PATH}/.ceo/connector"),
            },
            DiagnosticCheck {
                name: "Credential Expiry".into(),
                severity: DiagnosticSeverity::Warn,
                message: "Credential expires in less than 7 days".into(),
            },
            DiagnosticCheck {
                name: "Target 'x' Repo Match".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Target repository mismatch: expected 'a/b', but local git remote origin is 'c/d'".into(),
            },
        ],
        overall_passed: false,
    }
}

#[test]
fn doctor_human_preserves_pass_warn_fail_semantics_without_table_layout() {
    let report = sample_report();
    let out = ceo_connector::doctor::render_doctor_human(&report);

    assert!(out.contains("[PASS] Connector Root"));
    assert!(out.contains("[WARN] Credential Expiry"));
    assert!(out.contains("[FAIL] Target 'x' Repo Match"));
    assert!(out.contains("Result: DOCTOR DETECTED ONE OR MORE FAILURES"));

    // Long paths/IDs appear verbatim on their own message lines.
    assert!(out.contains(&format!("{LONG_PATH}/.ceo/connector")));

    // No fixed-width column alignment: no padded check-name columns.
    assert!(!out.contains("PASS  "));
    assert!(!out.contains("---"));

    // Healthy report wording preserved.
    let mut healthy = sample_report();
    healthy.checks = vec![DiagnosticCheck {
        name: "Git Executable".into(),
        severity: DiagnosticSeverity::Pass,
        message: "git version 2.43.0".into(),
    }];
    healthy.overall_passed = true;
    let healthy_out = ceo_connector::doctor::render_doctor_human(&healthy);
    assert!(healthy_out.contains("Result: ALL REQUIRED CHECKS PASSED"));
}

#[test]
fn doctor_json_is_clean_and_preserves_check_semantics() {
    let report = sample_report();
    let json = serde_json::to_string_pretty(&report).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["overall_passed"], false);
    let checks = parsed["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 3);
    assert_eq!(checks[0]["severity"], "Pass");
    assert_eq!(checks[1]["severity"], "Warn");
    assert_eq!(checks[2]["severity"], "Fail");
    assert_eq!(checks[2]["name"], "Target 'x' Repo Match");
}

// ---------------------------------------------------------------------------
// 5. Job list: filter mapping, rendering, JSON
// ---------------------------------------------------------------------------

fn summary(job_id: &str, state: &str, exec: Option<&str>, outcome: Option<&str>) -> JobSummaryItem {
    JobSummaryItem {
        job_id: job_id.into(),
        request_id: format!("req-{job_id}"),
        target_id: "tgt_11111111111111111111111111111111".into(),
        target_alias: "chief-everything-officer".into(),
        state: state.into(),
        execution_status: exec.map(|s| s.into()),
        business_outcome: outcome.map(|s| s.into()),
        created_at: "2026-09-29T20:00:00.000Z".into(),
        expires_at: if state == "queued" {
            Some("2026-09-29T20:05:00.000Z".into())
        } else {
            None
        },
        resource_id: None,
        result_target: "none".into(),
    }
}

#[tokio::test]
async fn job_list_filter_mapping_to_query_string() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path.starts_with("/api/connector/jobs") && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({ "jobs": [], "next_cursor": null }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    client
        .list_jobs(
            &cred,
            &ceo_connector::client::JobListQuery {
                state: Some("running".into()),
                target_id: Some("tgt_abc".into()),
                limit: Some(5),
                cursor: None,
            },
        )
        .await
        .unwrap();

    client
        .list_jobs(&cred, &ceo_connector::client::JobListQuery::default())
        .await
        .unwrap();

    let reqs = server.requests();
    assert_eq!(reqs.len(), 2);
    let first_path = &reqs[0].path;
    assert!(
        first_path.starts_with("/api/connector/jobs?"),
        "{first_path}"
    );
    assert!(first_path.contains("state=running"), "{first_path}");
    assert!(first_path.contains("target_id=tgt_abc"), "{first_path}");
    assert!(first_path.contains("limit=5"), "{first_path}");
    assert_eq!(reqs[1].path, "/api/connector/jobs");
}

#[test]
fn job_list_human_renders_queued_running_terminal_blocks() {
    let res = JobListResponse {
        jobs: vec![
            summary("job-queued-1", "queued", None, None),
            summary("job-running-1", "running", None, None),
            summary(
                "job-terminal-1",
                "terminal",
                Some("FAILED"),
                Some("REJECTED"),
            ),
        ],
        next_cursor: Some("1696012345678-0".into()),
    };

    let out = render_job_list(&res);

    // Newest first is the server's ordering; the renderer preserves it.
    let idx_queued = out.find("Job: job-queued-1").unwrap();
    let idx_running = out.find("Job: job-running-1").unwrap();
    let idx_terminal = out.find("Job: job-terminal-1").unwrap();
    assert!(idx_queued < idx_running && idx_running < idx_terminal);

    assert!(out.contains("  State: queued\n"));
    assert!(out.contains("  State: running\n"));
    assert!(out.contains("  State: terminal\n"));
    assert!(out.contains("  Execution status: FAILED\n"));
    assert!(out.contains("  Business outcome: REJECTED\n"));
    assert!(out.contains("  Created: 2026-09-29T20:00:00.000Z\n"));
    assert!(out.contains("  Expires: 2026-09-29T20:05:00.000Z\n"));
    assert!(out.contains("Next cursor: 1696012345678-0"));
    assert!(!out.contains("JOB_ID"));
}

#[test]
fn job_list_json_is_clean_machine_output() {
    let res = JobListResponse {
        jobs: vec![summary("job-1", "running", None, None)],
        next_cursor: None,
    };
    let json = serde_json::to_string_pretty(&res).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let job = parsed["jobs"].as_array().unwrap().first().unwrap();
    assert_eq!(job["job_id"], "job-1");
    assert_eq!(job["state"], "running");
    assert_eq!(job["execution_status"], serde_json::Value::Null);
    assert_eq!(parsed["next_cursor"], serde_json::Value::Null);
}

// ---------------------------------------------------------------------------
// 6. Job show: running and terminal rendering, optional fields, JSON
// ---------------------------------------------------------------------------

fn running_detail() -> JobDetail {
    JobDetail {
        job_id: "job-327cac97-b376-4b37-8975-1a55e7062c5d".into(),
        request_id: "req-327cac97".into(),
        target_id: LONG_TARGET_ID.into(),
        target_alias: "chief-everything-officer".into(),
        state: "running".into(),
        execution_status: None,
        business_outcome: None,
        created_at: "2026-09-29T19:00:00.000Z".into(),
        expires_at: None,
        resource_id: None,
        result_target: "none".into(),
        execution_timeout_seconds: 3600,
        execution: Some(JobExecutionPart {
            attempt_id: "atm_327cac97".into(),
            phase: "running".into(),
            claimed_at: "2026-09-29T19:00:05.000Z".into(),
            started_at: Some("2026-09-29T19:00:07.000Z".into()),
        }),
        report: None,
        result: None,
        task: None,
    }
}

fn terminal_detail() -> JobDetail {
    let mut d = running_detail();
    d.state = "terminal".into();
    d.execution_status = Some("FAILED".into());
    d.business_outcome = Some("REJECTED".into());
    d.report = Some(JobReportPart {
        execution_status: "FAILED".into(),
        business_outcome: "REJECTED".into(),
        task_dispatched: true,
        finished_at: "2026-09-29T19:30:00.000Z".into(),
        duration_ms: 1_795_000,
        executor: JobReportExecutorPart {
            executor_type: "orca_tui".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "abc123".into(),
        error: Some(JobReportErrorPart {
            stage: "execution".into(),
            code: "EXECUTOR_FAILED".into(),
            message: "agent exited non-zero".into(),
        }),
        received_at: "2026-09-29T19:30:01.000Z".into(),
    });
    d.result = Some(JobResultMetaPart {
        target: "none".into(),
        attempt_id: "atm_327cac97".into(),
        payload_sha256: "def456".into(),
        resource_id: "res_1".into(),
        commit: "deadbeef".into(),
        received_at: "2026-09-29T19:30:02.000Z".into(),
    });
    d
}

#[test]
fn job_show_running_human_renders_attempt_block() {
    let out = render_job_detail(&running_detail());
    assert!(out.contains("Job: job-327cac97-b376-4b37-8975-1a55e7062c5d"));
    assert!(out.contains("  State: running\n"));
    assert!(out.contains("  Execution timeout: 3600s\n"));
    assert!(out.contains("  Attempt:\n"));
    assert!(out.contains("    ID: atm_327cac97\n"));
    assert!(out.contains("    Phase: running\n"));
    assert!(out.contains("    Started: 2026-09-29T19:00:07.000Z\n"));
    // Optional sections absent for a running job.
    assert!(!out.contains("Report:"));
    assert!(!out.contains("Result:"));
    assert!(!out.contains("Prompt:"));
}

#[test]
fn job_show_terminal_human_renders_report_and_result() {
    let out = render_job_detail(&terminal_detail());
    assert!(out.contains("  State: terminal\n"));
    assert!(out.contains("  Execution status: FAILED\n"));
    assert!(out.contains("  Business outcome: REJECTED\n"));
    assert!(
        out.contains("Error: stage=execution, code=EXECUTOR_FAILED, message=agent exited non-zero")
    );
    assert!(out.contains("  Result:\n"));
    assert!(out.contains("    Commit: deadbeef\n"));
}

#[test]
fn job_show_human_renders_task_block_when_included() {
    let mut d = running_detail();
    d.task = Some(JobTaskPart {
        prompt: "Fix the flaky test.\nRun cargo test twice.".into(),
        acceptance: "cargo test passes".into(),
        timeout_seconds: 3600,
    });
    let out = render_job_detail(&d);
    assert!(out.contains("  Prompt:\n"));
    assert!(out.contains("    Fix the flaky test.\n"));
    assert!(out.contains("    Run cargo test twice.\n"));
    assert!(out.contains("  Acceptance:\n"));
    assert!(out.contains("    cargo test passes\n"));
}

#[test]
fn job_show_json_is_clean_and_optionals_are_null_or_absent() {
    let running = serde_json::to_string_pretty(&running_detail()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&running).unwrap();
    assert_eq!(parsed["state"], "running");
    assert_eq!(parsed["execution_status"], serde_json::Value::Null);
    assert_eq!(parsed["report"], serde_json::Value::Null);
    assert!(parsed.get("task").is_none() || parsed["task"].is_null());

    let terminal = serde_json::to_string_pretty(&terminal_detail()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&terminal).unwrap();
    assert_eq!(parsed["state"], "terminal");
    assert_eq!(parsed["report"]["execution_status"], "FAILED");
    assert_eq!(parsed["report"]["error"]["code"], "EXECUTOR_FAILED");
    assert_eq!(parsed["result"]["commit"], "deadbeef");
}

#[tokio::test]
async fn job_show_include_task_maps_to_query_param() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path.starts_with("/api/connector/jobs/job-1") && req.method == "GET" {
            let body = if req.path.contains("include_task=true") {
                serde_json::json!({
                    "job_id": "job-1", "request_id": "req-1", "target_id": "tgt_1",
                    "target_alias": "t", "state": "running", "execution_status": null,
                    "business_outcome": null, "created_at": "2026-09-29T19:00:00.000Z",
                    "expires_at": null, "resource_id": null, "result_target": "none",
                    "execution_timeout_seconds": 3600, "execution": null, "report": null,
                    "result": null,
                    "task": { "prompt": "p", "acceptance": "a", "timeout_seconds": 3600 }
                })
            } else {
                serde_json::json!({
                    "job_id": "job-1", "request_id": "req-1", "target_id": "tgt_1",
                    "target_alias": "t", "state": "running", "execution_status": null,
                    "business_outcome": null, "created_at": "2026-09-29T19:00:00.000Z",
                    "expires_at": null, "resource_id": null, "result_target": "none",
                    "execution_timeout_seconds": 3600, "execution": null, "report": null,
                    "result": null
                })
            };
            return MockResponse::json(200, &body);
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let detail = client.get_job(&cred, "job-1", false).await.unwrap();
    assert!(detail.task.is_none());

    let detail = client.get_job(&cred, "job-1", true).await.unwrap();
    let task = detail.task.expect("task must parse when include_task=true");
    assert_eq!(task.prompt, "p");

    let reqs = server.requests();
    assert_eq!(reqs[0].path, "/api/connector/jobs/job-1");
    assert_eq!(reqs[1].path, "/api/connector/jobs/job-1?include_task=true");
}

// ---------------------------------------------------------------------------
// 7. Clap parsing for job commands
// ---------------------------------------------------------------------------

#[test]
fn clap_parses_job_list_and_show() {
    let cli = Cli::try_parse_from([
        "ceo-connector",
        "job",
        "list",
        "--state",
        "running",
        "--target-id",
        "tgt_abc",
        "--limit",
        "5",
        "--json",
    ])
    .unwrap();
    match cli.command {
        Commands::Job {
            sub:
                JobSubcommands::List {
                    json,
                    state,
                    target_id,
                    limit,
                    cursor,
                },
        } => {
            assert!(json);
            assert_eq!(state.as_deref(), Some("running"));
            assert_eq!(target_id.as_deref(), Some("tgt_abc"));
            assert_eq!(limit, Some(5));
            assert!(cursor.is_none());
        }
        other => panic!("unexpected parse: {other:?}"),
    }

    let cli = Cli::try_parse_from(["ceo-connector", "job", "show", "job-327cac97"]).unwrap();
    match cli.command {
        Commands::Job {
            sub:
                JobSubcommands::Show {
                    job_id,
                    json,
                    include_task,
                },
        } => {
            assert_eq!(job_id, "job-327cac97");
            assert!(!json);
            assert!(!include_task);
        }
        other => panic!("unexpected parse: {other:?}"),
    }

    let cli = Cli::try_parse_from([
        "ceo-connector",
        "job",
        "show",
        "job-1",
        "--json",
        "--include-task",
    ])
    .unwrap();
    match cli.command {
        Commands::Job {
            sub: JobSubcommands::Show { include_task, .. },
        } => assert!(include_task),
        other => panic!("unexpected parse: {other:?}"),
    }
}

#[test]
fn clap_rejects_invalid_job_state() {
    let err =
        Cli::try_parse_from(["ceo-connector", "job", "list", "--state", "bogus"]).unwrap_err();
    assert_eq!(err.exit_code(), 2);
    assert!(err.to_string().contains("invalid job state 'bogus'"));

    for state in JOB_STATE_FILTERS {
        assert!(parse_state_filter(state).is_ok(), "{state} must be valid");
    }
    assert!(parse_state_filter("Bogus").is_err());
    assert!(parse_state_filter("").is_err());
}
