//! PROJECT-036 Slice 1A: server-authoritative Target rename + exact human
//! Target selector.
//!
//! Covers: exact alias resolution for bind/set-agent/set-model/
//! set-default-runtime, raw target_id backward compatibility, unknown /
//! fuzzy / case-folded selector rejection, fail-closed ID-vs-alias
//! ambiguity, schema-v3 local config carrying no alias at all (alias authority is Server-only),
//! rename-by-selector driving an immutable-ID server rename (no
//! delete/recreate), and stable name-oriented rendering contracts.

mod common;

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::client::{ConnectorTargetProjection, RenameTargetResponse};
use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::targets::{
    resolve_selector_from_catalogue, target_bind, target_rename, target_set_agent,
    target_set_default_runtime, target_set_model, TargetError,
};
use common::mock_server::{MockResponse, MockServer};

const SERVER_ALIAS: &str = "bill-laptop";
const STALE_LOCAL_ALIAS: &str = "stale-alias";
const TARGET_ID: &str = "tgt_real";

fn projection(id: &str, alias: &str) -> ConnectorTargetProjection {
    ConnectorTargetProjection {
        target_id: id.to_string(),
        workspace_id: "ws_1".to_string(),
        alias: alias.to_string(),
        display_name: alias.to_string(),
        kind: "general_automation".to_string(),
        repository: None,
        disabled: false,
        is_default_agent_runtime: false,
        this_device_binding: None,
        active_binding_count: 0,
    }
}

fn catalogue_json() -> serde_json::Value {
    serde_json::json!({
        "targets": [{
            "target": {
                "id": TARGET_ID,
                "workspace_id": "ws_1",
                "alias": SERVER_ALIAS,
                "display_name": "Bill Laptop",
                "kind": "general_automation",
                "repository": null,
                "disabled": false
            },
            "this_device_binding": {
                "id": "bnd_1",
                "enabled": true
            },
            "active_binding_count": 1
        }]
    })
}

