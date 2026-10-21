mod common;

use std::io::Write;
use std::path::Path;

use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{run_doctor_with_orca_and_release, DiagnosticSeverity};
use ceo_connector::local_state::ExecutionLock;
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::upgrade::{
    current_platform_asset, extract_binary, parse_semver, parse_sha256sums, platform_asset_name,
    run_upgrade, InstallTarget, ReleaseSource, UpgradeError, UpgradeOptions, CURRENT_VERSION,
    GITHUB_REPO,
};
use common::mock_server::{MockRequest, MockResponse, MockServer};
use sha2::{Digest, Sha256};

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn empty_response() -> MockResponse {
    MockResponse {
        status: 0,
        headers: vec![],
        body: vec![],
    }
}

fn raw_response(body: Vec<u8>) -> MockResponse {
    MockResponse {
        status: 200,
        headers: vec![],
        body,
    }
}

fn release_entry(
    version: &str,
    asset: &str,
    asset_url: &str,
    sums_url: &str,
    prerelease: bool,
) -> serde_json::Value {
    serde_json::json!({
        "tag_name": format!("connector-v{version}"),
        "draft": false,
        "prerelease": prerelease,
        "assets": [
            { "name": asset, "browser_download_url": asset_url },
            { "name": "SHA256SUMS", "browser_download_url": sums_url }
        ]
    })
}

fn upgrade_handler(
    origin: String,
    asset: &'static str,
    latest_archive: Vec<u8>,
    older_archive: Vec<u8>,
    corrupt_sums: bool,
) -> impl Fn(&MockRequest) -> MockResponse + Send + Sync + 'static {
    let latest_hex = sha256_hex(&latest_archive);
    let older_hex = sha256_hex(&older_archive);
    let latest_sums = if corrupt_sums {
        format!("{}  {asset}\n", "0".repeat(64))
    } else {
        format!("{latest_hex}  {asset}\n")
    };
    let older_sums = format!("{older_hex}  {asset}\n");
    let latest_asset_url = format!("{origin}/dl/{asset}");
    let latest_sums_url = format!("{origin}/dl/SHA256SUMS");
    let older_asset_url = format!("{origin}/dl/9.8.0/{asset}");
    let older_sums_url = format!("{origin}/dl/9.8.0/SHA256SUMS");
    let releases_path = format!("/repos/{GITHUB_REPO}/releases");

    move |req: &MockRequest| {
        if req.method != "GET" {
            return empty_response();
        }
        if req.path == format!("{releases_path}?per_page=30") {
            let prerelease =
                release_entry("9.9.10", asset, &latest_asset_url, &latest_sums_url, true);
            let unrelated = serde_json::json!({
                "tag_name": "server-v1.0.0",
                "draft": false,
                "prerelease": false,
                "assets": []
            });
            let latest = release_entry("9.9.9", asset, &latest_asset_url, &latest_sums_url, false);
            let older = release_entry("9.8.0", asset, &older_asset_url, &older_sums_url, false);
            return MockResponse::json(
                200,
                &serde_json::json!([prerelease, unrelated, latest, older]),
            );
        }
        if req.path == format!("{releases_path}/tags/connector-v9.8.0") {
            let older = release_entry("9.8.0", asset, &older_asset_url, &older_sums_url, false);
            return MockResponse::json(200, &older);
        }
        if req.path == "/dl/SHA256SUMS" {
            return raw_response(latest_sums.clone().into_bytes());
        }
        if req.path == format!("/dl/{asset}") {
            return raw_response(latest_archive.clone());
        }
        if req.path == "/dl/9.8.0/SHA256SUMS" {
            return raw_response(older_sums.clone().into_bytes());
        }
        if req.path == format!("/dl/9.8.0/{asset}") {
            return raw_response(older_archive.clone());
        }
        empty_response()
    }
}

fn build_tar_gz(binary: &[u8], include_binary: bool) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    {
        let mut builder = tar::Builder::new(&mut encoder);
        if include_binary {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(binary.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "ceo-connector-9.9.9/ceo-connector", binary)
                .unwrap();
        } else {
            let readme = b"readme";
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(readme.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "ceo-connector-9.9.9/README.txt", &readme[..])
                .unwrap();
        }
        builder.finish().unwrap();
    }
    encoder.finish().unwrap()
}

