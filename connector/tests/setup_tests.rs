//! PROJECT-036 Slice 2 — reusable idempotent setup application services.
//!
//! Realistic mock HTTP Server surfaces + temporary filesystem/Git fixtures.
//! The SetupService itself is never mocked to always succeed: every test goes
//! through `ensure_agent_runtime` / `ensure_coding_target` against a stateful
//! fake Server and real local Git repositories.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::setup::{
    configure_agent_runtime_executor, ensure_agent_runtime, ensure_agent_runtime_with_repo,
    ensure_coding_target, ensure_coding_target_with_policy, AgentRuntimeRepoSpec, CodingPathPolicy,
    SetupError, AGENT_RUNTIME_REPO_CLONE_URL, AGENT_RUNTIME_TARGET_ALIAS,
};
use common::mock_server::{MockResponse, MockServer};

// ---------------------------------------------------------------------------
// Stateful fake Server (DeviceAuth surface)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct FakeTarget {
    id: String,
    workspace_id: String,
    alias: String,
    display_name: String,
    kind: String,
    repository: Option<serde_json::Value>,
    disabled: bool,
    is_default: bool,
    binding_enabled: bool,
}

impl FakeTarget {
    fn wire(&self) -> serde_json::Value {
        let binding = if self.binding_enabled {
            Some(serde_json::json!({
                "id": format!("bnd_{}", self.id),
                "enabled": true
            }))
        } else {
            None
        };
        serde_json::json!({
            "target": {
                "id": self.id,
                "workspace_id": self.workspace_id,
                "alias": self.alias,
                "display_name": self.display_name,
                "kind": self.kind,
                "repository": self.repository,
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
    fail_default_runtime: bool,
    target_counter: usize,
    last_register_body: Option<serde_json::Value>,
}

impl ServerState {
    fn new(workspaces: Vec<serde_json::Value>) -> Self {
        Self {
            workspaces,
            targets: vec![],
            register_calls: 0,
            bind_calls: 0,
            default_runtime_calls: 0,
            fail_default_runtime: false,
            target_counter: 0,
            last_register_body: None,
        }
    }
}

fn fake_target(alias: &str, kind: &str) -> FakeTarget {
    FakeTarget {
        id: format!("tgt_{alias}"),
        workspace_id: "ws_fix".to_string(),
        alias: alias.to_string(),
        display_name: alias.to_string(),
        kind: kind.to_string(),
        repository: None,
        disabled: false,
        is_default: false,
        binding_enabled: true,
    }
}

async fn start_fake_server(
    workspaces: Vec<serde_json::Value>,
) -> (MockServer, Arc<Mutex<ServerState>>) {
    let server = MockServer::start().await;
    let state = Arc::new(Mutex::new(ServerState::new(workspaces)));
    let st = state.clone();
    server.add_handler(move |req| {
        let mut st = st.lock().unwrap();
        let path = req.path.as_str();
        match (req.method.as_str(), path) {
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
                let display = body["display_name"].as_str().unwrap().to_string();
                let kind = body["kind"].as_str().unwrap().to_string();
                let ws = body["workspace_id"].as_str().unwrap().to_string();
                let repository = body.get("repository").cloned();
                let id = format!("tgt_new_{}", st.target_counter);
                st.target_counter += 1;
                st.register_calls += 1;
                st.last_register_body = Some(body);
                st.targets.push(FakeTarget {
                    id: id.clone(),
                    workspace_id: ws.clone(),
                    alias: alias.clone(),
                    display_name: display.clone(),
                    kind: kind.clone(),
                    repository: repository.clone(),
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
                            "display_name": display,
                            "kind": kind,
                            "repository": repository,
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
                let t = st.targets.iter_mut().find(|t| t.id == id);
                match t {
                    Some(t) => {
                        let replayed = t.binding_enabled;
                        t.binding_enabled = true;
                        MockResponse::json(
                            200,
                            &serde_json::json!({
                                "target_id": id,
                                "binding_id": format!("bnd_{id}"),
                                "enabled": true,
                                "replayed": replayed,
                            }),
                        )
                    }
                    None => MockResponse::json(
                        404,
                        &serde_json::json!({ "error": "TARGET_NOT_FOUND", "message": "no such target" }),
                    ),
                }
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
                if st.fail_default_runtime {
                    return MockResponse::json(
                        500,
                        &serde_json::json!({ "error": "INTERNAL", "message": "boom" }),
                    );
                }
                let exists = st.targets.iter().any(|t| t.id == id);
                if !exists {
                    return MockResponse::json(
                        404,
                        &serde_json::json!({ "error": "TARGET_NOT_FOUND", "message": "no such target" }),
                    );
                }
                let replayed = st
                    .targets
                    .iter()
                    .find(|t| t.id == id)
                    .unwrap()
                    .is_default;
                // Workspace default is exclusive: clear others.
                for other in st.targets.iter_mut() {
                    other.is_default = other.id == id;
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

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn commit_all(dir: &Path, message: &str) {
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
            message,
        ],
    );
}

/// Creates a real Git repository with the given origin remote and one commit.
fn init_git_repo_with_origin(path: &Path, origin: &str) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-b", "master"]);
    git(path, &["remote", "add", "origin", origin]);
    fs::write(path.join("README.md"), "fixture\n").unwrap();
    commit_all(path, "init");
}

/// Creates a local bare repository fixture used as a stand-in for the
/// canonical remote while CI stays network-free. The returned path is both
/// the clone URL and the expected origin string (verification normalizes
/// GitHub remotes; a plain path compares as-is).
fn create_bare_fixture(parent: &Path) -> PathBuf {
    fs::create_dir_all(parent).unwrap();
    let bare = parent.join("ceo-agent-runtime-fixture.git");
    git(
        parent,
        &["init", "--bare", "-b", "master", bare.to_str().unwrap()],
    );
    let seed = parent.join("seed-work");
    fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-b", "master"]);
    fs::write(seed.join("README.md"), "ceo agent runtime fixture\n").unwrap();
    commit_all(&seed, "seed");
    git(&seed, &["push", bare.to_str().unwrap(), "HEAD:master"]);
    bare
}

struct TestEnv {
    _temp: tempfile::TempDir,
    paths: ConnectorPaths,
    state: Arc<Mutex<ServerState>>,
}

impl TestEnv {
    fn count(&self, f: impl Fn(&ServerState) -> usize) -> usize {
        f(&self.state.lock().unwrap())
    }

    fn register_calls(&self) -> usize {
        self.count(|s| s.register_calls)
    }
    fn bind_calls(&self) -> usize {
        self.count(|s| s.bind_calls)
    }
    fn default_calls(&self) -> usize {
        self.count(|s| s.default_runtime_calls)
    }

    fn config(&self) -> Option<LocalConfig> {
        LocalConfig::load(&self.paths.config_file()).unwrap()
    }

    /// Local target mapping, tolerant of an absent config file (no writes
    /// have happened yet) for negative-path assertions.
    fn local_targets(&self) -> std::collections::BTreeMap<String, LocalTarget> {
        self.config().map(|c| c.targets).unwrap_or_default()
    }

    fn assert_no_local_targets(&self) {
        assert!(self.local_targets().is_empty());
    }

    fn raw_config_text(&self) -> String {
        fs::read_to_string(self.paths.config_file()).unwrap_or_default()
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

fn active_attempt(paths: &ConnectorPaths, target_id: &str) {
    ceo_connector::local_state::atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({ "target_id": target_id }),
    )
    .unwrap();
}

fn write_config_with_executor(env: &TestEnv, target_id: &str, local_path: &str) {
    let cred_text = fs::read_to_string(env.paths.credential_file()).unwrap();
    let cred: serde_json::Value = serde_json::from_str(&cred_text).unwrap();
    let origin = cred["server_origin"].as_str().unwrap().to_string();
    let mut config = LocalConfig::new(origin).unwrap();
    config.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: local_path.to_string(),
            executor: Some(
                LocalExecutorConfig::new_with_model(
                    "cursor".into(),
                    "/path/agent -f --trust".into(),
                    Some("gpt-5".into()),
                )
                .unwrap(),
            ),
        },
    );
    config.save(&env.paths.config_file()).unwrap();
}

// ---------------------------------------------------------------------------
// A. Workspace context
// ---------------------------------------------------------------------------

#[tokio::test]
async fn single_workspace_resolves_internally_without_ws_input() {
    let env = env_with_workspaces(one_workspace()).await;
    let dir = env._temp.path().join("proj");
    fs::create_dir_all(&dir).unwrap();

    let outcome = ensure_coding_target(&env.paths, "proj", &dir)
        .await
        .unwrap();

    // The caller never supplied any workspace identifier; setup resolved the
    // single workspace internally and registered inside it.
    assert!(outcome.target_created);
    assert_eq!(outcome.alias, "proj");
    assert_eq!(outcome.kind, "coding");
    assert_eq!(env.register_calls(), 1);
    let body = {
        let st = env.state.lock().unwrap();
        st.last_register_body.clone().unwrap()
    };
    assert_eq!(body["workspace_id"], "ws_fix");
    let config = env.config().unwrap();
    assert!(config.targets.contains_key(&outcome.target_id));
}

#[tokio::test]
async fn zero_workspaces_fails_actionably_without_local_write() {
    let env = env_with_workspaces(vec![]).await;
    let dir = env._temp.path().join("proj");
    fs::create_dir_all(&dir).unwrap();

    let err = ensure_coding_target(&env.paths, "proj", &dir)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::NoWorkspace));
    assert!(err.to_string().contains("NO_WORKSPACE"));
    assert_eq!(env.register_calls(), 0);
    assert!(env.config().is_none());
}

#[tokio::test]
async fn multiple_workspaces_fail_closed_without_arbitrary_selection() {
    let env = env_with_workspaces(vec![
        serde_json::json!({ "id": "ws_alpha", "role": "owner", "workspace_repository": null }),
        serde_json::json!({ "id": "ws_beta", "role": "owner", "workspace_repository": null }),
    ])
    .await;
    let dir = env._temp.path().join("proj");
    fs::create_dir_all(&dir).unwrap();

    let err = ensure_coding_target(&env.paths, "proj", &dir)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::MultiWorkspaceUnsupported(2)));
    let msg = err.to_string();
    assert!(msg.contains("MULTI_WORKSPACE_SETUP_UNSUPPORTED"));
    // Never picks first and never exposes raw workspace IDs.
    assert!(!msg.contains("ws_alpha"));
    assert!(!msg.contains("ws_beta"));
    assert_eq!(env.register_calls(), 0);
    assert!(env.config().is_none());
}

// ---------------------------------------------------------------------------
// B. Agent Runtime ensure
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agent_runtime_absent_target_created_once_with_canonical_identity() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();

    assert!(outcome.target_created);
    assert!(!outcome.repo_cloned);
    assert!(outcome.binding_created);
    assert!(outcome.default_changed);
    assert_eq!(outcome.alias, AGENT_RUNTIME_TARGET_ALIAS);
    assert_eq!(outcome.kind, "coding");

    assert_eq!(env.register_calls(), 1);
    let body = {
        let st = env.state.lock().unwrap();
        st.last_register_body.clone().unwrap()
    };
    assert_eq!(body["alias"], "ceo-agent-runtime");
    assert_eq!(body["display_name"], "CEO Agent Runtime");
    assert_eq!(body["kind"], "coding");
    // No fabricated workspace-repository metadata for the external repo.
    assert!(body.get("repository").is_none());

    // Default runtime set only after local setup succeeded.
    assert_eq!(env.default_calls(), 1);

    let config = env.config().unwrap();
    assert_eq!(config.schema_version, 3);
    let lt = config.targets.get(&outcome.target_id).unwrap();
    assert_eq!(
        lt.local_path,
        fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
}

#[tokio::test]
async fn agent_runtime_rerun_reuses_same_immutable_target_id() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let first = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    let second = ensure_agent_runtime(&env.paths, &repo).await.unwrap();

    assert_eq!(first.target_id, second.target_id);
    assert_eq!(env.register_calls(), 1);
    assert!(!second.target_created);
    assert!(!second.repo_cloned);
    assert!(!second.binding_created);
    // Already default after the first run: honest no-op/replay.
    assert!(!second.default_changed);
    assert_eq!(env.default_calls(), 1);
    assert_eq!(env.bind_calls(), 0);
}

#[tokio::test]
async fn agent_runtime_existing_wrong_kind_fails() {
    let env = env_with_workspaces(one_workspace()).await;
    let st = env.state.lock().unwrap();
    let seeded = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "general_automation");
    let seeded_id = seeded.id.clone();
    drop(st);
    env.state.lock().unwrap().targets.push(seeded);

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let err = ensure_agent_runtime(&env.paths, &repo).await.unwrap_err();
    assert!(
        matches!(err, SetupError::TargetWrongKind { ref kind, .. } if kind == "general_automation")
    );
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.default_calls(), 0);
    assert!(!env.local_targets().contains_key(&seeded_id));
}

