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
    #[error("Target '{0}' not found. Use an exact target alias (case-sensitive, as shown by `ceo-connector target list`) or an exact target ID; partial or fuzzy matches are not accepted.")]
    TargetNotFound(String),
    #[error(
        "Target selector '{0}' is ambiguous: it matches both a target ID and another target's alias (SELECTOR_AMBIGUOUS). Use the full target ID or a distinct alias."
    )]
    AmbiguousSelector(String),
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
    /// Server-authoritative alias. `None` when the Server catalogue cannot
    /// supply it (e.g. a locally-mapped target absent from the catalogue);
    /// local state never fabricates Server-owned names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Server-authoritative Target kind; `None` when unknown locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
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
    /// Optional per-target model override (omitted when no override is set,
    /// matching the Option-field JSON convention used by agent_id/command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
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
    verify_local_repo_full_name(path, &expected_repo.full_name)
}

/// Verifies that `path` is an existing directory, that it is the top-level of a Git repository,
/// and that its `origin` remote normalizes to `expected_full_name` (e.g. "owner/repo").
///
/// Shared by `verify_local_repository` and the setup application services
/// (which verify a repository by full name without any Server repository
/// metadata, e.g. the canonical CEO Agent Runtime repository).
pub fn verify_local_repo_full_name(
    path: &Path,
    expected_full_name: &str,
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

    let expected_normalized = expected_full_name.to_lowercase();
    let actual_normalized = normalized.to_lowercase();

    if expected_normalized != actual_normalized {
        return Err(TargetError::RepositoryMismatch {
            expected: expected_full_name.to_string(),
            actual: normalized,
        });
    }

    Ok(())
}

/// Fail-fast local guard: refuses when `target_id` is currently in use by an
/// active attempt (TARGET_IN_USE). Shared by target management commands and
/// the setup application services (which re-check it under `state.lock`
/// before any local config mutation).
pub fn check_active_attempt_target_in_use(
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

// ---------------------------------------------------------------------------
// Exact Target selector resolution (shared application service)
// ---------------------------------------------------------------------------

/// Outcome of resolving an exact Target selector against the
/// server-authoritative catalogue. `projection` is `None` only when the
/// selector was accepted as a direct target_id via the local device config
/// (offline/direct-ID fallback for local-only commands); the Server catalogue
/// is the only authority for aliases.
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub target_id: String,
    pub projection: Option<crate::client::ConnectorTargetProjection>,
}

fn local_config_has_target(paths: &ConnectorPaths, target_id: &str) -> Result<bool, TargetError> {
    let config = crate::config::LocalConfig::load(&paths.config_file())?;
    Ok(config
        .map(|c| c.targets.contains_key(target_id))
        .unwrap_or(false))
}

/// Resolves a selector that is either an exact immutable target_id or an
/// exact server-authoritative Target alias in the authenticated workspace
/// catalogue.
///
/// Contract (PROJECT-036 Slice 1A + 1B):
/// - exact target_id remains supported (raw ID for scripts/debugging);
/// - otherwise the selector must exactly equal a Server alias — no substring,
///   prefix, fuzzy, or case-insensitive matching;
/// - the Server catalogue decides alias truth; local schema-v3 config stores
///   no alias at all, so aliases can never resolve from local cache;
/// - an ID-vs-alias ambiguity referring to different Targets fails closed;
/// - unknown selectors fail with an actionable error;
/// - when the Server catalogue is unreachable (or the device is not logged
///   in), a direct target_id already known to this device keeps working so
///   existing local-only direct-ID behavior is preserved; aliases never
///   resolve from local cache.
pub async fn resolve_target_selector(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    cred: &crate::credential::DeviceCredential,
    selector: &str,
) -> Result<ResolvedTarget, TargetError> {
    let trimmed = selector.trim();
    if trimmed.is_empty() {
        return Err(TargetError::TargetNotFound(selector.to_string()));
    }

    // Matching is strict: the selector string must exactly equal an immutable
    // target_id or a server alias (no trimming/case folding/fuzzy matching).
    let catalogue = client.list_targets(cred, None).await;
    match catalogue {
        Ok(targets) => resolve_selector_from_catalogue(paths, &targets, selector),
        Err(client_err) => {
            // Server catalogue unavailable: fall back to direct-ID only.
            if local_config_has_target(paths, selector)? {
                return Ok(ResolvedTarget {
                    target_id: selector.to_string(),
                    projection: None,
                });
            }
            Err(TargetError::Client(client_err))
        }
    }
}

