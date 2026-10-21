use std::collections::HashMap;
use std::io::{Cursor, IsTerminal, Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::local_state::ExecutionLock;
use crate::paths::ConnectorPaths;

pub const GITHUB_REPO: &str = "SentimentalK/chief-everything-officer";
pub const TAG_PREFIX: &str = "connector-v";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

const SHA256SUMS_ASSET: &str = "SHA256SUMS";

#[derive(Debug, Clone)]
pub struct ReleaseSource {
    pub api_base: String,
}

impl Default for ReleaseSource {
    fn default() -> Self {
        Self {
            api_base: "https://api.github.com".into(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UpgradeOptions {
    pub check_only: bool,
    pub target_version: Option<String>,
    pub assume_yes: bool,
}

/// Where an upgrade installs to.
///
/// Production callers pass `std::env::current_exe()?.canonicalize()?` and
/// verify the downloaded binary. Tests use a temporary file and skip the
/// verification step.
#[derive(Debug, Clone)]
pub struct InstallTarget {
    pub exe_path: PathBuf,
    pub verify_new_binary: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpgradeReceipt {
    pub current_version: String,
    pub target_version: String,
    pub tag: String,
    pub up_to_date: bool,
    pub update_available: bool,
    pub check_only: bool,
    pub asset: String,
    pub sha256: Option<String>,
    pub installed_path: String,
    pub replaced: bool,
    pub daemon_running: bool,
    pub restart_required: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum UpgradeError {
    #[error(
        "This platform is not supported by ceo-connector releases (UPGRADE_UNSUPPORTED_PLATFORM)"
    )]
    UnsupportedPlatform,

    #[error("Could not look up the GitHub release: {0} (UPGRADE_RELEASE_LOOKUP_FAILED)")]
    ReleaseLookupFailed(String),

    #[error("Release '{0}' was not found (UPGRADE_VERSION_NOT_FOUND)")]
    VersionNotFound(String),

    #[error("Release '{0}' does not contain the required assets (UPGRADE_ASSET_MISSING)")]
    AssetMissing(String),

    #[error("Failed to download the release asset: {0} (UPGRADE_DOWNLOAD_FAILED)")]
    DownloadFailed(String),

    #[error("SHA256 verification failed for {0} (UPGRADE_CHECKSUM_MISMATCH)")]
    ChecksumMismatch(String),

    #[error("The release archive is invalid or missing the ceo-connector binary: {0} (UPGRADE_ARCHIVE_INVALID)")]
    ArchiveInvalid(String),

    #[error("Cannot write the upgraded binary ({detail}). Download {asset_url}, verify its SHA256, and replace {exe_path} manually (UPGRADE_TARGET_NOT_WRITABLE)")]
    TargetNotWritable {
        detail: String,
        asset_url: String,
        exe_path: String,
    },

    #[error("The downloaded binary failed verification: {0} (UPGRADE_VERIFY_FAILED)")]
    VerifyFailed(String),

    #[error(
        "an attempt is executing; wait for it to finish or run `ceo-connector pause` first (UPGRADE_ATTEMPT_ACTIVE)"
    )]
    AttemptActive,

    #[error("Upgrade requires confirmation; re-run with --yes in a non-interactive environment (UPGRADE_CONFIRMATION_REQUIRED)")]
    ConfirmationRequired,

    #[error("Invalid version '{0}'; expected X.Y.Z (UPGRADE_INVALID_VERSION)")]
    InvalidVersion(String),
}

#[derive(Debug, Clone)]
pub struct ReleaseInfo {
    pub version: String,
    pub tag: String,
    pub asset_name: String,
    pub asset_url: String,
    pub sums_url: String,
}

#[derive(Debug, serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Parses a plain `X.Y.Z` version (an optional leading `v` is accepted).
/// Pre-release and build suffixes are rejected.
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut parts = s.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn platform_asset_name(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("ceo-connector-linux-x64.tar.gz"),
        ("linux", "aarch64") => Some("ceo-connector-linux-arm64.tar.gz"),
        ("macos", "x86_64") => Some("ceo-connector-macos-x64.zip"),
        ("macos", "aarch64") => Some("ceo-connector-macos-arm64.zip"),
        ("windows", "x86_64") => Some("ceo-connector-windows-x64.zip"),
        _ => None,
    }
}

pub fn current_platform_asset() -> Result<&'static str, UpgradeError> {
    platform_asset_name(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or(UpgradeError::UnsupportedPlatform)
}

pub fn binary_name_for_os(os: &str) -> &'static str {
    if os == "windows" {
        "ceo-connector.exe"
    } else {
        "ceo-connector"
    }
}

/// Parses `SHA256SUMS` content into `name -> lowercase hex`.
///
/// Accepts both the `<hex>  <name>` text-mode form and the `<hex> *<name>`
/// binary-mode form.
pub fn parse_sha256sums(text: &str) -> HashMap<String, String> {
    let mut sums = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hex) = parts.next() else {
            continue;
        };
        let Some(name) = parts.next() else {
            continue;
        };
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = name.trim_start_matches('*');
        if name.is_empty() {
            continue;
        }
        sums.insert(name.to_string(), hex.to_ascii_lowercase());
    }
    sums
}