#[tokio::test]
async fn agent_runtime_disabled_target_fails() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    seeded.disabled = true;
    env.state.lock().unwrap().targets.push(seeded);

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let err = ensure_agent_runtime(&env.paths, &repo).await.unwrap_err();
    assert!(matches!(err, SetupError::TargetDisabled(_)));
    assert!(err.to_string().contains("TARGET_DISABLED"));
    assert_eq!(env.register_calls(), 0);
    env.assert_no_local_targets();
}

#[tokio::test]
async fn agent_runtime_existing_verified_repo_reused_without_clone() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);
    let marker = repo.join("local-marker.txt");
    fs::write(&marker, "user work\n").unwrap();

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert!(!outcome.repo_cloned);
    assert!(!outcome.target_created);
    assert!(!outcome.binding_created);
    assert!(outcome.default_changed);
    // Pre-existing user content untouched.
    assert!(marker.exists());
    assert_eq!(
        outcome.local_path,
        fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    let config = env.config().unwrap();
    assert_eq!(
        config.targets.get(&outcome.target_id).unwrap().local_path,
        outcome.local_path
    );
}

#[tokio::test]
async fn agent_runtime_absent_path_clones_and_verifies_official_repo() {
    let env = env_with_workspaces(one_workspace()).await;
    let bare = create_bare_fixture(env._temp.path().join("fixtures").as_path());
    let spec = AgentRuntimeRepoSpec {
        clone_url: bare.to_string_lossy().to_string(),
        expected_full_name: bare.to_string_lossy().to_string(),
    };
    let dest = env._temp.path().join("runtime").join("ceo-agent-runtime");

    let outcome = ensure_agent_runtime_with_repo(&env.paths, &dest, &spec)
        .await
        .unwrap();

    assert!(outcome.repo_cloned);
    assert!(outcome.target_created);
    assert!(outcome.default_changed);
    // Clone landed exactly at the requested destination and is a verified repo.
    assert!(dest.join("README.md").exists());
    let origin = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&dest)
        .output()
        .unwrap();
    assert!(origin.status.success());
    assert_eq!(
        String::from_utf8_lossy(&origin.stdout).trim(),
        bare.to_string_lossy().to_string()
    );
    assert_eq!(
        outcome.local_path,
        fs::canonicalize(&dest)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    let config = env.config().unwrap();
    assert_eq!(
        config.targets.get(&outcome.target_id).unwrap().local_path,
        outcome.local_path
    );
    assert_eq!(env.default_calls(), 1);
}

