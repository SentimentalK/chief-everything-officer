use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

use ceo_connector::cli::{Cli, Commands, JobSubcommands, ProjectSubcommands};
use ceo_connector::config::{LocalConfig, LocalTarget, CONFIG_SCHEMA_VERSION};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::orca::discovery::extract_known_agents_from_agent_context_json;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::{
    build_project_display_items, infer_project_name, project_add, project_delete, project_detach,
    project_list, project_remove, render_project_list, render_project_show, ProjectDisplayItem,
    ProjectError,
};
use ceo_connector::redelivery::{
    receipt_file_path, run_redeliver, DeliveryReceipt, PreservedResultMeta,
};
use ceo_connector::setup::{
    discover_agent_runtime_candidates, AGENT_RUNTIME_REPO_FULL_NAME, AGENT_RUNTIME_TARGET_ALIAS,
};
use clap::Parser;
use inquire::Autocomplete;

mod common;
use common::mock_server::{MockResponse, MockServer};

fn init_git_repo(path: &Path, origin_url: Option<&str>) {
    fs::create_dir_all(path).unwrap();
    let status = Command::new("git")
        .arg("init")
        .current_dir(path)
        .status()
        .unwrap();
    assert!(status.success());

    let _ = Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(path)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .status();

    fs::write(path.join("README.md"), "# Test\n").unwrap();
    let _ = Command::new("git")
        .args(["add", "."])
        .current_dir(path)
        .status();
    let _ = Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(path)
        .status();

    if let Some(url) = origin_url {
        let _ = Command::new("git")
            .args(["remote", "add", "origin", url])
            .current_dir(path)
            .status();
    }
}

fn setup_test_profile(server_origin: &str) -> (TempDir, ConnectorPaths) {
    let temp = TempDir::new().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("dot-ceo"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential {
        schema_version: 1,
        server_origin: server_origin.to_string(),
        user_id: "user_test_123".to_string(),
        device_id: "dev_test_123".to_string(),
        credential_id: "crd_test_123".to_string(),
        secret: "secret_123".to_string(),
        expires_at_ms: chrono::Utc::now().timestamp_millis() + 86400000,
    };
    cred.save(&paths.credential_file()).unwrap();

    let cfg = LocalConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        server_url: server_origin.to_string(),
        targets: std::collections::BTreeMap::new(),
    };
    cfg.save(&paths.config_file()).unwrap();

    (temp, paths)
}

// ---------------------------------------------------------------------------
// 1. CLI Parsing Tests
// ---------------------------------------------------------------------------

#[test]
fn test_cli_parsing_project_first_surface() {
    // project add
    let cli = Cli::try_parse_from(["ceo-connector", "project", "add"]).unwrap();
    match cli.command {
        Commands::Project {
            sub:
                ProjectSubcommands::Add {
                    path,
                    name,
                    agent,
                    model,
                },
        } => {
            assert_eq!(path, None);
            assert_eq!(name, None);
            assert_eq!(agent, None);
            assert_eq!(model, None);
        }
        _ => panic!("unexpected command"),
    }

    // project add with explicit path, name, agent, model
    let cli = Cli::try_parse_from([
        "ceo-connector",
        "project",
        "add",
        "/my/path",
        "--name",
        "my-proj",
        "--agent",
        "codex",
        "--model",
        "gpt-5",
    ])
    .unwrap();
    match cli.command {
        Commands::Project {
            sub:
                ProjectSubcommands::Add {
                    path,
                    name,
                    agent,
                    model,
                },
        } => {
            assert_eq!(path.as_deref(), Some("/my/path"));
            assert_eq!(name.as_deref(), Some("my-proj"));
            assert_eq!(agent.as_deref(), Some("codex"));
            assert_eq!(model.as_deref(), Some("gpt-5"));
        }
        _ => panic!("unexpected command"),
    }

    // project add with --agent having no value
    let cli = Cli::try_parse_from(["ceo-connector", "project", "add", "--agent"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::Add { agent, .. },
        } => {
            assert_eq!(agent.as_deref(), Some(""));
        }
        _ => panic!("unexpected command"),
    }

    // project set with --agent having no value
    let cli =
        Cli::try_parse_from(["ceo-connector", "project", "set", "my-proj", "--agent"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::Set { project, agent, .. },
        } => {
            assert_eq!(project, "my-proj");
            assert_eq!(agent.as_deref(), Some(""));
        }
        _ => panic!("unexpected command"),
    }

    // project list with and without flags
    let cli = Cli::try_parse_from(["ceo-connector", "project", "list"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::List { all, json },
        } => {
            assert!(!all);
            assert!(!json);
        }
        _ => panic!("unexpected command"),
    }

    let cli = Cli::try_parse_from(["ceo-connector", "project", "list", "--all", "--json"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::List { all, json },
        } => {
            assert!(all);
            assert!(json);
        }
        _ => panic!("unexpected command"),
    }

    // project detach
    let cli = Cli::try_parse_from(["ceo-connector", "project", "detach", "my-proj"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::Detach { project },
        } => {
            assert_eq!(project, "my-proj");
        }
        _ => panic!("unexpected command"),
    }

    // project delete (explicit selector; confirmation/force + json flags)
    let cli = Cli::try_parse_from(["ceo-connector", "project", "delete", "my-proj"]).unwrap();
    match cli.command {
        Commands::Project {
            sub:
                ProjectSubcommands::Delete {
                    project,
                    force,
                    json,
                },
        } => {
            assert_eq!(project, "my-proj");
            assert!(!force);
            assert!(!json);
        }
        _ => panic!("unexpected command"),
    }

    let cli = Cli::try_parse_from([
        "ceo-connector",
        "project",
        "delete",
        "my-proj",
        "--force",
        "--json",
    ])
    .unwrap();
    match cli.command {
        Commands::Project {
            sub:
                ProjectSubcommands::Delete {
                    project,
                    force,
                    json,
                },
        } => {
            assert_eq!(project, "my-proj");
            assert!(force);
            assert!(json);
        }
        _ => panic!("unexpected command"),
    }

    // project remove
    let cli = Cli::try_parse_from(["ceo-connector", "project", "remove", "my-proj"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::Remove { project },
        } => {
            assert_eq!(project, "my-proj");
        }
        _ => panic!("unexpected command"),
    }

    // project default-runtime with and without argument
    let cli = Cli::try_parse_from(["ceo-connector", "project", "default-runtime"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::DefaultRuntime { project },
        } => {
            assert_eq!(project, None);
        }
        _ => panic!("unexpected command"),
    }

    let cli =
        Cli::try_parse_from(["ceo-connector", "project", "default-runtime", "my-proj"]).unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::DefaultRuntime { project },
        } => {
            assert_eq!(project.as_deref(), Some("my-proj"));
        }
        _ => panic!("unexpected command"),
    }

    // redeliver with and without job_id
    let cli = Cli::try_parse_from(["ceo-connector", "redeliver"]).unwrap();
    match cli.command {
        Commands::Redeliver { job_id, attempt } => {
            assert_eq!(job_id, None);
            assert_eq!(attempt, None);
        }
        _ => panic!("unexpected command"),
    }

    let cli = Cli::try_parse_from([
        "ceo-connector",
        "redeliver",
        "job-123",
        "--attempt",
        "att-1",
    ])
    .unwrap();
    match cli.command {
        Commands::Redeliver { job_id, attempt } => {
            assert_eq!(job_id.as_deref(), Some("job-123"));
            assert_eq!(attempt.as_deref(), Some("att-1"));
        }
        _ => panic!("unexpected command"),
    }

    // job list --project
    let cli = Cli::try_parse_from(["ceo-connector", "job", "list", "--project", "my-app"]).unwrap();
    match cli.command {
        Commands::Job {
            sub: JobSubcommands::List { project, .. },
        } => {
            assert_eq!(project.as_deref(), Some("my-app"));
        }
        _ => panic!("unexpected command"),
    }
}

