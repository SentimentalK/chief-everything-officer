use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

use crate::client::{
    ClientError, ConnectorClient, ConnectorTargetProjection, RegisterTargetInput,
    RegisterTargetRepoSource, TargetRepositoryPart,
};
use crate::config::{ConfigError, LocalConfig, LocalTarget};
use crate::credential::CredentialError;
use crate::local_state::ExecutionLock;
use crate::paths::ConnectorPaths;
use crate::render::{push_field, push_line};

#[derive(Error, Debug)]
pub enum TargetError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("Path '{0}' does not exist or is not a directory")]
    PathNotFound(String),
    #[error("Git error: {0}")]
    GitError(String),
    #[error("Target repository mismatch: expected '{expected}', but local git remote origin is '{actual}' (TARGET_REPOSITORY_MISMATCH)")]
    RepositoryMismatch { expected: String, actual: String },
    #[error("Workspace '{0}' not found or missing repository binding")]
    WorkspaceNotFound(String),
    #[error("Target '{0}' not found on server")]
    TargetNotFound(String),
    #[error("Target '{0}' is currently in use by active attempt (TARGET_IN_USE)")]
    TargetInUse(String),
    #[error("Target '{0}' is disabled on server (TARGET_DISABLED)")]
    TargetDisabled(String),
    #[error("Target '{0}' device binding is not active on server")]
    TargetBindingInactive(String),
    #[error("Device not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
    #[error("Local credential server mismatch: config origin is '{expected}', but credential origin is '{actual}' (LOCAL_CREDENTIAL_SERVER_MISMATCH)")]
    LocalCredentialServerMismatch { expected: String, actual: String },
    #[error("Profile or state lock is currently busy. Please retry shortly. (PROFILE_BUSY)")]
    ProfileBusy,
}