#[tokio::test]
async fn agent_runtime_existing_wrong_repo_fails_without_overwrite() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("unrelated-project");
    init_git_repo_with_origin(&repo, "https://github.com/other/wrong-repo.git");
    let marker = repo.join("user-work.txt");
    fs::write(&marker, "irreplaceable\n").unwrap();

    let err = ensure_agent_runtime(&env.paths, &repo).await.unwrap_err();
    assert!(matches!(err, SetupError::PathConflict { .. }));
    assert!(err.to_string().contains("SETUP_PATH_CONFLICT"));
    // No overwrite/delete of the pre-existing user path.
    assert!(marker.exists());
    let origin = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&origin.stdout).trim(),
        "https://github.com/other/wrong-repo.git"
    );
    // No local mapping, no default mutation.
    env.assert_no_local_targets();
    assert_eq!(env.default_calls(), 0);
}

#[tokio::test]
async fn git_missing_error_is_distinct_and_actionable() {
    // Distinct GIT_NOT_FOUND mapping is unit-tested against a real missing
    // executable in src/setup; here we pin the actionable message contract.
    let err = SetupError::GitNotFound;
    assert!(err.to_string().contains("GIT_NOT_FOUND"));
    assert!(err.to_string().contains("git"));
}

#[tokio::test]
async fn clone_failure_leaves_no_mapping_or_default_and_rerun_recovers() {
    let env = env_with_workspaces(one_workspace()).await;
    let missing_remote = env._temp.path().join("does-not-exist.git");
    let bad_spec = AgentRuntimeRepoSpec {
        clone_url: missing_remote.to_string_lossy().to_string(),
        expected_full_name: missing_remote.to_string_lossy().to_string(),
    };
    let dest = env._temp.path().join("ceo-agent-runtime");

    // 1. Register succeeds, clone fails.
    let err = ensure_agent_runtime_with_repo(&env.paths, &dest, &bad_spec)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::Git(_)));
    // Server progress is honest: the Target was registered...
    assert_eq!(env.register_calls(), 1);
    // ...but no local mapping was written and no default was set.
    env.assert_no_local_targets();
    assert_eq!(env.default_calls(), 0);
    assert_eq!(env.bind_calls(), 0);
    // No half-installed destination poisons the rerun.
    assert!(!dest.exists());
    // Staging directory was cleaned up.
    let leftovers: Vec<_> = fs::read_dir(env._temp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".ceo-setup-"))
        .collect();
    assert!(leftovers.is_empty(), "staging leftovers: {leftovers:?}");

    // 2. Rerun with a reachable source converges without duplicate registration.
    let bare = create_bare_fixture(env._temp.path().join("fixtures").as_path());
    let good_spec = AgentRuntimeRepoSpec {
        clone_url: bare.to_string_lossy().to_string(),
        expected_full_name: bare.to_string_lossy().to_string(),
    };
    let outcome = ensure_agent_runtime_with_repo(&env.paths, &dest, &good_spec)
        .await
        .unwrap();
    assert_eq!(env.register_calls(), 1); // reused, not duplicated
    assert!(!outcome.target_created);
    assert!(outcome.repo_cloned);
    assert!(outcome.default_changed);
    let config = env.config().unwrap();
    assert_eq!(config.targets.len(), 1);
    assert!(config.targets.contains_key(&outcome.target_id));
}

