//! Bounded legacy repository-identity backfill tests (Project identity).
//!
//! Legacy production Targets report repository=null. The repository-first
//! fresh-device resolution only works for Targets that already carry
//! repository metadata, so an already-bound Device (its schema-v3 local
//! config maps the exact immutable target_id to the verified local checkout)
//! may backfill the identity onto the exact existing target via the explicit
//! Server attach capability.
//!
//! These tests simulate the Server's authoritative attach/register contracts
//! with an in-process mock and prove:
//! - a bound legacy repository-null target is backfilled onto its EXACT
//!   target_id (no rename, no duplicate register);
//! - a subsequent fresh Device resolves the SAME target_id by repository
//!   identity despite a different requested name and clone folder;
//! - a fresh/unbound Device can never claim a legacy null target by human
//!   alias alone (no attach call, fail closed);
//! - another active target already owning the identity fails closed;
//! - the config-mapped disabled target is rejected, not backfilled;
//! - a stale local mapping WITHOUT an active this-device Server binding
//!   never triggers an attach (no auto-bind, fail closed);
//! - a disabled this-device binding never triggers an attach;
//! - only another device being bound does not authorize this device;
//! - local config remains keyed by the immutable target_id throughout.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

use ceo_connector::config::{LocalConfig, LocalTarget, CONFIG_SCHEMA_VERSION};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::project_add;

mod common;
use common::mock_server::{MockResponse, MockServer};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn init_git_repo(path: &std::path::Path, origin_url: Option<&str>) {
    std::fs::create_dir_all(path).unwrap();
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

fn canonical(path: &std::path::Path) -> String {
    std::fs::canonicalize(path)
        .unwrap()
        .to_string_lossy()
        .to_string()
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

fn map_target_in_config(paths: &ConnectorPaths, target_id: &str, local_path: &str) {
    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: local_path.to_string(),
            executor: None,
        },
    );
    cfg.save(&paths.config_file()).unwrap();
}

fn seed_binding(state: &SimServerState, credential_id: &str, target_id: &str, enabled: bool) {
    state.bindings.lock().unwrap().push(SimBinding {
        credential_id: credential_id.to_string(),
        target_id: target_id.to_string(),
        enabled,
    });
}

