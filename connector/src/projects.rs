use serde::{Deserialize, Serialize};
use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

use crate::client::{ClientError, ConnectorClient};
use crate::config::{ConfigError, LocalConfig, LocalExecutorConfig, LocalTarget};
use crate::credential::CredentialError;
use crate::local_state::ExecutionLock;
use crate::orca::discovery::{AgentDiscovery, OrcaCliAgentDiscovery};
use crate::paths::ConnectorPaths;
use crate::setup::{
    ensure_binding_step, ensure_server_target, resolve_current_workspace, SetupError,
};
use crate::targets::{
    build_target_display_items, check_active_attempt_target_in_use, resolve_target_selector,
    target_remove, target_rename, target_set_default_runtime, TargetDisplayItem, TargetError,
};

#[derive(Error, Debug)]
pub enum ProjectError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("Target error: {0}")]
    Target(#[from] TargetError),
    #[error("Setup error: {0}")]
    Setup(#[from] SetupError),
    #[error("Path '{0}' does not exist or is not a directory")]
    PathNotFound(String),
    #[error("Directory '{0}' is not a Git repository. Ordinary projects must be initialized with Git prior to adding.")]
    NotGitRepo(String),
    #[error("Directory '{actual}' is not the root of the Git repository ('{expected}'). Ordinary projects must be added at repository root.")]
    NotRepoRoot { expected: String, actual: String },
    #[error("Git error: {0}")]
    GitError(String),
    #[error("Could not infer project name from Git remote or directory. Please specify --name.")]
    CannotInferName,
    #[error("Project '{0}' not found. Use an exact project alias, display name, or target ID.")]
    ProjectNotFound(String),
    #[error("Project selector '{0}' is ambiguous: matches multiple projects. Use the full target ID or distinct alias.")]
    AmbiguousSelector(String),
    #[error("{0}")]
    InteractiveRequired(String),
    #[error("Orca agent discovery failed: {0}")]
    OrcaDiscovery(String),
    #[error("Device not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
}

impl From<crate::config::ProfileError> for ProjectError {
    fn from(err: crate::config::ProfileError) -> Self {
        match err {
            crate::config::ProfileError::NotLoggedIn => ProjectError::NotLoggedIn,
            crate::config::ProfileError::ConfigNotFound => ProjectError::NotLoggedIn,
            crate::config::ProfileError::LocalCredentialServerMismatch { expected, actual } => {
                ProjectError::Target(TargetError::LocalCredentialServerMismatch {
                    expected,
                    actual,
                })
            }
            crate::config::ProfileError::Config(e) => ProjectError::Config(e),
            crate::config::ProfileError::Credential(e) => ProjectError::Credential(e),
            crate::config::ProfileError::Io(e) => ProjectError::Io(e),
        }
    }
}

pub fn is_tty() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

// ---------------------------------------------------------------------------
// Project Display Items & Rendering
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDisplayItem {
    pub target_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
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
    pub model: Option<String>,
}

impl From<TargetDisplayItem> for ProjectDisplayItem {
    fn from(t: TargetDisplayItem) -> Self {
        let name = t
            .display_name
            .clone()
            .or_else(|| t.alias.clone())
            .unwrap_or_else(|| t.target_id.clone());
        Self {
            target_id: t.target_id,
            name,
            alias: t.alias,
            kind: t.kind,
            local_path: t.local_path,
            status: t.status,
            disabled: t.disabled,
            is_default_agent_runtime: t.is_default_agent_runtime,
            active_binding_count: t.active_binding_count,
            repository: t.repository,
            agent_id: t.agent_id,
            model: t.model,
        }
    }
}

pub async fn build_project_display_items(
    paths: &ConnectorPaths,
) -> Result<Vec<ProjectDisplayItem>, ProjectError> {
    let target_items = build_target_display_items(paths).await?;
    Ok(target_items.into_iter().map(Into::into).collect())
}

fn color_status(status: &str, is_tty: bool) -> String {
    if !is_tty {
        return status.to_string();
    }
    match status {
        "READY" => format!("\x1b[32m{status}\x1b[0m"), // Green
        "PATH_MISSING" | "UNBOUND" | "REPOSITORY_MISMATCH" | "SERVER_BOUND_NOT_LOCAL" => {
            format!("\x1b[33m{status}\x1b[0m") // Yellow
        }
        "TARGET_DISABLED" | "LOCAL_ONLY" => format!("\x1b[31m{status}\x1b[0m"), // Red
        _ => status.to_string(),
    }
}

fn bold(text: &str, is_tty: bool) -> String {
    if !is_tty {
        text.to_string()
    } else {
        format!("\x1b[1m{text}\x1b[0m")
    }
}

/// Renders human project list output as a vertical tree/block structure.
/// - Display Name/title is first.
/// - Raw target IDs (tgt_*) are HIDDEN in normal list output.
/// - Restrained ANSI color when is_tty is true; zero ANSI when false.
pub fn render_project_list(items: &[ProjectDisplayItem], is_tty: bool) -> String {
    if items.is_empty() {
        return "No projects configured.\n".to_string();
    }

    let mut out = String::new();
    for item in items {
        let title_suffix = if item.is_default_agent_runtime {
            " (default runtime)"
        } else {
            ""
        };
        let title = format!("Project: {}{}", item.name, title_suffix);
        out.push_str(&bold(&title, is_tty));
        out.push('\n');

        if let Some(alias) = &item.alias {
            out.push_str(&format!("  Alias:      {alias}\n"));
        }
        if let Some(kind) = &item.kind {
            out.push_str(&format!("  Kind:       {kind}\n"));
        }
        out.push_str(&format!(
            "  Status:     {}\n",
            color_status(&item.status, is_tty)
        ));
        match &item.local_path {
            Some(path) => out.push_str(&format!("  Path:       {path}\n")),
            None => out.push_str("  Path:       <not bound locally>\n"),
        }
        match &item.repository {
            Some(repo) => out.push_str(&format!("  Repository: {repo}\n")),
            None => out.push_str("  Repository: <none>\n"),
        }
        match &item.agent_id {
            Some(agent) => out.push_str(&format!("  Agent:      {agent}\n")),
            None => out.push_str("  Agent:      <not configured>\n"),
        }
        match &item.model {
            Some(model) => out.push_str(&format!("  Model:      {model}\n")),
            None => out.push_str("  Model:      <default>\n"),
        }
        out.push('\n');
    }
    out
}

/// Renders single project detailed view.
/// Exposes target_id and active bindings.
pub fn render_project_show(item: &ProjectDisplayItem, is_tty: bool) -> String {
    let mut out = String::new();
    let title_suffix = if item.is_default_agent_runtime {
        " (default runtime)"
    } else {
        ""
    };
    let title = format!("Project: {}{}", item.name, title_suffix);
    out.push_str(&bold(&title, is_tty));
    out.push('\n');

    out.push_str(&format!("  ID:              {}\n", item.target_id));
    if let Some(alias) = &item.alias {
        out.push_str(&format!("  Alias:           {alias}\n"));
    }
    if let Some(kind) = &item.kind {
        out.push_str(&format!("  Kind:            {kind}\n"));
    }
    out.push_str(&format!(
        "  Status:          {}\n",
        color_status(&item.status, is_tty)
    ));
    out.push_str(&format!(
        "  Default runtime: {}\n",
        if item.is_default_agent_runtime {
            "yes"
        } else {
            "no"
        }
    ));
    out.push_str(&format!(
        "  Active bindings: {}\n",
        item.active_binding_count
    ));
    match &item.local_path {
        Some(path) => out.push_str(&format!("  Path:            {path}\n")),
        None => out.push_str("  Path:            <not bound locally>\n"),
    }
    match &item.repository {
        Some(repo) => out.push_str(&format!("  Repository:      {repo}\n")),
        None => out.push_str("  Repository:      <none>\n"),
    }
    match &item.agent_id {
        Some(agent) => out.push_str(&format!("  Agent:           {agent}\n")),
        None => out.push_str("  Agent:           <not configured>\n"),
    }
    match &item.model {
        Some(model) => out.push_str(&format!("  Model:           {model}\n")),
        None => out.push_str("  Model:           <default>\n"),
    }
    out
}

// ---------------------------------------------------------------------------
// Git & Name Validation
// ---------------------------------------------------------------------------

pub fn validate_git_repository(path: &Path) -> Result<PathBuf, ProjectError> {
    if !path.exists() || !path.is_dir() {
        return Err(ProjectError::PathNotFound(path.display().to_string()));
    }
    let canonical = fs::canonicalize(path)?;

    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .current_dir(&canonical)
        .output()
        .map_err(|e| ProjectError::GitError(format!("Failed to execute git: {e}")))?;

    if !output.status.success() {
        return Err(ProjectError::NotGitRepo(canonical.display().to_string()));
    }

    let toplevel_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let toplevel = fs::canonicalize(Path::new(&toplevel_str))?;

    if canonical != toplevel {
        return Err(ProjectError::NotRepoRoot {
            expected: toplevel.display().to_string(),
            actual: canonical.display().to_string(),
        });
    }

    Ok(canonical)
}

pub fn infer_project_name(path: &Path) -> Result<String, ProjectError> {
    // 1. Try git remote get-url origin
    if let Ok(output) = Command::new("git")
        .arg("remote")
        .arg("get-url")
        .arg("origin")
        .current_dir(path)
        .output()
    {
        if output.status.success() {
            let remote_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !remote_url.is_empty() {
                let stripped = remote_url
                    .trim_end_matches('/')
                    .strip_suffix(".git")
                    .unwrap_or(&remote_url);
                if let Some(pos) = stripped.rfind(['/', ':']) {
                    let base = &stripped[pos + 1..];
                    if !base.is_empty() {
                        let sanitized = sanitize_name(base);
                        if !sanitized.is_empty() {
                            return Ok(sanitized);
                        }
                    }
                }
            }
        }
    }

    // 2. Fall back to Git-root directory basename
    if let Some(fname) = path.file_name() {
        let name_str = fname.to_string_lossy();
        let sanitized = sanitize_name(&name_str);
        if !sanitized.is_empty() {
            return Ok(sanitized);
        }
    }

    Err(ProjectError::CannotInferName)
}

fn sanitize_name(name: &str) -> String {
    name.trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Agent Selection
// ---------------------------------------------------------------------------

pub async fn resolve_agent_choice(
    agent_arg: Option<&str>,
    interactive: bool,
) -> Result<Option<String>, ProjectError> {
    match agent_arg {
        None => Ok(None),
        Some("") => {
            // Flag --agent passed without a value
            if !interactive {
                return Err(ProjectError::InteractiveRequired(
                    "--agent without a value requires an interactive terminal. Provide an explicit agent ID, e.g. `--agent codex` or `--agent auto`.".into(),
                ));
            }
            let client = crate::orca::client::OrcaCliClient::default();
            let discovery = OrcaCliAgentDiscovery::new(&client);
            let mut known = discovery
                .discover_agents()
                .await
                .map_err(ProjectError::OrcaDiscovery)?;

            let mut options = vec!["auto (follow Orca default policy)".to_string()];
            options.append(&mut known);

            let answer = inquire::Select::new("Select execution agent for this project:", options)
                .with_starting_cursor(0)
                .prompt()
                .map_err(|e| ProjectError::InteractiveRequired(e.to_string()))?;

            if answer.starts_with("auto") {
                Ok(Some("auto".to_string()))
            } else {
                Ok(Some(answer))
            }
        }
        Some("auto") => Ok(Some("auto".to_string())),
        Some(explicit) => {
            let clean = explicit.trim().to_lowercase();
            // Validate explicit agent against Orca discovery when available
            let client = crate::orca::client::OrcaCliClient::default();
            let discovery = OrcaCliAgentDiscovery::new(&client);
            match discovery.discover_agents().await {
                Ok(known) => {
                    if !known.iter().any(|k| k.to_lowercase() == clean) {
                        return Err(ProjectError::Config(ConfigError::InvalidExecutor(format!(
                            "unknown or unsupported agent '{explicit}'. Orca known agents: {}",
                            known.join(", ")
                        ))));
                    }
                    Ok(Some(clean))
                }
                Err(e) => {
                    // Escape hatch when Orca discovery is unavailable
                    eprintln!("Warning: Orca agent discovery unavailable ({e}); proceeding with explicit agent '{explicit}'.");
                    Ok(Some(clean))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands Implementation
// ---------------------------------------------------------------------------

pub async fn project_add(
    paths: &ConnectorPaths,
    path_arg: Option<&str>,
    name_override: Option<&str>,
    agent_arg: Option<&str>,
    model_arg: Option<&str>,
) -> Result<(), ProjectError> {
    paths.ensure_dirs()?;

    // 1. Resolve path (default to current directory)
    let raw_path = path_arg.unwrap_or(".");
    let canonical_path = validate_git_repository(Path::new(raw_path))?;
    let canonical_str = canonical_path.to_string_lossy().to_string();

    // 2. Infer or take name override
    let project_name = match name_override {
        Some(name) => {
            let s = sanitize_name(name);
            if s.is_empty() {
                return Err(ProjectError::CannotInferName);
            }
            s
        }
        None => infer_project_name(&canonical_path)?,
    };

    // 3. Server mutation: ensure Server Target exists and bind to device
    let interactive = is_tty();
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let ws = resolve_current_workspace(&client, &cred).await?;
    let catalogue = client.list_targets(&cred, Some(&ws.id)).await?;

    let ensured = ensure_server_target(
        &client,
        &cred,
        &ws.id,
        &catalogue,
        &project_name,
        &project_name,
    )
    .await?;

    // Check active attempt
    check_active_attempt_target_in_use(paths, &ensured.target_id)?;

    // Ensure device binding
    let _ = ensure_binding_step(&client, &cred, &ensured).await?;

    // 4. Update local config
    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(ProjectError::Target(TargetError::ProfileBusy))
        }
        Err(e) => return Err(ProjectError::Io(e)),
    };

    let mut config = LocalConfig::load(&paths.config_file())?.unwrap_or_else(|| LocalConfig {
        schema_version: crate::config::CONFIG_SCHEMA_VERSION,
        server_url: cred.server_origin.clone(),
        targets: std::collections::BTreeMap::new(),
    });

    let existing_target = config.targets.get(&ensured.target_id);
    let existing_executor = existing_target.and_then(|t| t.executor.clone());

    let final_executor = match (agent_arg, model_arg) {
        (None, None) => {
            // Idempotency: re-running project add with no --agent/--model preserves
            // existing executor/model exactly!
            existing_executor
        }
        _ => {
            let requested_agent = resolve_agent_choice(agent_arg, interactive).await?;
            let current_agent = existing_executor.as_ref().map(|e| e.agent_id.clone());
            let current_model = existing_executor.as_ref().and_then(|e| e.model.clone());

            let effective_agent = match requested_agent {
                Some(a) => Some(a),
                None => current_agent,
            };

            let effective_agent = match effective_agent {
                Some(a) => a,
                None => {
                    return Err(ProjectError::Config(ConfigError::InvalidExecutor(
                        "--model requires an execution agent. Supply --agent <id> or configure an agent first.".into()
                    )));
                }
            };

            let effective_model = match model_arg {
                Some("auto") => None,
                Some(m) => Some(m.trim().to_string()),
                None => {
                    if LocalExecutorConfig::agent_supports_model_override(&effective_agent) {
                        current_model
                    } else {
                        None
                    }
                }
            };

            if effective_model.is_some()
                && !LocalExecutorConfig::agent_supports_model_override(&effective_agent)
            {
                return Err(ProjectError::Config(ConfigError::InvalidExecutor(format!(
                    "model override is not supported for agent '{effective_agent}'"
                ))));
            }

            let exec = LocalExecutorConfig::new_logical(effective_agent, effective_model)?;
            exec.validate()?;
            Some(exec)
        }
    };

    config.targets.insert(
        ensured.target_id.clone(),
        LocalTarget {
            local_path: canonical_str.clone(),
            executor: final_executor,
        },
    );
    config.save(&paths.config_file())?;

    println!("Project '{project_name}' added at '{canonical_str}'.");
    Ok(())
}

pub async fn project_list(paths: &ConnectorPaths, json_format: bool) -> Result<(), ProjectError> {
    let items = build_project_display_items(paths).await?;
    if json_format {
        println!("{}", serde_json::to_string_pretty(&items)?);
    } else {
        print!("{}", render_project_list(&items, is_tty()));
    }
    Ok(())
}

pub async fn project_show(
    paths: &ConnectorPaths,
    selector: &str,
    json_format: bool,
) -> Result<(), ProjectError> {
    let items = build_project_display_items(paths).await?;

    // Match exact target_id, exact alias, or exact name
    let by_id: Vec<&ProjectDisplayItem> =
        items.iter().filter(|i| i.target_id == selector).collect();
    let by_alias: Vec<&ProjectDisplayItem> = items
        .iter()
        .filter(|i| i.alias.as_deref() == Some(selector))
        .collect();
    let by_name: Vec<&ProjectDisplayItem> = items.iter().filter(|i| i.name == selector).collect();

    let matched = if by_id.len() == 1 {
        by_id[0]
    } else if by_alias.len() == 1 {
        by_alias[0]
    } else if by_name.len() == 1 {
        by_name[0]
    } else if by_id.len() > 1 || by_alias.len() > 1 || by_name.len() > 1 {
        return Err(ProjectError::AmbiguousSelector(selector.to_string()));
    } else {
        return Err(ProjectError::ProjectNotFound(selector.to_string()));
    };

    if json_format {
        println!("{}", serde_json::to_string_pretty(&matched)?);
    } else {
        print!("{}", render_project_show(matched, is_tty()));
    }
    Ok(())
}

pub async fn project_set(
    paths: &ConnectorPaths,
    selector: &str,
    path_arg: Option<&str>,
    agent_arg: Option<&str>,
    model_arg: Option<&str>,
) -> Result<(), ProjectError> {
    if path_arg.is_none() && agent_arg.is_none() && model_arg.is_none() {
        return Err(ProjectError::InteractiveRequired(
            "At least one of --path, --agent, or --model must be provided to `project set`.".into(),
        ));
    }

    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let resolved = resolve_target_selector(paths, &client, &cred, selector).await?;
    let target_id = resolved.target_id;

    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        std::time::Duration::from_secs(3),
        std::time::Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(ProjectError::Target(TargetError::ProfileBusy))
        }
        Err(e) => return Err(ProjectError::Io(e)),
    };
    check_active_attempt_target_in_use(paths, &target_id)?;

    let mut config = LocalConfig::load(&paths.config_file())?
        .ok_or_else(|| ProjectError::ProjectNotFound(target_id.clone()))?;

    let target = config
        .targets
        .get_mut(&target_id)
        .ok_or_else(|| ProjectError::ProjectNotFound(target_id.clone()))?;

    if let Some(new_path) = path_arg {
        let canonical = validate_git_repository(Path::new(new_path))?;
        target.local_path = canonical.to_string_lossy().to_string();
    }

    let interactive = is_tty();
    let new_agent = resolve_agent_choice(agent_arg, interactive).await?;

    let current_agent = target.executor.as_ref().map(|e| e.agent_id.clone());
    let current_model = target.executor.as_ref().and_then(|e| e.model.clone());

    let final_agent = match new_agent {
        Some(aid) => Some(aid),
        None => current_agent,
    };

    let final_model = match model_arg {
        Some("auto") => None,
        Some(m) => Some(m.trim().to_string()),
        None => current_model,
    };

    if let Some(agent) = final_agent {
        if final_model.is_some() && !LocalExecutorConfig::agent_supports_model_override(&agent) {
            return Err(ProjectError::Config(ConfigError::InvalidExecutor(format!(
                "model override is not supported for agent '{agent}'"
            ))));
        }
        let exec = LocalExecutorConfig::new_logical(agent, final_model)?;
        exec.validate()?;
        target.executor = Some(exec);
    } else if final_model.is_some() {
        return Err(ProjectError::Config(ConfigError::InvalidExecutor(
            "cannot configure a model override without an agent".into(),
        )));
    }

    config.save(&paths.config_file())?;
    println!("Project '{selector}' updated.");
    Ok(())
}

pub async fn project_rename(
    paths: &ConnectorPaths,
    selector: &str,
    new_name: &str,
    json_format: bool,
) -> Result<(), ProjectError> {
    target_rename(paths, selector, new_name, json_format)
        .await
        .map_err(ProjectError::Target)
}

pub async fn project_remove(paths: &ConnectorPaths, selector: &str) -> Result<(), ProjectError> {
    paths.ensure_dirs()?;
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let resolved = resolve_target_selector(paths, &client, &cred, selector).await?;
    target_remove(paths, &resolved.target_id)
        .await
        .map_err(ProjectError::Target)?;
    println!("Project '{selector}' removed from this device.");
    Ok(())
}

pub async fn project_default_runtime(
    paths: &ConnectorPaths,
    selector: Option<&str>,
) -> Result<(), ProjectError> {
    match selector {
        Some(s) => {
            target_set_default_runtime(paths, s)
                .await
                .map_err(ProjectError::Target)?;
        }
        None => {
            let items = build_project_display_items(paths).await?;
            if let Some(def) = items.iter().find(|i| i.is_default_agent_runtime) {
                println!(
                    "Default runtime project: {} (alias: {})",
                    def.name,
                    def.alias.as_deref().unwrap_or("<none>")
                );
            } else {
                println!("No default Agent Runtime project configured for this workspace.");
            }
        }
    }
    Ok(())
}