#[tokio::test]
async fn agent_runtime_device_binding_converges_idempotently() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    seeded.binding_enabled = false;
    let seeded_id = seeded.id.clone();
    env.state.lock().unwrap().targets.push(seeded);

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let first = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert!(first.binding_created);
    assert_eq!(env.bind_calls(), 1);

    let second = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert!(!second.binding_created);
    assert_eq!(env.bind_calls(), 1); // no duplicate bind
    assert_eq!(second.target_id, seeded_id);
}

#[tokio::test]
async fn agent_runtime_local_mapping_writes_only_v3_device_owned_fields() {
    let env = env_with_workspaces(one_workspace()).await;
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    // Compare the persisted path through the typed config representation, not
    // a raw-text substring: JSON escapes backslashes on Windows, so the file
    // contains `C:\\Users\\...` while `outcome.local_path` holds
    // `C:\Users\...`. Path equality must hold exactly across platforms.
    let config = env.config().unwrap();
    assert_eq!(config.schema_version, 3);
    let lt = config.targets.get(&outcome.target_id).unwrap();
    assert_eq!(lt.local_path, outcome.local_path);
    // Server-owned Target metadata never leaks into local state.
    let raw = env.raw_config_text();
    assert!(!raw.contains("\"alias\""));
    assert!(!raw.contains("\"kind\""));
    assert!(!raw.contains("\"workspace_id\""));
}

#[tokio::test]
async fn agent_runtime_preserves_existing_executor_and_model_exactly() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    write_config_with_executor(&env, "tgt_ceo-agent-runtime", "/old/path");

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert_eq!(outcome.target_id, "tgt_ceo-agent-runtime");

    let config = env.config().unwrap();
    let lt = config.targets.get("tgt_ceo-agent-runtime").unwrap();
    assert_eq!(lt.local_path, outcome.local_path);
    let exec = lt.executor.as_ref().unwrap();
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command.as_deref(), Some("/path/agent -f --trust"));
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
}

#[tokio::test]
async fn agent_runtime_active_attempt_blocks_local_mutation() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);
    active_attempt(&env.paths, "tgt_ceo-agent-runtime");

    let err = ensure_agent_runtime(&env.paths, &repo).await.unwrap_err();
    assert!(matches!(err, SetupError::TargetInUse(ref id) if id == "tgt_ceo-agent-runtime"));
    assert!(err.to_string().contains("TARGET_IN_USE"));
    // No binding churn, no local write, no default mutation.
    assert_eq!(env.bind_calls(), 0);
    env.assert_no_local_targets();
    assert_eq!(env.default_calls(), 0);
}

