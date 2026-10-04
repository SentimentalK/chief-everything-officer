use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use crate::client::{ConnectorClient, ConnectorTargetProjection};
use crate::credential::DeviceCredential;
use crate::paths::{reject_control_ancestor_symlinks, reject_symlink_target, ConnectorPaths};
use crate::platform::{diagnose_dir_privacy, diagnose_file_privacy, PrivacyStatus};
use crate::render::{push_field, push_line};
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
    run_doctor_with_orca(
        paths,
        json_format,
        crate::orca::client::OrcaCliClient::default(),
    )
    .await
}

pub async fn run_doctor_with_orca(
    paths: &ConnectorPaths,
    json_format: bool,
    orca_client: crate::orca::client::OrcaCliClient,
) -> DoctorReport {
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

    // 4. Orca discovery and runtime status
    check_orca_cli(&orca_client, &mut checks).await;

    // 5. Server reachability, identity, workspaces, targets
    if let Some(ref c) = cred {
        check_server_integration(paths, c, &orca_client, &mut checks).await;
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
        print!("{}", render_doctor_human(&report));
    }

    report
}

/// Renders doctor human output as vertical blocks. Each check's name and
/// message live on separate lines so long paths/IDs never break layout;
/// no fixed-width table alignment is used.
pub fn render_doctor_human(report: &DoctorReport) -> String {
    let mut out = String::new();
    push_line(&mut out, 0, "CEO Connector Doctor");
    for c in &report.checks {
        push_line(&mut out, 2, &format!("[{}] {}", c.severity, c.name));
        push_field(&mut out, 4, "Message", &c.message);
    }
    if report.overall_passed {
        push_line(&mut out, 0, "Result: ALL REQUIRED CHECKS PASSED");
    } else {
        push_line(&mut out, 0, "Result: DOCTOR DETECTED ONE OR MORE FAILURES");
    }
    out
}

