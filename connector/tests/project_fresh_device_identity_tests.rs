//! Fresh-device Project identity: repository-first resolution tests (Git Local Slice).
//!
//! These tests simulate the Server's authoritative register contract
//! (repository-first resolution inside a serialized transaction) with a small
//! in-process mock, then drive two/three independent Devices (separate local
//! state roots + credentials) through `project add` against the same Git
//! repository to prove:
//! - custom name on Device A + default add on Device B reuses one target_id;
//! - local clone folder names never matter;
//! - a different requested human name never renames the Server Target;
//! - the same human name on different repositories is not identity;
//! - equivalent supported SSH/HTTPS origins resolve consistently;
//! - duplicate create paths stay idempotent (no duplicate active Targets);
//! - local config remains keyed by the immutable target_id;
//! - unresolvable repository identity fails clearly before any server call.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

use ceo_connector::config::{LocalConfig, CONFIG_SCHEMA_VERSION};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::project_add;

mod common;
use common::mock_server::{MockResponse, MockServer};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn init_git_repo(path: &std::path::Path, origin_url: Option<&str>) {
    fs_err_create_dir_all(path);
    let status = std::process::Command::new("git")
        .arg("init")
        .current_dir(path)
        .status()
        .unwrap();
    assert!(status.success());

    let _ = std::process::Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(path)
        .status();
    let _ = std::process::Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .status();

    std::fs::write(path.join("README.md"), "# Test\n").unwrap();
    let _ = std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(path)
        .status();
    let _ = std::process::Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(path)
        .status();

    if let Some(url) = origin_url {
        let _ = std::process::Command::new("git")
            .args(["remote", "add", "origin", url])
            .current_dir(path)
            .status();
    }
}

fn fs_err_create_dir_all(path: &std::path::Path) {
    std::fs::create_dir_all(path).unwrap();
}

