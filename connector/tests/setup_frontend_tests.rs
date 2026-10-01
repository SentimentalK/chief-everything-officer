//! PROJECT-036 Slice 3 — guided interactive setup frontend.
//!
//! Deterministic tests: all prompts run through a scripted [`SetupUi`] test
//! driver (no real terminal, no PTY dependency), while every mutation goes
//! through the real shared setup application services against a stateful
//! fake Server and real local Git fixtures. Pre-baked rendering is never
//! treated as success: core calls and their observable effects are asserted.

mod common;

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
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
    complete_path, default_project_path_with_home, expand_tilde_with_home,
    is_safe_single_path_component, login_handoff_action, post_login_handoff, run_setup_wizard,
    run_standalone_setup, HandoffAction, SetupCompletion, SetupUi, UiError,
    CODING_PROJECT_MENU_LABEL, FINISH_MENU_LABEL, SETUP_MENU_PROMPT,
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
    let st = state.clone();
    server.add_handler(move |req| {
        let mut st = st.lock().unwrap();
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api/connector/workspaces") => MockResponse::json(
                200,
                &serde_json::json!({ "workspaces": st.workspaces }),
            ),
            ("GET", p) if p.starts_with("/api/connector/targets") => {
                let targets: Vec<serde_json::Value> = st.targets.iter().map(|t| t.wire()).collect();
                MockResponse::json(200, &serde_json::json!({ "targets": targets }))
            }
            ("POST", "/api/connector/targets/register") => {
                let body: serde_json::Value = req.json().unwrap();
                let alias = body["alias"].as_str().unwrap().to_string();
                let ws = body["workspace_id"].as_str().unwrap().to_string();
                st.register_calls += 1;
                let id = format!("tgt_new_{}", st.register_calls);
                st.targets.push(FakeTarget {
                    id: id.clone(),
                    workspace_id: ws.clone(),
                    alias: alias.clone(),
                    kind: "coding".to_string(),
                    disabled: false,
                    is_default: false,
                    binding_enabled: true,
                });
                MockResponse::json(
                    201,
                    &serde_json::json!({
                        "target": {
                            "id": id,
                            "workspace_id": ws,
                            "alias": alias,
                            "display_name": alias,
                            "kind": "coding",
                            "repository": null,
                            "disabled": false,
                            "is_default_agent_runtime": false,
                        },
                        "binding": { "id": "bnd_new", "enabled": true },
                        "target_created": true,
                        "binding_created": true,
                        "replayed": false,
                    }),
                )
            }
            ("POST", p) if p.starts_with("/api/connector/targets/") && p.ends_with("/bind") => {
                let id = p
                    .strip_prefix("/api/connector/targets/")
                    .and_then(|r| r.strip_suffix("/bind"))
                    .unwrap()
                    .to_string();
                st.bind_calls += 1;
                let replayed = st
                    .targets
                    .iter_mut()
                    .find(|t| t.id == id)
                    .map(|t| {
                        let was = t.binding_enabled;
                        t.binding_enabled = true;
                        was
                    })
                    .unwrap_or(false);
                MockResponse::json(
                    200,
                    &serde_json::json!({
                        "target_id": id,
                        "binding_id": "bnd_x",
                        "enabled": true,
                        "replayed": replayed,
                    }),
                )
            }
            ("POST", p)
                if p.starts_with("/api/connector/targets/") && p.ends_with("/default-runtime") =>
            {
                let id = p
                    .strip_prefix("/api/connector/targets/")
                    .and_then(|r| r.strip_suffix("/default-runtime"))
                    .unwrap()
                    .to_string();
                st.default_runtime_calls += 1;
                let exists = st.targets.iter().any(|t| t.id == id);
                if !exists {
                    return MockResponse::json(
                        404,
                        &serde_json::json!({ "error": "TARGET_NOT_FOUND", "message": "no such target" }),
                    );
                }
                let replayed = st.targets.iter().any(|t| t.id == id && t.is_default);
                for t in st.targets.iter_mut() {
                    t.is_default = t.id == id;
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
            _ => MockResponse { status: 0, headers: vec![], body: vec![] },
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
        "role": "owner",
        "workspace_repository": null
    })]
}

fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