/// Minimal simulated Server state implementing both authoritative contracts:
/// repository-first register and the bounded attach-repository backfill.
#[derive(Default)]
struct SimServerState {
    targets: Mutex<Vec<SimTarget>>,
    register_count: AtomicU32,
    attach_count: AtomicU32,
    attach_last_target_id: Mutex<String>,
    /// DeviceTargetBinding rows: (credential_id, target_id, enabled).
    /// Missing rows and enabled=false rows are distinct states, matching the
    /// Server's device_target_bindings (row presence + disabled_at_ms).
    bindings: Mutex<Vec<SimBinding>>,
    next_id: AtomicU32,
    rename_count: AtomicU32,
    /// When set, the simulated attach endpoint rejects with
    /// TARGET_REPOSITORY_CONFLICT (simulates another device winning the
    /// identity between this device's catalogue snapshot and the attach).
    attach_conflict_inject: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
struct SimBinding {
    credential_id: String,
    target_id: String,
    enabled: bool,
}

#[derive(Clone)]
struct SimTarget {
    id: String,
    alias: String,
    display_name: String,
    kind: String,
    full_name: Option<String>,
    disabled: bool,
}

impl SimTarget {
    fn legacy(id: &str, alias: &str) -> Self {
        Self {
            id: id.to_string(),
            alias: alias.to_string(),
            display_name: alias.to_string(),
            kind: "coding".to_string(),
            full_name: None,
            disabled: false,
        }
    }
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

fn target_wire_json(t: &SimTarget) -> serde_json::Value {
    serde_json::json!({
        "id": t.id,
        "workspace_id": "ws_1",
        "alias": t.alias,
        "display_name": t.display_name,
        "kind": t.kind,
        "repository": t.full_name.as_ref().map(|f| serde_json::json!({
            "provider": "github",
            "external_id": f.to_lowercase(),
            "full_name": f,
        })),
        "disabled": t.disabled,
        "is_default_agent_runtime": false
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
            let cred_id = bearer_credential_id(req);
            let targets = state.targets.lock().unwrap();
            let bindings = state.bindings.lock().unwrap();
            let items: Vec<serde_json::Value> = targets
                .iter()
                .map(|t| {
                    // Mirror the Server contract: this_device_binding is null
                    // when no row exists for this device, and enabled mirrors
                    // disabled_at_ms IS NULL.
                    let this_binding = bindings
                        .iter()
                        .find(|b| b.credential_id == cred_id && b.target_id == t.id)
                        .map(|b| {
                            serde_json::json!({
                                "id": format!("bnd_{}", b.credential_id),
                                "enabled": b.enabled
                            })
                        });
                    serde_json::json!({
                        "target": target_wire_json(t),
                        "this_device_binding": this_binding,
                        "active_binding_count": bindings
                            .iter()
                            .filter(|b| b.target_id == t.id && b.enabled)
                            .count()
                    })
                })
                .collect();
            return MockResponse::json(200, &serde_json::json!({ "targets": items }));
        }
        if req.method == "POST" && req.path.ends_with("/attach-repository") {
            state.attach_count.fetch_add(1, Ordering::SeqCst);
            let target_id = req
                .path
                .strip_suffix("/attach-repository")
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            *state.attach_last_target_id.lock().unwrap() = target_id.clone();

            let body: serde_json::Value = req.json().unwrap();
            let workspace_id = body["workspace_id"].as_str().unwrap_or("");
            let repository = &body["repository"];
            let provider = repository["provider"].as_str().unwrap_or("");
            let full_name = repository["full_name"].as_str().unwrap_or("").to_lowercase();

            if state.attach_conflict_inject.load(Ordering::SeqCst) {
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_REPOSITORY_CONFLICT", "message": "another active target already owns this repository identity." }),
                );
            }
            if workspace_id != "ws_1" {
                return MockResponse::json(
                    404,
                    &serde_json::json!({ "error": "TARGET_NOT_FOUND", "message": "ExecutionTarget not found." }),
                );
            }

            let mut targets = state.targets.lock().unwrap();
            let Some(idx) = targets.iter().position(|t| t.id == target_id) else {
                return MockResponse::json(
                    404,
                    &serde_json::json!({ "error": "TARGET_NOT_FOUND", "message": "ExecutionTarget not found." }),
                );
            };
            let t = targets[idx].clone();
            if t.disabled {
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_DISABLED", "message": "ExecutionTarget is disabled." }),
                );
            }
            if t.kind != "coding" {
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_REPOSITORY_CONFLICT", "message": "repository identity can only be attached to coding targets." }),
                );
            }
            // Mirror the Server's independent active-binding requirement: an
            // attach is only authorized for the EXACT calling device holding
            // an ACTIVE binding row for this exact target_id.
            let cred_id = bearer_credential_id(req);
            let bindings = state.bindings.lock().unwrap();
            let binding_active = bindings
                .iter()
                .any(|b| b.credential_id == cred_id && b.target_id == t.id && b.enabled);
            drop(bindings);
            if !binding_active {
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_REPOSITORY_CONFLICT", "message": "device has no active binding for this target; never auto-binds." }),
                );
            }
            if let Some(existing) = &t.full_name {
                if existing.to_lowercase() == full_name && provider == "github" {
                    return MockResponse::json(
                        200,
                        &serde_json::json!({ "ok": true, "target": target_wire_json(&t), "replayed": true }),
                    );
                }
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_REPOSITORY_CONFLICT", "message": "refusing to overwrite existing repository identity." }),
                );
            }
            // Another active target owning the same identity => clear conflict.
            let owned_elsewhere = targets.iter().any(|o| {
                o.id != t.id
                    && !o.disabled
                    && o.full_name
                        .as_ref()
                        .map(|f| f.to_lowercase() == full_name)
                        .unwrap_or(false)
            });
            if owned_elsewhere {
                return MockResponse::json(
                    409,
                    &serde_json::json!({ "error": "TARGET_REPOSITORY_CONFLICT", "message": "another active target already owns this repository identity." }),
                );
            }
            targets[idx].full_name = Some(full_name.clone());
            let updated = targets[idx].clone();
            return MockResponse::json(
                200,
                &serde_json::json!({ "ok": true, "target": target_wire_json(&updated), "replayed": false }),
            );
        }
        if req.method == "POST" && req.path.contains("/api/connector/targets/register") {
            state.register_count.fetch_add(1, Ordering::SeqCst);
            let body: serde_json::Value = req.json().unwrap();
            let alias = body["alias"].as_str().unwrap_or("").to_string();
            let display_name = body["display_name"].as_str().unwrap_or("").to_string();
            let repository = &body["repository"];
            let requested_full_name = if repository.is_object() && repository["source"] == "remote_url" {
                Some(repository["full_name"].as_str().unwrap_or("").to_lowercase())
            } else {
                None
            };
            let cred_id = bearer_credential_id(req);

            let mut targets = state.targets.lock().unwrap();
            let mut bindings = state.bindings.lock().unwrap();

            // Repository-first resolution (active targets only).
            if let Some(wanted) = &requested_full_name {
                let matches: Vec<SimTarget> = targets
                    .iter()
                    .filter(|t| {
                        !t.disabled
                            && t.kind == "coding"
                            && t.full_name
                                .as_ref()
                                .map(|f| f.to_lowercase() == *wanted)
                                .unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                if matches.len() > 1 {
                    return MockResponse::json(
                        409,
                        &serde_json::json!({ "error": "TARGET_ALIAS_CONFLICT", "message": "multiple active targets resolve to the same repository identity." }),
                    );
                }
                if let Some(existing) = matches.into_iter().next() {
                    let already = bindings
                        .iter()
                        .any(|b| b.credential_id == cred_id && b.target_id == existing.id);
                    if !already {
                        bindings.push(SimBinding {
                            credential_id: cred_id.clone(),
                            target_id: existing.id.clone(),
                            enabled: true,
                        });
                    }
                    return MockResponse::json(
                        200,
                        &serde_json::json!({
                            "target": target_wire_json(&existing),
                            "binding": { "id": format!("bnd_{cred_id}"), "enabled": true },
                            "target_created": false,
                            "binding_created": !already,
                            "replayed": already
                        }),
                    );
                }
            }

            // Alias path: conflicting metadata fails closed (repository-null
            // legacy target + remote_url register => providerMatches false).
            if let Some(existing) = targets.iter().find(|t| t.alias == alias).cloned() {
                if existing.disabled {
                    return MockResponse::json(
                        409,
                        &serde_json::json!({ "error": "TARGET_DISABLED", "message": "Execution target is disabled." }),
                    );
                }
                if existing.kind != body["kind"].as_str().unwrap_or("") {
                    return MockResponse::json(
                        409,
                        &serde_json::json!({ "error": "TARGET_ALIAS_CONFLICT", "message": "kind conflicts." }),
                    );
                }
                let metadata_conflicts = match (&existing.full_name, &requested_full_name) {
                    (None, Some(_)) | (Some(_), None) => true,
                    (Some(a), Some(b)) => a.to_lowercase() != *b,
                    (None, None) => false,
                };
                if metadata_conflicts {
                    return MockResponse::json(
                        409,
                        &serde_json::json!({ "error": "TARGET_ALIAS_CONFLICT", "message": "Execution target with alias exists but metadata conflicts." }),
                    );
                }
                let already = bindings
                    .iter()
                    .any(|b| b.credential_id == cred_id && b.target_id == existing.id);
                if !already {
                    bindings.push(SimBinding {
                        credential_id: cred_id.clone(),
                        target_id: existing.id.clone(),
                        enabled: true,
                    });
                }
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "target": target_wire_json(&existing),
                        "binding": { "id": format!("bnd_{cred_id}"), "enabled": true },
                        "target_created": false,
                        "binding_created": !already,
                        "replayed": already
                    }),
                );
            }

            // Create.
            let n = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
            let target = SimTarget {
                id: format!("tgt_sim_{n}"),
                alias: alias.clone(),
                display_name: display_name.clone(),
                kind: body["kind"].as_str().unwrap_or("coding").to_string(),
                full_name: requested_full_name.clone(),
                disabled: false,
            };
            targets.push(target.clone());
            bindings.push(SimBinding {
                credential_id: cred_id.clone(),
                target_id: target.id.clone(),
                enabled: true,
            });
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": target_wire_json(&target),
                    "binding": { "id": format!("bnd_{cred_id}"), "enabled": true },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/bind") {
            let cred_id = bearer_credential_id(req);
            let target_id = req.path.rsplit('/').nth(1).unwrap_or("").to_string();
            let replayed = {
                let mut bindings = state.bindings.lock().unwrap();
                if let Some(existing) = bindings
                    .iter_mut()
                    .find(|b| b.credential_id == cred_id && b.target_id == target_id)
                {
                    let was_enabled = existing.enabled;
                    existing.enabled = true;
                    was_enabled
                } else {
                    bindings.push(SimBinding {
                        credential_id: cred_id.clone(),
                        target_id: target_id.clone(),
                        enabled: true,
                    });
                    false
                }
            };
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "target_id": target_id,
                    "binding_id": format!("bnd_{cred_id}"),
                    "enabled": true,
                    "replayed": replayed
                }),
            );
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