fn seed_local_config(paths: &ConnectorPaths, server_origin: &str) {
    let mut config = LocalConfig::new(server_origin.to_string()).unwrap();
    config.targets.insert(
        TARGET_ID.to_string(),
        LocalTarget {
            local_path: "/tmp/repo".to_string(),
            executor: Some(
                LocalExecutorConfig::new("cursor".into(), "agent -f --trust".into()).unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();
}

fn seed_credential(paths: &ConnectorPaths, origin: &str) {
    let cred = DeviceCredential::new(
        origin.into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();
}

fn temp_paths() -> (tempfile::TempDir, ConnectorPaths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    (temp, paths)
}

fn make_dir_under(temp: &tempfile::TempDir, name: &str) -> String {
    let dir = temp.path().join(name);
    fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().to_string()
}

/// Standard mock: server catalogue with one target (alias `bill-laptop`,
/// id `tgt_real`), plus optional rename endpoint. Records how many times
/// register/unbind endpoints are hit (must stay zero for rename).
struct RenameMock {
    _server: MockServer,
    register_hits: Arc<AtomicUsize>,
    unbind_hits: Arc<AtomicUsize>,
    rename_hits: Arc<AtomicUsize>,
    rename_bodies: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    origin: String,
}

async fn rename_mock() -> RenameMock {
    rename_mock_with_rename_response(MockResponse::json(
        200,
        &serde_json::json!({
            "ok": true,
            "target_id": TARGET_ID,
            "previous_alias": SERVER_ALIAS,
            "alias": "bill-desk",
            "replayed": false,
            "updated_at_ms": 1700000000000i64
        }),
    ))
    .await
}

async fn rename_mock_with_rename_response(rename_response: MockResponse) -> RenameMock {
    let server = MockServer::start().await;
    let register_hits = Arc::new(AtomicUsize::new(0));
    let unbind_hits = Arc::new(AtomicUsize::new(0));
    let rename_hits = Arc::new(AtomicUsize::new(0));
    let rename_bodies = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));

    let rh = register_hits.clone();
    let uh = unbind_hits.clone();
    let eh = rename_hits.clone();
    let eb = rename_bodies.clone();
    server.add_handler(move |req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &catalogue_json());
        }
        if req.method == "POST" && req.path == "/api/connector/targets/register" {
            rh.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(500, &serde_json::json!({ "error": "must_not_be_called" }));
        }
        if req.method == "POST" && req.path.ends_with("/unbind") {
            uh.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(500, &serde_json::json!({ "error": "must_not_be_called" }));
        }
        if req.method == "POST" && req.path == "/api/connector/targets/tgt_real/rename" {
            eh.fetch_add(1, Ordering::SeqCst);
            if let Ok(body) = req.json::<serde_json::Value>() {
                eb.lock().unwrap().push(body);
            }
            return rename_response.clone();
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    RenameMock {
        origin: server.origin(),
        _server: server,
        register_hits,
        unbind_hits,
        rename_hits,
        rename_bodies,
    }
}

// ---------------------------------------------------------------------------
// Selector resolution (pure catalogue tests)
// ---------------------------------------------------------------------------

#[test]
fn exact_alias_and_exact_id_resolve_from_catalogue() {
    let (_temp, paths) = temp_paths();
    let catalogue = vec![projection(TARGET_ID, SERVER_ALIAS)];

    let by_alias = resolve_selector_from_catalogue(&paths, &catalogue, SERVER_ALIAS).unwrap();
    assert_eq!(by_alias.target_id, TARGET_ID);
    assert!(by_alias.projection.is_some());

    let by_id = resolve_selector_from_catalogue(&paths, &catalogue, TARGET_ID).unwrap();
    assert_eq!(by_id.target_id, TARGET_ID);
}

#[test]
fn fuzzy_case_folded_and_partial_selectors_are_rejected() {
    let (_temp, paths) = temp_paths();
    let catalogue = vec![projection(TARGET_ID, SERVER_ALIAS)];

    for selector in [
        "Bill-Laptop",
        "BILL-LAPTOP",
        "bill-lapt",
        "bill",
        "laptop",
        " bill-laptop ",
    ] {
        // Matching is verbatim: case folding, substrings, and padded input
        // never match.
        let err = resolve_selector_from_catalogue(&paths, &catalogue, selector).unwrap_err();
        assert!(
            matches!(err, TargetError::TargetNotFound(ref s) if s == selector),
            "selector '{selector}' must not resolve; got {err:?}"
        );
    }
}

#[test]
fn unknown_alias_fails_with_actionable_error() {
    let (_temp, paths) = temp_paths();
    let catalogue = vec![projection(TARGET_ID, SERVER_ALIAS)];

    let err = resolve_selector_from_catalogue(&paths, &catalogue, "no-such-target").unwrap_err();
    let rendered = err.to_string();
    assert!(rendered.contains("no-such-target"));
    assert!(rendered.contains("exact"));
}

#[test]
fn id_vs_alias_ambiguity_fails_closed() {
    let (_temp, paths) = temp_paths();
    // "tgt_dup" is the ID of one target and the alias of a different one.
    let catalogue = vec![
        projection("tgt_dup", "one"),
        projection("tgt_other", "tgt_dup"),
    ];

    let err = resolve_selector_from_catalogue(&paths, &catalogue, "tgt_dup").unwrap_err();
    assert!(matches!(err, TargetError::AmbiguousSelector(s) if s == "tgt_dup"));
}

#[test]
fn local_config_stores_no_alias_and_never_resolves_one() {
    let (_temp, paths) = temp_paths();
    seed_local_config(&paths, "http://127.0.0.1:4000");
    // Server catalogue carries the alias for this target_id.
    let catalogue = vec![projection(TARGET_ID, SERVER_ALIAS)];

    // Server alias resolves to the same immutable ID...
    let resolved = resolve_selector_from_catalogue(&paths, &catalogue, SERVER_ALIAS).unwrap();
    assert_eq!(resolved.target_id, TARGET_ID);

    // ...while any alias not in the Server catalogue (e.g. a stale alias an
    // older local copy might have held) does not resolve at all: schema v3
    // local config stores no alias and never supplies alias authority.
    let err = resolve_selector_from_catalogue(&paths, &catalogue, STALE_LOCAL_ALIAS).unwrap_err();
    assert!(matches!(err, TargetError::TargetNotFound(_)));
}

// ---------------------------------------------------------------------------
// bind / set-agent / set-model / set-default-runtime with alias selectors
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bind_accepts_exact_alias_and_drives_immutable_id() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &catalogue_json());
        }
        if req.method == "POST" && req.path == "/api/connector/targets/tgt_real/bind" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "target_id": "tgt_real",
                    "binding_id": "bnd_new",
                    "enabled": true,
                    "replayed": false
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (temp, paths) = temp_paths();
    seed_credential(&paths, &server.origin());
    seed_local_config(&paths, &server.origin());
    let dir = make_dir_under(&temp, "bind_dir");

    // Exact alias (server authority), not the stale local alias.
    target_bind(&paths, SERVER_ALIAS, &dir, None, None)
        .await
        .unwrap();

    // Exact raw target_id still works (backward compatible).
    target_bind(&paths, TARGET_ID, &dir, None, None)
        .await
        .unwrap();

    let bind_calls: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|r| r.path.ends_with("/bind"))
        .collect();
    assert_eq!(bind_calls.len(), 2);
    assert!(bind_calls
        .iter()
        .all(|r| r.path == "/api/connector/targets/tgt_real/bind"));

    // Local config stays keyed by the immutable target_id.
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key(TARGET_ID));
}

