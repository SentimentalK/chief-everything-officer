//! Guided interactive setup frontend tests (Convergence & Discovery).
//!
//! Deterministic tests: all prompts run through a scripted [`SetupUi`] test
//! driver (no real terminal, no PTY dependency), while mutations go
//! through the real shared setup application services against a stateful
//! fake Server and real local Git fixtures.

mod common;

use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ceo_connector::cli::Cli;
use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::DoctorReport;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::setup::{
    assess_agent_runtime_readiness, AGENT_RUNTIME_REPO_CLONE_URL, AGENT_RUNTIME_TARGET_ALIAS,
};
use ceo_connector::setup_frontend::{
    login_handoff_action, post_login_handoff, run_setup_convergence,
    run_setup_convergence_with_home, run_setup_wizard, run_standalone_setup, HandoffAction,
    SetupCompletion, SetupUi, UiError,
};
use common::mock_server::{MockResponse, MockServer};

// ---------------------------------------------------------------------------
// Stateful fake Server (subset used by setup flows + readiness)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct FakeTarget {
    id: String,
    workspace_id: String,
    alias: String,
    kind: String,
    disabled: bool,
    is_default: bool,
    binding_enabled: bool,
}

impl FakeTarget {
    fn wire(&self) -> serde_json::Value {
        let binding = if self.binding_enabled {
            Some(serde_json::json!({ "id": format!("bnd_{}", self.id), "enabled": true }))
        } else {
            None
        };
        serde_json::json!({
            "target": {
                "id": self.id,
                "workspace_id": self.workspace_id,
                "alias": self.alias,
                "display_name": self.alias,
                "kind": self.kind,
                "repository": null,
                "disabled": self.disabled,
                "is_default_agent_runtime": self.is_default,
            },
            "this_device_binding": binding,
            "active_binding_count": if self.binding_enabled { 1 } else { 0 },
        })
    }
}

struct ServerState {
    workspaces: Vec<serde_json::Value>,
    targets: Vec<FakeTarget>,
    register_calls: usize,
    bind_calls: usize,
    default_runtime_calls: usize,
}

fn fake_target(alias: &str, kind: &str) -> FakeTarget {
    FakeTarget {
        id: format!("tgt_{alias}"),
        workspace_id: "ws_fix".to_string(),
        alias: alias.to_string(),
        kind: kind.to_string(),
        disabled: false,
        is_default: false,
        binding_enabled: true,
    }
}