fn assert_attach_called_once(server: &MockServer, expected_target_id: &str) {
    let attaches: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path.ends_with("/attach-repository"))
        .collect();
    assert_eq!(
        attaches.len(),
        1,
        "attach-repository must be called exactly once"
    );
    let body: serde_json::Value = attaches[0].json().unwrap();
    assert_eq!(body["workspace_id"], "ws_1");
    assert_eq!(body["repository"]["source"], "remote_url");
    assert_eq!(body["repository"]["provider"], "github");
    assert_eq!(body["repository"]["full_name"], "org/legacy-repo");
    assert!(
        attaches[0]
            .path
            .ends_with(&format!("/{expected_target_id}/attach-repository")),
        "attach must address the exact target_id, got {}",
        attaches[0].path
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bound_legacy_null_target_backfills_onto_exact_target_id() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    // Legacy production shape: repository-null active coding target.
    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");

    // The bound legacy Device's local config already maps the exact
    // target_id to the verified checkout being added, and the Server still
    // has an ACTIVE binding row for this exact device + target.
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_1cf2ba3e", &canonical(&repo_dir));
    seed_binding(&state, "crd_devA", "tgt_1cf2ba3e", true);

    // A DIFFERENT requested human name: backfill must not rename anything.
    project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("renamed-app"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("project add failed: {e}"));

    // Attach ran exactly once, addressed at the exact target_id; no register.
    assert_attach_called_once(&server, "tgt_1cf2ba3e");
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    // The legacy Target keeps its alias (no implicit rename) and now owns
    // the normalized repository identity.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].alias, "legacy-app");
    assert_eq!(targets[0].display_name, "legacy-app");
    assert_eq!(targets[0].full_name.as_deref(), Some("org/legacy-repo"));
    drop(targets);
    assert_eq!(state.rename_count.load(Ordering::SeqCst), 0);

    // Local config remains keyed by the immutable target_id.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(cfg.targets.len(), 1);
    assert!(cfg.targets.contains_key("tgt_1cf2ba3e"));
}

