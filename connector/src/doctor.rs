use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use crate::client::{ConnectorClient, ConnectorTargetProjection};
use crate::config::LocalConfig;
use crate::credential::DeviceCredential;
use crate::paths::{reject_control_ancestor_symlinks, reject_symlink_target, ConnectorPaths};
use crate::targets::verify_local_repository;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticSeverity {
    Pass,
    Warn,
    Fail,
}

impl std::fmt::Display for DiagnosticSeverity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiagnosticSeverity::Pass => write!(f, "PASS"),
            DiagnosticSeverity::Warn => write!(f, "WARN"),
            DiagnosticSeverity::Fail => write!(f, "FAIL"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticCheck {
    pub name: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorReport {
    pub checks: Vec<DiagnosticCheck>,
    pub overall_passed: bool,
}

pub async fn run_doctor(paths: &ConnectorPaths, json_format: bool) -> DoctorReport {
    let mut checks = Vec::new();

    // 1. Filesystem directories and permissions
    check_filesystem(paths, &mut checks);

    // 2. Bound profile & Credential validation & expiry
    let bound_profile = crate::config::load_bound_profile(paths);
    let cred = match bound_profile {
        Ok(profile) => {
            checks.push(DiagnosticCheck {
                name: "Config & Credential Origin".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Bound to origin '{}'", profile.credential.server_origin),
            });
            check_credentials(paths, &mut checks);
            Some(profile.credential)
        }
        Err(crate::config::ProfileError::LocalCredentialServerMismatch { expected, actual }) => {
            checks.push(DiagnosticCheck {
                name: "Config & Credential Origin".into(),
                severity: DiagnosticSeverity::Fail,
                message: format!(
                    "LOCAL_CREDENTIAL_SERVER_MISMATCH: config origin is '{expected}', but credential origin is '{actual}'"
                ),
            });
            check_credentials(paths, &mut checks);
            None
        }
        Err(_) => check_credentials(paths, &mut checks),
    };

    // 3. Git tool & identity
    check_git_tooling(&mut checks);

    // 4. Orca discovery
    check_orca_cli(&mut checks);

    // 5. Server reachability, identity, workspaces, targets
    if let Some(ref c) = cred {
        check_server_integration(paths, c, &mut checks).await;
    } else {
        checks.push(DiagnosticCheck {
            name: "Server Auth Probe".into(),
            severity: DiagnosticSeverity::Fail,
            message: "Cannot probe server: device is not logged in or credential mismatch".into(),
        });
    }

    let overall_passed = !checks
        .iter()
        .any(|c| c.severity == DiagnosticSeverity::Fail);
    let report = DoctorReport {
        checks,
        overall_passed,
    };

    if json_format {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!("============================================================");
        println!("  CEO Connector Doctor");
        println!("============================================================");
        for c in &report.checks {
            let symbol = match c.severity {
                DiagnosticSeverity::Pass => "✓",
                DiagnosticSeverity::Warn => "!",
                DiagnosticSeverity::Fail => "✗",
            };
            println!(
                "  [{}] {:<5} {:<32} {}",
                symbol, c.severity, c.name, c.message
            );
        }
        println!("============================================================");
        if overall_passed {
            println!("  Result: ALL REQUIRED CHECKS PASSED");
        } else {
            println!("  Result: DOCTOR DETECTED ONE OR MORE FAILURES");
        }
        println!("============================================================");
    }

    report
}

fn check_filesystem(paths: &ConnectorPaths, checks: &mut Vec<DiagnosticCheck>) {
    if !paths.config_dir.exists() {
        checks.push(DiagnosticCheck {
            name: "Config Directory".into(),
            severity: DiagnosticSeverity::Fail,
            message: format!(
                "Config directory does not exist: {}",
                paths.config_dir.display()
            ),
        });
    } else {
        let sym_res = reject_control_ancestor_symlinks(&paths.config_dir);
        let mode = fs::metadata(&paths.config_dir)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0);
        if sym_res.is_err() {
            checks.push(DiagnosticCheck {
                name: "Config Directory".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Config directory or ancestor is a symlink".into(),
            });
        } else if mode != 0o700 {
            checks.push(DiagnosticCheck {
                name: "Config Directory".into(),
                severity: DiagnosticSeverity::Warn,
                message: format!("Permissions are 0{:o}, expected 0700", mode),
            });
        } else {
            checks.push(DiagnosticCheck {
                name: "Config Directory".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Valid (0700) at {}", paths.config_dir.display()),
            });
        }
    }

    if !paths.state_dir.exists() {
        checks.push(DiagnosticCheck {
            name: "State Directory".into(),
            severity: DiagnosticSeverity::Fail,
            message: format!(
                "State directory does not exist: {}",
                paths.state_dir.display()
            ),
        });
    } else {
        let sym_res = reject_control_ancestor_symlinks(&paths.state_dir);
        let mode = fs::metadata(&paths.state_dir)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0);
        if sym_res.is_err() {
            checks.push(DiagnosticCheck {
                name: "State Directory".into(),
                severity: DiagnosticSeverity::Fail,
                message: "State directory or ancestor is a symlink".into(),
            });
        } else if mode != 0o700 {
            checks.push(DiagnosticCheck {
                name: "State Directory".into(),
                severity: DiagnosticSeverity::Warn,
                message: format!("Permissions are 0{:o}, expected 0700", mode),
            });
        } else {
            checks.push(DiagnosticCheck {
                name: "State Directory".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Valid (0700) at {}", paths.state_dir.display()),
            });
        }
    }
}