fn build_zip(binary: &[u8], include_binary: bool) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if include_binary {
            writer
                .start_file("ceo-connector-9.9.9/ceo-connector", options)
                .unwrap();
            writer.write_all(binary).unwrap();
        } else {
            writer
                .start_file("ceo-connector-9.9.9/README.txt", options)
                .unwrap();
            writer.write_all(b"readme").unwrap();
        }
        writer.finish().unwrap();
    }
    cursor.into_inner()
}

fn build_archive(asset: &str, binary: &[u8], include_binary: bool) -> Vec<u8> {
    if asset.ends_with(".tar.gz") {
        build_tar_gz(binary, include_binary)
    } else {
        build_zip(binary, include_binary)
    }
}

fn has_tmp_files(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
}

fn test_paths_and_exe(temp: &tempfile::TempDir) -> (ConnectorPaths, std::path::PathBuf) {
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    let exe = temp.path().join("ceo-connector");
    std::fs::write(&exe, b"old").unwrap();
    (paths, exe)
}

#[test]
fn semver_parsing_and_ordering() {
    assert_eq!(parse_semver("2.6.0"), Some((2, 6, 0)));
    assert_eq!(parse_semver("v2.6.0"), Some((2, 6, 0)));
    assert_eq!(parse_semver("2.6"), None);
    assert_eq!(parse_semver("2.6.0-rc1"), None);
    assert!(parse_semver("2.10.0").unwrap() > parse_semver("2.9.9").unwrap());
}

#[test]
fn platform_assets_are_exact() {
    assert_eq!(
        platform_asset_name("linux", "x86_64"),
        Some("ceo-connector-linux-x64.tar.gz")
    );
    assert_eq!(
        platform_asset_name("linux", "aarch64"),
        Some("ceo-connector-linux-arm64.tar.gz")
    );
    assert_eq!(
        platform_asset_name("macos", "x86_64"),
        Some("ceo-connector-macos-x64.zip")
    );
    assert_eq!(
        platform_asset_name("macos", "aarch64"),
        Some("ceo-connector-macos-arm64.zip")
    );
    assert_eq!(
        platform_asset_name("windows", "x86_64"),
        Some("ceo-connector-windows-x64.zip")
    );
    assert_eq!(platform_asset_name("freebsd", "x86_64"), None);
}

#[test]
fn sha256sums_parses_both_formats() {
    let text = format!(
        "{}  ceo-connector-linux-x64.tar.gz\n{} *ceo-connector-macos-arm64.zip\n",
        "A".repeat(64),
        "B".repeat(64)
    );
    let sums = parse_sha256sums(&text);
    assert_eq!(
        sums.get("ceo-connector-linux-x64.tar.gz").cloned(),
        Some("a".repeat(64))
    );
    assert_eq!(
        sums.get("ceo-connector-macos-arm64.zip").cloned(),
        Some("b".repeat(64))
    );
}

#[test]
fn extract_binary_from_tar_and_zip() {
    let payload = b"payload-binary-bytes";
    let tar = build_archive("ceo-connector-linux-x64.tar.gz", payload, true);
    assert_eq!(
        extract_binary("ceo-connector-linux-x64.tar.gz", &tar, "ceo-connector").unwrap(),
        payload
    );

    let zip = build_archive("ceo-connector-macos-arm64.zip", payload, true);
    assert_eq!(
        extract_binary("ceo-connector-macos-arm64.zip", &zip, "ceo-connector").unwrap(),
        payload
    );

    let tar_without_binary = build_archive("ceo-connector-linux-x64.tar.gz", payload, false);
    assert!(matches!(
        extract_binary(
            "ceo-connector-linux-x64.tar.gz",
            &tar_without_binary,
            "ceo-connector"
        ),
        Err(UpgradeError::ArchiveInvalid(_))
    ));

    let zip_without_binary = build_archive("ceo-connector-macos-arm64.zip", payload, false);
    assert!(matches!(
        extract_binary(
            "ceo-connector-macos-arm64.zip",
            &zip_without_binary,
            "ceo-connector"
        ),
        Err(UpgradeError::ArchiveInvalid(_))
    ));
}