#[tokio::test]
async fn fresh_device_after_backfill_resolves_same_target_id_despite_name_and_folder() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp_a, paths_a) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let (_temp_b, paths_b) = setup_device_profile(&server.origin(), "crd_devB", "dev_B");

    // Device A: bound legacy device backfills (active this-device binding).
    let repo_dir_a = _temp_a.path().join("clone-a");
    init_git_repo(&repo_dir_a, Some("git@github.com:org/legacy-repo.git"));
    map_target_in_config(&paths_a, "tgt_1cf2ba3e", &canonical(&repo_dir_a));
    seed_binding(&state, "crd_devA", "tgt_1cf2ba3e", true);
    project_add(
        &paths_a,
        Some(repo_dir_a.to_str().unwrap()),
        None,
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("device A add failed: {e}"));
    assert_attach_called_once(&server, "tgt_1cf2ba3e");

    // Fresh Device B: empty local config, a DIFFERENT clone folder name and
    // an equivalent-but-different origin form. It must resolve the SAME
    // target_id purely by repository identity.
    let repo_dir_b = _temp_b.path().join("totally-different-clone-folder");
    init_git_repo(&repo_dir_b, Some("https://github.com/org/legacy-repo.git"));
    project_add(
        &paths_b,
        Some(repo_dir_b.to_str().unwrap()),
        Some("fresh-different-name"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("device B add failed: {e}"));

    // No duplicate register, no second attach.
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);
    assert_eq!(state.attach_count.load(Ordering::SeqCst), 1);

    // Exactly one target; alias unchanged; both devices' configs keyed by
    // the SAME immutable target_id.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "tgt_1cf2ba3e");
    assert_eq!(targets[0].alias, "legacy-app");
    drop(targets);
    let cfg_a = LocalConfig::load(&paths_a.config_file()).unwrap().unwrap();
    let cfg_b = LocalConfig::load(&paths_b.config_file()).unwrap().unwrap();
    assert_eq!(cfg_a.targets.len(), 1);
    assert_eq!(cfg_b.targets.len(), 1);
    assert_eq!(
        cfg_a.targets.keys().next().unwrap(),
        cfg_b.targets.keys().next().unwrap()
    );
    assert_eq!(cfg_a.targets.keys().next().unwrap(), "tgt_1cf2ba3e");
}