/// Pure catalogue-based resolution, split out for unit testing.
pub fn resolve_selector_from_catalogue(
    paths: &ConnectorPaths,
    targets: &[crate::client::ConnectorTargetProjection],
    selector: &str,
) -> Result<ResolvedTarget, TargetError> {
    // 1. Exact immutable target_id match wins.
    if let Some(by_id) = targets.iter().find(|t| t.target_id == selector) {
        // Fail closed if the same string is also another target's exact alias.
        let ambiguous = targets
            .iter()
            .any(|t| t.target_id != by_id.target_id && t.alias == selector);
        if ambiguous {
            return Err(TargetError::AmbiguousSelector(selector.to_string()));
        }
        return Ok(ResolvedTarget {
            target_id: by_id.target_id.clone(),
            projection: Some(by_id.clone()),
        });
    }

    // 2. Exact server-authoritative alias match (case-sensitive, whole string).
    let alias_matches: Vec<&crate::client::ConnectorTargetProjection> =
        targets.iter().filter(|t| t.alias == selector).collect();
    match alias_matches.len() {
        1 => {
            let t = alias_matches[0];
            Ok(ResolvedTarget {
                target_id: t.target_id.clone(),
                projection: Some(t.clone()),
            })
        }
        0 => {
            // Direct-ID fallback for local-only targets known to this device
            // (e.g. server catalogue does not include this device's mapping).
            if local_config_has_target(paths, selector)? {
                return Ok(ResolvedTarget {
                    target_id: selector.to_string(),
                    projection: None,
                });
            }
            Err(TargetError::TargetNotFound(selector.to_string()))
        }
        _ => Err(TargetError::AmbiguousSelector(selector.to_string())),
    }
}