#[tokio::test]
async fn bind_rejects_unknown_alias_clearly() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &catalogue_json());
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (temp, paths) = temp_paths();
    seed_credential(&paths, &server.origin());
    seed_local_config(&paths, &server.origin());
    let dir = make_dir_under(&temp, "bind_dir");

    let err = target_bind(&paths, "no-such-target", &dir, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, TargetError::TargetNotFound(ref s) if s == "no-such-target"));

    // Fuzzy/partial and stale-local-alias selectors are not accepted either.
    for selector in ["bill-lapt", "Bill-Laptop", STALE_LOCAL_ALIAS] {
        let err = target_bind(&paths, selector, &dir, None, None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, TargetError::TargetNotFound(_)),
            "selector '{selector}' must not resolve"
        );
    }
}

#[tokio::test]
async fn set_agent_and_set_model_accept_exact_alias() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &catalogue_json());
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &server.origin());
    seed_local_config(&paths, &server.origin());

    // Exact server alias resolves and drives the local executor config keyed
    // by the immutable target_id.
    target_set_agent(&paths, SERVER_ALIAS, "cursor", "agent -f --trust")
        .await
        .unwrap();

    target_set_model(&paths, SERVER_ALIAS, Some("gpt-5"))
        .await
        .unwrap();

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let target = config.targets.get(TARGET_ID).unwrap();
    let executor = target.executor.as_ref().unwrap();
    assert_eq!(executor.agent_id, "cursor");
    assert_eq!(executor.model.as_deref(), Some("gpt-5"));

    // Raw target_id still works for both commands.
    target_set_model(&paths, TARGET_ID, None).await.unwrap();
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let executor = config
        .targets
        .get(TARGET_ID)
        .unwrap()
        .executor
        .as_ref()
        .unwrap();
    assert!(executor.model.is_none());
}

#[tokio::test]
async fn set_agent_preserves_direct_id_behavior_without_credential() {
    let (_temp, paths) = temp_paths();
    seed_local_config(&paths, "http://127.0.0.1:4000");
    assert!(!paths.credential_file().exists());

    // No credential: legacy direct-ID behavior is preserved for the
    // local-only executor mutation.
    target_set_agent(&paths, TARGET_ID, "cursor", "agent -f --trust")
        .await
        .unwrap();
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.get(TARGET_ID).unwrap().executor.is_some());
}

#[tokio::test]
async fn set_default_runtime_accepts_exact_alias() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &catalogue_json());
        }
        if req.method == "POST" && req.path == "/api/connector/targets/tgt_real/default-runtime" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "workspace_id": "ws_1",
                    "target_id": "tgt_real",
                    "is_default_agent_runtime": true,
                    "replayed": false,
                    "updated_at_ms": 1700000000000i64
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &server.origin());

    // Alias selector hits the immutable-ID endpoint...
    target_set_default_runtime(&paths, SERVER_ALIAS)
        .await
        .unwrap();

    // ...and the raw target_id keeps working.
    target_set_default_runtime(&paths, TARGET_ID).await.unwrap();

    let calls: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|r| r.path.ends_with("/default-runtime"))
        .collect();
    assert_eq!(calls.len(), 2);
    assert!(calls
        .iter()
        .all(|r| r.path == "/api/connector/targets/tgt_real/default-runtime"));
}