#[tokio::test]
async fn fresh_unbound_device_cannot_claim_legacy_null_target_by_alias() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    // Fresh Device B: NO local config mapping for the checkout. The human
    // alias matches the legacy target, but an alias match is never
    // authority to BACKFILL repository identity onto it.
    let (_temp_b, paths_b) = setup_device_profile(&server.origin(), "crd_devB", "dev_B");
    let repo_dir_b = _temp_b.path().join("clone-b");
    init_git_repo(&repo_dir_b, Some("https://github.com/org/legacy-repo.git"));

    project_add(
        &paths_b,
        Some(repo_dir_b.to_str().unwrap()),
        Some("legacy-app"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("unexpected failure: {e}"));

    // The attach capability was NEVER called: alias match alone is not
    // backfill authority on a fresh/unbound Device.
    assert_eq!(state.attach_count.load(Ordering::SeqCst), 0);

    // The legacy target remains repository-null: no identity was attached
    // through the alias path.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].full_name.is_none());
    assert_eq!(targets[0].alias, "legacy-app");
    drop(targets);

    // The add bound locally under the legacy target's alias (accepted
    // pre-existing alias semantics); local config is keyed by target_id.
    let cfg = LocalConfig::load(&paths_b.config_file()).unwrap().unwrap();
    assert_eq!(cfg.targets.len(), 1);
    assert!(cfg.targets.contains_key("tgt_1cf2ba3e"));
}

#[tokio::test]
async fn attach_conflict_race_fails_closed_without_registering() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_legacy", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    // Device A: stale local mapping, active this-device binding, but a
    // catalogue/attach race injects a conflict...
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_legacy", &canonical(&repo_dir));
    seed_binding(&state, "crd_devA", "tgt_legacy", true);
    // Simulate a catalogue/attach race: between this device's catalogue
    // snapshot and the attach call, another device registered an active
    // target owning the same repository identity. The Server's atomic
    // attach must reject, and the connector must fail closed.
    state.attach_conflict_inject.store(true, Ordering::SeqCst);

    let err = project_add(&paths, Some(repo_dir.to_str().unwrap()), None, None, None)
        .await
        .expect_err("attach conflict must fail closed");
    assert!(
        err.to_string().contains("TARGET_REPOSITORY_CONFLICT"),
        "unexpected error: {err}"
    );

    assert_eq!(state.attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    // No duplicate target was registered; the legacy target stays
    // repository-null (never overwritten or auto-merged).
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].full_name.is_none());
}

#[tokio::test]
async fn rerun_after_backfill_is_idempotent_and_folder_changes_stay_irrelevant() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let repo_dir_a = _temp.path().join("first-folder");
    init_git_repo(&repo_dir_a, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_1cf2ba3e", &canonical(&repo_dir_a));
    seed_binding(&state, "crd_devA", "tgt_1cf2ba3e", true);

    project_add(&paths, Some(repo_dir_a.to_str().unwrap()), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("first add failed: {e}"));
    assert_attach_called_once(&server, "tgt_1cf2ba3e");

    // Second run from a DIFFERENT clone folder of the same repository: the
    // repository identity now matches in the catalogue, so no attach and no
    // register happen; the same target_id is reused and the local config
    // re-points at the new folder (still keyed by target_id).
    let repo_dir_b = _temp.path().join("second-folder");
    init_git_repo(&repo_dir_b, Some("git@github.com:org/legacy-repo.git"));
    project_add(
        &paths,
        Some(repo_dir_b.to_str().unwrap()),
        Some("yet-another-name"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("second add failed: {e}"));

    assert_eq!(state.attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].alias, "legacy-app");
    drop(targets);

    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(cfg.targets.len(), 1);
    let entry = cfg.targets.get("tgt_1cf2ba3e").unwrap();
    assert_eq!(entry.local_path, canonical(&repo_dir_b));
}