#[tokio::test]
async fn run_upgrade_installs_latest_stable_release() {
    let asset = current_platform_asset().unwrap();
    let latest_bytes = b"latest-binary-bytes".to_vec();
    let older_bytes = b"older-binary-bytes".to_vec();
    let latest_archive = build_archive(asset, &latest_bytes, true);
    let older_archive = build_archive(asset, &older_bytes, true);

    let server = MockServer::start().await;
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        false,
    ));

    let temp = tempfile::tempdir().unwrap();
    let (paths, exe) = test_paths_and_exe(&temp);
    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let target = InstallTarget {
        exe_path: exe.clone(),
        verify_new_binary: false,
    };
    let opts = UpgradeOptions {
        check_only: false,
        target_version: None,
        assume_yes: true,
    };

    let receipt = run_upgrade(&paths, &opts, &source, &target).await.unwrap();

    assert!(receipt.replaced);
    assert_eq!(receipt.target_version, "9.9.9");
    assert_eq!(std::fs::read(&exe).unwrap(), latest_bytes);
    assert!(!has_tmp_files(temp.path()));
}

#[tokio::test]
async fn run_upgrade_rejects_checksum_mismatch_without_touching_the_binary() {
    let asset = current_platform_asset().unwrap();
    let latest_bytes = b"latest-binary-bytes".to_vec();
    let latest_archive = build_archive(asset, &latest_bytes, true);
    let older_archive = build_archive(asset, b"older", true);

    let server = MockServer::start().await;
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        true,
    ));

    let temp = tempfile::tempdir().unwrap();
    let (paths, exe) = test_paths_and_exe(&temp);
    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let target = InstallTarget {
        exe_path: exe.clone(),
        verify_new_binary: false,
    };
    let opts = UpgradeOptions {
        check_only: false,
        target_version: None,
        assume_yes: true,
    };

    let err = run_upgrade(&paths, &opts, &source, &target)
        .await
        .unwrap_err();

    assert!(matches!(err, UpgradeError::ChecksumMismatch(_)));
    assert_eq!(std::fs::read(&exe).unwrap(), b"old".to_vec());
    assert!(!has_tmp_files(temp.path()));
}

#[tokio::test]
async fn run_upgrade_installs_an_explicit_version() {
    let asset = current_platform_asset().unwrap();
    let latest_bytes = b"latest-binary-bytes".to_vec();
    let older_bytes = b"older-binary-bytes".to_vec();
    let latest_archive = build_archive(asset, &latest_bytes, true);
    let older_archive = build_archive(asset, &older_bytes, true);

    let server = MockServer::start().await;
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        false,
    ));

    let temp = tempfile::tempdir().unwrap();
    let (paths, exe) = test_paths_and_exe(&temp);
    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let target = InstallTarget {
        exe_path: exe.clone(),
        verify_new_binary: false,
    };
    let opts = UpgradeOptions {
        check_only: false,
        target_version: Some("9.8.0".into()),
        assume_yes: true,
    };

    let receipt = run_upgrade(&paths, &opts, &source, &target).await.unwrap();

    assert!(receipt.replaced);
    assert_eq!(receipt.target_version, "9.8.0");
    assert_eq!(receipt.tag, "connector-v9.8.0");
    assert_eq!(std::fs::read(&exe).unwrap(), older_bytes);
    assert!(server
        .requests()
        .iter()
        .any(|req| req.path.ends_with("/releases/tags/connector-v9.8.0")));
}

#[tokio::test]
async fn run_upgrade_check_only_downloads_nothing() {
    let asset = current_platform_asset().unwrap();
    let latest_archive = build_archive(asset, b"latest-binary-bytes", true);
    let older_archive = build_archive(asset, b"older-binary-bytes", true);

    let server = MockServer::start().await;
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        false,
    ));

    let temp = tempfile::tempdir().unwrap();
    let (paths, exe) = test_paths_and_exe(&temp);
    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let target = InstallTarget {
        exe_path: exe.clone(),
        verify_new_binary: false,
    };
    let opts = UpgradeOptions {
        check_only: true,
        target_version: None,
        assume_yes: true,
    };

    let receipt = run_upgrade(&paths, &opts, &source, &target).await.unwrap();

    assert!(receipt.check_only);
    assert!(receipt.update_available);
    assert!(!receipt.replaced);
    assert_eq!(std::fs::read(&exe).unwrap(), b"old".to_vec());
    assert!(!server
        .requests()
        .iter()
        .any(|req| req.path.starts_with("/dl/")));
    assert!(!has_tmp_files(temp.path()));
}