// ---------------------------------------------------------------------------
// target rename
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rename_resolves_selector_to_immutable_id_without_recreating() {
    let mock = rename_mock().await;
    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &mock.origin);
    seed_local_config(&paths, &mock.origin);

    // By exact alias...
    target_rename(&paths, SERVER_ALIAS, "bill-desk", false)
        .await
        .unwrap();

    // ...and by exact target_id.
    target_rename(&paths, TARGET_ID, "bill-desk", false)
        .await
        .unwrap();

    assert_eq!(mock.rename_hits.load(Ordering::SeqCst), 2);
    for body in mock.rename_bodies.lock().unwrap().iter() {
        assert_eq!(
            body.get("alias").and_then(|v| v.as_str()),
            Some("bill-desk")
        );
    }
    // Rename never registers or unbinds: no delete/recreate.
    assert_eq!(mock.register_hits.load(Ordering::SeqCst), 0);
    assert_eq!(mock.unbind_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rename_requires_server_known_target() {
    // Server catalogue works but does not know the selector; rename must not
    // fall back to local cached state.
    let mock = rename_mock().await;
    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &mock.origin);
    seed_local_config(&paths, &mock.origin);

    let err = target_rename(&paths, STALE_LOCAL_ALIAS, "bill-desk", false)
        .await
        .unwrap_err();
    assert!(matches!(err, TargetError::TargetNotFound(_)));
    assert_eq!(mock.rename_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rename_surfaces_server_conflict_and_replay() {
    // Conflict response is surfaced as a structured client error.
    let conflict_mock = rename_mock_with_rename_response(MockResponse::json(
        409,
        &serde_json::json!({
            "error": "TARGET_ALIAS_CONFLICT",
            "message": "ExecutionTarget with alias 'bill-desk' already exists in workspace 'ws_1'."
        }),
    ))
    .await;
    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &conflict_mock.origin);
    seed_local_config(&paths, &conflict_mock.origin);

    let err = target_rename(&paths, SERVER_ALIAS, "bill-desk", false)
        .await
        .unwrap_err();
    match err {
        TargetError::Client(ceo_connector::client::ClientError::TargetError { code, .. }) => {
            assert_eq!(code, "TARGET_ALIAS_CONFLICT");
        }
        other => panic!("unexpected error: {other:?}"),
    }

    // Idempotent replay (same alias) parses and renders fine.
    let replay_mock = rename_mock_with_rename_response(MockResponse::json(
        200,
        &serde_json::json!({
            "ok": true,
            "target_id": TARGET_ID,
            "previous_alias": "bill-desk",
            "alias": "bill-desk",
            "replayed": true,
            "updated_at_ms": 1700000000000i64
        }),
    ))
    .await;
    let (_temp2, paths2) = temp_paths();
    seed_credential(&paths2, &replay_mock.origin);
    seed_local_config(&paths2, &replay_mock.origin);
    target_rename(&paths2, SERVER_ALIAS, "bill-desk", true)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Stable DTO / rendering contracts
// ---------------------------------------------------------------------------

#[test]
fn rename_response_dto_parses_server_payload() {
    let res: RenameTargetResponse = serde_json::from_str(
        r#"{
            "ok": true,
            "target_id": "tgt_real",
            "previous_alias": "bill-laptop",
            "alias": "bill-desk",
            "replayed": false,
            "updated_at_ms": 1700000000000
        }"#,
    )
    .unwrap();
    assert_eq!(res.previous_alias, "bill-laptop");
    assert_eq!(res.alias, "bill-desk");
    assert!(!res.replayed);

    // Additive-tolerant decode: unknown/absent optional fields are accepted.
    let minimal: RenameTargetResponse = serde_json::from_str(
        r#"{ "ok": true, "target_id": "t", "previous_alias": "a", "alias": "b" }"#,
    )
    .unwrap();
    assert!(minimal.updated_at_ms == 0);
}