// ---------------------------------------------------------------------------
// 2. Project Add: Name Inference and Validation-Before-Mutation
// ---------------------------------------------------------------------------

#[test]
fn test_project_add_name_inference() {
    let temp = TempDir::new().unwrap();
    let repo_dir = temp.path().join("my-awesome-repo");

    // Case 1: remote origin basename
    init_git_repo(
        &repo_dir,
        Some("https://github.com/SentimentalK/remote-project-name.git"),
    );
    let inferred = infer_project_name(&repo_dir).unwrap();
    assert_eq!(inferred, "remote-project-name");

    // Case 2: ssh remote origin
    let repo_dir_2 = temp.path().join("repo-ssh");
    init_git_repo(&repo_dir_2, Some("git@github.com:org/ssh-project.git"));
    let inferred_ssh = infer_project_name(&repo_dir_2).unwrap();
    assert_eq!(inferred_ssh, "ssh-project");

    // Case 3: directory basename fallback when no remote
    let repo_dir_3 = temp.path().join("local-dir-name");
    init_git_repo(&repo_dir_3, None);
    let inferred_local = infer_project_name(&repo_dir_3).unwrap();
    assert_eq!(inferred_local, "local-dir-name");
}

#[tokio::test]
async fn test_project_add_validation_before_server_mutation() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let server_called = Arc::new(AtomicU32::new(0));
    let sc = server_called.clone();
    server.add_handler(move |_req| {
        sc.fetch_add(1, Ordering::SeqCst);
        MockResponse::json(500, &serde_json::json!({ "error": "should not be called" }))
    });

    let not_a_git_dir = _temp.path().join("plain_dir");
    fs::create_dir_all(&not_a_git_dir).unwrap();

    // project add on non-git dir MUST FAIL before any server call!
    let res = project_add(
        &paths,
        Some(&not_a_git_dir.to_string_lossy()),
        None,
        None,
        None,
    )
    .await;
    assert!(res.is_err(), "must fail for non-git directory");
    assert_eq!(
        server_called.load(Ordering::SeqCst),
        0,
        "ZERO server mutation/calls allowed before validation"
    );

    // project add on non-existent path MUST FAIL before any server call!
    let non_existent = _temp.path().join("does_not_exist");
    let res = project_add(
        &paths,
        Some(&non_existent.to_string_lossy()),
        None,
        None,
        None,
    )
    .await;
    assert!(res.is_err());
    assert_eq!(server_called.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// 3. Project Output: Vertical Tree/Block & Zero ANSI on Non-TTY
// ---------------------------------------------------------------------------

#[test]
fn test_project_render_formatting_and_zero_ansi_on_non_tty() {
    let item = ProjectDisplayItem {
        target_id: "tgt_123456789abcdef".to_string(),
        name: "Chief Everything Officer".to_string(),
        alias: Some("chief-everything-officer".to_string()),
        kind: Some("coding".to_string()),
        local_path: Some("/home/user/codes/ceo".to_string()),
        status: "READY".to_string(),
        disabled: false,
        is_default_agent_runtime: true,
        active_binding_count: 1,
        repository: Some("SentimentalK/chief-everything-officer".to_string()),
        agent_id: Some("opencode".to_string()),
        model: None,
        runnable: None,
    };

    // 1. Non-TTY list rendering must NOT contain ANSI escape codes
    let list_out = render_project_list(std::slice::from_ref(&item), false);
    assert!(
        !list_out.contains("\x1b["),
        "non-TTY output must not contain ANSI escape codes"
    );
    // Display Name first!
    assert!(list_out.starts_with("Project: Chief Everything Officer (default runtime)\n"));
    // Raw target_id (tgt_*) must be HIDDEN in normal list output!
    assert!(
        !list_out.contains("tgt_123456789abcdef"),
        "raw target_id must be hidden in normal list output"
    );
    assert!(list_out.contains("  Alias:      chief-everything-officer\n"));
    assert!(list_out.contains("  Agent:      opencode\n"));
    assert!(list_out.contains("  Model:      <default>\n"));

    // 2. Non-TTY show rendering must NOT contain ANSI escape codes
    let show_out = render_project_show(&item, false);
    assert!(
        !show_out.contains("\x1b["),
        "non-TTY output must not contain ANSI escape codes"
    );
    // Show output DOES expose the target_id
    assert!(show_out.contains("  ID:              tgt_123456789abcdef\n"));
    assert!(show_out.contains("  Active bindings: 1\n"));
}

#[test]
fn test_project_json_output_guarantees() {
    let item = ProjectDisplayItem {
        target_id: "tgt_json_1".to_string(),
        name: "My App".to_string(),
        alias: Some("my-app".to_string()),
        kind: Some("coding".to_string()),
        local_path: Some("/path/to/app".to_string()),
        status: "READY".to_string(),
        disabled: false,
        is_default_agent_runtime: false,
        active_binding_count: 1,
        repository: None,
        agent_id: Some("codex".to_string()),
        model: Some("gpt-5".to_string()),
        runnable: None,
    };

    let json_str = serde_json::to_string_pretty(&item).unwrap();
    assert!(!json_str.contains("\x1b["), "JSON must never contain ANSI");
    let deserialized: ProjectDisplayItem = serde_json::from_str(&json_str).unwrap();
    assert_eq!(deserialized.name, "My App");
    assert_eq!(deserialized.model.as_deref(), Some("gpt-5"));
}

// ---------------------------------------------------------------------------
// 4. Orca Agent Discovery Parsing & Failure Path
// ---------------------------------------------------------------------------

#[test]
fn test_agent_context_parsing_and_no_hardcoded_fallback() {
    // Valid Orca 1.4.219 agent-context sample
    let valid_json = r#"{
        "commands": [
            {
                "command": "worker-start",
                "path": ["orchestration", "worker-start"],
                "notes": [
                    "--agent takes an Orca agent id enabled on the worker server, such as claude, codex, cursor, antigravity, muse, zcode, opencode, or opencode2."
                ]
            }
        ]
    }"#;

    let agents = extract_known_agents_from_agent_context_json(valid_json).unwrap();
    assert_eq!(
        agents,
        vec![
            "claude",
            "codex",
            "cursor",
            "antigravity",
            "muse",
            "zcode",
            "opencode",
            "opencode2"
        ]
    );

    // Corrupt or missing path: fails clearly without hardcoded catalogue
    let invalid_json = r#"{ "commands": [] }"#;
    let res = extract_known_agents_from_agent_context_json(invalid_json);
    assert!(res.is_err());
    let err_msg = res.unwrap_err();
    assert!(err_msg.contains("not found in Orca agent-context"));
}