impl From<crate::config::ProfileError> for TargetError {
    fn from(err: crate::config::ProfileError) -> Self {
        match err {
            crate::config::ProfileError::NotLoggedIn => TargetError::NotLoggedIn,
            crate::config::ProfileError::ConfigNotFound => TargetError::NotLoggedIn,
            crate::config::ProfileError::LocalCredentialServerMismatch { expected, actual } => {
                TargetError::LocalCredentialServerMismatch { expected, actual }
            }
            crate::config::ProfileError::Config(e) => TargetError::Config(e),
            crate::config::ProfileError::Credential(e) => TargetError::Credential(e),
            crate::config::ProfileError::Io(e) => TargetError::Io(e),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetDisplayItem {
    pub target_id: String,
    pub alias: String,
    pub kind: String,
    pub local_path: Option<String>,
    pub status: String,
    pub disabled: bool,
    pub is_default_agent_runtime: bool,
    pub active_binding_count: u32,
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_command: Option<String>,
}

/// Normalizes a GitHub remote URL (HTTPS or SSH) into an `owner/repo` string.
/// Examples:
/// - https://github.com/owner/repo.git -> owner/repo
/// - https://github.com/owner/repo -> owner/repo
/// - git@github.com:owner/repo.git -> owner/repo
/// - ssh://git@github.com/owner/repo.git -> owner/repo
pub fn normalize_github_remote(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    if let Some(rest) = without_git.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    } else if let Some(rest) = without_git.strip_prefix("http://github.com/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    } else if let Some(rest) = without_git.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    } else if let Some(rest) = without_git.strip_prefix("ssh://git@github.com/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    }

    None
}

/// Verifies that `path` is an existing directory, that it is the top-level of a Git repository,
/// and that its `origin` remote matches the expected `owner/repo`.
pub fn verify_local_repository(
    path: &Path,
    expected_repo: &TargetRepositoryPart,
) -> Result<(), TargetError> {
    if !path.is_dir() {
        return Err(TargetError::PathNotFound(path.display().to_string()));
    }

    let canonical = fs::canonicalize(path)?;

    // 1. git rev-parse --show-toplevel
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .current_dir(&canonical)
        .output()
        .map_err(|e| TargetError::GitError(format!("Failed to execute git: {e}")))?;

    if !output.status.success() {
        return Err(TargetError::GitError(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let toplevel_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let toplevel_path = fs::canonicalize(Path::new(&toplevel_str))?;

    if canonical != toplevel_path {
        return Err(TargetError::GitError(format!(
            "Directory '{}' is not the repository top-level ('{}')",
            canonical.display(),
            toplevel_path.display()
        )));
    }

    // 2. git remote get-url origin
    let remote_output = Command::new("git")
        .arg("remote")
        .arg("get-url")
        .arg("origin")
        .current_dir(&canonical)
        .output()
        .map_err(|e| TargetError::GitError(format!("Failed to get git remote: {e}")))?;

    if !remote_output.status.success() {
        return Err(TargetError::GitError(
            "No 'origin' remote found in local git repository".into(),
        ));
    }

    let remote_url = String::from_utf8_lossy(&remote_output.stdout)
        .trim()
        .to_string();
    let normalized = normalize_github_remote(&remote_url).unwrap_or_else(|| remote_url.clone());

    let expected_normalized = expected_repo.full_name.to_lowercase();
    let actual_normalized = normalized.to_lowercase();

    if expected_normalized != actual_normalized {
        return Err(TargetError::RepositoryMismatch {
            expected: expected_repo.full_name.clone(),
            actual: normalized,
        });
    }

    Ok(())
}

fn check_active_attempt_target_in_use(
    paths: &ConnectorPaths,
    target_id: &str,
) -> Result<(), TargetError> {
    if paths.active_attempt_file().exists() {
        if let Ok(content) = fs::read_to_string(paths.active_attempt_file()) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(active_tid) = val.get("target_id").and_then(|v| v.as_str()) {
                    if active_tid == target_id {
                        return Err(TargetError::TargetInUse(target_id.to_string()));
                    }
                }
            }
        }
    }
    Ok(())
}

fn resolve_executor_args(
    agent_id: Option<String>,
    agent_command: Option<String>,
) -> Result<Option<crate::config::LocalExecutorConfig>, TargetError> {
    match (agent_id, agent_command) {
        (Some(aid), Some(cmd)) => {
            let cfg = crate::config::LocalExecutorConfig::new(aid, cmd)?;
            Ok(Some(cfg))
        }
        (None, None) => Ok(None),
        _ => Err(TargetError::Config(
            crate::config::ConfigError::InvalidExecutor(
                "Both --agent-id and --agent-command must be provided together".into(),
            ),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn target_add(
    paths: &ConnectorPaths,
    workspace_id: &str,
    alias: &str,
    display_name: &str,
    kind: &str,
    path_input: &str,
    use_workspace_repository: bool,
    agent_id: Option<String>,
    agent_command: Option<String>,
) -> Result<(), TargetError> {
    let executor = resolve_executor_args(agent_id, agent_command)?;
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let mut config = profile.config;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let local_path = PathBuf::from(path_input);
    if !local_path.exists() || !local_path.is_dir() {
        return Err(TargetError::PathNotFound(path_input.to_string()));
    }
    let canonical_path = fs::canonicalize(&local_path)?;
    let canonical_str = canonical_path.to_string_lossy().to_string();

    let repo_source = if kind == "coding" && use_workspace_repository {
        // Preflight repository check against Workspace
        let workspaces = client.list_workspaces(&cred).await?;
        let ws = workspaces
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| TargetError::WorkspaceNotFound(workspace_id.to_string()))?;

        let ws_repo = ws.workspace_repository.ok_or_else(|| {
            TargetError::WorkspaceNotFound(format!(
                "Workspace '{workspace_id}' has no backing repository"
            ))
        })?;

        let repo_part = TargetRepositoryPart {
            provider: ws_repo.provider,
            external_id: ws_repo.external_id,
            full_name: ws_repo.full_name,
        };
        verify_local_repository(&canonical_path, &repo_part)?;

        Some(RegisterTargetRepoSource {
            source: "workspace_repository".into(),
        })
    } else {
        None
    };

    let input = RegisterTargetInput {
        workspace_id: workspace_id.to_string(),
        alias: alias.to_string(),
        display_name: display_name.to_string(),
        kind: kind.to_string(),
        repository: repo_source,
    };

    // Acquire state.lock with bounded retry
    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(TargetError::ProfileBusy)
        }
        Err(e) => return Err(TargetError::Io(e)),
    };

    let res = client.register_target(&cred, &input).await?;

    // Post-register authoritative validation against returned target projection (closes TOCTOU)
    if let Some(ref target_repo) = res.target.repository {
        verify_local_repository(&canonical_path, target_repo)?;
    }

    // Atomically update local config
    config.targets.insert(
        res.target.id.clone(),
        LocalTarget {
            workspace_id: res.target.workspace_id,
            alias: res.target.alias,
            kind: res.target.kind,
            local_path: canonical_str,
            executor,
        },
    );

    config.save(&paths.config_file())?;

    println!(
        "Target '{}' ({}) successfully registered and mapped to '{}'.",
        res.target.id,
        alias,
        canonical_path.display()
    );
    Ok(())
}

pub async fn target_bind(
    paths: &ConnectorPaths,
    target_id: &str,
    path_input: &str,
    agent_id: Option<String>,
    agent_command: Option<String>,
) -> Result<(), TargetError> {
    let executor = resolve_executor_args(agent_id, agent_command)?;
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let mut config = profile.config;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let local_path = PathBuf::from(path_input);
    if !local_path.exists() || !local_path.is_dir() {
        return Err(TargetError::PathNotFound(path_input.to_string()));
    }
    let canonical_path = fs::canonicalize(&local_path)?;
    let canonical_str = canonical_path.to_string_lossy().to_string();

    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(TargetError::ProfileBusy)
        }
        Err(e) => return Err(TargetError::Io(e)),
    };
    check_active_attempt_target_in_use(paths, target_id)?;

    // Bind on server
    client.bind_target(&cred, target_id).await?;

    // Authoritative verification after bind
    let targets = client.list_targets(&cred, None).await?;
    let target = targets
        .into_iter()
        .find(|t| t.target_id == target_id)
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    if target.disabled {
        return Err(TargetError::TargetDisabled(target_id.to_string()));
    }

    if let Some(ref repo) = target.repository {
        verify_local_repository(&canonical_path, repo)?;
    }

    config.targets.insert(
        target_id.to_string(),
        LocalTarget {
            workspace_id: target.workspace_id,
            alias: target.alias,
            kind: target.kind,
            local_path: canonical_str,
            executor,
        },
    );

    config.save(&paths.config_file())?;
    println!(
        "Target '{}' successfully bound and mapped to '{}'.",
        target_id,
        canonical_path.display()
    );
    Ok(())
}

pub async fn target_set_agent(
    paths: &ConnectorPaths,
    target_id: &str,
    agent_id: &str,
    agent_command: &str,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let executor_cfg =
        crate::config::LocalExecutorConfig::new(agent_id.to_string(), agent_command.to_string())?;

    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(TargetError::ProfileBusy)
        }
        Err(e) => return Err(TargetError::Io(e)),
    };
    check_active_attempt_target_in_use(paths, target_id)?;

    let mut config = crate::config::LocalConfig::load(&paths.config_file())?
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    let target = config
        .targets
        .get_mut(target_id)
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    target.executor = Some(executor_cfg);
    config.save(&paths.config_file())?;

    println!(
        "Target '{}' agent executor updated: agent_id='{}', command='{}'.",
        target_id, agent_id, agent_command
    );
    Ok(())
}

pub async fn target_remove(paths: &ConnectorPaths, target_id: &str) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let mut config = profile.config;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(TargetError::ProfileBusy)
        }
        Err(e) => return Err(TargetError::Io(e)),
    };
    check_active_attempt_target_in_use(paths, target_id)?;

    // Unbind on server first
    client.unbind_target(&cred, target_id).await?;

    // Then update local config
    if config.targets.remove(target_id).is_some() {
        config.save(&paths.config_file())?;
    }

    println!("Target '{}' binding removed.", target_id);
    Ok(())
}