/// Real Git repository whose origin verifies as the canonical official
/// Agent Runtime repository.
fn init_agent_runtime_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-b", "master"]);
    git(
        path,
        &["remote", "add", "origin", AGENT_RUNTIME_REPO_CLONE_URL],
    );
    fs::write(path.join("README.md"), "fixture\n").unwrap();
    git(
        path,
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
        path,
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

/// Seeds the fake Server with the canonical Agent Runtime Target fully
/// configured from the Server side (enabled, bound, default).
fn seed_configured_runtime(env: &TestEnv) -> String {
    let mut t = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    t.is_default = true;
    t.binding_enabled = true;
    let id = t.id.clone();
    env.state.lock().unwrap().targets.push(t);
    id
}

/// Writes the schema-v3 local mapping for `target_id` to a verified repo.
fn write_local_mapping(env: &TestEnv, target_id: &str, local_path: &Path) {
    let cred_text = fs::read_to_string(env.paths.credential_file()).unwrap();
    let cred: serde_json::Value = serde_json::from_str(&cred_text).unwrap();
    let mut config = LocalConfig::new(cred["server_origin"].as_str().unwrap().to_string()).unwrap();
    config.targets.insert(
        target_id.to_string(),
        ceo_connector::config::LocalTarget {
            local_path: fs::canonicalize(local_path)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            executor: None, // executor/model is intentionally NOT required
        },
    );
    config.save(&env.paths.config_file()).unwrap();
}

// ---------------------------------------------------------------------------
// Scripted frontend driver (deterministic; no real terminal)
// ---------------------------------------------------------------------------

enum ScriptedAction {
    Select(usize),
    CancelSelect,
    Text(String),
    CancelText,
}

#[derive(Default)]
struct ScriptedUi {
    script: VecDeque<ScriptedAction>,
    messages: Vec<String>,
    errors: Vec<String>,
    select_calls: Vec<(String, Vec<String>)>,
    text_calls: Vec<(String, Option<String>, bool)>,
}

impl ScriptedUi {
    fn new(script: impl IntoIterator<Item = ScriptedAction>) -> Self {
        Self {
            script: script.into_iter().collect(),
            ..Default::default()
        }
    }

    fn take(&mut self, kind: &str) -> ScriptedAction {
        self.script.pop_front().unwrap_or_else(|| {
            panic!("unexpected {kind} prompt: the wizard must not prompt beyond the scripted flow")
        })
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
        match self.take("select") {
            ScriptedAction::Select(i) => Ok(i),
            ScriptedAction::CancelSelect => Err(UiError::Cancelled),
            _ => panic!("scripted text answer consumed by select prompt"),
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
            default.map(|d| d.to_string()),
            complete_paths,
        ));
        match self.take("text") {
            ScriptedAction::Text(t) => Ok(t),
            ScriptedAction::CancelText => Err(UiError::Cancelled),
            _ => panic!("scripted select answer consumed by text prompt"),
        }
    }
}

// ---------------------------------------------------------------------------
// Counting Doctor stub (Finish/Doctor exit semantics)
// ---------------------------------------------------------------------------

fn make_doctor(
    counter: Arc<AtomicUsize>,
    passed: bool,
) -> impl ceo_connector::setup_frontend::DoctorRunner {
    CountingDoctor { counter, passed }
}

struct CountingDoctor {
    counter: Arc<AtomicUsize>,
    passed: bool,
}

#[async_trait::async_trait]
impl ceo_connector::setup_frontend::DoctorRunner for CountingDoctor {
    async fn run(&self, _paths: &ConnectorPaths) -> DoctorReport {
        self.counter.fetch_add(1, Ordering::SeqCst);
        DoctorReport {
            checks: vec![],
            overall_passed: self.passed,
        }
    }
}

// ---------------------------------------------------------------------------
// A. CLI surface / non-interactive safety
// ---------------------------------------------------------------------------

#[test]
fn cli_surface_setup_command_and_no_setup_flag_are_discoverable() {
    use clap::CommandFactory;
    let cmd = Cli::command();
    assert!(
        cmd.find_subcommand("setup").is_some(),
        "`setup` must be a discoverable subcommand"
    );
    let login = cmd.find_subcommand("login").expect("login subcommand");
    assert!(
        login.get_arguments().any(|a| a.get_id() == "no_setup"),
        "login must expose the explicit --no-setup escape hatch"
    );
}