async fn start_fake_server(
    workspaces: Vec<serde_json::Value>,
) -> (MockServer, Arc<Mutex<ServerState>>) {
    let server = MockServer::start().await;
    let state = Arc::new(Mutex::new(ServerState {
        workspaces,
        targets: vec![],
        register_calls: 0,
        bind_calls: 0,
        default_runtime_calls: 0,
    }));
    let s_clone = state.clone();
    server.add_handler(move |req| {
        let path = req.path.clone();
        let method = req.method.clone();
        let mut st = s_clone.lock().unwrap();

        match (method.as_str(), path.as_str()) {
            ("GET", "/api/connector/workspaces") => {
                MockResponse::json(200, &serde_json::json!({ "workspaces": st.workspaces }))
            }
            ("GET", p) if p.starts_with("/api/connector/targets") => {
                let list: Vec<serde_json::Value> = st.targets.iter().map(|t| t.wire()).collect();
                MockResponse::json(200, &serde_json::json!({ "targets": list }))
            }
            ("POST", "/api/connector/targets/register") => {
                st.register_calls += 1;
                let body: serde_json::Value =
                    serde_json::from_slice(&req.body).unwrap_or(serde_json::Value::Null);
                let alias = body
                    .get("alias")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unnamed")
                    .to_string();
                let kind = body
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("coding")
                    .to_string();
                let id = format!("tgt_{alias}");
                let mut created = false;
                if !st.targets.iter().any(|t| t.id == id) {
                    st.targets.push(FakeTarget {
                        id: id.clone(),
                        workspace_id: "ws_fix".to_string(),
                        alias: alias.clone(),
                        kind: kind.clone(),
                        disabled: false,
                        is_default: false,
                        binding_enabled: true,
                    });
                    created = true;
                }
                MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "workspace_id": "ws_fix",
                        "target": {
                            "id": id,
                            "workspace_id": "ws_fix",
                            "alias": alias,
                            "kind": kind,
                            "disabled": false,
                            "is_default_agent_runtime": false,
                        },
                        "binding": {
                            "id": format!("bnd_{id}"),
                            "target_id": id,
                            "device_id": "dev_1",
                            "enabled": true,
                        },
                        "replayed": !created,
                        "created_at_ms": 1,
                    }),
                )
            }
            ("POST", p) if p.starts_with("/api/connector/targets/") && p.ends_with("/bind") => {
                st.bind_calls += 1;
                let id = p
                    .trim_start_matches("/api/connector/targets/")
                    .trim_end_matches("/bind");
                MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "workspace_id": "ws_fix",
                        "target_id": id,
                        "binding": {
                            "id": format!("bnd_{id}"),
                            "target_id": id,
                            "device_id": "dev_1",
                            "enabled": true,
                        },
                        "replayed": false,
                        "created_at_ms": 1,
                    }),
                )
            }
            ("POST", p)
                if p.starts_with("/api/connector/targets/") && p.ends_with("/default-runtime") =>
            {
                st.default_runtime_calls += 1;
                let id = p
                    .trim_start_matches("/api/connector/targets/")
                    .trim_end_matches("/default-runtime");
                let mut replayed = true;
                for t in &mut st.targets {
                    if t.id == id {
                        if !t.is_default {
                            t.is_default = true;
                            replayed = false;
                        }
                    } else {
                        t.is_default = false;
                    }
                }
                MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "workspace_id": "ws_fix",
                        "target_id": id,
                        "is_default_agent_runtime": true,
                        "replayed": replayed,
                        "updated_at_ms": 1,
                    }),
                )
            }
            _ => MockResponse {
                status: 0,
                headers: vec![],
                body: vec![],
            },
        }
    });
    (server, state)
}

// ---------------------------------------------------------------------------
// Local environment / Git fixtures
// ---------------------------------------------------------------------------

struct TestEnv {
    _temp: tempfile::TempDir,
    _server: MockServer,
    paths: ConnectorPaths,
    state: Arc<Mutex<ServerState>>,
}

impl TestEnv {
    fn register_calls(&self) -> usize {
        self.state.lock().unwrap().register_calls
    }
    fn default_calls(&self) -> usize {
        self.state.lock().unwrap().default_runtime_calls
    }
    fn config(&self) -> Option<LocalConfig> {
        LocalConfig::load(&self.paths.config_file()).unwrap()
    }
}

async fn env_with_workspaces(workspaces: Vec<serde_json::Value>) -> TestEnv {
    let (server, state) = start_fake_server(workspaces).await;
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
    TestEnv {
        _temp: temp,
        _server: server,
        paths,
        state,
    }
}

fn one_workspace() -> Vec<serde_json::Value> {
    vec![serde_json::json!({
        "id": "ws_fix",
        "name": "Single Workspace",
        "role": "owner",
    })]
}

fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success(), "git {:?} failed in {:?}", args, dir);
}

fn init_agent_runtime_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-b", "master"]);
    git(
        dir,
        &["remote", "add", "origin", AGENT_RUNTIME_REPO_CLONE_URL],
    );
    fs::write(dir.join("README.md"), "ceo-agent-runtime\n").unwrap();
    git(
        dir,
        &[
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "add",
            ".",
        ],
    );
    git(
        dir,
        &[
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-m",
            "init",
        ],
    );
}

fn seed_configured_runtime(env: &TestEnv) -> String {
    let mut t = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    t.is_default = true;
    let id = t.id.clone();
    env.state.lock().unwrap().targets.push(t);
    id
}

fn write_local_mapping(env: &TestEnv, target_id: &str, local_path: &Path) {
    write_local_mapping_with_executor(env, target_id, local_path, None);
}