#[tokio::test]
async fn agent_runtime_already_default_is_noop_replay() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    seeded.is_default = true;
    env.state.lock().unwrap().targets.push(seeded);

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert!(!outcome.default_changed);
    assert_eq!(env.default_calls(), 0); // no unnecessary Server mutation
    let config = env.config().unwrap();
    assert_eq!(config.targets.len(), 1);
}

#[tokio::test]
async fn agent_runtime_default_change_only_after_local_setup_succeeds() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding");
    seeded.binding_enabled = false;
    env.state.lock().unwrap().targets.push(seeded);

    // Different target is currently the default; our target is not.
    env.state.lock().unwrap().targets.push(FakeTarget {
        is_default: true,
        ..fake_target("other-default", "coding")
    });

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    // Local setup succeeds -> the default is changed afterwards.
    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert!(outcome.default_changed);
    assert!(outcome.binding_created);
    assert_eq!(env.default_calls(), 1);
    let st = env.state.lock().unwrap();
    assert!(
        st.targets
            .iter()
            .find(|t| t.alias == AGENT_RUNTIME_TARGET_ALIAS)
            .unwrap()
            .is_default
    );
    assert!(
        !st.targets
            .iter()
            .find(|t| t.alias == "other-default")
            .unwrap()
            .is_default
    );
}

#[tokio::test]
async fn agent_runtime_default_set_failure_is_partial_progress_and_rerun_converges() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));
    env.state.lock().unwrap().fail_default_runtime = true;

    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    // 1. Default mutation fails AFTER local mapping succeeded.
    let err = ensure_agent_runtime(&env.paths, &repo).await.unwrap_err();
    let SetupError::PartialDefaultRuntime { outcome, source } = err else {
        panic!("expected PartialDefaultRuntime, got {err:?}");
    };
    assert!(!outcome.default_changed);
    assert_eq!(outcome.alias, AGENT_RUNTIME_TARGET_ALIAS);
    // The default mutation failed on the Server surface.
    assert!(matches!(*source, SetupError::Client(_)));
    // Local steps are committed: mapping exists, binding intact.
    let config = env.config().unwrap();
    assert!(config.targets.contains_key(&outcome.target_id));
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.bind_calls(), 0);

    // 2. Rerun converges without duplicating prior work.
    env.state.lock().unwrap().fail_default_runtime = false;
    let second = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    assert_eq!(second.target_id, outcome.target_id);
    assert_eq!(env.register_calls(), 0);
    assert_eq!(env.bind_calls(), 0);
    assert!(!second.repo_cloned);
    assert!(second.default_changed);
    // First attempt failed, second attempt performed the mutation: two calls
    // total, no duplicates of anything else.
    assert_eq!(env.default_calls(), 2);
    let config = env.config().unwrap();
    assert_eq!(config.targets.len(), 1);
}

// ---------------------------------------------------------------------------
// C. Coding Target ensure
// ---------------------------------------------------------------------------

#[tokio::test]
async fn coding_existing_exact_alias_reused_by_immutable_id() {
    let env = env_with_workspaces(one_workspace()).await;
    let seeded = fake_target("my-app", "coding");
    let seeded_id = seeded.id.clone();
    env.state.lock().unwrap().targets.push(seeded);

    let dir = env._temp.path().join("my-app-dir");
    fs::create_dir_all(&dir).unwrap();

    let outcome = ensure_coding_target(&env.paths, "my-app", &dir)
        .await
        .unwrap();
    assert_eq!(outcome.target_id, seeded_id);
    assert!(!outcome.target_created);
    assert!(!outcome.binding_created);
    assert!(!outcome.repo_cloned);
    assert!(!outcome.default_changed);
    assert_eq!(env.register_calls(), 0);
    let config = env.config().unwrap();
    assert_eq!(
        config.targets.get(&seeded_id).unwrap().local_path,
        fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
}

#[tokio::test]
async fn coding_absent_alias_creates_exactly_one_and_rerun_creates_no_duplicate() {
    let env = env_with_workspaces(one_workspace()).await;
    let dir = env._temp.path().join("fresh-app");
    fs::create_dir_all(&dir).unwrap();

    let first = ensure_coding_target(&env.paths, "fresh-app", &dir)
        .await
        .unwrap();
    assert!(first.target_created);
    assert!(first.binding_created);
    assert_eq!(env.register_calls(), 1);
    let body = {
        let st = env.state.lock().unwrap();
        st.last_register_body.clone().unwrap()
    };
    assert_eq!(body["alias"], "fresh-app");
    assert_eq!(body["display_name"], "fresh-app");
    assert_eq!(body["kind"], "coding");
    // No fabricated repository metadata.
    assert!(body.get("repository").is_none());

    let second = ensure_coding_target(&env.paths, "fresh-app", &dir)
        .await
        .unwrap();
    assert_eq!(second.target_id, first.target_id);
    assert!(!second.target_created);
    assert!(!second.binding_created);
    assert_eq!(env.register_calls(), 1);
    assert_eq!(env.bind_calls(), 0);
    assert_eq!(env.state.lock().unwrap().targets.len(), 1);
}

#[tokio::test]
async fn coding_alias_matching_is_exact_and_case_sensitive() {
    let env = env_with_workspaces(one_workspace()).await;
    let seeded = fake_target("My-App", "coding");
    let seeded_id = seeded.id.clone();
    env.state.lock().unwrap().targets.push(seeded);

    let dir = env._temp.path().join("app-dir");
    fs::create_dir_all(&dir).unwrap();

    // Wrong case does NOT fuzzy-match the existing target: it registers a new
    // exact-alias target instead (no case folding).
    let outcome = ensure_coding_target(&env.paths, "my-app", &dir)
        .await
        .unwrap();
    assert_ne!(outcome.target_id, seeded_id);
    assert!(outcome.target_created);
    assert_eq!(env.register_calls(), 1);
    let body = {
        let st = env.state.lock().unwrap();
        st.last_register_body.clone().unwrap()
    };
    assert_eq!(body["alias"], "my-app");
    // The differently-cased original is untouched and still present.
    assert_eq!(env.state.lock().unwrap().targets.len(), 2);
    assert!(env
        .state
        .lock()
        .unwrap()
        .targets
        .iter()
        .any(|t| t.id == seeded_id && t.alias == "My-App"));
}

#[tokio::test]
async fn coding_existing_alias_wrong_kind_fails() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target("svc", "general_automation"));

    let dir = env._temp.path().join("svc-dir");
    fs::create_dir_all(&dir).unwrap();

    let err = ensure_coding_target(&env.paths, "svc", &dir)
        .await
        .unwrap_err();
    assert!(
        matches!(err, SetupError::TargetWrongKind { ref kind, .. } if kind == "general_automation")
    );
    assert_eq!(env.register_calls(), 0);
    env.assert_no_local_targets();
}

