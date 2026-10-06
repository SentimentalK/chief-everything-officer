//! Shell-completion behavior: clap static completion plus Server-owned
//! Project alias candidates.

mod common;

use std::ffi::OsString;
use std::fs;
use std::path::Path;

use ceo_connector::cli::{Cli, Commands, ProjectSubcommands};
use ceo_connector::completion::{command_with_project_candidates, load_project_alias_candidates};
use ceo_connector::config::{LocalConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::paths::ConnectorPaths;
use clap::{CommandFactory, Parser};
use clap_complete::engine::complete;
use common::mock_server::{MockResponse, MockServer};

const ALIASES: &[&str] = &["chief-everything-officer", "echolet"];

fn candidate_values(aliases: &[&str], words: &[&str], index: usize) -> Vec<String> {
    let mut cmd = command_with_project_candidates(aliases.iter().copied());
    let args: Vec<OsString> = words.iter().copied().map(OsString::from).collect();
    complete(&mut cmd, args, index, None)
        .unwrap()
        .into_iter()
        .map(|candidate| candidate.get_value().to_string_lossy().into_owned())
        .collect()
}

fn assert_contains(values: &[String], expected: &str) {
    assert!(
        values.iter().any(|value| value == expected),
        "expected `{expected}` in {values:?}"
    );
}

#[test]
fn static_top_level_prefix_proposes_project() {
    let values = candidate_values(&[], &["ceo-connector", "pro"], 1);
    assert_contains(&values, "project");
}

#[test]
fn static_completion_still_works_when_dynamic_alias_list_is_empty() {
    let values = candidate_values(&[], &["ceo-connector", "pro"], 1);
    assert_contains(&values, "project");

    let flags = candidate_values(&[], &["ceo-connector", "project", "list", "--j"], 3);
    assert_contains(&flags, "--json");
}

#[test]
fn project_subcommand_completion_lists_project_commands() {
    let values = candidate_values(&[], &["ceo-connector", "project", ""], 2);
    for name in [
        "add",
        "list",
        "show",
        "set",
        "rename",
        "detach",
        "delete",
        "default-runtime",
    ] {
        assert_contains(&values, name);
    }
}

#[test]
fn dynamic_selector_prefixes_propose_matching_aliases() {
    let show = candidate_values(ALIASES, &["ceo-connector", "project", "show", "e"], 3);
    assert_eq!(show, vec!["echolet".to_string()]);

    let set = candidate_values(ALIASES, &["ceo-connector", "project", "set", "ch"], 3);
    assert_eq!(set, vec!["chief-everything-officer".to_string()]);
}

#[test]
fn empty_selector_prefix_returns_all_aliases() {
    let values = candidate_values(ALIASES, &["ceo-connector", "project", "show", ""], 3);
    assert_contains(&values, "chief-everything-officer");
    assert_contains(&values, "echolet");
}

#[test]
fn rename_completes_existing_project_but_not_the_new_name() {
    let current = candidate_values(ALIASES, &["ceo-connector", "project", "rename", "e"], 3);
    assert_eq!(current, vec!["echolet".to_string()]);

    let new_name = candidate_values(
        ALIASES,
        &["ceo-connector", "project", "rename", "echolet", ""],
        4,
    );
    assert!(
        !new_name
            .iter()
            .any(|value| ALIASES.contains(&value.as_str())),
        "new_name must not reuse Project aliases, got {new_name:?}"
    );
}

#[test]
fn default_runtime_optional_selector_offers_aliases() {
    let values = candidate_values(
        ALIASES,
        &["ceo-connector", "project", "default-runtime", ""],
        3,
    );
    assert_contains(&values, "chief-everything-officer");
    assert_contains(&values, "echolet");
}

#[test]
fn job_list_project_flag_offers_matching_alias() {
    let values = candidate_values(
        ALIASES,
        &["ceo-connector", "job", "list", "--project", "e"],
        4,
    );
    assert_eq!(values, vec!["echolet".to_string()]);
}

#[test]
fn parser_accepts_selectors_outside_the_completion_list() {
    let cli = Cli::try_parse_from([
        "ceo-connector",
        "project",
        "show",
        "tgt_not_in_the_completion_list",
    ])
    .unwrap();
    match cli.command {
        Commands::Project {
            sub: ProjectSubcommands::Show { project, .. },
        } => assert_eq!(project, "tgt_not_in_the_completion_list"),
        other => panic!("unexpected command: {other:?}"),
    }

    let cmd = command_with_project_candidates(ALIASES.iter().copied());
    assert!(
        cmd.try_get_matches_from([
            "ceo-connector",
            "project",
            "delete",
            "tgt_not_in_the_completion_list",
        ])
        .is_ok(),
        "completion candidates must not constrain runtime selector values"
    );
}

#[test]
fn version_flag_reports_2_5_5() {
    assert_eq!(Cli::command().get_version(), Some("2.5.5"));
    let err = Cli::try_parse_from(["ceo-connector", "--version"]).unwrap_err();
    assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
    assert!(err.to_string().contains("2.5.5"));
}

fn target_wire(id: &str, alias: &str, display_name: &str) -> serde_json::Value {
    serde_json::json!({
        "target": {
            "id": id,
            "workspace_id": "ws_1",
            "alias": alias,
            "display_name": display_name,
            "kind": "coding",
            "repository": null,
            "disabled": false
        },
        "this_device_binding": null,
        "active_binding_count": 0
    })
}

fn write_profile(paths: &ConnectorPaths, origin: &str, target_ids: &[&str]) {
    fs::create_dir_all(&paths.root_dir).unwrap();
    let cred = DeviceCredential::new(
        origin.to_string(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let mut config = LocalConfig::new(origin.to_string()).unwrap();
    for id in target_ids {
        config.targets.insert(
            (*id).to_string(),
            LocalTarget {
                local_path: format!("/tmp/{id}-checkout"),
                executor: None,
            },
        );
    }
    config.save(&paths.config_file()).unwrap();
}

fn file_snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = fs::read(&path) {
                files.push((
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    bytes,
                ));
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

#[tokio::test]
async fn catalogue_aliases_are_filtered_to_local_target_ids() {
    let server = MockServer::start().await;
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let requests_clone = requests.clone();
    server.add_handler(move |req| {
        if req.method == "GET" && req.path == "/api/connector/targets" {
            requests_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [
                        target_wire("tgt_foreign", "not-on-this-device", "Foreign"),
                        target_wire("tgt_echo", "echolet", "Echo Display"),
                        target_wire("tgt_chief", "chief-everything-officer", "Chief Everything Officer"),
                        target_wire("tgt_echo", "echolet", "Echo Display Duplicate"),
                        target_wire("tgt_blank", "", "Blank Alias"),
                    ]
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
    // Local config also has a target the Server does not know, plus a path
    // name that must not be invented as an alias. `tgt_blank` is local but
    // its Server alias is empty. `tgt_foreign` is Server-only.
    write_profile(
        &paths,
        &server.origin(),
        &["tgt_echo", "tgt_chief", "tgt_only_local", "tgt_blank"],
    );
    let before = file_snapshot(&paths.root_dir);

    let aliases = load_project_alias_candidates(&paths).await;

    assert_eq!(
        aliases,
        vec![
            "chief-everything-officer".to_string(),
            "echolet".to_string(),
        ]
    );
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(file_snapshot(&paths.root_dir), before);
    assert!(
        server
            .requests()
            .iter()
            .all(|req| req.method == "GET" && req.path == "/api/connector/targets"),
        "completion lookup may only read the target catalogue: {:?}",
        server.requests()
    );
}

#[tokio::test]
async fn missing_credential_returns_no_aliases_and_does_not_mutate() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    fs::create_dir_all(&paths.root_dir).unwrap();
    fs::write(
        paths.config_file(),
        br#"{"schema_version":3,"server_url":"https://ceo.example.com","targets":{"tgt_echo":{"local_path":"/tmp/echolet"}}}"#,
    )
    .unwrap();
    let before = file_snapshot(&paths.root_dir);

    let aliases = load_project_alias_candidates(&paths).await;

    assert!(aliases.is_empty());
    assert_eq!(file_snapshot(&paths.root_dir), before);
}

#[tokio::test]
async fn legacy_config_is_not_migrated_during_completion_lookup() {
    let server = MockServer::start().await;
    server.add_handler(|_| MockResponse::json(500, &serde_json::json!({"error": "nope"})));

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    fs::create_dir_all(&paths.root_dir).unwrap();
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
    let legacy = br#"{"schema_version":2,"server_url":"http://127.0.0.1:9","targets":{}}"#;
    fs::write(paths.config_file(), legacy).unwrap();
    let before = fs::read(paths.config_file()).unwrap();

    let aliases = load_project_alias_candidates(&paths).await;

    assert!(aliases.is_empty());
    assert_eq!(fs::read(paths.config_file()).unwrap(), before);
    assert!(
        server.requests().is_empty(),
        "legacy config must not be migrated or used to call the Server"
    );
}

#[tokio::test]
async fn server_failure_returns_no_aliases_and_does_not_mutate() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.method == "GET" && req.path == "/api/connector/targets" {
            return MockResponse::json(500, &serde_json::json!({"error": "unavailable"}));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    write_profile(&paths, &server.origin(), &["tgt_echo"]);
    let before = file_snapshot(&paths.root_dir);

    let aliases = load_project_alias_candidates(&paths).await;

    assert!(aliases.is_empty());
    assert_eq!(file_snapshot(&paths.root_dir), before);
    assert_eq!(server.requests().len(), 1);
}