fn write_local_mapping_with_executor(
    env: &TestEnv,
    target_id: &str,
    local_path: &Path,
    executor: Option<ceo_connector::config::LocalExecutorConfig>,
) {
    let cred_text = fs::read_to_string(env.paths.credential_file()).unwrap();
    let cred: serde_json::Value = serde_json::from_str(&cred_text).unwrap();
    let mut config = LocalConfig::new(cred["server_origin"].as_str().unwrap().to_string()).unwrap();
    config.targets.insert(
        target_id.to_string(),
        ceo_connector::config::LocalTarget {
            local_path: local_path.to_string_lossy().into_owned(),
            executor,
        },
    );
    config.save(&env.paths.config_file()).unwrap();
}

// ---------------------------------------------------------------------------
// Scripted UI test driver
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Debug, Clone)]
enum ScriptedAction {
    Select(usize),
    CancelSelect,
    Text(String),
    CancelText,
}

struct ScriptedUi {
    actions: VecDeque<ScriptedAction>,
    messages: Vec<String>,
    errors: Vec<String>,
    select_calls: Vec<(String, Vec<String>)>,
    text_calls: Vec<(String, Option<String>, bool)>,
}

impl ScriptedUi {
    fn new<I: IntoIterator<Item = ScriptedAction>>(actions: I) -> Self {
        Self {
            actions: actions.into_iter().collect(),
            messages: vec![],
            errors: vec![],
            select_calls: vec![],
            text_calls: vec![],
        }
    }

    fn joined_messages(&self) -> String {
        self.messages.join("\n")
    }
}

impl SetupUi for ScriptedUi {
    fn message(&mut self, line: &str) {
        self.messages.push(line.to_string());
    }

    fn error(&mut self, line: &str) {
        self.errors.push(line.to_string());
    }

    fn select(&mut self, prompt: &str, options: &[String]) -> Result<usize, UiError> {
        self.select_calls
            .push((prompt.to_string(), options.to_vec()));
        match self.actions.pop_front() {
            Some(ScriptedAction::Select(idx)) => {
                if idx < options.len() {
                    Ok(idx)
                } else {
                    Err(UiError::Failed(format!(
                        "Scripted index {idx} out of range (len {})",
                        options.len()
                    )))
                }
            }
            Some(ScriptedAction::CancelSelect) => Err(UiError::Cancelled),
            other => Err(UiError::Failed(format!(
                "Unexpected scripted action for select({prompt}): {other:?}"
            ))),
        }
    }

    fn text(
        &mut self,
        prompt: &str,
        default: Option<&str>,
        complete_paths: bool,
    ) -> Result<String, UiError> {
        self.text_calls.push((
            prompt.to_string(),
            default.map(ToString::to_string),
            complete_paths,
        ));
        match self.actions.pop_front() {
            Some(ScriptedAction::Text(s)) => Ok(s),
            Some(ScriptedAction::CancelText) => Err(UiError::Cancelled),
            other => Err(UiError::Failed(format!(
                "Unexpected scripted action for text({prompt}): {other:?}"
            ))),
        }
    }
}

struct TestDoctor {
    calls: Arc<AtomicUsize>,
    report: DoctorReport,
}

impl TestDoctor {
    fn new(calls: Arc<AtomicUsize>, passed: bool) -> Self {
        Self {
            calls,
            report: DoctorReport {
                overall_passed: passed,
                checks: vec![],
            },
        }
    }
}

#[async_trait::async_trait]
impl ceo_connector::setup_frontend::DoctorRunner for TestDoctor {
    async fn run(&self, _paths: &ConnectorPaths) -> DoctorReport {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.report.clone()
    }
}

fn make_doctor(counter: Arc<AtomicUsize>, passed: bool) -> TestDoctor {
    TestDoctor::new(counter, passed)
}

// ---------------------------------------------------------------------------
// Tests: CLI surface & Readiness
// ---------------------------------------------------------------------------

#[test]
fn cli_surface_setup_command_exposes_runtime_path_flag() {
    use clap::CommandFactory;
    let cmd = Cli::command();
    let setup = cmd.find_subcommand("setup").expect("setup subcommand");
    assert!(
        setup.get_arguments().any(|a| a.get_id() == "runtime_path"),
        "setup must expose --runtime-path"
    );
    let login = cmd.find_subcommand("login").expect("login subcommand");
    assert!(
        login.get_arguments().any(|a| a.get_id() == "no_setup"),
        "login must expose --no-setup escape hatch"
    );
}

