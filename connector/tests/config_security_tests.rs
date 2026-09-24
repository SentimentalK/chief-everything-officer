use std::fs;
use std::os::unix::fs::PermissionsExt;

use ceo_connector::config::{normalize_server_origin, LocalConfig};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::enrollment::PendingEnrollmentSession;
use ceo_connector::paths::ConnectorPaths;

#[test]
fn server_origin_security_rules() {
    // Valid origins
    assert_eq!(
        normalize_server_origin("https://api.ceo.dev").unwrap(),
        "https://api.ceo.dev"
    );
    assert_eq!(
        normalize_server_origin("http://127.0.0.1:8080").unwrap(),
        "http://127.0.0.1:8080"
    );
    assert_eq!(
        normalize_server_origin("http://[::1]:9090/").unwrap(),
        "http://[::1]:9090"
    );

    // Forbidden schemes
    assert!(normalize_server_origin("http://api.ceo.dev").is_err());
    assert!(normalize_server_origin("ftp://api.ceo.dev").is_err());

    // Forbidden components
    assert!(normalize_server_origin("https://api.ceo.dev/path").is_err());
    assert!(normalize_server_origin("https://api.ceo.dev?query=1").is_err());
    assert!(normalize_server_origin("https://api.ceo.dev#frag").is_err());
    assert!(normalize_server_origin("https://user:pass@api.ceo.dev").is_err());
}

#[test]
fn strict_schemas_deny_unknown_fields() {
    let bad_config = r#"{
        "schema_version": 1,
        "server_url": "https://api.ceo.dev",
        "targets": {},
        "extra_field": "disallowed"
    }"#;
    assert!(serde_json::from_str::<LocalConfig>(bad_config).is_err());

    let bad_cred = r#"{
        "schema_version": 1,
        "server_origin": "https://api.ceo.dev",
        "user_id": "usr_1",
        "device_id": "dev_1",
        "credential_id": "dcr_1",
        "secret": "s",
        "expires_at_ms": 1000,
        "injected": true
    }"#;
    assert!(serde_json::from_str::<DeviceCredential>(bad_cred).is_err());

    let bad_enrollment = r#"{
        "schema_version": 1,
        "server_origin": "https://api.ceo.dev",
        "device_code": "code",
        "user_code": "ABCD-1234",
        "reserved_device_id": "dev_1",
        "reserved_credential_id": "dcr_1",
        "secret": "s",
        "expires_at_ms": 1000,
        "poll_interval_seconds": 2,
        "stray": 42
    }"#;
    assert!(serde_json::from_str::<PendingEnrollmentSession>(bad_enrollment).is_err());
}

#[test]
fn control_directories_and_files_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let cfg_mode = fs::metadata(&paths.config_dir)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(cfg_mode, 0o700);

    let state_mode = fs::metadata(&paths.state_dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(state_mode, 0o700);

    let cred = DeviceCredential::new(
        "https://api.ceo.dev".into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret123".into(),
        2000000000000,
    )
    .unwrap();

    cred.save(&paths.credential_file()).unwrap();
    let file_mode = fs::metadata(paths.credential_file())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(file_mode, 0o600);
}

#[test]
fn symlink_control_path_rejected() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();

    let link_config = temp.path().join("config_symlink");
    symlink(&outside, &link_config).unwrap();

    let paths = ConnectorPaths::from_roots(link_config, temp.path().join("state"));
    assert!(paths.ensure_dirs().is_err());
}