#[tokio::test]
async fn run_upgrade_refuses_while_an_attempt_is_active() {
    let asset = current_platform_asset().unwrap();
    let latest_archive = build_archive(asset, b"latest-binary-bytes", true);
    let older_archive = build_archive(asset, b"older-binary-bytes", true);

    let server = MockServer::start().await;
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        false,
    ));

    let temp = tempfile::tempdir().unwrap();
    let (paths, exe) = test_paths_and_exe(&temp);
    let _lock = ExecutionLock::acquire(&paths.daemon_lock_file()).unwrap();
    std::fs::write(paths.active_attempt_file(), b"{\"job_id\":\"job_1\"}").unwrap();

    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let target = InstallTarget {
        exe_path: exe.clone(),
        verify_new_binary: false,
    };
    let opts = UpgradeOptions {
        check_only: false,
        target_version: None,
        assume_yes: true,
    };

    let err = run_upgrade(&paths, &opts, &source, &target)
        .await
        .unwrap_err();

    assert!(matches!(err, UpgradeError::AttemptActive));
    assert_eq!(std::fs::read(&exe).unwrap(), b"old".to_vec());
}

fn healthy_mock_orca(temp: &tempfile::TempDir) -> OrcaCliClient {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script_path = temp.path().join("mock-orca");
        let script = r#"#!/bin/sh
if [ "$1" = "status" ]; then
    echo '{"ok":true,"result":{"app":{"running":true},"runtime":{"state":"ready","reachable":true,"appVersion":"1.4.209"}}}'
    exit 0
fi
echo '{"ok":true}'
"#;
        std::fs::write(&script_path, script).unwrap();
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
        OrcaCliClient::new(script_path)
    }
    #[cfg(windows)]
    {
        let script_path = temp.path().join("mock-orca.cmd");
        let script = "@echo off\r\nif \"%~1\"==\"status\" (\r\necho {\"ok\":true,\"result\":{\"app\":{\"running\":true},\"runtime\":{\"state\":\"ready\",\"reachable\":true,\"appVersion\":\"1.4.209\"}}}\r\nexit /b 0\r\n)\r\necho {\"ok\":true}\r\n";
        std::fs::write(&script_path, script).unwrap();
        OrcaCliClient::new(script_path)
    }
}

#[tokio::test]
async fn doctor_warns_when_a_newer_connector_release_exists() {
    let asset = current_platform_asset().unwrap();
    let latest_archive = build_archive(asset, b"latest-binary-bytes", true);
    let older_archive = build_archive(asset, b"older-binary-bytes", true);

    let server = MockServer::start().await;
    server.add_handler(|req: &MockRequest| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }
        if req.path == "/api/connector/workspaces" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "workspaces": [] }));
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
        }
        empty_response()
    });
    server.add_handler(upgrade_handler(
        server.origin(),
        asset,
        latest_archive,
        older_archive,
        false,
    ));

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let credential = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    credential.save(&paths.credential_file()).unwrap();

    let config = LocalConfig::new(server.origin()).unwrap();
    config.save(&paths.config_file()).unwrap();

    let source = ReleaseSource {
        api_base: server.origin(),
    };
    let report =
        run_doctor_with_orca_and_release(&paths, true, healthy_mock_orca(&temp), Some(&source))
            .await;

    let check = report
        .checks
        .iter()
        .find(|check| check.name == "Connector Version")
        .expect("doctor must include a Connector Version check");
    assert_eq!(check.severity, DiagnosticSeverity::Warn);
    assert!(
        check
            .message
            .contains(&format!("Update available: {CURRENT_VERSION} -> 9.9.9")),
        "unexpected message: {}",
        check.message
    );
    assert!(report.overall_passed);
}