#[test]
fn interactive_terminal_detection_matches_std_tty_state() {
    use std::io::IsTerminal;
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    assert_eq!(
        ceo_connector::setup_frontend::is_interactive_terminal(),
        interactive
    );
}

#[tokio::test]
async fn readiness_connected_without_executor_is_explicit_partial_state() {
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping(&env, &target_id, &repo);

    let readiness = assess_agent_runtime_readiness(&env.paths).await.unwrap();
    assert!(readiness.server_target_exists);
    assert!(readiness.device_connected);
    assert!(!readiness.executor_ready);
    assert!(!readiness.agent_runtime_configured);
    assert!(readiness.needs_setup());
    let config = env.config().unwrap();
    assert!(config.targets.get(&target_id).unwrap().executor.is_none());
}

#[tokio::test]
async fn readiness_fully_configured_includes_executor() {
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping_with_executor(
        &env,
        &target_id,
        &repo,
        Some(ceo_connector::config::LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
    );

    let readiness = assess_agent_runtime_readiness(&env.paths).await.unwrap();
    assert!(readiness.server_target_exists);
    assert!(readiness.device_connected);
    assert!(readiness.executor_ready);
    assert!(readiness.agent_runtime_configured);
    assert!(!readiness.needs_setup());
}

#[tokio::test]
async fn post_login_handoff_no_setup_never_invokes_wizard() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut ui = ScriptedUi::new([]);
    let completion = post_login_handoff(&env.paths, true, true, &mut ui)
        .await
        .unwrap();
    assert_eq!(completion, None);
    assert!(ui.select_calls.is_empty() && ui.text_calls.is_empty());
}

#[tokio::test]
async fn post_login_handoff_non_interactive_prints_next_step_without_prompts() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut ui = ScriptedUi::new([]);
    let completion = post_login_handoff(&env.paths, false, false, &mut ui)
        .await
        .unwrap();
    assert_eq!(completion, None);
    assert!(ui.select_calls.is_empty() && ui.text_calls.is_empty());
    assert!(ui.joined_messages().contains("ceo-connector setup"));
}

#[tokio::test]
async fn post_login_handoff_probe_failure_keeps_login_successful() {
    let env = env_with_workspaces(one_workspace()).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let cred = DeviceCredential::new(
        format!("http://127.0.0.1:{port}"),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&env.paths.credential_file()).unwrap();

    let mut ui = ScriptedUi::new([]);
    let completion = post_login_handoff(&env.paths, false, true, &mut ui)
        .await
        .unwrap();
    assert_eq!(completion, None, "probe failure must not fail the login");
    assert!(ui.select_calls.is_empty());
    assert!(ui
        .joined_messages()
        .contains("Could not check setup readiness"));
    assert!(ui.joined_messages().contains("ceo-connector setup"));
}

#[test]
fn handoff_decision_pure_function_is_exhaustive() {
    let unready = ceo_connector::setup::SetupReadiness::default();
    let ready = ceo_connector::setup::SetupReadiness {
        server_target_exists: true,
        device_connected: true,
        executor_ready: true,
        agent_runtime_configured: true,
    };
    assert_eq!(
        login_handoff_action(true, true, &Ok(unready)),
        HandoffAction::DisabledByFlag
    );
    assert_eq!(
        login_handoff_action(false, false, &Ok(unready)),
        HandoffAction::NonInteractive
    );
    assert_eq!(
        login_handoff_action(false, true, &Ok(unready)),
        HandoffAction::EnterWizard
    );
    assert_eq!(
        login_handoff_action(false, true, &Ok(ready)),
        HandoffAction::AlreadyConfigured
    );
    assert_eq!(
        login_handoff_action(
            false,
            true,
            &Err(ceo_connector::setup::SetupError::GitNotFound)
        ),
        HandoffAction::ProbeFailed
    );
}