fn check_filesystem(paths: &ConnectorPaths, checks: &mut Vec<DiagnosticCheck>) {
    if !paths.root_dir.exists() {
        checks.push(DiagnosticCheck {
            name: "Connector Root".into(),
            severity: DiagnosticSeverity::Fail,
            message: format!(
                "Connector root does not exist (run `ceo-connector login` or any command that initializes it): {}",
                paths.root_dir.display()
            ),
        });
    } else {
        let sym_res = reject_control_ancestor_symlinks(&paths.root_dir);
        if sym_res.is_err() {
            checks.push(DiagnosticCheck {
                name: "Connector Root".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Connector root or ancestor is a symlink".into(),
            });
        } else {
            match diagnose_dir_privacy(&paths.root_dir) {
                Ok(PrivacyStatus::Private { detail }) => checks.push(DiagnosticCheck {
                    name: "Connector Root".into(),
                    severity: DiagnosticSeverity::Pass,
                    message: format!("Valid ({detail}) at {}", paths.root_dir.display()),
                }),
                Ok(PrivacyStatus::Exposed { detail }) => checks.push(DiagnosticCheck {
                    name: "Connector Root".into(),
                    severity: DiagnosticSeverity::Warn,
                    message: detail,
                }),
                Err(e) => checks.push(DiagnosticCheck {
                    name: "Connector Root".into(),
                    severity: DiagnosticSeverity::Warn,
                    message: format!("Could not verify directory privacy: {e}"),
                }),
            }
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

    match diagnose_file_privacy(&paths.credential_file()) {
        Ok(PrivacyStatus::Private { .. }) => {}
        Ok(PrivacyStatus::Exposed { detail }) => {
            checks.push(DiagnosticCheck {
                name: "Credential Permissions".into(),
                severity: DiagnosticSeverity::Warn,
                message: detail,
            });
        }
        Err(e) => {
            checks.push(DiagnosticCheck {
                name: "Credential Permissions".into(),
                severity: DiagnosticSeverity::Warn,
                message: format!("Could not verify credential file privacy: {e}"),
            });
        }
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

async fn check_orca_cli(
    client: &crate::orca::client::OrcaCliClient,
    checks: &mut Vec<DiagnosticCheck>,
) {
    match client.status().await {
        Ok(status) if status.ok => {
            if let Some(res) = status.result {
                let ver = res.runtime.app_version.unwrap_or_else(|| "unknown".into());
                let app_running = res.app.running;
                let runtime_state = res.runtime.state;
                if app_running && runtime_state == "ready" {
                    checks.push(DiagnosticCheck {
                        name: "Orca CLI & Runtime".into(),
                        severity: DiagnosticSeverity::Pass,
                        message: format!("Version {ver}, desktop app running, runtime ready"),
                    });
                } else if app_running {
                    checks.push(DiagnosticCheck {
                        name: "Orca CLI & Runtime".into(),
                        severity: DiagnosticSeverity::Fail,
                        message: format!(
                            "Version {ver}, desktop app running, runtime state: {runtime_state} (expected 'ready')"
                        ),
                    });
                } else {
                    checks.push(DiagnosticCheck {
                        name: "Orca CLI & Runtime".into(),
                        severity: DiagnosticSeverity::Fail,
                        message: format!(
                            "Version {ver}, desktop app not running (start Orca before running daemon)"
                        ),
                    });
                }
            } else {
                checks.push(DiagnosticCheck {
                    name: "Orca CLI & Runtime".into(),
                    severity: DiagnosticSeverity::Pass,
                    message: "Orca CLI status ok".into(),
                });
            }
        }
        Ok(_) => {
            checks.push(DiagnosticCheck {
                name: "Orca CLI & Runtime".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Orca status reported ok=false".into(),
            });
        }
        Err(crate::orca::client::OrcaError::Io(err))
            if err.kind() == std::io::ErrorKind::NotFound =>
        {
            checks.push(DiagnosticCheck {
                name: "Orca CLI & Runtime".into(),
                severity: DiagnosticSeverity::Fail,
                message: "Orca CLI not found in PATH (required for execution)".into(),
            });
        }
        Err(e) => {
            let ver = Command::new("orca").arg("--version").output();
            if let Ok(out) = ver {
                if out.status.success() {
                    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    checks.push(DiagnosticCheck {
                        name: "Orca CLI & Runtime".into(),
                        severity: DiagnosticSeverity::Fail,
                        message: format!("Detected {v}, but status probe failed: {e}"),
                    });
                    return;
                }
            }
            checks.push(DiagnosticCheck {
                name: "Orca CLI & Runtime".into(),
                severity: DiagnosticSeverity::Fail,
                message: format!("Orca CLI probe failed: {e}"),
            });
        }
    }
}

async fn check_server_integration(
    paths: &ConnectorPaths,
    cred: &DeviceCredential,
    orca_client: &crate::orca::client::OrcaCliClient,
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
    let config = crate::config::load_current_config(paths).ok().flatten();
    let local_targets = config.as_ref().map(|c| &c.targets);

    match client.list_targets(cred, None).await {
        Ok(server_targets) => {
            let mut server_map: BTreeMap<String, ConnectorTargetProjection> = BTreeMap::new();
            for st in server_targets {
                server_map.insert(st.target_id.clone(), st);
            }

            if let Some(lt_map) = local_targets {
                let mut path_seen = std::collections::HashMap::new();

                // Human-facing display name: prefer the Server-authoritative
                // alias so no check name or next-step command ever requires a
                // raw target ID. The raw target_id remains in --json/debug
                // data (it is part of the stable advanced output).
                let display_name = |tid: &str| -> String {
                    server_map
                        .get(tid)
                        .map(|t| t.alias.clone())
                        .unwrap_or_else(|| tid.to_string())
                };

                for (tid, lt) in lt_map {
                    let display = display_name(tid);
                    let p = Path::new(&lt.local_path);
                    if !p.exists() || !p.is_dir() {
                        checks.push(DiagnosticCheck {
                            name: format!("Target '{}' Path", display),
                            severity: DiagnosticSeverity::Fail,
                            message: format!("Local path '{}' does not exist", lt.local_path),
                        });
                    } else {
                        // Check duplicate local path warning
                        if let Some(other_tid) =
                            path_seen.insert(lt.local_path.clone(), tid.clone())
                        {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Duplicate Path", display),
                                severity: DiagnosticSeverity::Warn,
                                message: format!(
                                    "Shares path with target '{}' (permitted)",
                                    display_name(&other_tid)
                                ),
                            });
                        }
                    }

                    if let Some(st) = server_map.get(tid) {
                        if st.disabled {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Status", display),
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
                                name: format!("Target '{}' Binding", display),
                                severity: DiagnosticSeverity::Fail,
                                message: "Device is not actively bound to this target on server"
                                    .into(),
                            });
                        } else if let Some(ref repo) = st.repository {
                            if p.is_dir() {
                                if let Err(e) = verify_local_repository(p, repo) {
                                    checks.push(DiagnosticCheck {
                                        name: format!("Target '{}' Repo Match", display),
                                        severity: DiagnosticSeverity::Fail,
                                        message: format!("{e}"),
                                    });
                                } else {
                                    checks.push(DiagnosticCheck {
                                        name: format!("Target '{}'", display),
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
                                name: format!("Target '{}'", display),
                                severity: DiagnosticSeverity::Pass,
                                message: "Healthy and bound on server".into(),
                            });
                        }
                    } else {
                        checks.push(DiagnosticCheck {
                            name: format!("Target '{}' Server Sync", display),
                            severity: DiagnosticSeverity::Warn,
                            message: "Locally mapped target not found on server".into(),
                        });
                    }

                    match &lt.executor {
                        Some(exec) => {
                            if let Err(e) = exec.validate() {
                                checks.push(DiagnosticCheck {
                                    name: format!("Target '{}' Executor Configuration", display),
                                    severity: DiagnosticSeverity::Fail,
                                    message: format!("Invalid executor configuration: {e}"),
                                });
                            } else {
                                checks.push(DiagnosticCheck {
                                    name: format!("Target '{}' Executor Configuration", display),
                                    severity: DiagnosticSeverity::Pass,
                                    message: {
                                        let cmd_suffix = match &exec.command {
                                            Some(c) => format!(" ({c})"),
                                            None => String::new(),
                                        };
                                        match &exec.model {
                                            Some(m) => format!(
                                                "Configured for agent '{}'{cmd_suffix} with model override '{}'",
                                                exec.agent_id, m
                                            ),
                                            None => format!(
                                                "Configured for agent '{}'{cmd_suffix}",
                                                exec.agent_id
                                            ),
                                        }
                                    },
                                });

                                if let Some(cmd) = &exec.command {
                                    let agent_found = find_in_path(cmd);
                                    if agent_found {
                                        checks.push(DiagnosticCheck {
                                            name: format!(
                                                "Target '{}' Agent Availability",
                                                display
                                            ),
                                            severity: DiagnosticSeverity::Pass,
                                            message: "Agent executable found in PATH".to_string(),
                                        });
                                    } else {
                                        checks.push(DiagnosticCheck {
                                            name: format!(
                                                "Target '{}' Agent Availability",
                                                display
                                            ),
                                            severity: DiagnosticSeverity::Warn,
                                            message: "Agent executable not found in PATH"
                                                .to_string(),
                                        });
                                    }
                                } else {
                                    // Shared admission policy (PROJECT-039
                                    // slice): the daemon refuses to claim
                                    // logical-only executors when the
                                    // installed Orca lacks the Agent-aware
                                    // launch surface; surface the same verdict
                                    // as a Doctor FAIL.
                                    let compatible = crate::execution_admission::evaluate_executor_compatibility(
                                        Some(exec),
                                        Some(orca_client),
                                    )
                                    .await;
                                    match compatible {
                                        Ok(()) => checks.push(DiagnosticCheck {
                                            name: format!("Target '{}' Agent Launch Surface", display),
                                            severity: DiagnosticSeverity::Pass,
                                            message: format!("Orca supports orchestration Agent launch for '{}'", exec.agent_id),
                                        }),
                                        Err(crate::execution_admission::ExecutionCompatibility::AgentLaunchUnavailable { .. }) => {
                                            checks.push(DiagnosticCheck {
                                                 name: format!("Target '{}' Agent Launch Compatibility", display),
                                                 severity: DiagnosticSeverity::Fail,
                                                 message: crate::execution_admission::ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE.to_string() + ": installed Orca version does not expose the required orchestration Agent launch surface required by Connector",
                                             });
                                        }
                                        Err(other) => {
                                            checks.push(DiagnosticCheck {
                                                name: format!("Target '{}' Agent Launch Compatibility", display),
                                                severity: DiagnosticSeverity::Fail,
                                                message: other.to_string(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        None => {
                            checks.push(DiagnosticCheck {
                                name: format!("Target '{}' Executor Configuration", display),
                                severity: DiagnosticSeverity::Fail,
                                message: format!(
                                    "No agent executor configured. Configure one with `ceo-connector target set-agent --target-id {} --agent-id <id>`",
                                    display
                                ),
                            });
                        }
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

/// Doctor's agent availability probe. Thin delegate to the shared
/// cross-platform executable discovery (Windows PATHEXT-aware; no shell).
fn find_in_path(cmd: &str) -> bool {
    crate::setup_frontend::executable_in_path(cmd)
}