fn check_credentials(
    paths: &ConnectorPaths,
    checks: &mut Vec<DiagnosticCheck>,
) -> Option<DeviceCredential> {
    if !paths.credential_file().exists() {
        checks.push(DiagnosticCheck {
            name: "Device Credential".into(),
            severity: DiagnosticSeverity::Fail,
            message: "Not found. Please run `ceo-connector login`.".into(),
        });
        return None;
    }

    if reject_symlink_target(&paths.credential_file()).is_err() {
        checks.push(DiagnosticCheck {
            name: "Device Credential".into(),
            severity: DiagnosticSeverity::Fail,
            message: "Credential file is a symlink (rejected)".into(),
        });
        return None;
    }

    let mode = fs::metadata(paths.credential_file())
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0);
    if mode != 0o600 {
        checks.push(DiagnosticCheck {
            name: "Credential Permissions".into(),
            severity: DiagnosticSeverity::Warn,
            message: format!("Permissions are 0{:o}, expected 0600", mode),
        });
    }

    match DeviceCredential::load(&paths.credential_file()) {
        Ok(Some(cred)) => {
            let now = chrono::Utc::now().timestamp_millis();
            if cred.is_expired(now) {
                checks.push(DiagnosticCheck {
                    name: "Credential Expiry".into(),
                    severity: DiagnosticSeverity::Fail,
                    message: "Credential has expired. Please run `ceo-connector login`.".into(),
                });
            } else if cred.expires_at_ms - now < 7 * 86400 * 1000 {
                checks.push(DiagnosticCheck {
                    name: "Credential Expiry".into(),
                    severity: DiagnosticSeverity::Warn,
                    message: "Credential expires in less than 7 days".to_string(),
                });
            } else {
                checks.push(DiagnosticCheck {
                    name: "Credential Expiry".into(),
                    severity: DiagnosticSeverity::Pass,
                    message: "Valid and unexpired".into(),
                });
            }
            Some(cred)
        }
        Ok(None) => {
            checks.push(DiagnosticCheck {
                name: "Device Credential".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Missing credential".into(),
            });
            None
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Device Credential".into(),
                severity: DiagnosticSeverity::Fail,
                message: format!("Invalid credential format: {e}"),
            });
            None
        }
    }
}

fn check_git_tooling(checks: &mut Vec<DiagnosticCheck>) {
    let git_version = Command::new("git").arg("--version").output();
    match git_version {
        Ok(output) if output.status.success() => {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            checks.push(DiagnosticCheck {
                name: "Git Executable".into(),
                severity: DiagnosticSeverity::Pass,
                message: ver,
            });
        }
        _ => {
            checks.push(DiagnosticCheck {
                name: "Git Executable".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Git is not installed or not in PATH".into(),
            });
        }
    }

    let user_name = Command::new("git").args(["config", "user.name"]).output();
    let user_email = Command::new("git").args(["config", "user.email"]).output();

    let has_name = user_name.map(|o| !o.stdout.is_empty()).unwrap_or(false);
    let has_email = user_email.map(|o| !o.stdout.is_empty()).unwrap_or(false);

    if has_name && has_email {
        checks.push(DiagnosticCheck {
            name: "Git User Identity".into(),
            severity: DiagnosticSeverity::Pass,
            message: "user.name and user.email configured".into(),
        });
    } else {
        checks.push(DiagnosticCheck {
            name: "Git User Identity".into(),
            severity: DiagnosticSeverity::Warn,
            message: "user.name or user.email not configured in git".into(),
        });
    }
}

fn check_orca_cli(checks: &mut Vec<DiagnosticCheck>) {
    let orca_version = Command::new("orca").arg("--version").output();
    match orca_version {
        Ok(output) if output.status.success() => {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            checks.push(DiagnosticCheck {
                name: "Orca CLI Executable".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Detected version {ver}"),
            });
        }
        _ => {
            checks.push(DiagnosticCheck {
                name: "Orca CLI Executable".into(),
                severity: DiagnosticSeverity::Warn,
                message: "Orca CLI not found in PATH (required for V1.7 execution)".into(),
            });
        }
    }
}