#[tokio::test]
async fn config_mapped_disabled_target_is_not_backfilled() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    let mut disabled = SimTarget::legacy("tgt_disabled", "legacy-app");
    disabled.disabled = true;
    state.targets.lock().unwrap().push(disabled);

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_disabled", &canonical(&repo_dir));
    seed_binding(&state, "crd_devA", "tgt_disabled", true);

    let err = project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("legacy-app"),
        None,
        None,
    )
    .await
    .expect_err("disabled mapped target must not be backfilled");
    assert!(
        err.to_string().contains("TARGET_DISABLED"),
        "unexpected error: {err}"
    );

    // Attach was never attempted on the disabled target, and the alias path
    // rejects the disabled target without registering anything.
    assert_eq!(state.attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    // Still disabled and repository-null.
    let targets = state.targets.lock().unwrap();
    assert!(targets[0].full_name.is_none());
    assert!(targets[0].disabled);
}

#[tokio::test]
async fn stale_local_mapping_without_server_binding_never_backfills() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_1cf2ba3e", &canonical(&repo_dir));
    // NO device_target_bindings row exists for this device + target: the
    // local mapping is stale state after detach/unbind and must never
    // authorize a legacy backfill attach.

    project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("legacy-app"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("unexpected failure: {e}"));

    // The attach capability was NEVER called: without an active this-device
    // Server binding the local mapping cannot authorize backfill, and the
    // backfill never auto-binds.
    assert_eq!(state.attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    // The legacy target stays repository-null and keeps its alias; no
    // duplicate target was registered.
    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "tgt_1cf2ba3e");
    assert_eq!(targets[0].alias, "legacy-app");
    assert!(targets[0].full_name.is_none());
    drop(targets);

    // Local config remains keyed by the immutable target_id.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(cfg.targets.contains_key("tgt_1cf2ba3e"));
}

#[tokio::test]
async fn disabled_this_device_binding_never_authorizes_backfill() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_1cf2ba3e", &canonical(&repo_dir));
    // The binding row exists but is DISABLED (unbound/detached): this is not
    // backfill authority.
    seed_binding(&state, "crd_devA", "tgt_1cf2ba3e", false);

    project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("legacy-app"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("unexpected failure: {e}"));

    assert_eq!(state.attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].full_name.is_none());
    drop(targets);
}

#[tokio::test]
async fn another_device_binding_does_not_authorize_this_device_backfill() {
    let server = MockServer::start().await;
    let state = Arc::new(SimServerState::default());
    attach_simulated_server(&server, state.clone());

    state
        .targets
        .lock()
        .unwrap()
        .push(SimTarget::legacy("tgt_1cf2ba3e", "legacy-app"));

    let (_temp, paths) = setup_device_profile(&server.origin(), "crd_devA", "dev_A");
    let repo_dir = _temp.path().join("clone-folder");
    init_git_repo(&repo_dir, Some("https://github.com/org/legacy-repo.git"));
    map_target_in_config(&paths, "tgt_1cf2ba3e", &canonical(&repo_dir));
    // Only ANOTHER device holds an active binding for this target; that
    // never authorizes THIS device's backfill attach.
    seed_binding(&state, "crd_devB", "tgt_1cf2ba3e", true);

    project_add(
        &paths,
        Some(repo_dir.to_str().unwrap()),
        Some("legacy-app"),
        None,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("unexpected failure: {e}"));

    assert_eq!(state.attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(state.register_count.load(Ordering::SeqCst), 0);

    let targets = state.targets.lock().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].alias, "legacy-app");
    assert!(targets[0].full_name.is_none());
    drop(targets);
}