// ---------------------------------------------------------------------------
// Tests: Convergence Setup Execution & Doctor Mirroring
// ---------------------------------------------------------------------------

#[tokio::test]
async fn convergence_runs_doctor_at_completion_and_mirrors_verdict() {
    for doctor_passed in [true, false] {
        let env = env_with_workspaces(one_workspace()).await;
        let target_id = seed_configured_runtime(&env);
        let repo = env._temp.path().join("ceo-agent-runtime");
        init_agent_runtime_repo(&repo);
        write_local_mapping_with_executor(
            &env,
            &target_id,
            &repo,
            Some(
                ceo_connector::config::LocalExecutorConfig::new_logical("auto".into(), None)
                    .unwrap(),
            ),
        );

        let counter = Arc::new(AtomicUsize::new(0));
        let doctor = make_doctor(counter.clone(), doctor_passed);
        let mut ui = ScriptedUi::new([]);
        let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
            .await
            .unwrap();
        assert_eq!(
            completion,
            SetupCompletion::Finished { doctor_passed },
            "verdict must mirror Doctor report"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "Doctor must run exactly once"
        );
        assert!(ui
            .joined_messages()
            .contains("Setup steps finished. Running doctor..."));
    }
}

#[tokio::test]
async fn standalone_setup_maps_doctor_verdict_to_exit_code() {
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping_with_executor(
        &env,
        &target_id,
        &repo,
        Some(ceo_connector::config::LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
    );

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([]);
    let code = run_standalone_setup(&env.paths, &mut ui, &doctor, None)
        .await
        .unwrap();
    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), false);
    let mut ui = ScriptedUi::new([]);
    let code = run_standalone_setup(&env.paths, &mut ui, &doctor, None)
        .await
        .unwrap();
    assert_eq!(code, ExitCode::FAILURE);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn convergence_reuses_existing_valid_runtime_mapping() {
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping_with_executor(
        &env,
        &target_id,
        &repo,
        Some(ceo_connector::config::LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
    );

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([]);

    let completion = run_setup_convergence(&env.paths, &mut ui, &doctor, None)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    assert!(ui
        .joined_messages()
        .contains("Existing valid CEO Agent Runtime device mapping verified; reusing."));
    assert!(ui
        .joined_messages()
        .contains("Execution agent configuration verified (reused existing)."));
    assert_eq!(ui.select_calls.len(), 0);
    assert_eq!(ui.text_calls.len(), 0);
}

// ---------------------------------------------------------------------------
// Tests: P0 BLOCKER 4 — Wire Runtime Discovery
// ---------------------------------------------------------------------------

#[tokio::test]
async fn convergence_discovery_single_candidate_auto_links_without_prompt() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let home = env._temp.path().join("fake_home");
    fs::create_dir_all(&home).unwrap();
    let discovered_repo = home.join("codes").join("ceo-agent-runtime");
    init_agent_runtime_repo(&discovered_repo);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([]);

    let completion =
        run_setup_convergence_with_home(&env.paths, &mut ui, &doctor, None, Some(&home))
            .await
            .unwrap();

    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    assert_eq!(
        ui.select_calls.len(),
        0,
        "must auto-link without select prompt"
    );
    assert_eq!(ui.text_calls.len(), 0, "must auto-link without text prompt");
    assert!(ui.joined_messages().contains("auto-linking..."));
    assert!(ui
        .joined_messages()
        .contains("Configured execution agent for 'ceo-agent-runtime': agent 'auto' (follow Orca default policy)."));

    let config = env.config().unwrap();
    let target = config.targets.values().next().expect("target configured");
    assert_eq!(
        fs::canonicalize(&target.local_path).unwrap(),
        fs::canonicalize(&discovered_repo).unwrap()
    );
    let exec = target.executor.as_ref().expect("executor configured");
    assert_eq!(exec.agent_id, "auto");
    assert_eq!(exec.command, None);
}