fn setup_device_profile(
    server_origin: &str,
    credential_id: &str,
    device_id: &str,
) -> (TempDir, ConnectorPaths) {
    let temp = TempDir::new().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("dot-ceo"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential {
        schema_version: 1,
        server_origin: server_origin.to_string(),
        user_id: "user_test_123".to_string(),
        device_id: device_id.to_string(),
        credential_id: credential_id.to_string(),
        secret: format!("secret_{credential_id}"),
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

/// Minimal simulated Server state implementing the repository-first register
/// contract: register resolves an existing ACTIVE target by repository
/// identity (provider + lowercase owner/repo) BEFORE any alias/name logic;
/// alias conflicts on different repositories return 409.
#[derive(Default)]
struct SimServerState {
    targets: Mutex<Vec<SimTarget>>,
    register_count: AtomicU32,
    bindings: Mutex<Vec<(String, String)>>, // (credential_id, target_id)
    next_id: AtomicU32,
    rename_count: AtomicU32,
    /// When set, GET /targets returns an empty catalogue (simulates a device
    /// whose catalogue snapshot predates another device's registration).
    catalogue_hidden: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
struct SimTarget {
    id: String,
    alias: String,
    display_name: String,
    full_name: String,
}

fn bearer_credential_id(req: &common::mock_server::MockRequest) -> String {
    let auth = req
        .headers
        .get("authorization")
        .cloned()
        .unwrap_or_default();
    // Bearer ceo_dev1.<credential_id>.<secret>
    auth.split('.').nth(1).unwrap_or("").to_string()
}

fn target_wire_json(t: &SimTarget, is_default_agent_runtime: bool) -> serde_json::Value {
    serde_json::json!({
        "id": t.id,
        "workspace_id": "ws_1",
        "alias": t.alias,
        "display_name": t.display_name,
        "kind": "coding",
        "repository": {
            "provider": "github",
            "external_id": t.full_name.to_lowercase(),
            "full_name": t.full_name,
        },
        "disabled": false,
        "is_default_agent_runtime": is_default_agent_runtime
    })
}

fn attach_simulated_server(server: &MockServer, state: Arc<SimServerState>) {
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
            if state.catalogue_hidden.load(Ordering::SeqCst) {
                return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
            }
            let cred_id = bearer_credential_id(req);
            let targets = state.targets.lock().unwrap();
            let bindings = state.bindings.lock().unwrap();
            let items: Vec<serde_json::Value> = targets
                .iter()
                .map(|t| {
                    let bound = bindings
                        .iter()
                        .any(|(cid, tid)| cid == &cred_id && tid == &t.id);
                    serde_json::json!({
                        "target": target_wire_json(t, false),
                        "this_device_binding": { "id": format!("bnd_{cred_id}"), "enabled": bound },
                        "active_binding_count": bindings.iter().filter(|(_, tid)| tid == &t.id).count()
                    })
                })
                .collect();
            return MockResponse::json(200, &serde_json::json!({ "targets": items }));
        }
        if req.method == "POST" && req.path.contains("/api/connector/targets/register") {
            state.register_count.fetch_add(1, Ordering::SeqCst);
            let body: serde_json::Value = req.json().unwrap();
            let alias = body["alias"].as_str().unwrap_or("").to_string();
            let display_name = body["display_name"].as_str().unwrap_or("").to_string();
            let repository = &body["repository"];
            let cred_id = bearer_credential_id(req);

            let mut targets = state.targets.lock().unwrap();
            let mut bindings = state.bindings.lock().unwrap();

            // Repository-first resolution (remote_url source).
            if repository.is_object() && repository["source"] == "remote_url" {
                let full_name = repository["full_name"].as_str().unwrap_or("").to_lowercase();
                if let Some(existing) = targets
                    .iter()
                    .find(|t| t.full_name.to_lowercase() == full_name)
                    .cloned()
                {
                    // Reuse: no rename, no duplicate; ensure this device's binding.
                    let already = bindings
                        .iter()
                        .any(|(cid, tid)| cid == &cred_id && tid == &existing.id);
                    if !already {
                        bindings.push((cred_id.clone(), existing.id.clone()));
                    }
                    let binding_created = !already;
                    return MockResponse::json(
                        200,
                        &serde_json::json!({
                            "target": target_wire_json(&existing, false),
                            "binding": { "id": format!("bnd_{cred_id}"), "enabled": true },
                            "target_created": false,
                            "binding_created": binding_created,
                            "replayed": already
                        }),
                    );
                }
            }

            // Alias-based path: same alias + different repository => 409.
            if let Some(existing) = targets.iter().find(|t| t.alias == alias) {
                let repo_differs = match (repository.as_object(), existing.full_name.as_str()) {
                    (Some(repo), existing_full) => {
                        repo["full_name"]
                            .as_str()
                            .map(|f| f.to_lowercase() != existing_full.to_lowercase())
                            .unwrap_or(false)
                    }
                    _ => false,
                };
                if repo_differs {
                    return MockResponse::json(
                        409,
                        &serde_json::json!({
                            "error": "TARGET_ALIAS_CONFLICT",
                            "message": "Execution target with alias exists but metadata conflicts."
                        }),
                    );
                }
            }

            // Create.
            let n = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
            let full_name = if repository.is_object() {
                repository["full_name"].as_str().unwrap_or("").to_string()
            } else {
                String::new()
            };
            let target = SimTarget {
                id: format!("tgt_sim_{n}"),
                alias: alias.clone(),
                display_name: display_name.clone(),
                full_name: full_name.clone(),
            };
            targets.push(target.clone());
            bindings.push((cred_id.clone(), target.id.clone()));
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": target_wire_json(&target, false),
                    "binding": { "id": format!("bnd_{cred_id}"), "enabled": true },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/bind") {
            let cred_id = bearer_credential_id(req);
            let target_id = req
                .path
                .rsplit('/')
                .nth(1)
                .unwrap_or("")
                .to_string();
            {
                let mut bindings = state.bindings.lock().unwrap();
                let already = bindings
                    .iter()
                    .any(|(cid, tid)| cid == &cred_id && tid == &target_id);
                if !already {
                    bindings.push((cred_id.clone(), target_id.clone()));
                }
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "target_id": target_id,
                        "binding_id": format!("bnd_{cred_id}"),
                        "enabled": true,
                        "replayed": already
                    }),
                );
            }
        }
        if req.method == "POST" && req.path.ends_with("/rename") {
            state.rename_count.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(400, &serde_json::json!({ "error": "rename must never happen" }));
        }
        MockResponse::json(
            404,
            &serde_json::json!({ "error": "not found", "path": req.path, "method": req.method }),
        )
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fresh_device_b_reuses_target_across_custom_names_and_clone_folders() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    let (_temp_a, paths_a) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let (_temp_b, paths_b) = setup_device_profile(&server.origin(), "crd_devB", "dev_B");

    // Device A: custom (typo) project name, clone folder differs from the
    // repo-derived default.
    let repo_dir_a = _temp_a.path().join("custom-folder-a");
    init_git_repo(&repo_dir_a, Some("https://github.com/org/shared-repo.git"));
    project_add(
        &paths_a,
        Some(repo_dir_a.to_str().unwrap()),
        Some("custom-typo-name"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("device A add failed: {e}"));

    assert_eq!(state.register_count.load(Ordering::SeqCst), 1);

    // Device B: fresh device, default repo-derived name, different local
    // clone folder name, same Git repository.
    let repo_dir_b = _temp_b.path().join("b-clone-different-name");
    init_git_repo(&repo_dir_b, Some("git@github.com:org/shared-repo.git"));
    project_add(
        &paths_b,
        Some(repo_dir_b.to_str().unwrap()),
        None,
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("device B add failed: {e}"));

    // Exactly ONE server target exists for the repository; Device B's add
    // did not register a duplicate.
    assert_eq!(
        state.register_count.load(Ordering::SeqCst),
        1,
        "Device B must resolve by repository identity, not register a duplicate"
    );

    // Both devices' local configs are keyed by the SAME immutable target_id.
    let cfg_a = LocalConfig::load(&paths_a.config_file()).unwrap().unwrap();
    let cfg_b = LocalConfig::load(&paths_b.config_file()).unwrap().unwrap();
    assert_eq!(cfg_a.targets.len(), 1);
    assert_eq!(cfg_b.targets.len(), 1);
    let target_id_a = cfg_a.targets.keys().next().unwrap().clone();
    let target_id_b = cfg_b.targets.keys().next().unwrap().clone();
    assert_eq!(target_id_a, target_id_b);
    assert!(target_id_a.starts_with("tgt_sim_"));

    // No implicit rename: the Server Target keeps Device A's custom alias.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].alias, "custom-typo-name");
    assert_eq!(state.rename_count.load(Ordering::SeqCst), 0);

    // Device B's register request carried the normalized repository identity.
    let registers: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path.contains("/api/connector/targets/register"))
        .collect();
    assert_eq!(registers.len(), 1);
    let body: serde_json::Value = registers[0].json().unwrap();
    assert_eq!(body["repository"]["source"], "remote_url");
    assert_eq!(body["repository"]["provider"], "github");
    assert_eq!(body["repository"]["full_name"], "org/shared-repo");
}