// ---------------------------------------------------------------------------
// 5. Setup Bounded Runtime Discovery
// ---------------------------------------------------------------------------

#[test]
fn test_bounded_runtime_discovery() {
    let temp = TempDir::new().unwrap();
    let home = temp.path();

    // 1. None found initially
    let found = discover_agent_runtime_candidates(home);
    assert!(found.is_empty());

    // 2. Verified checkout in ~/codes/ceo-agent-runtime
    let codes_dir = home.join("codes").join(AGENT_RUNTIME_TARGET_ALIAS);
    init_git_repo(
        &codes_dir,
        Some(&format!(
            "https://github.com/{AGENT_RUNTIME_REPO_FULL_NAME}.git"
        )),
    );

    let found = discover_agent_runtime_candidates(home);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0], fs::canonicalize(&codes_dir).unwrap());

    // 3. Second checkout in ~/.ceo/ceo-agent-runtime
    let dot_ceo_dir = home.join(".ceo").join(AGENT_RUNTIME_TARGET_ALIAS);
    init_git_repo(
        &dot_ceo_dir,
        Some(&format!(
            "https://github.com/{AGENT_RUNTIME_REPO_FULL_NAME}.git"
        )),
    );

    let found = discover_agent_runtime_candidates(home);
    assert_eq!(found.len(), 2);
}

// ---------------------------------------------------------------------------
// 6. Path Completion UX: No Passive Suggestions, Longest Common Prefix on Tab
// ---------------------------------------------------------------------------