/// Builds a client + credential when the device is logged in; `None` when no
/// credential exists (local-only direct-ID behavior is then preserved).
fn try_load_client(
    paths: &ConnectorPaths,
) -> Result<Option<(ConnectorClient, crate::credential::DeviceCredential)>, TargetError> {
    if !paths.credential_file().exists() {
        return Ok(None);
    }
    let profile = crate::config::load_bound_profile(paths)?;
    let client = ConnectorClient::new(&profile.credential.server_origin)?;
    Ok(Some((client, profile.credential)))
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

    // Atomically update local config: only Device-owned v3 fields are stored
    // locally. Alias/kind/workspace live solely in the Server catalogue.
    config.targets.insert(
        res.target.id.clone(),
        LocalTarget {
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
    target_selector: &str,
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
    // Fail-fast local guard on the raw selector (works even when the server
    // catalogue is unreachable); re-checked against the resolved immutable ID.
    check_active_attempt_target_in_use(paths, target_selector)?;

    // Exact selector resolution (alias or target_id) against the server
    // catalogue; bind always needs the server projection.
    let resolved = resolve_target_selector(paths, &client, &cred, target_selector).await?;
    if resolved.projection.is_none() {
        return Err(TargetError::TargetNotFound(target_selector.to_string()));
    }
    let target_id = resolved.target_id;
    check_active_attempt_target_in_use(paths, &target_id)?;

    // Bind on server
    client.bind_target(&cred, &target_id).await?;

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
        // Only Device-owned v3 fields are stored locally; alias/kind/
        // workspace stay Server-owned (read from the fresh projection above).
        LocalTarget {
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
    target_selector: &str,
    agent_id: &str,
    agent_command: &str,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let executor_cfg =
        crate::config::LocalExecutorConfig::new(agent_id.to_string(), agent_command.to_string())?;

    // Exact selector resolution: server catalogue when logged in (alias
    // authority lives on the server); otherwise fall back to direct target_id
    // only, preserving legacy offline direct-ID behavior.
    let target_id = match try_load_client(paths)? {
        Some((client, cred)) => {
            resolve_target_selector(paths, &client, &cred, target_selector)
                .await?
                .target_id
        }
        None => target_selector.to_string(),
    };

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
    check_active_attempt_target_in_use(paths, &target_id)?;

    let mut config = crate::config::LocalConfig::load(&paths.config_file())?
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    let target = config
        .targets
        .get_mut(&target_id)
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    // Preserve any existing model override: `set-agent` re-configures the
    // agent_id/command but must not accidentally clear the model override.
    let preserved_model = target.executor.as_ref().and_then(|e| e.model.clone());
    let executor_cfg = if let Some(model) = preserved_model {
        crate::config::LocalExecutorConfig::new_with_model(
            agent_id.to_string(),
            agent_command.to_string(),
            Some(model),
        )?
    } else {
        executor_cfg
    };
    target.executor = Some(executor_cfg);
    config.save(&paths.config_file())?;

    println!(
        "Target '{}' agent executor updated: agent_id='{}', command='{}'.",
        target_id, agent_id, agent_command
    );
    Ok(())
}

/// Sets or clears the optional per-target model override (local executor
/// policy). `None` for `model` clears the override; the agent_id/command are
/// always preserved. Refuses mutation while the target is in an active
/// attempt (TARGET_IN_USE), consistent with `target_set_agent`.
pub async fn target_set_model(
    paths: &ConnectorPaths,
    target_selector: &str,
    model: Option<&str>,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;

    // Exact selector resolution: server catalogue when logged in (alias
    // authority lives on the server); otherwise fall back to direct target_id
    // only, preserving legacy offline direct-ID behavior.
    let target_id = match try_load_client(paths)? {
        Some((client, cred)) => {
            resolve_target_selector(paths, &client, &cred, target_selector)
                .await?
                .target_id
        }
        None => target_selector.to_string(),
    };

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
    check_active_attempt_target_in_use(paths, &target_id)?;

    let mut config = crate::config::LocalConfig::load(&paths.config_file())?
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    let target = config
        .targets
        .get_mut(&target_id)
        .ok_or_else(|| TargetError::TargetNotFound(target_id.to_string()))?;

    let executor = target.executor.as_mut().ok_or_else(|| {
        TargetError::Config(crate::config::ConfigError::InvalidExecutor(format!(
            "target '{target_id}' has no agent executor configured; run `ceo-connector target set-agent --target-id {target_id} --agent-id <id> --agent-command <command>` first"
        )))
    })?;

    executor.model = model.map(|m| m.to_string());
    executor.validate()?;
    config.save(&paths.config_file())?;

    match model {
        Some(m) => println!(
            "Target '{}' model override set to '{}' (applies to newly launched executions).",
            target_id, m
        ),
        None => println!(
            "Target '{}' model override cleared; the agent will use its default model.",
            target_id
        ),
    }
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
        // Alias/kind are Server-owned: when the catalogue cannot supply them
        // (e.g. LOCAL_ONLY targets) they render as unknown, never fabricated.
        push_line(
            &mut out,
            0,
            &format!("Target: {}", item.alias.as_deref().unwrap_or("<unknown>")),
        );
        push_field(&mut out, 2, "ID", &item.target_id);
        push_field(
            &mut out,
            2,
            "Kind",
            item.kind.as_deref().unwrap_or("<unknown>"),
        );
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
        match &item.model {
            Some(model) => push_line(&mut out, 2, &format!("Model: {model}")),
            None => push_line(&mut out, 2, "Model: <default>"),
        }
        push_line(&mut out, 0, "");
    }
    out
}

/// Builds the merged target display projection (server catalogue + local
/// config), including the workspace default Agent Runtime marker. Exposed
/// separately from `target_list` so the projection is testable without
/// capturing stdout.
///
/// Authority split (PROJECT-036 Slice 1B): alias/kind/repository/disabled/
/// binding/default-runtime come ONLY from the Server catalogue; local_path/
/// executor/model come ONLY from the v3 local config, merged by immutable
/// target_id. A logged-in device that cannot obtain the Server catalogue
/// fails clearly instead of rendering stale/fabricated Server-owned metadata.
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
            schema_version: crate::config::CONFIG_SCHEMA_VERSION,
            server_url: "".into(),
            targets: BTreeMap::new(),
        });
        (cfg, None)
    };

    let server_targets: Vec<ConnectorTargetProjection> = if let Some(ref c) = cred {
        let client = ConnectorClient::new(&c.server_origin)?;
        // Fail clearly on Server-unavailable: do not silently render an
        // empty catalogue or fabricate Server-owned fields from local state.
        client.list_targets(c, None).await?
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
                alias: Some(st.alias),
                kind: Some(st.kind),
                local_path: Some(lt.local_path.clone()),
                status,
                disabled: st.disabled,
                is_default_agent_runtime: st.is_default_agent_runtime,
                active_binding_count: st.active_binding_count,
                repository: st.repository.map(|r| r.full_name),
                agent_id: lt.executor.as_ref().map(|e| e.agent_id.clone()),
                agent_command: lt.executor.as_ref().map(|e| e.command.clone()),
                model: lt.executor.as_ref().and_then(|e| e.model.clone()),
            });
        } else {
            // Locally mapped but absent from the fetched Server catalogue.
            // v3 local state carries no alias/kind and never fabricates
            // Server-owned metadata: they are rendered as unknown.
            let status = if !path_exists {
                "PATH_MISSING".into()
            } else {
                "LOCAL_ONLY".into()
            };

            display_items.push(TargetDisplayItem {
                target_id: tid.clone(),
                alias: None,
                kind: None,
                local_path: Some(lt.local_path.clone()),
                status,
                disabled: false,
                is_default_agent_runtime: false,
                active_binding_count: 0,
                repository: None,
                agent_id: lt.executor.as_ref().map(|e| e.agent_id.clone()),
                agent_command: lt.executor.as_ref().map(|e| e.command.clone()),
                model: lt.executor.as_ref().and_then(|e| e.model.clone()),
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
            alias: Some(st.alias),
            kind: Some(st.kind),
            local_path: None,
            status,
            disabled: st.disabled,
            is_default_agent_runtime: st.is_default_agent_runtime,
            active_binding_count: st.active_binding_count,
            repository: st.repository.map(|r| r.full_name),
            agent_id: None,
            agent_command: None,
            model: None,
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
    target_selector: &str,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    // Exact selector resolution (alias or target_id); this is a server
    // mutation, so the server projection is required.
    let resolved = resolve_target_selector(paths, &client, &cred, target_selector).await?;
    if resolved.projection.is_none() {
        return Err(TargetError::TargetNotFound(target_selector.to_string()));
    }
    let target_id = resolved.target_id;

    let res = client.set_default_runtime_target(&cred, &target_id).await?;

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

/// Renames a Target's human alias on the Server. The current selector may be
/// an exact alias or an exact immutable target_id; it is resolved via the
/// shared exact selector service and the rename is sent for the immutable
/// target_id (never a delete/recreate). Human output is name-oriented; raw
/// IDs appear only in `--json` diagnostics.
pub async fn target_rename(
    paths: &ConnectorPaths,
    target_selector: &str,
    new_alias: &str,
    json_format: bool,
) -> Result<(), TargetError> {
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let resolved = resolve_target_selector(paths, &client, &cred, target_selector).await?;
    if resolved.projection.is_none() {
        return Err(TargetError::TargetNotFound(target_selector.to_string()));
    }

    let res = client
        .rename_target(&cred, &resolved.target_id, new_alias)
        .await?;

    if json_format {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "target_id": res.target_id,
                "previous_alias": res.previous_alias,
                "alias": res.alias,
                "replayed": res.replayed,
                "updated_at_ms": res.updated_at_ms,
            }))
            .unwrap()
        );
    } else if res.replayed {
        println!(
            "Target '{}' already has alias '{}'; nothing changed.",
            res.previous_alias, res.alias
        );
    } else {
        println!(
            "Target '{}' renamed to '{}'.",
            res.previous_alias, res.alias
        );
    }
    Ok(())
}