#[tokio::test]
async fn coding_disabled_target_fails() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target("svc", "coding");
    seeded.disabled = true;
    env.state.lock().unwrap().targets.push(seeded);

    let dir = env._temp.path().join("svc-dir");
    fs::create_dir_all(&dir).unwrap();

    let err = ensure_coding_target(&env.paths, "svc", &dir)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::TargetDisabled(_)));
    env.assert_no_local_targets();
}

#[tokio::test]
async fn coding_missing_local_path_fails_before_any_server_mutation() {
    // PROJECT-036 Slice 4 ordering contract: a missing local directory is
    // detected BEFORE any new Server Target registration/binding mutation.
    let env = env_with_workspaces(one_workspace()).await;
    let missing = env._temp.path().join("does-not-exist");

    let err = ensure_coding_target(&env.paths, "ghost", &missing)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::PathNotFound(_)));
    assert_eq!(env.register_calls(), 0);
    env.assert_no_local_targets();
    assert_eq!(env.bind_calls(), 0);
    assert_eq!(env.default_calls(), 0);
    assert!(!missing.exists());
}

#[tokio::test]
async fn coding_existing_non_directory_fails_closed() {
    let env = env_with_workspaces(one_workspace()).await;
    let file_path = env._temp.path().join("not-a-dir");
    fs::write(&file_path, "irreplaceable user data\n").unwrap();

    let err = ensure_coding_target(&env.paths, "blocked", &file_path)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::PathConflict { .. }));
    assert!(err.to_string().contains("not a directory"));
    // User file untouched; zero Server mutation; zero local writes.
    assert_eq!(
        fs::read_to_string(&file_path).unwrap(),
        "irreplaceable user data\n"
    );
    assert_eq!(env.register_calls(), 0);
    env.assert_no_local_targets();
}

#[tokio::test]
async fn coding_create_policy_creates_directory_before_target_ensure() {
    let env = env_with_workspaces(one_workspace()).await;
    let missing = env._temp.path().join("freshly-created");

    let outcome = ensure_coding_target_with_policy(
        &env.paths,
        "freshly-created",
        &missing,
        CodingPathPolicy::CreateIfMissing,
    )
    .await
    .unwrap();

    // The directory was created by the core (no git init, no repo
    // fabrication) BEFORE the Server Target registration.
    assert!(missing.is_dir());
    assert!(outcome.directory_created);
    assert!(outcome.target_created);
    assert_eq!(env.register_calls(), 1);
    // The ensure/register endpoint creates the binding atomically, so no
    // separate bind call is needed.
    assert_eq!(env.bind_calls(), 0);
    let config = env.config().unwrap();
    assert_eq!(
        config.targets.get(&outcome.target_id).unwrap().local_path,
        fs::canonicalize(&missing)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    // Plain directory, never fabricated into a repo.
    assert!(!missing.join(".git").exists());
}

#[tokio::test]
async fn coding_create_policy_rerun_reuses_directory_and_target() {
    let env = env_with_workspaces(one_workspace()).await;
    let missing = env._temp.path().join("freshly-created");

    let first = ensure_coding_target_with_policy(
        &env.paths,
        "freshly-created",
        &missing,
        CodingPathPolicy::CreateIfMissing,
    )
    .await
    .unwrap();
    assert!(first.directory_created);

    // Rerun converges: the directory and Target are reused honestly.
    let second = ensure_coding_target_with_policy(
        &env.paths,
        "freshly-created",
        &missing,
        CodingPathPolicy::CreateIfMissing,
    )
    .await
    .unwrap();
    assert_eq!(second.target_id, first.target_id);
    assert!(!second.directory_created);
    assert!(!second.target_created);
    assert_eq!(env.register_calls(), 1);
    assert_eq!(env.bind_calls(), 0);
}

#[tokio::test]
async fn coding_directory_creation_local_failure_never_mutates_server() {
    // A path whose parent is a FILE makes create_dir_all fail: the Server
    // must stay untouched and the error honest.
    let env = env_with_workspaces(one_workspace()).await;
    let parent_file = env._temp.path().join("parent-is-a-file");
    fs::write(&parent_file, "user data\n").unwrap();
    let child = parent_file.join("child");

    let err = ensure_coding_target_with_policy(
        &env.paths,
        "blocked-create",
        &child,
        CodingPathPolicy::CreateIfMissing,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, SetupError::Io(_)));
    assert_eq!(env.register_calls(), 0);
    env.assert_no_local_targets();
    assert_eq!(fs::read_to_string(&parent_file).unwrap(), "user data\n");
}