#[test]
fn interactive_terminal_detection_matches_libc_tty_state() {
    // In the cargo test harness stdin/stdout are not a TTY, so the guard
    // must report non-interactive (never claim interactivity it cannot
    // back). This pins the contract used by `setup` and the login handoff.
    let interactive =
        unsafe { libc::isatty(libc::STDIN_FILENO) == 1 && libc::isatty(libc::STDOUT_FILENO) == 1 };
    assert_eq!(
        ceo_connector::setup_frontend::is_interactive_terminal(),
        interactive
    );
}

// ---------------------------------------------------------------------------
// B. Readiness / handoff
// ---------------------------------------------------------------------------

#[tokio::test]
async fn readiness_configured_when_all_runtime_facts_present() {
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping(&env, &target_id, &repo);

    let readiness = assess_agent_runtime_readiness(&env.paths).await.unwrap();
    assert!(
        !readiness.needs_setup(),
        "fully configured runtime must report needs_setup=false"
    );
    // Executor/model absence does NOT by itself make needs_setup true.
    let config = env.config().unwrap();
    assert!(config.targets.get(&target_id).unwrap().executor.is_none());
}

#[tokio::test]
async fn readiness_missing_target_is_needs_setup() {
    let env = env_with_workspaces(one_workspace()).await;
    assert!(assess_agent_runtime_readiness(&env.paths)
        .await
        .unwrap()
        .needs_setup());
}

#[tokio::test]
async fn readiness_missing_or_disabled_binding_is_needs_setup() {
    for binding_enabled in [false, false] {
        let env = env_with_workspaces(one_workspace()).await;
        let mut t = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
        t.is_default = true;
        t.binding_enabled = binding_enabled;
        env.state.lock().unwrap().targets.push(t);
        assert!(
            assess_agent_runtime_readiness(&env.paths)
                .await
                .unwrap()
                .needs_setup(),
            "binding enabled={binding_enabled} must be needs_setup"
        );
    }
}

#[tokio::test]
async fn readiness_not_default_is_needs_setup() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut t = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    t.is_default = false;
    env.state.lock().unwrap().targets.push(t);
    assert!(assess_agent_runtime_readiness(&env.paths)
        .await
        .unwrap()
        .needs_setup());
}

#[tokio::test]
async fn readiness_missing_local_mapping_or_path_or_wrong_repo_is_needs_setup() {
    // 1. No local mapping at all.
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    assert!(assess_agent_runtime_readiness(&env.paths)
        .await
        .unwrap()
        .needs_setup());

    // 2. Mapping present but path does not exist.
    write_local_mapping(&env, &target_id, &repo);
    let missing = env._temp.path().join("removed-runtime");
    let cred_text = fs::read_to_string(env.paths.credential_file()).unwrap();
    let cred: serde_json::Value = serde_json::from_str(&cred_text).unwrap();
    let mut config = LocalConfig::new(cred["server_origin"].as_str().unwrap().to_string()).unwrap();
    config.targets.insert(
        target_id.clone(),
        ceo_connector::config::LocalTarget {
            local_path: missing.to_string_lossy().into_owned(),
            executor: None,
        },
    );
    config.save(&env.paths.config_file()).unwrap();
    assert!(assess_agent_runtime_readiness(&env.paths)
        .await
        .unwrap()
        .needs_setup());

    // 3. Mapping present but the path is not the official repository.
    let wrong = env._temp.path().join("wrong-repo");
    init_git_repo_wrong_origin(&wrong);
    write_local_mapping(&env, &target_id, &wrong);
    assert!(assess_agent_runtime_readiness(&env.paths)
        .await
        .unwrap()
        .needs_setup());
}