pub fn extract_binary(
    asset_name: &str,
    bytes: &[u8],
    binary_name: &str,
) -> Result<Vec<u8>, UpgradeError> {
    if asset_name.ends_with(".tar.gz") {
        extract_from_tar_gz(bytes, binary_name)
    } else if asset_name.ends_with(".zip") {
        extract_from_zip(bytes, binary_name)
    } else {
        Err(UpgradeError::ArchiveInvalid(format!(
            "unsupported archive format: {asset_name}"
        )))
    }
}

fn extract_from_tar_gz(bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, UpgradeError> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
        let matches = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == binary_name)
            .unwrap_or(false);
        if matches {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
            return Ok(buf);
        }
    }
    Err(UpgradeError::ArchiveInvalid(format!(
        "no '{binary_name}' entry in the archive"
    )))
}

fn extract_from_zip(bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, UpgradeError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
        if file.is_dir() {
            continue;
        }
        let matches = std::path::Path::new(file.name())
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == binary_name)
            .unwrap_or(false);
        if matches {
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| UpgradeError::ArchiveInvalid(e.to_string()))?;
            return Ok(buf);
        }
    }
    Err(UpgradeError::ArchiveInvalid(format!(
        "no '{binary_name}' entry in the archive"
    )))
}

pub fn build_http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .expect("failed to build the HTTP client")
}

fn github_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header("User-Agent", format!("ceo-connector/{CURRENT_VERSION}"))
        .header("Accept", "application/vnd.github+json")
}

fn release_assets(
    release: &GithubRelease,
    asset_name: &str,
) -> Result<(String, String), UpgradeError> {
    let mut asset_url = None;
    let mut sums_url = None;
    for asset in &release.assets {
        if asset.name == asset_name {
            asset_url = Some(asset.browser_download_url.clone());
        } else if asset.name == SHA256SUMS_ASSET {
            sums_url = Some(asset.browser_download_url.clone());
        }
    }
    match (asset_url, sums_url) {
        (Some(asset_url), Some(sums_url)) => Ok((asset_url, sums_url)),
        _ => Err(UpgradeError::AssetMissing(release.tag_name.clone())),
    }
}

fn release_info(release: GithubRelease, asset_name: &str) -> Result<ReleaseInfo, UpgradeError> {
    let version = release
        .tag_name
        .strip_prefix(TAG_PREFIX)
        .and_then(parse_semver)
        .ok_or_else(|| UpgradeError::ReleaseLookupFailed(release.tag_name.clone()))?;
    let (asset_url, sums_url) = release_assets(&release, asset_name)?;
    Ok(ReleaseInfo {
        version: format!("{}.{}.{}", version.0, version.1, version.2),
        tag: release.tag_name,
        asset_name: asset_name.to_string(),
        asset_url,
        sums_url,
    })
}