async fn check_server_integration(
    paths: &ConnectorPaths,
    cred: &DeviceCredential,
    checks: &mut Vec<DiagnosticCheck>,
) {
    let client = match ConnectorClient::new(&cred.server_origin) {
        Ok(c) => c,
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Server Origin".into(),
                severity: DiagnosticSeverity::Fail,
                message: format!("Invalid origin: {e}"),
            });
            return;
        }
    };

    // 1. Identity probe
    match client.identity(cred).await {
        Ok(ident) => {
            checks.push(DiagnosticCheck {
                name: "Server Identity Auth".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!(
                    "Authenticated as device '{}' (user '{}')",
                    ident.device.id, ident.user_id
                ),
            });
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Server Identity Auth".into(),
                severity: DiagnosticSeverity::Fail,
                message: format!("Failed to authenticate with server: {e}"),
            });
            return;
        }
    }

    // 2. Workspaces probe
    match client.list_workspaces(cred).await {
        Ok(ws) => {
            checks.push(DiagnosticCheck {
                name: "Workspace Discovery".into(),
                severity: DiagnosticSeverity::Pass,
                message: format!("Discovered {} workspace(s)", ws.len()),
            });
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Workspace Discovery".into(),
                severity: DiagnosticSeverity::Warn,
                message: format!("Workspace discovery failed: {e}"),
            });
        }
    }

    // 3. Targets catalogue & reconciliation
    let config = LocalConfig::load(&paths.config_file()).ok().flatten();
    let local_targets = config.as_ref().map(|c| &c.targets);

    match client.list_targets(cred, None).await {
        Ok(server_targets) => {
            let mut server_map: BTreeMap<String, ConnectorTargetProjection> = BTreeMap::new();
            for st in server_targets {
                server_map.insert(st.target_id.clone(), st);
            }

            if let Some(lt_map) = local_targets {
                let mut path_seen = std::collections::HashMap::new();

                for (tid, lt) in lt_map {
                    let p = Path::new(&lt.local_path);
                    if !p.exists() || !p.is_dir() {
                        checks.push(DiagnosticCheck {
                            name: format!("Target '{}' Path", lt.alias),
                            severity: DiagnosticSeverity::Fail,
                            message: format!("Local path '{}' does not exist", lt.local_path),
                        });
                    } else {
                        // Check duplicate local path warning
                        if let Some(other_alias) =
                            path_seen.insert(lt.local_path.clone(), lt.alias.clone())
                        {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Duplicate Path", lt.alias),
                                severity: DiagnosticSeverity::Warn,
                                message: format!(
                                    "Shares path with target '{}' (permitted)",
                                    other_alias
                                ),
                            });
                        }
                    }

                    if let Some(st) = server_map.get(tid) {
                        if st.disabled {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Status", lt.alias),
                                severity: DiagnosticSeverity::Fail,
                                message: "Target is disabled on server".into(),
                            });
                        } else if st
                            .this_device_binding
                            .as_ref()
                            .map(|b| !b.enabled)
                            .unwrap_or(true)
                        {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Binding", lt.alias),
                                severity: DiagnosticSeverity::Fail,
                                message: "Device is not actively bound to this target on server"
                                    .into(),
                            });
                        } else if let Some(ref repo) = st.repository {
                            if p.is_dir() {
                                if let Err(e) = verify_local_repository(p, repo) {
                                    checks.push(DiagnosticCheck {
                                        name: format!("Target '{}' Repo Match", lt.alias),
                                        severity: DiagnosticSeverity::Fail,
                                        message: format!("{e}"),
                                    });
                                } else {
                                    checks.push(DiagnosticCheck {
                                        name: format!("Target '{}'", lt.alias),
                                        severity: DiagnosticSeverity::Pass,
                                        message: format!(
                                            "Healthy, bound, and repository matches '{}'",
                                            repo.full_name
                                        ),
                                    });
                                }
                            }
                        } else {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}'", lt.alias),
                                severity: DiagnosticSeverity::Pass,
                                message: "Healthy and bound on server".into(),
                            });
                        }
                    } else {
                        checks.push(DiagnosticCheck {
                            name: format!("Target '{}' Server Sync", lt.alias),
                            severity: DiagnosticSeverity::Warn,
                            message: "Locally mapped target not found on server".into(),
                        });
                    }
                }
            }
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Target Query".into(),
                severity: DiagnosticSeverity::Warn,
                message: format!("Failed to query targets: {e}"),
            });
        }
    }
}
