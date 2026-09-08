//! BridgeConfig file-load integration. The pure parsing rules are unit-tested
//! inside `config.rs`; here we exercise the on-disk `load()` path and the
//! API-key permission checks end to end.

use ceo_worker::bridge::config::{load_api_key, BridgeConfig, ConfigError};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn write(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, content).unwrap();
    p
}

fn json_config(dir: &Path, patch: &str) -> String {
    format!(
        r#"{{"schema_version":1,"server_url":"https://ceo.example.com","api_key_file":{key:?},"expected_identity":{{"user_id":"usr_a","workspace_id":"ws_b"}},"workspaces":{ws}{patch}}}"#,
        key = write(dir, "key", "sekret\n").display().to_string(),
        ws = dirs_json(dir)
    )
}

fn dirs_json(dir: &Path) -> String {
    let tools = dir.join("tools");
    std::fs::create_dir(&tools).unwrap();
    format!(r#"{{"tools":{:?}}}"#, tools.display().to_string())
}

#[test]
fn loads_valid_config_from_disk_and_resolves_alias() {
    let t = tempfile::tempdir().unwrap();
    let cfg_path = write(t.path(), "bridge.json", &json_config(t.path(), ""));
    let cfg = BridgeConfig::load(&cfg_path).unwrap();
    assert_eq!(cfg.server_base.scheme(), "https");
    assert_eq!(cfg.server_base.host_str(), Some("ceo.example.com"));
    let resolved = cfg.resolve_workspace("tools").expect("alias resolves");
    assert!(resolved.is_dir());
    assert!(cfg.resolve_workspace("missing").is_none());
}

#[test]
fn missing_config_file_is_an_error() {
    let err = BridgeConfig::load(Path::new("/definitely/not/here.json")).unwrap_err();
    assert!(matches!(err, ConfigError::Io(_)));
}

#[test]
fn key_file_perm_guards_are_enforced_on_disk() {
    let t = tempfile::tempdir().unwrap();
    let ok = write(t.path(), "ok", "sekret\n");
    std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(load_api_key(&ok).unwrap().as_str(), "sekret");

    let group_readable = write(t.path(), "gr", "sekret\n");
    std::fs::set_permissions(&group_readable, std::fs::Permissions::from_mode(0o640)).unwrap();
    assert!(load_api_key(&group_readable).is_err());

    let world_writable = write(t.path(), "ww", "sekret\n");
    std::fs::set_permissions(&world_writable, std::fs::Permissions::from_mode(0o606)).unwrap();
    assert!(load_api_key(&world_writable).is_err());

    let empty = write(t.path(), "empty", "");
    std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(load_api_key(&empty).is_err());
}