#[tokio::test]
async fn coding_server_repo_metadata_is_verified_when_present() {
    // Positive: metadata matches the local repository.
    let env = env_with_workspaces(one_workspace()).await;
    env.state.lock().unwrap().targets.push(FakeTarget {
        repository: Some(serde_json::json!({
            "provider": "github",
            "external_id": "111",
            "full_name": "my-org/my-repo"
        })),
        ..fake_target("repo-app", "coding")
    });
    let repo = env._temp.path().join("my-repo");
    init_git_repo_with_origin(&repo, "git@github.com:my-org/my-repo.git");

    let outcome = ensure_coding_target(&env.paths, "repo-app", &repo)
        .await
        .unwrap();
    assert_eq!(
        outcome.local_path,
        fs::canonicalize(&repo)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    assert!(env
        .config()
        .unwrap()
        .targets
        .contains_key(&outcome.target_id));
}

#[tokio::test]
async fn coding_server_repo_metadata_mismatch_fails_without_local_write() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state.lock().unwrap().targets.push(FakeTarget {
        repository: Some(serde_json::json!({
            "provider": "github",
            "external_id": "111",
            "full_name": "my-org/my-repo"
        })),
        ..fake_target("repo-app", "coding")
    });
    let repo = env._temp.path().join("wrong-repo");
    init_git_repo_with_origin(&repo, "https://github.com/other/other-repo.git");

    let err = ensure_coding_target(&env.paths, "repo-app", &repo)
        .await
        .unwrap_err();
    assert!(
        matches!(err, SetupError::RepositoryMismatch { ref expected, .. } if expected == "my-org/my-repo")
    );
    env.assert_no_local_targets();
    assert_eq!(env.bind_calls(), 0);
}

#[tokio::test]
async fn coding_absent_server_repo_invents_nothing() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target("plain-app", "coding"));

    // Plain (non-Git) directory is fine when the Server has no repo metadata.
    let dir = env._temp.path().join("plain");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("notes.txt"), "not a git repo\n").unwrap();

    let outcome = ensure_coding_target(&env.paths, "plain-app", &dir)
        .await
        .unwrap();
    assert_eq!(
        outcome.local_path,
        fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    assert!(env
        .config()
        .unwrap()
        .targets
        .contains_key(&outcome.target_id));
    // No repo metadata was fabricated on registration either.
    let body = {
        let st = env.state.lock().unwrap();
        st.last_register_body.clone()
    };
    // (existing target reused in this test; the register-body assertion for
    // absent metadata is covered by coding_absent_alias_creates_exactly_one)
    drop(body);
}

#[tokio::test]
async fn coding_binding_converges_idempotently() {
    let env = env_with_workspaces(one_workspace()).await;
    let mut seeded = fake_target("bind-app", "coding");
    seeded.binding_enabled = false;
    env.state.lock().unwrap().targets.push(seeded);

    let dir = env._temp.path().join("bind-app-dir");
    fs::create_dir_all(&dir).unwrap();

    let first = ensure_coding_target(&env.paths, "bind-app", &dir)
        .await
        .unwrap();
    assert!(first.binding_created);
    assert_eq!(env.bind_calls(), 1);

    let second = ensure_coding_target(&env.paths, "bind-app", &dir)
        .await
        .unwrap();
    assert!(!second.binding_created);
    assert_eq!(env.bind_calls(), 1);
}

#[tokio::test]
async fn coding_local_mapping_preserves_executor_and_model() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target("exec-app", "coding"));

    let dir = env._temp.path().join("exec-app-dir");
    fs::create_dir_all(&dir).unwrap();
    write_config_with_executor(&env, "tgt_exec-app", "/old/path");

    let outcome = ensure_coding_target(&env.paths, "exec-app", &dir)
        .await
        .unwrap();
    let config = env.config().unwrap();
    let lt = config.targets.get("tgt_exec-app").unwrap();
    assert_eq!(lt.local_path, outcome.local_path);
    let exec = lt.executor.as_ref().unwrap();
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command.as_deref(), Some("/path/agent -f --trust"));
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
}

#[tokio::test]
async fn coding_active_attempt_guard_preserved() {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target("busy-app", "coding"));

    let dir = env._temp.path().join("busy-app-dir");
    fs::create_dir_all(&dir).unwrap();
    active_attempt(&env.paths, "tgt_busy-app");

    let err = ensure_coding_target(&env.paths, "busy-app", &dir)
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::TargetInUse(ref id) if id == "tgt_busy-app"));
    assert!(err.to_string().contains("TARGET_IN_USE"));
    assert_eq!(env.bind_calls(), 0);
    env.assert_no_local_targets();
}

// ---------------------------------------------------------------------------
// D. Device-local executor configuration (PROJECT-036 Slice 4)
// ---------------------------------------------------------------------------