pub async fn target_list(paths: &ConnectorPaths, json_format: bool) -> Result<(), TargetError> {
    let display_items = build_target_display_items(paths).await?;

    if json_format {
        println!("{}", serde_json::to_string_pretty(&display_items).unwrap());
    } else {
        print!("{}", render_target_blocks(&display_items));
    }

    Ok(())
}

/// Renders target list human output as vertical blocks (one block per
/// target). Long UUIDs, paths, and agent commands each get their own line;
/// no fixed-width table alignment is used.
pub fn render_target_blocks(items: &[TargetDisplayItem]) -> String {
    if items.is_empty() {
        return "No targets configured.\n".to_string();
    }

    let mut out = String::new();
    for item in items {
        push_line(&mut out, 0, &format!("Target: {}", item.alias));
        push_field(&mut out, 2, "ID", &item.target_id);
        push_field(&mut out, 2, "Kind", &item.kind);
        push_field(&mut out, 2, "Status", &item.status);
        push_field(
            &mut out,
            2,
            "Default runtime",
            if item.is_default_agent_runtime {
                "yes"
            } else {
                "no"
            },
        );
        match &item.local_path {
            Some(path) => push_field(&mut out, 2, "Path", path),
            None => push_field(&mut out, 2, "Path", "<not bound locally>"),
        }
        match &item.repository {
            Some(repo) => push_field(&mut out, 2, "Repository", repo),
            None => push_line(&mut out, 2, "Repository: <none>"),
        }
        push_field(
            &mut out,
            2,
            "Active bindings",
            &item.active_binding_count.to_string(),
        );
        match (&item.agent_id, &item.agent_command) {
            (Some(id), Some(cmd)) => {
                push_line(&mut out, 2, &format!("Agent: {id}"));
                push_field(&mut out, 2, "Command", cmd);
            }
            _ => push_line(&mut out, 2, "Agent: <not configured>"),
        }
        push_line(&mut out, 0, "");
    }
    out
}