#[test]
fn test_path_completion_no_passive_suggestions_and_tab_prefix() {
    use ceo_connector::setup_frontend::PathCompleter;

    let mut completer = PathCompleter;

    // get_suggestions MUST return empty list so no passive dropdown renders below prompt!
    let suggestions = completer.get_suggestions("/any/path").unwrap();
    assert!(
        suggestions.is_empty(),
        "get_suggestions must return empty list to prevent passive directory listing"
    );

    // Create temporary directory structure
    let temp = TempDir::new().unwrap();
    let base = temp.path();
    fs::create_dir_all(base.join("project-alpha")).unwrap();
    fs::create_dir_all(base.join("project-alpine")).unwrap();

    let prefix_query = format!("{}/project-al", base.display());
    let completion = completer.get_completion(&prefix_query, None).unwrap();
    assert_eq!(
        completion,
        Some(format!("{}/project-alp", base.display())),
        "Tab completion must complete longest common prefix"
    );
}

// ---------------------------------------------------------------------------
// 7. Smart Redelivery (PROJECT-038)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_smart_redelivery_no_candidates_exits_terse() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    // No files in results_dir -> exits 0 with terse message
    let res = run_redeliver(&paths, None, None).await;
    assert!(res.is_ok());
}

#[tokio::test]
async fn test_smart_redelivery_candidate_delivered_and_receipt_persisted() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let job_id = "job-smart-1";
    let attempt_id = "att-smart-1";
    let resource_id = "res-smart-1";
    let claim_token = "tok_smart_1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    // 1. Setup metadata
    let meta = PreservedResultMeta {
        server_origin: server.origin(),
        device_id: "dev_test_123".to_string(),
        job_id: job_id.to_string(),
        attempt_id: attempt_id.to_string(),
        claim_token: claim_token.to_string(),
        resource_id: Some(resource_id.to_string()),
    };
    let meta_file = paths.preserved_managed_result_meta_file(job_id, attempt_id);
    ceo_connector::local_state::atomic_write_json(&meta_file, &meta).unwrap();

    // 2. Setup valid preserved result
    let envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Smart redelivery result",
        "operations": [{ "op": "upsert_content", "content": "Valid smart redelivery content" }]
    });
    let result_file = paths.preserved_managed_result_file(job_id, attempt_id);
    ceo_connector::local_state::atomic_write_json(&result_file, &envelope).unwrap();

    // 3. Mock server responses
    let server_submit_calls = Arc::new(AtomicU32::new(0));
    let sc = server_submit_calls.clone();
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/jobs/job-smart-1") {
            // Unresolved job on server (result is None)
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "job_id": "job-smart-1",
                    "request_id": "req-1",
                    "target_id": "tgt_1",
                    "target_alias": "app",
                    "state": "running",
                    "created_at": "2026-10-01T00:00:00Z",
                    "result_target": "commit",
                    "execution_timeout_seconds": 300,
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/result") {
            sc.fetch_add(1, Ordering::SeqCst);
            let body_val: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            let delivery_mode = body_val.get("delivery_mode").and_then(|v| v.as_str());
            assert_eq!(
                delivery_mode,
                Some("automatic"),
                "smart redelivery must send delivery_mode='automatic' to satisfy server jobResultRequestSchema"
            );
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-10-01T00:05:00Z",
                    "resource_id": "res-smart-1",
                    "commit": "git-commit-hash-smart"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Run smart redelivery (no job_id)
    let res = run_redeliver(&paths, None, None).await;
    assert!(res.is_ok());
    assert_eq!(server_submit_calls.load(Ordering::SeqCst), 1);

    // Verify local receipt was created
    let receipt_path = receipt_file_path(&paths.results_dir(), job_id, attempt_id);
    assert!(
        receipt_path.exists(),
        "receipt file must exist after delivery"
    );
    let receipt: DeliveryReceipt =
        serde_json::from_str(&fs::read_to_string(&receipt_path).unwrap()).unwrap();
    assert_eq!(receipt.job_id, job_id);
    assert_eq!(receipt.attempt_id, attempt_id);

    // Run smart redelivery a SECOND time: must skip because local receipt exists!
    let res2 = run_redeliver(&paths, None, None).await;
    assert!(res2.is_ok());
    assert_eq!(
        server_submit_calls.load(Ordering::SeqCst),
        1,
        "second scan must skip candidate due to receipt"
    );
}

#[tokio::test]
async fn test_smart_redelivery_server_digest_match_skips_submission() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let job_id = "job-smart-digest";
    let attempt_id = "att-smart-digest";
    let resource_id = "res-smart-digest";
    let claim_token = "tok_digest_1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    let meta = PreservedResultMeta {
        server_origin: server.origin(),
        device_id: "dev_test_123".to_string(),
        job_id: job_id.to_string(),
        attempt_id: attempt_id.to_string(),
        claim_token: claim_token.to_string(),
        resource_id: Some(resource_id.to_string()),
    };
    let meta_file = paths.preserved_managed_result_meta_file(job_id, attempt_id);
    ceo_connector::local_state::atomic_write_json(&meta_file, &meta).unwrap();

    let envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Digest match result",
        "operations": [{ "op": "upsert_content", "content": "Valid digest match content" }]
    });
    let result_file = paths.preserved_managed_result_file(job_id, attempt_id);
    ceo_connector::local_state::atomic_write_json(&result_file, &envelope).unwrap();

    let (_, expected_sha256) = ceo_connector::managed_result::read_and_validate_from_file(
        &result_file,
        job_id,
        attempt_id,
        Some(resource_id),
    )
    .unwrap();

    let server_submit_called = Arc::new(AtomicU32::new(0));
    let sc = server_submit_called.clone();
    let expected_sha256_clone = expected_sha256.clone();
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/jobs/job-smart-digest") {
            // Server ALREADY accepted this attempt with matching payload sha256!
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "job_id": "job-smart-digest",
                    "request_id": "req-1",
                    "target_id": "tgt_1",
                    "target_alias": "app",
                    "state": "terminal",
                    "created_at": "2026-10-01T00:00:00Z",
                    "result_target": "commit",
                    "execution_timeout_seconds": 300,
                    "result": {
                        "target": "commit",
                        "attempt_id": "att-smart-digest",
                        "payload_sha256": expected_sha256_clone,
                        "resource_id": "res-smart-digest",
                        "commit": "git-hash-existing",
                        "received_at": "2026-10-01T00:05:00Z"
                    }
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/result") {
            sc.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let res = run_redeliver(&paths, None, None).await;
    assert!(res.is_ok());
    assert_eq!(
        server_submit_called.load(Ordering::SeqCst),
        0,
        "submission must be skipped when server digest matches"
    );

    // Local receipt must now exist
    let receipt_path = receipt_file_path(&paths.results_dir(), job_id, attempt_id);
    assert!(receipt_path.exists());
}