fn init_git_repo_wrong_origin(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("README.md"), "fixture\n").unwrap();
    git(path, &["init", "-b", "master"]);
    git(
        path,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/other/wrong.git",
        ],
    );
    git(
        path,
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
        path,
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

#[tokio::test]
async fn readiness_probe_failure_is_reported_not_faked() {
    // Credential pointing at a closed port: readiness cannot be determined.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    let cred = DeviceCredential::new(
        format!("http://127.0.0.1:{port}"),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let readiness = assess_agent_runtime_readiness(&paths).await;
    assert!(
        readiness.is_err(),
        "unreachable Server must be a probe failure, not needs_setup"
    );
}

#[tokio::test]
async fn post_login_handoff_enters_wizard_when_needed_and_interactive() {
    let env = env_with_workspaces(one_workspace()).await; // fresh/unconfigured
    let mut ui = ScriptedUi::new([ScriptedAction::CancelSelect]);
    let completion = post_login_handoff(&env.paths, false, true, &mut ui)
        .await
        .unwrap();
    assert_eq!(completion, Some(SetupCompletion::Cancelled));
    // The SAME wizard frontend as `ceo-connector setup` was entered.
    assert_eq!(ui.select_calls.len(), 1);
    assert_eq!(ui.select_calls[0].0, SETUP_MENU_PROMPT);
    // Authentication was not disturbed.
    assert!(env.paths.credential_file().exists());
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
    // Point the stored credential at a closed port to simulate a temporary
    // Server outage AFTER successful authentication.
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
    let unready = ceo_connector::setup::SetupReadiness {
        agent_runtime_configured: false,
    };
    let ready = ceo_connector::setup::SetupReadiness {
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
// C. Menu behavior
// ---------------------------------------------------------------------------

#[tokio::test]
async fn top_menu_finish_runs_doctor_exactly_once_and_mirrors_verdict() {
    for doctor_passed in [true, false] {
        let env = env_with_workspaces(one_workspace()).await;
        let counter = Arc::new(AtomicUsize::new(0));
        let doctor = make_doctor(counter.clone(), doctor_passed);
        let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]); // Finish
        let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
            .await
            .unwrap();
        assert_eq!(
            completion,
            SetupCompletion::Finished { doctor_passed },
            "exit verdict must mirror the Doctor report"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "Doctor must run exactly once"
        );
        assert!(ui
            .joined_messages()
            .contains("Setup complete. Running doctor..."));
        // No setup actions were performed.
        assert_eq!(env.register_calls(), 0);
        assert_eq!(env.default_calls(), 0);
    }
}

#[tokio::test]
async fn standalone_setup_maps_doctor_verdict_to_exit_code() {
    let env = env_with_workspaces(one_workspace()).await;
    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), true);
    let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]);
    let code = run_standalone_setup(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(code, ExitCode::SUCCESS);
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter.clone(), false);
    let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]);
    let code = run_standalone_setup(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(code, ExitCode::FAILURE);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn top_menu_cancel_exits_safely_without_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([ScriptedAction::CancelSelect]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(completion, SetupCompletion::Cancelled);
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.default_calls(), 0);
    assert!(env.config().is_none() || env.config().unwrap().targets.is_empty());
}

#[tokio::test]
async fn configured_marker_comes_from_shared_readiness_view_model() {
    // Configured: marker present on the runtime menu entry.
    let env = env_with_workspaces(one_workspace()).await;
    let target_id = seed_configured_runtime(&env);
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);
    write_local_mapping(&env, &target_id, &repo);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]);
    run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();

    let (prompt, options) = ui.select_calls[0].clone();
    assert_eq!(prompt, SETUP_MENU_PROMPT);
    assert_eq!(options[0], "Enable CEO Agent Runtime [Configured]");
    assert_eq!(options[1], CODING_PROJECT_MENU_LABEL);
    assert_eq!(options[2], FINISH_MENU_LABEL);

    // Unconfigured: same menu, no marker.
    let env = env_with_workspaces(one_workspace()).await;
    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([ScriptedAction::Select(2)]);
    run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    let (_, options) = ui.select_calls[0].clone();
    assert_eq!(options[0], "Enable CEO Agent Runtime");
    assert!(!options[0].contains("[Configured]"));
}