#[tokio::test]
async fn convergence_discovery_multiple_candidates_fails_requiring_explicit_flag() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let home = env._temp.path().join("fake_home");
    fs::create_dir_all(&home).unwrap();
    let repo1 = home.join("codes").join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo1);
    let repo2 = home.join("dev").join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo2);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([]);

    let err = run_setup_convergence_with_home(&env.paths, &mut ui, &doctor, None, Some(&home))
        .await
        .unwrap_err();

    match err {
        ceo_connector::setup_frontend::SetupFrontendError::Ui(msg) => {
            assert!(msg.contains("multiple runtime candidates found"));
        }
        other => panic!("expected UI error for multiple candidates, got {other:?}"),
    }

    assert!(ui.errors.iter().any(|e| e.contains("--runtime-path")));
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "Doctor must not run on error"
    );
}

#[tokio::test]
async fn convergence_discovery_zero_candidates_proposes_dot_ceo_and_accepts() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let home = env._temp.path().join("fake_home");
    fs::create_dir_all(&home).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    // Option 0 is "Use proposed path (~/.ceo/ceo-agent-runtime)"
    let mut ui = ScriptedUi::new([ScriptedAction::Select(0)]);

    let completion =
        run_setup_convergence_with_home(&env.paths, &mut ui, &doctor, None, Some(&home))
            .await
            .unwrap();

    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    assert_eq!(ui.select_calls.len(), 1);
    let (prompt, options) = &ui.select_calls[0];
    assert!(prompt.contains("location"));
    assert!(options[0].contains(".ceo/ceo-agent-runtime"));

    let config = env.config().unwrap();
    let target = config.targets.values().next().expect("target configured");
    assert!(target.local_path.contains(".ceo/ceo-agent-runtime"));
    let exec = target.executor.as_ref().expect("executor configured");
    assert_eq!(exec.agent_id, "auto");
    assert_eq!(exec.command, None);
}

#[tokio::test]
async fn convergence_discovery_zero_candidates_change_path_accepts_custom_path() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let home = env._temp.path().join("fake_home");
    fs::create_dir_all(&home).unwrap();
    let custom_target = home.join("my_custom_runtime");

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    // Option 1 is "Change path"
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(1),
        ScriptedAction::Text(custom_target.to_string_lossy().into_owned()),
    ]);

    let completion =
        run_setup_convergence_with_home(&env.paths, &mut ui, &doctor, None, Some(&home))
            .await
            .unwrap();

    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    assert_eq!(ui.select_calls.len(), 1);
    assert_eq!(ui.text_calls.len(), 1);

    let config = env.config().unwrap();
    let target = config.targets.values().next().expect("target configured");
    assert_eq!(target.local_path, custom_target.to_string_lossy());
    let exec = target.executor.as_ref().expect("executor configured");
    assert_eq!(exec.agent_id, "auto");
}

#[tokio::test]
async fn convergence_discovery_zero_candidates_cancel_exits_without_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let home = env._temp.path().join("fake_home");
    fs::create_dir_all(&home).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    // Option 2 is "Cancel"
    let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]);

    let completion =
        run_setup_convergence_with_home(&env.paths, &mut ui, &doctor, None, Some(&home))
            .await
            .unwrap();

    assert_eq!(completion, SetupCompletion::Cancelled);
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.default_calls(), 0);
    assert!(env.config().is_none() || env.config().unwrap().targets.is_empty());
}

#[tokio::test]
async fn convergence_explicit_runtime_path_links_directly() {
    let env = env_with_workspaces(one_workspace()).await;
    seed_configured_runtime(&env);

    let custom_target = env._temp.path().join("explicit_runtime");
    init_agent_runtime_repo(&custom_target);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([]);

    let completion = run_setup_convergence(
        &env.paths,
        &mut ui,
        &doctor,
        Some(custom_target.to_str().unwrap()),
    )
    .await
    .unwrap();

    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    assert_eq!(ui.select_calls.len(), 0);
    assert_eq!(ui.text_calls.len(), 0);

    let config = env.config().unwrap();
    let target = config.targets.values().next().expect("target configured");
    assert_eq!(
        fs::canonicalize(&target.local_path).unwrap(),
        fs::canonicalize(&custom_target).unwrap()
    );
    let exec = target.executor.as_ref().expect("executor configured");
    assert_eq!(exec.agent_id, "auto");
    assert_eq!(exec.command, None);
}