#[tokio::test]
async fn test_project_add_idempotency_preserves_existing_executor_and_model() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/workspaces") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "workspaces": [{ "id": "ws_1", "role": "owner", "created_at": "2026-10-01T00:00:00Z" }]
                }),
            );
        }
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
        }
        if req.method == "POST" && req.path.contains("/api/connector/targets/register") {
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": {
                        "id": "tgt_proj_1",
                        "workspace_id": "ws_1",
                        "alias": "my-repo-idem",
                        "display_name": "my-repo-idem",
                        "kind": "coding",
                        "repository": null,
                        "disabled": false,
                        "is_default_agent_runtime": false
                    },
                    "binding": { "id": "bnd_1", "enabled": true },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/bind") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "binding": { "id": "bnd_1", "target_id": "tgt_proj_1", "device_id": "dev_1", "enabled": true }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let temp_repo = tempfile::tempdir().unwrap();
    let repo_dir = temp_repo.path().join("my-repo-idem");
    init_git_repo(&repo_dir, Some("https://github.com/org/my-repo-idem.git"));

    // 1. Initial add with --agent codex --model gpt-5
    let res = ceo_connector::projects::project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("my-repo-idem"),
        Some("codex"),
        Some("gpt-5"),
    )
    .await;
    assert!(res.is_ok(), "initial project add failed: {:?}", res);

    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let t = cfg.targets.get("tgt_proj_1").unwrap();
    let exec = t.executor.as_ref().unwrap();
    assert_eq!(exec.agent_id, "codex");
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));

    // 2. Repeat add with NO agent or model specified: must preserve existing executor and model!
    let res2 = ceo_connector::projects::project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("my-repo-idem"),
        None,
        None,
    )
    .await;
    assert!(res2.is_ok(), "repeat project add failed: {:?}", res2);

    let cfg2 = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let t2 = cfg2.targets.get("tgt_proj_1").unwrap();
    let exec2 = t2.executor.as_ref().unwrap();
    assert_eq!(exec2.agent_id, "codex", "must preserve existing agent_id");
    assert_eq!(
        exec2.model.as_deref(),
        Some("gpt-5"),
        "must preserve existing model"
    );
}

#[tokio::test]
async fn test_project_add_model_without_agent_on_fresh_project_fails_clearly() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/workspaces") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "workspaces": [{ "id": "ws_1", "role": "owner", "created_at": "2026-10-01T00:00:00Z" }]
                }),
            );
        }
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
        }
        if req.method == "POST" && req.path.contains("/api/connector/targets/register") {
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": {
                        "id": "tgt_proj_model",
                        "workspace_id": "ws_1",
                        "alias": "my-repo-model",
                        "display_name": "my-repo-model",
                        "kind": "coding",
                        "repository": null,
                        "disabled": false,
                        "is_default_agent_runtime": false
                    },
                    "binding": { "id": "bnd_1", "enabled": true },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/bind") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "binding": { "id": "bnd_1", "target_id": "tgt_proj_model", "device_id": "dev_1", "enabled": true }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let temp_repo = tempfile::tempdir().unwrap();
    let repo_dir = temp_repo.path().join("my-repo-model");
    init_git_repo(&repo_dir, Some("https://github.com/org/my-repo-model.git"));

    let res = ceo_connector::projects::project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("my-repo-model"),
        None,
        Some("gpt-5"),
    )
    .await;

    assert!(
        res.is_err(),
        "must fail when model is provided without agent on a fresh project"
    );
    let err_str = res.unwrap_err().to_string();
    assert!(
        err_str.contains("--model requires an execution agent"),
        "error must explain that --model requires an agent: {err_str}"
    );
}