// ---------------------------------------------------------------------------
// D. Agent Runtime frontend flow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agent_runtime_flow_delegates_to_ensure_agent_runtime_and_renders_facts() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(0), // Enable CEO Agent Runtime
        ScriptedAction::Text(repo.to_string_lossy().into_owned()),
        ScriptedAction::Select(0), // Continue
        ScriptedAction::Select(2), // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );

    // Delegation: the real shared setup service ran (not duplicated logic).
    assert_eq!(env.register_calls(), 1);
    assert_eq!(env.default_calls(), 1);
    let config = env.config().unwrap();
    assert_eq!(config.targets.len(), 1);

    // Typed outcome rendered as human facts: name/path/action, no raw IDs.
    let messages = ui.joined_messages();
    assert!(messages.contains("ceo-agent-runtime"));
    assert!(messages.contains(
        &fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .to_string()
    ));
    assert!(messages.contains("created"));
    assert!(messages.contains("cloned") || messages.contains("reused"));
    assert!(messages.contains("bound"));
    assert!(messages.contains("default"));
    for raw_prefix in ["tgt_", "ws_", "dev_", "bnd_"] {
        assert!(
            !messages.contains(raw_prefix),
            "raw ID prefix {raw_prefix} must not appear in rendered outcome"
        );
    }

    // Only the expected prompts were ever requested from the user.
    assert_eq!(ui.text_calls.len(), 1);
    assert_eq!(ui.text_calls[0].0, "Path to install the CEO Agent Runtime:");
}

#[tokio::test]
async fn agent_runtime_flow_offers_home_default_and_edit_loop_without_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);

    // A pre-existing non-repo path forces a recoverable core error on the
    // first Continue attempt (no clone, no mutation, no network).
    let blocker = env._temp.path().join("blocker");
    fs::write(&blocker, "not a repo\n").unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(0), // Enable CEO Agent Runtime
        ScriptedAction::Text(blocker.to_string_lossy().into_owned()),
        ScriptedAction::Select(1), // Edit path (no mutation)
        ScriptedAction::Text(repo.to_string_lossy().into_owned()),
        ScriptedAction::Select(0), // Continue
        ScriptedAction::Select(2), // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );

    // The first (conflicting) path never reached the local config; the edit
    // loop re-prompted and only the final accepted path was ensured once.
    assert_eq!(env.register_calls(), 1);
    let config = env.config().unwrap();
    let canonical = fs::canonicalize(&repo)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(config.targets.values().all(|t| t.local_path == canonical));

    // Default text was HOME/codes/ceo-agent-runtime when home is available.
    if let Some(home) = dirs::home_dir() {
        let expected = home.join("codes").join("ceo-agent-runtime");
        assert_eq!(
            ui.text_calls[0].1.as_deref(),
            Some(expected.to_string_lossy().as_ref())
        );
    }
    // Completion was enabled for path prompts.
    assert!(ui.text_calls.iter().all(|(_, _, complete)| *complete));
}

#[tokio::test]
async fn agent_runtime_cancel_at_confirm_returns_to_top_menu_without_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(0), // Enable CEO Agent Runtime
        ScriptedAction::Text(repo.to_string_lossy().into_owned()),
        ScriptedAction::Select(2), // Cancel
        ScriptedAction::Select(2), // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );

    // Returned to the top-level menu (top -> confirm -> top) with zero
    // mutations.
    assert_eq!(ui.select_calls.len(), 3);
    assert_eq!(
        ui.select_calls[1].0,
        "Confirm the Agent Runtime install path"
    );
    assert_eq!(ui.select_calls[2].0, SETUP_MENU_PROMPT);
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.default_calls(), 0);
    assert!(env.config().is_none() || env.config().unwrap().targets.is_empty());
}

#[tokio::test]
async fn agent_runtime_cancel_at_path_prompt_returns_to_menu_without_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(0),  // Enable CEO Agent Runtime
        ScriptedAction::CancelText, // Ctrl+C/Esc at the path prompt
        ScriptedAction::Select(2),  // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );
    // Back at the top-level menu, nothing was mutated.
    assert_eq!(ui.select_calls.len(), 2);
    assert_eq!(ui.select_calls[1].0, SETUP_MENU_PROMPT);
    assert_eq!(env.register_calls(), 0);
    assert!(env.config().is_none() || env.config().unwrap().targets.is_empty());
}