/// Builds the merged target display projection (server catalogue + local
/// config), including the workspace default Agent Runtime marker. Exposed
/// separately from `target_list` so the projection is testable without
/// capturing stdout.
pub async fn build_target_display_items(
    paths: &ConnectorPaths,
) -> Result<Vec<TargetDisplayItem>, TargetError> {
    let bound_profile = if paths.credential_file().exists() {
        Some(crate::config::load_bound_profile(paths)?)
    } else {
        None
    };

    let (config, cred) = if let Some(p) = bound_profile {
        (p.config, Some(p.credential))
    } else {
        let cfg = LocalConfig::load(&paths.config_file())?.unwrap_or_else(|| LocalConfig {
            schema_version: 1,
            server_url: "".into(),
            targets: BTreeMap::new(),
        });
        (cfg, None)
    };

    let server_targets: Vec<ConnectorTargetProjection> = if let Some(ref c) = cred {
        let client = ConnectorClient::new(&c.server_origin)?;
        client.list_targets(c, None).await.unwrap_or_default()
    } else {
        vec![]
    };

    let mut display_items: Vec<TargetDisplayItem> = Vec::new();

    // Index server targets by target_id
    let mut server_map: BTreeMap<String, ConnectorTargetProjection> = BTreeMap::new();
    for st in server_targets {
        server_map.insert(st.target_id.clone(), st);
    }

    // Process local config targets
    for (tid, lt) in &config.targets {
        let p = Path::new(&lt.local_path);
        let path_exists = p.exists() && p.is_dir();

        if let Some(st) = server_map.remove(tid) {
            let mut status = "READY".to_string();

            if st.disabled {
                status = "TARGET_DISABLED".into();
            } else if st
                .this_device_binding
                .as_ref()
                .map(|b| !b.enabled)
                .unwrap_or(true)
            {
                status = "UNBOUND".into();
            } else if !path_exists {
                status = "PATH_MISSING".into();
            } else if let Some(ref repo) = st.repository {
                if verify_local_repository(p, repo).is_err() {
                    status = "REPOSITORY_MISMATCH".into();
                }
            }

            display_items.push(TargetDisplayItem {
                target_id: tid.clone(),
                alias: st.alias,
                kind: st.kind,
                local_path: Some(lt.local_path.clone()),
                status,
                disabled: st.disabled,
                is_default_agent_runtime: st.is_default_agent_runtime,
                active_binding_count: st.active_binding_count,
                repository: st.repository.map(|r| r.full_name),
                agent_id: lt.executor.as_ref().map(|e| e.agent_id.clone()),
                agent_command: lt.executor.as_ref().map(|e| e.command.clone()),
            });
        } else {
            let status = if !path_exists {
                "PATH_MISSING".into()
            } else {
                "LOCAL_ONLY".into()
            };

            display_items.push(TargetDisplayItem {
                target_id: tid.clone(),
                alias: lt.alias.clone(),
                kind: lt.kind.clone(),
                local_path: Some(lt.local_path.clone()),
                status,
                disabled: false,
                is_default_agent_runtime: false,
                active_binding_count: 0,
                repository: None,
                agent_id: lt.executor.as_ref().map(|e| e.agent_id.clone()),
                agent_command: lt.executor.as_ref().map(|e| e.command.clone()),
            });
        }
    }

    // Any remaining server targets not mapped locally
    for (tid, st) in server_map {
        let status = if st
            .this_device_binding
            .as_ref()
            .map(|b| b.enabled)
            .unwrap_or(false)
        {
            "SERVER_BOUND_NOT_LOCAL".to_string()
        } else {
            "UNBOUND".to_string()
        };

        display_items.push(TargetDisplayItem {
            target_id: tid,
            alias: st.alias,
            kind: st.kind,
            local_path: None,
            status,
            disabled: st.disabled,
            is_default_agent_runtime: st.is_default_agent_runtime,
            active_binding_count: st.active_binding_count,
            repository: st.repository.map(|r| r.full_name),
            agent_id: None,
            agent_command: None,
        });
    }

    Ok(display_items)
}

/// Sets the workspace-scoped default Agent Runtime Target via the Server
/// control plane (DeviceAuth). The server derives the target's workspace and
/// enforces workspace-owner permission; no local config field is an
/// authority for this routing state.
pub async fn target_set_default_runtime(
    paths: &ConnectorPaths,
    target_id: &str,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let res = client.set_default_runtime_target(&cred, target_id).await?;

    println!(
        "Target '{}' set as the default Agent Runtime target for workspace '{}'.{}",
        res.target_id,
        res.workspace_id,
        if res.replayed {
            " (already the default; replayed)"
        } else {
            ""
        }
    );
    Ok(())
}