#[tokio::test]
async fn test_project_set_agent_auto_model_auto_clears_both_without_transient_conflict() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let target_id = "tgt_clear_test";
    let temp_repo = tempfile::tempdir().unwrap();
    let repo_dir = temp_repo.path().join("my-repo-clear");
    fs::create_dir_all(&repo_dir).unwrap();
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(&repo_dir)
        .output()
        .unwrap();

    // Initial config has agent=codex, model=gpt-5
    let mut cfg = LocalConfig::new(server.origin()).unwrap();
    let exec = ceo_connector::config::LocalExecutorConfig::new_logical(
        "codex".into(),
        Some("gpt-5".into()),
    )
    .unwrap();
    cfg.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: fs::canonicalize(&repo_dir)
                .unwrap()
                .to_string_lossy()
                .to_string(),
            executor: Some(exec),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    // Mock server for resolve_target_selector
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": target_id,
                            "workspace_id": "ws_1",
                            "alias": "my-repo-clear",
                            "display_name": "my-repo-clear",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Run: project set my-repo-clear --agent auto --model auto
    let res = ceo_connector::projects::project_set(
        &paths,
        "my-repo-clear",
        None,
        Some("auto"),
        Some("auto"),
    )
    .await;
    assert!(
        res.is_ok(),
        "project set --agent auto --model auto must succeed: {:?}",
        res
    );

    let updated_cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let updated_t = updated_cfg.targets.get(target_id).unwrap();
    let updated_exec = updated_t.executor.as_ref().unwrap();
    assert_eq!(updated_exec.agent_id, "default");
    assert_eq!(updated_exec.model, None, "model must be cleared to None");
}