#[tokio::test]
async fn agent_runtime_confirm_prompt_offers_continue_edit_cancel() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_agent_runtime_repo(&repo);

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(0),
        ScriptedAction::Text(repo.to_string_lossy().into_owned()),
        ScriptedAction::Select(2), // Cancel
        ScriptedAction::Select(2), // Finish
    ]);
    run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();

    let (prompt, options) = &ui.select_calls[1];
    assert_eq!(prompt, "Confirm the Agent Runtime install path");
    assert_eq!(
        options,
        &vec![
            "Continue".to_string(),
            "Edit path".to_string(),
            "Cancel".to_string()
        ]
    );
    // The confirmation showed the resolved path before any mutation.
    assert!(ui.joined_messages().contains("CEO Agent Runtime"));
    assert!(ui.joined_messages().contains("Path:"));
}

// ---------------------------------------------------------------------------
// E. Coding project frontend flow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn coding_flow_delegates_to_ensure_coding_target_with_name_and_path_only() {
    let env = env_with_workspaces(one_workspace()).await;
    let dir = env._temp.path().join("my-app");
    fs::create_dir_all(&dir).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(1),             // Add a coding project
        ScriptedAction::Text("my-app".into()), // Project name
        ScriptedAction::Text(dir.to_string_lossy().into_owned()),
        ScriptedAction::Select(0), // Create / Bind
        ScriptedAction::Select(2), // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );

    assert_eq!(env.register_calls(), 1);
    let config = env.config().unwrap();
    assert_eq!(config.targets.len(), 1);

    // Exactly two prompts were requested: project name + directory.
    assert_eq!(ui.text_calls.len(), 2);
    assert_eq!(ui.text_calls[0].0, "Project name:");
    assert_eq!(ui.text_calls[1].0, "Project directory:");
    assert!(ui.text_calls.iter().all(|(_, _, _)| true));

    // Rendered facts include the alias and canonical path, never raw IDs.
    let messages = ui.joined_messages();
    assert!(messages.contains("my-app"));
    assert!(messages.contains(
        &fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string()
    ));
    for raw_prefix in ["tgt_", "ws_", "dev_", "bnd_"] {
        assert!(!messages.contains(raw_prefix));
    }
}

#[tokio::test]
async fn coding_flow_offers_safe_default_path_from_home() {
    let env = env_with_workspaces(one_workspace()).await;
    let dir = env._temp.path().join("safe-default");
    fs::create_dir_all(&dir).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(1),
        ScriptedAction::Text("safe-default".into()),
        ScriptedAction::Text(dir.to_string_lossy().into_owned()),
        ScriptedAction::Select(0),
        ScriptedAction::Select(2),
    ]);
    run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();

    if let Some(home) = dirs::home_dir() {
        let expected = home.join("codes").join("safe-default");
        assert_eq!(
            ui.text_calls[1].1.as_deref(),
            Some(expected.to_string_lossy().as_ref())
        );
    }
    // The name prompt has no default and no path completion; the directory
    // prompt has Tab completion.
    assert_eq!(ui.text_calls[0].1, None);
    assert!(!ui.text_calls[0].2);
    assert!(ui.text_calls[1].2);
}

#[tokio::test]
async fn coding_flow_recoverable_error_is_correctable_without_restarting_setup() {
    let env = env_with_workspaces(one_workspace()).await;
    // Missing path first (recoverable), then a valid directory.
    let missing = env._temp.path().join("does-not-exist");
    let dir = env._temp.path().join("fixed-app");
    fs::create_dir_all(&dir).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(1), // Add a coding project
        ScriptedAction::Text("fixed-app".into()),
        ScriptedAction::Text(missing.to_string_lossy().into_owned()),
        ScriptedAction::Select(0), // Create / Bind -> recoverable error
        ScriptedAction::Select(1), // Edit path
        ScriptedAction::Text(dir.to_string_lossy().into_owned()),
        ScriptedAction::Select(0), // Create / Bind -> success
        ScriptedAction::Select(2), // Finish
    ]);
    let completion = run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();
    assert_eq!(
        completion,
        SetupCompletion::Finished {
            doctor_passed: true
        }
    );

    // The error was surfaced and the retry converged via the shared core.
    assert!(ui
        .errors
        .iter()
        .any(|e| e.contains("Could not add the coding project")));
    assert_eq!(env.register_calls(), 1); // reused, no duplicate target
    let config = env.config().unwrap();
    let canonical = fs::canonicalize(&dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(config.targets.values().all(|t| t.local_path == canonical));
}