#[tokio::test]
async fn same_human_name_on_different_repositories_is_not_identity() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");

    let repo_a = _temp.path().join("folder-a");
    init_git_repo(&repo_a, Some("https://github.com/org/repo-a.git"));
    project_add(
        &paths,
        Some(repo_a.to_str().unwrap()),
        Some("same-project"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("repo-a add failed: {e}"));

    // Different repository, SAME requested human name: repository identity
    // differs, so it must NOT resolve to repo-a's target; the Server's alias
    // contract rejects the conflicting create (409).
    let repo_b = _temp.path().join("folder-b");
    init_git_repo(&repo_b, Some("https://github.com/org/repo-b.git"));
    let err = project_add(
        &paths,
        Some(repo_b.to_str().unwrap()),
        Some("same-project"),
        None,
        None,
    )
    .await
    .expect_err("same-name different-repo add must fail");
    let msg = err.to_string();
    assert!(
        msg.contains("SETUP_REPOSITORY_IDENTITY_CONFLICT"),
        "unexpected error: {msg}"
    );

    // Only repo-a's target exists; repo-b never created.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].full_name, "org/repo-a");

    // Local config only contains repo-a's target_id.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(cfg.targets.len(), 1);
}

#[tokio::test]
async fn equivalent_supported_ssh_and_https_origins_resolve_consistently() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    let (_temp_a, paths_a) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let (_temp_b, paths_b) = setup_device_profile(&server.origin(), "crd_devB", "dev_B");
    let (_temp_c, paths_c) = setup_device_profile(&server.origin(), "crd_devC", "dev_C");

    let repo_a = _temp_a.path().join("clone-https");
    init_git_repo(&repo_a, Some("https://github.com/org/forms-repo.git"));
    project_add(&paths_a, Some(repo_a.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("https add failed: {e}"));

    let repo_b = _temp_b.path().join("clone-scp-form");
    init_git_repo(&repo_b, Some("git@github.com:org/forms-repo.git"));
    project_add(&paths_b, Some(repo_b.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("scp-form add failed: {e}"));

    let repo_c = _temp_c.path().join("clone-ssh-url");
    init_git_repo(&repo_c, Some("ssh://git@github.com/org/forms-repo.git"));
    project_add(&paths_c, Some(repo_c.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("ssh-url add failed: {e}"));

    // All three origin forms resolve to the same single repository Target.
    assert_eq!(
        state.register_count.load(Ordering::SeqCst),
        1,
        "equivalent SSH/HTTPS origins must not create duplicate targets"
    );

    let cfg_a = LocalConfig::load(&paths_a.config_file()).unwrap().unwrap();
    let cfg_b = LocalConfig::load(&paths_b.config_file()).unwrap().unwrap();
    let cfg_c = LocalConfig::load(&paths_c.config_file()).unwrap().unwrap();
    let id_a = cfg_a.targets.keys().next().unwrap().clone();
    let id_b = cfg_b.targets.keys().next().unwrap().clone();
    let id_c = cfg_c.targets.keys().next().unwrap().clone();
    assert_eq!(id_a, id_b);
    assert_eq!(id_b, id_c);
}

#[tokio::test]
async fn duplicate_create_race_reuses_target_and_keeps_config_keyed_by_target_id() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    let (_temp_a, paths_a) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let (_temp_b, paths_b) = setup_device_profile(&server.origin(), "crd_devB", "dev_B");

    // Simulate the create race: both devices see a stale (empty) catalogue
    // snapshot, so Device B falls through to register; the Server's
    // transactional repository-first path must return the existing target
    // (target_created=false) instead of a duplicate.
    state.catalogue_hidden.store(true, Ordering::SeqCst);

    // Device A creates the target for the repository.
    let repo_a = _temp_a.path().join("race-a");
    init_git_repo(&repo_a, Some("https://github.com/org/race-repo.git"));
    project_add(&paths_a, Some(repo_a.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("device A add failed: {e}"));

    // Device B's create raced: register replay returns the same immutable
    // target; the connector must accept the reuse and key local state on
    // the same target_id.
    let repo_b = _temp_b.path().join("race-b");
    init_git_repo(&repo_b, Some("https://github.com/org/race-repo.git"));
    project_add(&paths_b, Some(repo_b.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("device B add failed: {e}"));

    assert_eq!(state.register_count.load(Ordering::SeqCst), 2);
    let targets = state.targets.lock().unwrap();
    assert_eq!(
        targets.len(),
        1,
        "duplicate create must not produce a second active repository Target"
    );

    let cfg_a = LocalConfig::load(&paths_a.config_file()).unwrap().unwrap();
    let cfg_b = LocalConfig::load(&paths_b.config_file()).unwrap().unwrap();
    let id_a = cfg_a.targets.keys().next().unwrap().clone();
    let id_b = cfg_b.targets.keys().next().unwrap().clone();
    assert_eq!(id_a, id_b);
    assert_eq!(id_a, targets[0].id);
}

#[tokio::test]
async fn unresolvable_repository_identity_fails_clearly_before_any_server_call() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());
    let server_requests = Arc::new(AtomicU32::new(0));
    let count = server_requests.clone();
    server.add_handler(move |_req| {
        count.fetch_add(1, Ordering::SeqCst);
        MockResponse::json(500, &serde_json::json!({ "error": "must not be called" }))
    });

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");

    // Case 1: Git repository without an 'origin' remote.
    let no_origin = _temp.path().join("no-origin-repo");
    init_git_repo(&no_origin, None);
    let err = project_add(&paths, Some(no_origin.to_str().unwrap()), None, None, None)
        .await
        .expect_err("missing origin must fail clearly");
    assert!(
        err.to_string().contains("REPOSITORY_ORIGIN_MISSING"),
        "unexpected error: {err}"
    );

    // Case 2: origin on an unsupported provider host.
    let gitlab_repo = _temp.path().join("gitlab-repo");
    init_git_repo(&gitlab_repo, Some("https://gitlab.com/org/repo.git"));
    let err = project_add(
        &paths,
        Some(gitlab_repo.to_str().unwrap()),
        None,
        None,
        None,
    )
    .await
    .expect_err("unsupported provider origin must fail clearly");
    assert!(
        err.to_string().contains("REPOSITORY_IDENTITY_UNRESOLVED"),
        "unexpected error: {err}"
    );

    // Zero server contact in both failure cases: no silent human-name
    // identity fallback.
    assert_eq!(
        server_requests.load(Ordering::SeqCst),
        0,
        "unresolvable repository identity must fail before any server call"
    );

    // No local mapping was created.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(cfg.targets.is_empty());
}