/// Seeds the canonical runtime Target (Server-side) plus a Device-local
/// verified checkout mapping without an executor — the exact fresh-device
/// dogfood state that motivated Slice 4.
async fn env_with_connected_runtime_without_executor() -> (TestEnv, String, std::path::PathBuf) {
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));
    let repo = env._temp.path().join("ceo-agent-runtime");
    init_git_repo_with_origin(&repo, AGENT_RUNTIME_REPO_CLONE_URL);

    let outcome = ensure_agent_runtime(&env.paths, &repo).await.unwrap();
    let config = env.config().unwrap();
    assert!(config.targets[&outcome.target_id].executor.is_none());
    (env, outcome.target_id, repo)
}

#[tokio::test]
async fn executor_config_writes_device_owned_orca_tui_executor_without_model() {
    let (env, target_id, _repo) = env_with_connected_runtime_without_executor().await;

    // The connect step in the helper already consumed bind/default calls;
    // capture baselines to prove the executor configure adds no mutation.
    let before_bind = env.bind_calls();
    let before_default = env.default_calls();
    let before_register = env.register_calls();

    let outcome = configure_agent_runtime_executor(&env.paths, "opencode", "opencode")
        .await
        .unwrap();

    assert!(outcome.executor_created);
    assert_eq!(outcome.target_id, target_id);
    assert_eq!(outcome.alias, AGENT_RUNTIME_TARGET_ALIAS);
    assert_eq!(outcome.agent_id, "opencode");
    assert_eq!(outcome.command, "opencode");
    assert_eq!(outcome.model, None, "fresh executor has no model");

    // Only Device-owned schema-v3 executor state was written, under the
    // shared local state contract.
    let config = env.config().unwrap();
    let exec = config.targets[&target_id].executor.as_ref().unwrap();
    assert_eq!(exec.kind, "orca_tui");
    assert_eq!(exec.agent_id, "opencode");
    assert_eq!(exec.command.as_deref(), Some("opencode"));
    assert_eq!(exec.model, None);

    // No Server mutation is needed for executor config.
    assert_eq!(env.register_calls(), before_register);
    assert_eq!(env.bind_calls(), before_bind);
    assert_eq!(env.default_calls(), before_default);
}

#[tokio::test]
async fn executor_config_never_silently_overwrites_existing_executor() {
    let (env, target_id, _repo) = env_with_connected_runtime_without_executor().await;
    write_config_with_executor(&env, &target_id, "/old/path");

    // A configure call with DIFFERENT values must reuse, not overwrite.
    let before_bind = env.bind_calls();
    let before_default = env.default_calls();
    let before_register = env.register_calls();
    let outcome = configure_agent_runtime_executor(&env.paths, "opencode", "opencode")
        .await
        .unwrap();
    assert!(!outcome.executor_created);
    assert_eq!(outcome.agent_id, "cursor");
    assert_eq!(outcome.command, "/path/agent -f --trust");
    // The existing model override is preserved exactly when reusing.
    assert_eq!(outcome.model.as_deref(), Some("gpt-5"));

    let exec = {
        let config = env.config().unwrap();
        config.targets[&target_id].executor.clone().unwrap()
    };
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command.as_deref(), Some("/path/agent -f --trust"));
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
    // Zero Server mutations either way.
    assert_eq!(env.register_calls(), before_register);
    assert_eq!(env.bind_calls(), before_bind);
    assert_eq!(env.default_calls(), before_default);
}

#[tokio::test]
async fn executor_config_validates_through_existing_executor_contract() {
    let (env, _target_id, _repo) = env_with_connected_runtime_without_executor().await;

    // Invalid agent_id characters are rejected by the existing validation.
    let err = configure_agent_runtime_executor(&env.paths, "bad agent id", "opencode")
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::Config(_)));
    assert!(err.to_string().contains("invalid characters"));

    // Empty command rejected.
    let err = configure_agent_runtime_executor(&env.paths, "opencode", "   ")
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::Config(_)));

    // Nothing was written by the rejected attempts.
    let config = env.config().unwrap();
    let tid = config.targets.keys().next().unwrap().clone();
    assert!(config.targets[&tid].executor.is_none());
}

#[tokio::test]
async fn executor_config_active_attempt_guard_blocks_local_mutation() {
    let (env, target_id, _repo) = env_with_connected_runtime_without_executor().await;
    active_attempt(&env.paths, &target_id);

    let err = configure_agent_runtime_executor(&env.paths, "opencode", "opencode")
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::TargetInUse(ref id) if *id == target_id));
    assert!(err.to_string().contains("TARGET_IN_USE"));
    let config = env.config().unwrap();
    assert!(config.targets[&target_id].executor.is_none());
}

#[tokio::test]
async fn executor_config_requires_canonical_server_target() {
    // No runtime Target on the Server at all.
    let env = env_with_workspaces(one_workspace()).await;
    let err = configure_agent_runtime_executor(&env.paths, "opencode", "opencode")
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::RuntimeTargetMissing));
    assert!(err.to_string().contains("SETUP_RUNTIME_TARGET_MISSING"));
}

#[tokio::test]
async fn executor_config_requires_local_mapping_first() {
    // Server Target exists but this Device has no local mapping yet.
    let env = env_with_workspaces(one_workspace()).await;
    env.state
        .lock()
        .unwrap()
        .targets
        .push(fake_target(AGENT_RUNTIME_TARGET_ALIAS, "coding"));

    let err = configure_agent_runtime_executor(&env.paths, "opencode", "opencode")
        .await
        .unwrap_err();
    assert!(matches!(err, SetupError::RuntimeNotConnected));
    assert!(err.to_string().contains("SETUP_RUNTIME_NOT_CONNECTED"));
}