// ---------------------------------------------------------------------------
// PROJECT-039: Project detach / delete / list semantics & regression tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_project_list_default_excludes_unbound_and_all_includes_unbound_and_json_scope() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let temp_repo = tempfile::tempdir().unwrap();
    let repo_dir = temp_repo.path().join("bound-proj");
    fs::create_dir_all(&repo_dir).unwrap();

    let target_bound_id = "tgt_bound_1";
    let target_unbound_id = "tgt_unbound_2";

    // Seed local config with bound-proj only
    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        target_bound_id.to_string(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: None,
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [
                        {
                            "target": {
                                "id": target_bound_id,
                                "workspace_id": "ws_1",
                                "alias": "bound-proj",
                                "display_name": "bound-proj",
                                "kind": "coding",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": { "id": "bnd_1", "enabled": true },
                            "active_binding_count": 1
                        },
                        {
                            "target": {
                                "id": target_unbound_id,
                                "workspace_id": "ws_1",
                                "alias": "unbound-proj",
                                "display_name": "unbound-proj",
                                "kind": "coding",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": null,
                            "active_binding_count": 0
                        }
                    ]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let all_items = build_project_display_items(&paths).await.unwrap();
    assert_eq!(all_items.len(), 2);

    // 1. Default list scope: excludes unbound server targets
    let mut default_items = all_items.clone();
    default_items.retain(|i| i.status != "UNBOUND");
    assert_eq!(default_items.len(), 1);
    assert_eq!(default_items[0].alias.as_deref(), Some("bound-proj"));
    assert_eq!(default_items[0].status, "READY");

    let rendered_default = render_project_list(&default_items, false);
    assert!(rendered_default.contains("Project: bound-proj"));
    assert!(!rendered_default.contains("unbound-proj"));

    // 2. --all list scope: includes unbound server targets
    let rendered_all = render_project_list(&all_items, false);
    assert!(rendered_all.contains("Project: bound-proj"));
    assert!(rendered_all.contains("Project: unbound-proj"));
    assert!(rendered_all.contains("Config:     UNBOUND"));

    // 3. JSON output scope mirrors human output scope
    let default_json = serde_json::to_string(&default_items).unwrap();
    let default_parsed: Vec<serde_json::Value> = serde_json::from_str(&default_json).unwrap();
    assert_eq!(default_parsed.len(), 1);
    assert_eq!(default_parsed[0]["alias"], "bound-proj");

    let all_json = serde_json::to_string(&all_items).unwrap();
    let all_parsed: Vec<serde_json::Value> = serde_json::from_str(&all_json).unwrap();
    assert_eq!(all_parsed.len(), 2);
    assert!(all_parsed.iter().any(|p| p["alias"] == "unbound-proj"));

    // 4. Exercise project_list directly (both human and json modes)
    assert!(project_list(&paths, false, false).await.is_ok());
    assert!(project_list(&paths, false, true).await.is_ok());
    assert!(project_list(&paths, true, false).await.is_ok());
    assert!(project_list(&paths, true, true).await.is_ok());
}

#[tokio::test]
async fn test_project_detach_and_remove_compat_alias_and_delete_semantics() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let target_id = "tgt_detach_test_1";
    let unbind_calls = Arc::new(AtomicU32::new(0));
    let unbind_calls_clone = unbind_calls.clone();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": target_id,
                            "workspace_id": "ws_1",
                            "alias": "hello-detach",
                            "display_name": "hello-detach",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        if req.method == "POST"
            && req
                .path
                .contains("/api/connector/targets/tgt_detach_test_1/unbind")
        {
            unbind_calls_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // 1. Seed local config
    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: "/tmp/some-path".to_string(),
            executor: None,
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    // 2. Active attempt guard check
    ceo_connector::local_state::atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "target_id": target_id,
            "job_id": "job_1",
            "attempt_id": "att_1"
        }),
    )
    .unwrap();
    let err_in_use = project_detach(&paths, "hello-detach").await.unwrap_err();
    // The guard stays fail-closed (TARGET_IN_USE) for a marker that cannot
    // be safely converged (legacy/corrupt partial marker): the enriched
    // variant still carries the TARGET_IN_USE code and never proceeds.
    match err_in_use {
        ProjectError::Target(ceo_connector::targets::TargetError::TargetInUseUnconverged {
            target_id: tid,
            reason,
        }) => {
            assert_eq!(tid, target_id);
            assert!(reason.contains("LOCAL_STATE_INVALID"));
        }
        other => panic!("expected TargetInUseUnconverged error, got: {:?}", other),
    }
    // No mutation happened on server or locally while blocked.
    assert_eq!(unbind_calls.load(Ordering::SeqCst), 0);
    fs::remove_file(paths.active_attempt_file()).unwrap();

    // 3. Detach removes device binding on server + removes local mapping
    let detach_res = project_detach(&paths, "hello-detach").await;
    assert!(detach_res.is_ok(), "detach must succeed: {:?}", detach_res);
    assert_eq!(unbind_calls.load(Ordering::SeqCst), 1);

    let cfg_after_detach = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!cfg_after_detach.targets.contains_key(target_id));

    // 4. project remove is a compatibility alias for detach (emits warning and calls detach)
    // Re-seed config to test remove
    let mut cfg_reseed = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg_reseed.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: "/tmp/some-path".to_string(),
            executor: None,
        },
    );
    cfg_reseed.save(&paths.config_file()).unwrap();

    let remove_res = project_remove(&paths, "hello-detach").await;
    assert!(
        remove_res.is_ok(),
        "remove compat alias must succeed: {:?}",
        remove_res
    );
    assert_eq!(unbind_calls.load(Ordering::SeqCst), 2);
    let cfg_after_remove = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!cfg_after_remove.targets.contains_key(target_id));

    // 5. project delete = workspace-level permanent deletion via the Server
    //    delete contract (PROJECT-039): explicit selector + force, and the
    //    local mapping is removed only after confirmed Server success.
    // Re-seed config to verify delete removes local state after Server success
    let mut cfg_for_delete = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg_for_delete.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: "/tmp/some-path".to_string(),
            executor: None,
        },
    );
    cfg_for_delete.save(&paths.config_file()).unwrap();

    let delete_calls = Arc::new(AtomicU32::new(0));
    let delete_calls_clone = delete_calls.clone();
    let unbind_calls_clone2 = unbind_calls.clone();
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": target_id,
                            "workspace_id": "ws_1",
                            "alias": "hello-detach",
                            "display_name": "hello-detach",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        if req.method == "POST"
            && req
                .path
                .contains("/api/connector/targets/tgt_detach_test_1/delete")
        {
            // The Connector must send the explicit confirmation flag.
            let body: serde_json::Value = req.json().unwrap_or(serde_json::Value::Null);
            if body.get("confirm") != Some(&serde_json::json!(true)) {
                return MockResponse::json(400, &serde_json::json!({ "error": "INVALID_REQUEST" }));
            }
            delete_calls_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "target_id": target_id,
                    "outcome": "deleted",
                    "terminal_job_count": 3
                }),
            );
        }
        if req.method == "POST"
            && req
                .path
                .contains("/api/connector/targets/tgt_detach_test_1/unbind")
        {
            unbind_calls_clone2.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let delete_res = project_delete(&paths, "hello-detach", true, false).await;
    assert!(
        delete_res.is_ok(),
        "workspace-level delete must succeed: {:?}",
        delete_res
    );
    assert_eq!(delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(unbind_calls.load(Ordering::SeqCst), 2); // detach/unbind untouched

    // Local mapping removed only after confirmed Server success
    let cfg_after_delete = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!cfg_after_delete.targets.contains_key(target_id));

    // Nonexistent selector gives clean ProjectNotFound (resolved from the
    // authoritative catalogue; never a delete inference)
    let not_found_err = project_delete(&paths, "nonexistent-proj", true, false)
        .await
        .unwrap_err();
    match not_found_err {
        ProjectError::ProjectNotFound(name) => {
            assert_eq!(name, "nonexistent-proj");
        }
        other => panic!("expected ProjectNotFound error, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_project_delete_confirmation_and_server_failure_keeps_local_mapping() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let target_id = "tgt_delete_guard_1";

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": target_id,
                            "workspace_id": "ws_1",
                            "alias": "guarded-project",
                            "display_name": "guarded-project",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/targets/tgt_delete_guard_1/delete") {
            // Server-side quiescence barrier: non-terminal jobs exist.
            return MockResponse::json(
                409,
                &serde_json::json!({
                    "error": "TARGET_DELETE_BLOCKED",
                    "message": "still has non-terminal jobs (queued: 1)",
                    "evidence": { "preparing": [], "queued": ["job-1"], "claimed": [], "running": [] }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Seed local mapping
    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: "/tmp/some-path".to_string(),
            executor: None,
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    // 1. Non-TTY without --force: destructive action is refused BEFORE any
    //    server delete request (clear confirmation semantics).
    let confirm_err = project_delete(&paths, "guarded-project", false, false)
        .await
        .unwrap_err();
    match confirm_err {
        ProjectError::InteractiveRequired(msg) => {
            assert!(msg.contains("--force"), "message: {msg}");
        }
        other => panic!("expected InteractiveRequired, got: {:?}", other),
    }

    // 2. With --force, the Server-side blocked outcome surfaces verbatim and
    //    the local mapping is NEVER removed when Server deletion fails.
    let blocked_err = project_delete(&paths, "guarded-project", true, false)
        .await
        .unwrap_err();
    match blocked_err {
        ProjectError::DeleteBlocked(msg) => {
            assert!(msg.contains("non-terminal jobs"), "message: {msg}");
        }
        other => panic!("expected DeleteBlocked, got: {:?}", other),
    }

    let cfg_after = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(
        cfg_after.targets.contains_key(target_id),
        "failed Server deletion must keep the local mapping"
    );
}

#[tokio::test]
async fn test_project_detach_then_add_reuses_existing_server_target() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let target_id = "tgt_reuse_42";
    let alias = "my-reuse-project";

    let temp_repo = tempfile::tempdir().unwrap();
    let repo_dir = temp_repo.path().join(alias);
    init_git_repo(
        &repo_dir,
        Some(&format!("https://github.com/org/{alias}.git")),
    );

    let register_count = Arc::new(AtomicU32::new(0));
    let bind_count = Arc::new(AtomicU32::new(0));
    let unbind_count = Arc::new(AtomicU32::new(0));
    let is_bound = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let reg_c = register_count.clone();
    let bnd_c = bind_count.clone();
    let unb_c = unbind_count.clone();
    let is_b = is_bound.clone();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/workspaces") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "workspaces": [{ "id": "ws_1", "role": "owner", "created_at": "2026-10-01T00:00:00Z" }]
                }),
            );
        }
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            if reg_c.load(Ordering::SeqCst) == 0 {
                return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
            } else {
                let bound = is_b.load(Ordering::SeqCst);
                let binding = if bound {
                    serde_json::json!({ "id": "bnd_1", "enabled": true })
                } else {
                    serde_json::json!({ "id": "bnd_1", "enabled": false })
                };
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "targets": [{
                            "target": {
                                "id": target_id,
                                "workspace_id": "ws_1",
                                "alias": alias,
                                "display_name": alias,
                                "kind": "coding",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": binding,
                            "active_binding_count": if bound { 1 } else { 0 }
                        }]
                    }),
                );
            }
        }
        if req.method == "POST" && req.path.contains("/api/connector/targets/register") {
            reg_c.fetch_add(1, Ordering::SeqCst);
            is_b.store(true, Ordering::SeqCst);
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": {
                        "id": target_id,
                        "workspace_id": "ws_1",
                        "alias": alias,
                        "display_name": alias,
                        "kind": "coding",
                        "repository": null,
                        "disabled": false,
                        "is_default_agent_runtime": false
                    },
                    "binding": { "id": "bnd_1", "enabled": true },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.ends_with("/bind") {
            bnd_c.fetch_add(1, Ordering::SeqCst);
            is_b.store(true, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "target_id": target_id,
                    "binding_id": "bnd_1",
                    "enabled": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.ends_with("/unbind") {
            unb_c.fetch_add(1, Ordering::SeqCst);
            is_b.store(false, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // 1. Initial add: registers target on server and binds to this device
    let add_res = project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some(alias),
        None,
        None,
    )
    .await;
    assert!(add_res.is_ok(), "initial project add failed: {:?}", add_res);
    assert_eq!(register_count.load(Ordering::SeqCst), 1);
    assert_eq!(bind_count.load(Ordering::SeqCst), 0);

    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(cfg.targets.contains_key(target_id));

    // Default list shows project as READY
    let items = build_project_display_items(&paths).await.unwrap();
    let mut default_items = items.clone();
    default_items.retain(|i| i.status != "UNBOUND");
    assert_eq!(default_items.len(), 1);
    assert_eq!(default_items[0].target_id, target_id);
    assert_eq!(default_items[0].status, "READY");

    // 2. Detach project
    let detach_res = project_detach(&paths, alias).await;
    assert!(detach_res.is_ok(), "detach failed: {:?}", detach_res);
    assert_eq!(unbind_count.load(Ordering::SeqCst), 1);

    // Local mapping removed
    let cfg_after_detach = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!cfg_after_detach.targets.contains_key(target_id));

    // Default list hidden
    let items_after_detach = build_project_display_items(&paths).await.unwrap();
    let mut default_hidden = items_after_detach.clone();
    default_hidden.retain(|i| i.status != "UNBOUND");
    assert_eq!(
        default_hidden.len(),
        0,
        "default list must hide detached project"
    );

    // --all visible as UNBOUND
    assert_eq!(items_after_detach.len(), 1);
    assert_eq!(items_after_detach[0].target_id, target_id);
    assert_eq!(items_after_detach[0].status, "UNBOUND");

    // 3. Add same project again: must REUSE existing Server Target!
    let re_add_res = project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some(alias),
        None,
        None,
    )
    .await;
    assert!(
        re_add_res.is_ok(),
        "re-add project failed: {:?}",
        re_add_res
    );

    // Crucial regression verification:
    // register_count must STILL be 1 (no duplicate server target created!)
    assert_eq!(
        register_count.load(Ordering::SeqCst),
        1,
        "must NOT register a duplicate target!"
    );
    // bind_count was called to re-bind this device
    assert_eq!(
        bind_count.load(Ordering::SeqCst),
        1,
        "must rebind existing target on server"
    );

    // Local mapping restored with the exact same Server Target ID
    let cfg_after_readd = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(
        cfg_after_readd.targets.contains_key(target_id),
        "local config must have original target_id"
    );

    // Default list now shows it as READY again!
    let items_after_readd = build_project_display_items(&paths).await.unwrap();
    let mut default_restored = items_after_readd.clone();
    default_restored.retain(|i| i.status != "UNBOUND");
    assert_eq!(default_restored.len(), 1);
    assert_eq!(default_restored[0].target_id, target_id);
    assert_eq!(default_restored[0].status, "READY");
}