#[tokio::test]
async fn coding_flow_confirm_prompt_offers_create_edit_edit_cancel() {
    let env = env_with_workspaces(one_workspace()).await;
    let dir = env._temp.path().join("confirm-app");
    fs::create_dir_all(&dir).unwrap();

    let counter = Arc::new(AtomicUsize::new(0));
    let doctor = make_doctor(counter, true);
    let mut ui = ScriptedUi::new([
        ScriptedAction::Select(1),
        ScriptedAction::Text("confirm-app".into()),
        ScriptedAction::Text(dir.to_string_lossy().into_owned()),
        ScriptedAction::Select(3), // Cancel
        ScriptedAction::Select(2), // Finish
    ]);
    run_setup_wizard(&env.paths, &mut ui, &doctor)
        .await
        .unwrap();

    let (prompt, options) = &ui.select_calls[1];
    assert_eq!(prompt, "Confirm the coding project");
    assert_eq!(
        options,
        &vec![
            "Create / Bind".to_string(),
            "Edit name".to_string(),
            "Edit path".to_string(),
            "Cancel".to_string(),
        ]
    );
    // Cancel returned to the top-level menu with zero mutations.
    assert_eq!(ui.select_calls[2].0, SETUP_MENU_PROMPT);
    assert_eq!(env.register_calls(), 0);
    assert!(env.config().is_none() || env.config().unwrap().targets.is_empty());
}

// ---------------------------------------------------------------------------
// F. Path editor / completion pure helpers
// ---------------------------------------------------------------------------

#[test]
fn tilde_expansion_semantics() {
    let home = Path::new("/home/u");
    assert_eq!(
        expand_tilde_with_home("~", Some(home)).unwrap(),
        PathBuf::from("/home/u")
    );
    assert_eq!(
        expand_tilde_with_home("~/co des/x", Some(home)).unwrap(),
        PathBuf::from("/home/u/co des/x")
    );
    assert_eq!(
        expand_tilde_with_home("/abs/path", Some(home)).unwrap(),
        PathBuf::from("/abs/path")
    );
    let err = expand_tilde_with_home("~alice/repos", Some(home)).unwrap_err();
    assert!(
        err.contains("~user"),
        "must reject ~user syntax clearly: {err}"
    );
    assert!(expand_tilde_with_home("", Some(home)).is_err());
    assert!(expand_tilde_with_home("~/x", None).is_err());
}

#[test]
fn default_project_path_is_none_for_unsafe_names() {
    let home = Path::new("/home/u");
    assert_eq!(
        default_project_path_with_home("app", Some(home)).unwrap(),
        "/home/u/codes/app"
    );
    for bad in ["", "  ", ".", "..", "a/b", "a\\b", "..\\x"] {
        assert!(
            default_project_path_with_home(bad, Some(home)).is_none(),
            "name {bad:?} must not produce a default path"
        );
    }
    // Surrounding whitespace is trimmed before the safety check, matching
    // how the wizard normalizes the name.
    assert_eq!(
        default_project_path_with_home(" spaced ", Some(home)).unwrap(),
        "/home/u/codes/spaced"
    );
    assert!(!is_safe_single_path_component("  "));
    assert!(is_safe_single_path_component("my-app"));
}

#[test]
fn path_completion_never_shells_and_preserves_spaces_unicode() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path();
    fs::create_dir_all(base.join("codes/nested dir")).unwrap();
    fs::create_dir_all(base.join("uni-dir-é")).unwrap();
    fs::write(base.join("plain.txt"), "x").unwrap();

    let suggestions = complete_path(&format!("{}/", base.display()));
    assert_eq!(suggestions.len(), 2, "directories only");
    assert!(suggestions.contains(&format!("{}/codes/", base.display())));
    assert!(suggestions.contains(&format!("{}/uni-dir-é/", base.display())));

    let nested = complete_path(&format!("{}/codes/nest", base.display()));
    assert_eq!(
        nested,
        vec![format!("{}/codes/nested dir/", base.display())],
        "spaces and prefix matching preserved without shell splitting"
    );

    // Nonexistent base yields no suggestions and never executes anything.
    assert!(complete_path("/definitely/not/here/x").is_empty());
}