pub async fn resolve_release(
    source: &ReleaseSource,
    http: &reqwest::Client,
    requested: Option<&str>,
    asset_name: &str,
) -> Result<ReleaseInfo, UpgradeError> {
    let api_base = source.api_base.trim_end_matches('/');
    match requested {
        Some(requested) => {
            let parsed = parse_semver(requested)
                .ok_or_else(|| UpgradeError::InvalidVersion(requested.to_string()))?;
            let tag = format!("{}{}.{}.{}", TAG_PREFIX, parsed.0, parsed.1, parsed.2);
            let url = format!("{api_base}/repos/{GITHUB_REPO}/releases/tags/{tag}");
            let response = github_request(http, &url)
                .send()
                .await
                .map_err(|e| UpgradeError::ReleaseLookupFailed(e.to_string()))?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(UpgradeError::VersionNotFound(tag));
            }
            if !response.status().is_success() {
                return Err(UpgradeError::ReleaseLookupFailed(format!(
                    "{url} returned HTTP {}",
                    response.status()
                )));
            }
            let release: GithubRelease = response
                .json()
                .await
                .map_err(|e| UpgradeError::ReleaseLookupFailed(e.to_string()))?;
            release_info(release, asset_name)
        }
        None => {
            let url = format!("{api_base}/repos/{GITHUB_REPO}/releases?per_page=30");
            let response = github_request(http, &url)
                .send()
                .await
                .map_err(|e| UpgradeError::ReleaseLookupFailed(e.to_string()))?;
            if !response.status().is_success() {
                return Err(UpgradeError::ReleaseLookupFailed(format!(
                    "{url} returned HTTP {}",
                    response.status()
                )));
            }
            let releases: Vec<GithubRelease> = response
                .json()
                .await
                .map_err(|e| UpgradeError::ReleaseLookupFailed(e.to_string()))?;
            let mut best: Option<((u64, u64, u64), GithubRelease)> = None;
            for release in releases {
                if release.draft || release.prerelease {
                    continue;
                }
                let Some(version) = release
                    .tag_name
                    .strip_prefix(TAG_PREFIX)
                    .and_then(parse_semver)
                else {
                    continue;
                };
                if best
                    .as_ref()
                    .map(|(current, _)| version > *current)
                    .unwrap_or(true)
                {
                    best = Some((version, release));
                }
            }
            let Some((_, release)) = best else {
                return Err(UpgradeError::ReleaseLookupFailed(
                    "no published connector releases found".into(),
                ));
            };
            release_info(release, asset_name)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_receipt(
    release: &ReleaseInfo,
    target: &InstallTarget,
    daemon_running: bool,
    up_to_date: bool,
    update_available: bool,
    check_only: bool,
    replaced: bool,
    sha256: Option<String>,
) -> UpgradeReceipt {
    UpgradeReceipt {
        current_version: CURRENT_VERSION.to_string(),
        target_version: release.version.clone(),
        tag: release.tag.clone(),
        up_to_date,
        update_available,
        check_only,
        asset: release.asset_name.clone(),
        sha256,
        installed_path: target.exe_path.display().to_string(),
        replaced,
        daemon_running,
        restart_required: replaced && daemon_running,
    }
}

async fn download_bytes(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, UpgradeError> {
    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| UpgradeError::DownloadFailed(e.to_string()))?;
    if !response.status().is_success() {
        return Err(UpgradeError::DownloadFailed(format!(
            "{url} returned HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| UpgradeError::DownloadFailed(e.to_string()))?;
    Ok(bytes.to_vec())
}

async fn download_text(http: &reqwest::Client, url: &str) -> Result<String, UpgradeError> {
    let bytes = download_bytes(http, url).await?;
    String::from_utf8(bytes).map_err(|e| UpgradeError::DownloadFailed(e.to_string()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn target_not_writable(
    detail: impl Into<String>,
    release: &ReleaseInfo,
    target: &InstallTarget,
) -> UpgradeError {
    UpgradeError::TargetNotWritable {
        detail: detail.into(),
        asset_url: release.asset_url.clone(),
        exe_path: target.exe_path.display().to_string(),
    }
}

pub async fn run_upgrade(
    paths: &ConnectorPaths,
    opts: &UpgradeOptions,
    source: &ReleaseSource,
    target: &InstallTarget,
) -> Result<UpgradeReceipt, UpgradeError> {
    let asset = current_platform_asset()?;
    let http = build_http_client(Duration::from_secs(60));
    let release = resolve_release(source, &http, opts.target_version.as_deref(), asset).await?;

    let daemon_running = ExecutionLock::is_locked(&paths.daemon_lock_file());
    if daemon_running && paths.active_attempt_file().exists() && !opts.check_only {
        return Err(UpgradeError::AttemptActive);
    }

    let current = parse_semver(CURRENT_VERSION).expect("CURRENT_VERSION is a valid semver");
    let target_version_value = parse_semver(&release.version)
        .ok_or_else(|| UpgradeError::InvalidVersion(release.version.clone()))?;
    let update_available = target_version_value > current;

    if opts.target_version.is_none() && !update_available {
        return Ok(make_receipt(
            &release,
            target,
            daemon_running,
            true,
            false,
            opts.check_only,
            false,
            None,
        ));
    }

    if opts.check_only {
        return Ok(make_receipt(
            &release,
            target,
            daemon_running,
            !update_available,
            update_available,
            true,
            false,
            None,
        ));
    }

    if !opts.assume_yes {
        if opts.target_version.is_some() && target_version_value < current {
            println!(
                "Warning: downgrading {} -> {}",
                CURRENT_VERSION, release.version
            );
        }
        if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
            print!(
                "Upgrade ceo-connector {} -> {}? [y/N] ",
                CURRENT_VERSION, release.version
            );
            std::io::stdout().flush().ok();
            let mut line = String::new();
            if std::io::stdin().read_line(&mut line).is_err() {
                return Err(UpgradeError::ConfirmationRequired);
            }
            let answer = line.trim();
            if answer != "y" && answer != "Y" {
                println!("Cancelled.");
                return Ok(make_receipt(
                    &release,
                    target,
                    daemon_running,
                    false,
                    update_available,
                    false,
                    false,
                    None,
                ));
            }
        } else {
            return Err(UpgradeError::ConfirmationRequired);
        }
    }

    let sums_text = download_text(&http, &release.sums_url).await?;
    let archive = download_bytes(&http, &release.asset_url).await?;

    let actual_hex = sha256_hex(&archive);
    let expected_hex = parse_sha256sums(&sums_text).remove(asset).ok_or_else(|| {
        UpgradeError::ChecksumMismatch(format!("{asset} is missing from {SHA256SUMS_ASSET}"))
    })?;
    if expected_hex != actual_hex {
        return Err(UpgradeError::ChecksumMismatch(format!(
            "expected {expected_hex}, got {actual_hex}"
        )));
    }

    let binary = extract_binary(asset, &archive, binary_name_for_os(std::env::consts::OS))?;

    let parent = target.exe_path.parent().ok_or_else(|| {
        target_not_writable("the target has no parent directory", &release, target)
    })?;
    let tmp = parent.join(format!(".ceo-connector.upgrade.{}.tmp", std::process::id()));

    let mut file = match std::fs::File::create(&tmp) {
        Ok(file) => file,
        Err(e) => {
            return Err(target_not_writable(
                format!("cannot create '{}': {e}", tmp.display()),
                &release,
                target,
            ));
        }
    };
    if let Err(e) = file.write_all(&binary) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(target_not_writable(
            format!("cannot write '{}': {e}", tmp.display()),
            &release,
            target,
        ));
    }
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(target_not_writable(
                format!("cannot set permissions on '{}': {e}", tmp.display()),
                &release,
                target,
            ));
        }
    }

    if target.verify_new_binary {
        let output = std::process::Command::new(&tmp).arg("--version").output();
        let ok = match &output {
            Ok(out) => {
                out.status.success()
                    && String::from_utf8_lossy(&out.stdout).contains(&release.version)
            }
            Err(_) => false,
        };
        if !ok {
            let _ = std::fs::remove_file(&tmp);
            let detail = match output {
                Ok(out) => format!(
                    "`--version` returned {} and stdout {:?}",
                    out.status,
                    String::from_utf8_lossy(&out.stdout)
                ),
                Err(e) => format!("could not run the downloaded binary: {e}"),
            };
            return Err(UpgradeError::VerifyFailed(detail));
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(e) = std::fs::rename(&tmp, &target.exe_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(target_not_writable(
                format!("cannot replace '{}': {e}", target.exe_path.display()),
                &release,
                target,
            ));
        }
    }

    #[cfg(windows)]
    {
        let old_path = PathBuf::from(format!("{}.old", target.exe_path.display()));
        if let Err(e) = std::fs::rename(&target.exe_path, &old_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(target_not_writable(
                format!("cannot move '{}' aside: {e}", target.exe_path.display()),
                &release,
                target,
            ));
        }
        if let Err(e) = std::fs::rename(&tmp, &target.exe_path) {
            let _ = std::fs::remove_file(&tmp);
            let _ = std::fs::rename(&old_path, &target.exe_path);
            return Err(target_not_writable(
                format!("cannot replace '{}': {e}", target.exe_path.display()),
                &release,
                target,
            ));
        }
        let _ = std::fs::remove_file(&old_path);
    }

    Ok(make_receipt(
        &release,
        target,
        daemon_running,
        false,
        update_available,
        false,
        true,
        Some(actual_hex),
    ))
}
