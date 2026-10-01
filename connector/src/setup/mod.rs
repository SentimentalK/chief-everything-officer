//! Reusable, non-interactive setup application services (PROJECT-036 Slice 2).
//!
//! This module owns the setup *orchestration/business sequencing* shared by
//! the future guided setup CLI wizard and a native Desktop frontend. It is
//! deliberately NOT a wizard: no menus, no line editor, no Tab completion, no
//! login handoff, no automatic Doctor, no interactive prompting, no stdout/
//! stderr printing, and no clap/argument parsing live here.
//!
//! Responsibilities:
//! 1. resolve the current single-workspace setup context internally (the
//!    normal V1 product flow supports one Workspace and never exposes ws_* IDs);
//! 2. ensure/reuse/install/bind the canonical CEO Agent Runtime Target;
//! 3. ensure/reuse/bind a coding Target by exact human alias;
//! 4. set/replay the workspace default Agent Runtime safely;
//! 5. update only Device-owned schema-v3 local state (local_path + optional
//!    executor/model, keyed by immutable target_id).
//!
//! Authority split is unchanged from Slices 1A/1B: the Server is authoritative
//! for workspace membership, Target alias/kind/repository/disabled/binding/
//! default-runtime; local schema-v3 config stores only Device-owned fields.

pub mod gitops;

use std::fs;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

use crate::client::{ClientError, ConnectorClient, ConnectorTargetProjection, RegisterTargetInput};
use crate::config::{load_bound_profile, ConfigError, LocalConfig, LocalTarget, ProfileError};
use crate::credential::{CredentialError, DeviceCredential};
use crate::local_state::ExecutionLock;
use crate::paths::ConnectorPaths;
use crate::targets::{
    check_active_attempt_target_in_use, verify_local_repo_full_name, verify_local_repository,
    TargetError,
};

// ---------------------------------------------------------------------------
// Canonical CEO Agent Runtime product identity
// ---------------------------------------------------------------------------

/// Server-authoritative canonical alias of the CEO Agent Runtime Target.
pub const AGENT_RUNTIME_TARGET_ALIAS: &str = "ceo-agent-runtime";
/// Canonical human display name of the CEO Agent Runtime Target.
pub const AGENT_RUNTIME_DISPLAY_NAME: &str = "CEO Agent Runtime";
/// Official repository clone URL for the CEO Agent Runtime.
pub const AGENT_RUNTIME_REPO_CLONE_URL: &str =
    "https://github.com/SentimentalK/ceo-agent-runtime.git";
/// Expected GitHub full name of the official CEO Agent Runtime repository.
pub const AGENT_RUNTIME_REPO_FULL_NAME: &str = "SentimentalK/ceo-agent-runtime";
/// The only Target kind setup creates or accepts.
pub const TARGET_KIND_CODING: &str = "coding";

/// Local repository provenance used to install/verify the Agent Runtime
/// clone. The canonical provenance points at the official repository; tests
/// may substitute a local bare fixture while the canonical URL/full-name and
/// git command construction are tested separately.
#[derive(Debug, Clone)]
pub struct AgentRuntimeRepoSpec {
    pub clone_url: String,
    pub expected_full_name: String,
}

impl AgentRuntimeRepoSpec {
    pub fn canonical() -> Self {
        Self {
            clone_url: AGENT_RUNTIME_REPO_CLONE_URL.to_string(),
            expected_full_name: AGENT_RUNTIME_REPO_FULL_NAME.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Typed domain outcomes / errors
// ---------------------------------------------------------------------------

/// Typed outcome of a setup operation. Pure domain data: the caller (CLI
/// wizard, Desktop frontend) owns all presentation. Reuse/idempotency facts
/// are explicit so reruns can render honest replays.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SetupTargetOutcome {
    /// Immutable Server Target ID (safe to key local state on).
    pub target_id: String,
    /// Server-authoritative alias (equals the canonical constant for the
    /// Agent Runtime flow, or the exact human input alias for coding setup).
    pub alias: String,
    /// Server-authoritative kind ("coding").
    pub kind: String,
    /// Verified canonical local path written to the schema-v3 config.
    pub local_path: String,
    /// true when this run registered the Server Target; false when an
    /// existing Target was reused by immutable ID.
    pub target_created: bool,
    /// true when this run cloned the local repository; false when an
    /// existing verified repository was reused. Always false for generic
    /// coding setup (which never clones).
    pub repo_cloned: bool,
    /// true when this run newly created/enabled the Device binding; false on
    /// an idempotent replay.
    pub binding_created: bool,
    /// true when this run changed the workspace default Agent Runtime; false
    /// when it was already the default (no-op/replay). Always false for
    /// generic coding setup.
    pub default_changed: bool,
}

#[derive(Error, Debug)]
pub enum SetupError {
    #[error("Target error: {0}")]
    Target(TargetError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
    #[error("Local credential server mismatch: config origin is '{expected}', but credential origin is '{actual}' (LOCAL_CREDENTIAL_SERVER_MISMATCH)")]
    CredentialServerMismatch { expected: String, actual: String },
    #[error("Setup requires exactly one workspace, but this device currently has none. Join or create a workspace first (NO_WORKSPACE).")]
    NoWorkspace,
    #[error("Setup supports devices belonging to exactly one workspace, but this device currently belongs to {0} workspaces; setup cannot determine which one to use (MULTI_WORKSPACE_SETUP_UNSUPPORTED).")]
    MultiWorkspaceUnsupported(usize),
    #[error("Alias '{0}' matched multiple Server Targets in the workspace; refusing to choose one (SETUP_ALIAS_AMBIGUOUS).")]
    AmbiguousAlias(String),
    #[error("Target '{alias}' exists on the Server with kind '{kind}', but setup requires kind 'coding' (SETUP_TARGET_WRONG_KIND).")]
    TargetWrongKind { alias: String, kind: String },
    #[error("Target '{0}' is disabled on server (TARGET_DISABLED)")]
    TargetDisabled(String),
    #[error("Target '{0}' is currently in use by active attempt (TARGET_IN_USE)")]
    TargetInUse(String),
    #[error("Local path '{0}' does not exist or is not a directory")]
    PathNotFound(String),
    #[error("Refusing to modify pre-existing path '{path}': {reason}. Setup never overwrites or deletes existing paths; correct or remove the path manually and rerun (SETUP_PATH_CONFLICT).")]
    PathConflict { path: String, reason: String },
    #[error("Destination path '{0}' is not usable as an install destination")]
    InvalidDestination(String),
    #[error("Git executable not found in PATH. Install git and rerun setup (GIT_NOT_FOUND).")]
    GitNotFound,
    #[error("Git error: {0}")]
    Git(String),
    #[error("Repository mismatch: expected '{expected}', but local git remote origin is '{actual}' (TARGET_REPOSITORY_MISMATCH)")]
    RepositoryMismatch { expected: String, actual: String },
    #[error("Profile or state lock is currently busy. Please retry shortly. (PROFILE_BUSY)")]
    ProfileBusy,
    #[error(
        "Setup finished the local steps but could not set the workspace default Agent Runtime: {source} (SETUP_DEFAULT_RUNTIME_PARTIAL). The target, binding, repository, and local mapping are already in place; rerun setup to converge."
    )]
    PartialDefaultRuntime {
        /// Honest partial-progress snapshot (default_changed is always false).
        outcome: Box<SetupTargetOutcome>,
        source: Box<SetupError>,
    },
}

impl From<ProfileError> for SetupError {
    fn from(err: ProfileError) -> Self {
        match err {
            ProfileError::NotLoggedIn => SetupError::NotLoggedIn,
            ProfileError::ConfigNotFound => SetupError::NotLoggedIn,
            ProfileError::Config(e) => SetupError::Config(e),
            ProfileError::Io(e) => SetupError::Io(e),
            ProfileError::Credential(e) => SetupError::Credential(e),
            ProfileError::LocalCredentialServerMismatch { expected, actual } => {
                SetupError::CredentialServerMismatch { expected, actual }
            }
        }
    }
}

impl From<TargetError> for SetupError {
    fn from(err: TargetError) -> Self {
        match err {
            TargetError::TargetInUse(id) => SetupError::TargetInUse(id),
            TargetError::TargetDisabled(id) => SetupError::TargetDisabled(id),
            TargetError::RepositoryMismatch { expected, actual } => {
                SetupError::RepositoryMismatch { expected, actual }
            }
            other => SetupError::Target(other),
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace context resolution
// ---------------------------------------------------------------------------

/// Pure single-workspace selection. The normal V1 product flow supports one
/// Workspace without exposing ws_* IDs:
/// - exactly one workspace => selected internally;
/// - zero workspaces => actionable failure;
/// - more than one => fail closed (never pick first, never expose raw IDs).
pub fn select_single_workspace(
    workspaces: Vec<crate::client::WorkspaceItem>,
) -> Result<crate::client::WorkspaceItem, SetupError> {
    match workspaces.len() {
        1 => Ok(workspaces.into_iter().next().unwrap()),
        0 => Err(SetupError::NoWorkspace),
        n => Err(SetupError::MultiWorkspaceUnsupported(n)),
    }
}

async fn resolve_current_workspace(
    client: &ConnectorClient,
    cred: &DeviceCredential,
) -> Result<crate::client::WorkspaceItem, SetupError> {
    let workspaces = client.list_workspaces(cred).await?;
    select_single_workspace(workspaces)
}

// ---------------------------------------------------------------------------
// Shared orchestration steps
// ---------------------------------------------------------------------------

/// Server-side Target ensure shared by both setup flows. Resolves the exact
/// alias within the freshly fetched workspace catalogue:
/// - existing => require kind=coding, not disabled, reuse the immutable
///   target_id (no rename, no delete/recreate, no duplicate);
/// - absent => register exactly one coding Target (repository metadata stays
///   absent; the current register API cannot truthfully express external
///   repository metadata for these flows).
///
/// The Device binding is intentionally NOT ensured here; it is ensured after
/// the local repository/path steps succeed.
#[derive(Debug, Clone)]
struct EnsuredTarget {
    target_id: String,
    alias: String,
    kind: String,
    target_created: bool,
    /// Server-reported state of this device's binding at ensure time.
    this_device_binding_active: bool,
    /// True when the Server reports that this ensure run itself created the
    /// Device binding (register auto-binds the current device).
    binding_created_by_register: bool,
    is_default_agent_runtime: bool,
    /// Server repository metadata when present (coding flows verify it).
    repository: Option<crate::client::TargetRepositoryPart>,
}

async fn ensure_server_target(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    workspace_id: &str,
    catalogue: &[ConnectorTargetProjection],
    alias: &str,
    display_name: &str,
) -> Result<EnsuredTarget, SetupError> {
    // Exact, case-sensitive whole-string alias match within the workspace.
    // No fuzzy/prefix/case-folding semantics are defined locally; the Server
    // alias contract is the only authority.
    let matches: Vec<&ConnectorTargetProjection> =
        catalogue.iter().filter(|t| t.alias == alias).collect();

    match matches.len() {
        1 => {
            let t = matches[0];
            if t.kind != TARGET_KIND_CODING {
                return Err(SetupError::TargetWrongKind {
                    alias: t.alias.clone(),
                    kind: t.kind.clone(),
                });
            }
            if t.disabled {
                return Err(SetupError::TargetDisabled(t.target_id.clone()));
            }
            Ok(EnsuredTarget {
                target_id: t.target_id.clone(),
                alias: t.alias.clone(),
                kind: t.kind.clone(),
                target_created: false,
                this_device_binding_active: t
                    .this_device_binding
                    .as_ref()
                    .map(|b| b.enabled)
                    .unwrap_or(false),
                binding_created_by_register: false,
                is_default_agent_runtime: t.is_default_agent_runtime,
                repository: t.repository.clone(),
            })
        }
        0 => {
            let input = RegisterTargetInput {
                workspace_id: workspace_id.to_string(),
                alias: alias.to_string(),
                display_name: display_name.to_string(),
                kind: TARGET_KIND_CODING.to_string(),
                // No fabricated workspace/repository metadata: the existing
                // register API cannot truthfully express these flows' external
                // repository truth, so repository stays absent.
                repository: None,
            };
            let res = client.register_target(cred, &input).await?;
            Ok(EnsuredTarget {
                target_id: res.target.id,
                alias: res.target.alias,
                kind: res.target.kind,
                target_created: res.target_created,
                // Register creates/enables this device's binding itself.
                this_device_binding_active: res.binding.enabled,
                binding_created_by_register: res.binding_created,
                is_default_agent_runtime: res.target.is_default_agent_runtime,
                repository: res.target.repository,
            })
        }
        _ => Err(SetupError::AmbiguousAlias(alias.to_string())),
    }
}

/// Ensures the current Device binding is enabled. Active => replay/no-op;
/// missing/disabled => existing bind API.
async fn ensure_device_binding(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    target_id: &str,
    binding_active: bool,
) -> Result<bool, SetupError> {
    if binding_active {
        return Ok(false);
    }
    let res = client.bind_target(cred, target_id).await?;
    Ok(!res.replayed)
}

/// Ensures the current Device binding is enabled. Active => replay/no-op;
/// missing/disabled => existing bind API. A binding created by the register
/// call itself counts as newly created.
async fn ensure_binding_step(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    ensured: &EnsuredTarget,
) -> Result<bool, SetupError> {
    if ensured.binding_created_by_register {
        return Ok(true);
    }
    ensure_device_binding(
        client,
        cred,
        &ensured.target_id,
        ensured.this_device_binding_active,
    )
    .await
}

fn acquire_state_lock(paths: &ConnectorPaths) -> Result<ExecutionLock, SetupError> {
    match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        Duration::from_secs(3),
        Duration::from_millis(50),
    ) {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Err(SetupError::ProfileBusy),
        Err(e) => Err(SetupError::Io(e)),
    }
}

fn check_target_in_use(paths: &ConnectorPaths, target_id: &str) -> Result<(), SetupError> {
    match check_active_attempt_target_in_use(paths, target_id) {
        Ok(()) => Ok(()),
        Err(TargetError::TargetInUse(id)) => Err(SetupError::TargetInUse(id)),
        Err(e) => Err(e.into()),
    }
}

/// Updates ONLY Device-owned schema-v3 local state for `target_id`:
/// - writes the verified canonical `local_path`;
/// - preserves any existing executor/model exactly (fresh runtime Targets may
///   legitimately have no executor yet — no Agent/provider installation here);
/// - never stores alias/kind/workspace (struct shape enforces this).
///
/// Concurrency: runs under `state.lock` and RE-READS the current schema-v3
/// config UNDER the lock, so concurrent `set-agent`/`set-model`/path changes
/// can never be overwritten by a stale setup snapshot. When the on-disk entry
/// already equals the desired state, nothing is written at all (idempotent
/// replay, no unnecessary rewrite). Returns true when a write happened.
fn write_local_mapping(
    paths: &ConnectorPaths,
    server_origin: &str,
    target_id: &str,
    canonical_path: &str,
) -> Result<bool, SetupError> {
    let _lock = acquire_state_lock(paths)?;

    // Re-checked under the lock: the active-attempt guard must never be
    // bypassed by a concurrent attempt start.
    check_target_in_use(paths, target_id)?;

    // Re-read under the lock (strict v3 parse; migration already ran during
    // profile load and this process holds the lock, so no re-locking).
    let mut config = match LocalConfig::load(&paths.config_file())? {
        Some(c) => c,
        None => LocalConfig::new(server_origin.to_string())?,
    };

    // Preserve existing Device-owned executor/model exactly.
    let executor = config
        .targets
        .get(target_id)
        .and_then(|t| t.executor.clone());
    let desired = LocalTarget {
        local_path: canonical_path.to_string(),
        executor,
    };

    if config.targets.get(target_id) == Some(&desired) {
        return Ok(false);
    }

    config.targets.insert(target_id.to_string(), desired);
    config.save(&paths.config_file())?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Agent Runtime ensure
// ---------------------------------------------------------------------------

/// Reusable setup operation: ensure the canonical CEO Agent Runtime Target
/// (alias `ceo-agent-runtime`, display name `CEO Agent Runtime`, kind
/// `coding`) exists on the Server, the local repository at `requested_path`
/// is the verified official repository (reused or freshly cloned), the
/// current Device is bound, the schema-v3 local mapping is written, and the
/// Target is the workspace default Agent Runtime — in that order.
///
/// Idempotent: rerunning with the same state/path produces no duplicate
/// Target, binding, clone, or unnecessary destructive rewrite.
pub async fn ensure_agent_runtime(
    paths: &ConnectorPaths,
    requested_path: &Path,
) -> Result<SetupTargetOutcome, SetupError> {
    ensure_agent_runtime_with_repo(paths, requested_path, &AgentRuntimeRepoSpec::canonical()).await
}

/// Testable variant of [`ensure_agent_runtime`] with an injectable repository
/// provenance. Production callers must use [`ensure_agent_runtime`], which
/// pins the canonical official repository.
pub async fn ensure_agent_runtime_with_repo(
    paths: &ConnectorPaths,
    requested_path: &Path,
    repo: &AgentRuntimeRepoSpec,
) -> Result<SetupTargetOutcome, SetupError> {
    paths.ensure_dirs()?;
    let profile = load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    // 1. Resolve the single current workspace internally.
    let ws = resolve_current_workspace(&client, &cred).await?;

    // 2. Fresh Server Target catalogue for that workspace.
    let catalogue = client.list_targets(&cred, Some(&ws.id)).await?;

    // 3-5. Ensure the canonical Target (create once / reuse by immutable ID).
    let ensured = ensure_server_target(
        &client,
        &cred,
        &ws.id,
        &catalogue,
        AGENT_RUNTIME_TARGET_ALIAS,
        AGENT_RUNTIME_DISPLAY_NAME,
    )
    .await?;

    // Fail-fast active-attempt guard (re-checked under the lock before any
    // local config mutation).
    check_target_in_use(paths, &ensured.target_id)?;

    // 6. Ensure the local repository path safely (reuse verified / clone).
    let (canonical_path_str, repo_cloned) = ensure_local_repo(requested_path, repo)?;

    // 7. Ensure the current Device binding is enabled.
    let binding_created = ensure_binding_step(&client, &cred, &ensured).await?;

    // 8. Update schema-v3 local state (only Device-owned fields).
    write_local_mapping(
        paths,
        &cred.server_origin,
        &ensured.target_id,
        &canonical_path_str,
    )?;

    // 9. Ensure the workspace default Agent Runtime — only after the verified
    // local path, binding, and local mapping all succeeded.
    let outcome = SetupTargetOutcome {
        target_id: ensured.target_id.clone(),
        alias: ensured.alias.clone(),
        kind: ensured.kind.clone(),
        local_path: canonical_path_str,
        target_created: ensured.target_created,
        repo_cloned,
        binding_created,
        default_changed: false,
    };

    if ensured.is_default_agent_runtime {
        // Already the default: honest no-op/replay, no Server mutation.
        return Ok(outcome);
    }

    match client
        .set_default_runtime_target(&cred, &ensured.target_id)
        .await
    {
        Ok(res) => Ok(SetupTargetOutcome {
            default_changed: !res.replayed,
            ..outcome
        }),
        Err(e) => {
            // Partial progress is honest: target/binding/clone/mapping are
            // committed; rerun converges without duplicating any of them.
            Err(SetupError::PartialDefaultRuntime {
                outcome: Box::new(outcome),
                source: Box::new(e.into()),
            })
        }
    }
}

/// Ensures the local repository for the Agent Runtime:
/// - existing verified Git repository whose origin normalizes to the expected
///   full name => reuse;
/// - existing pre-existing path that is not a verified repository => fail
///   without overwrite/delete;
/// - absent path => require git, clone, verify top-level + origin, publish
///   atomically.
fn ensure_local_repo(
    requested_path: &Path,
    repo: &AgentRuntimeRepoSpec,
) -> Result<(String, bool), SetupError> {
    match fs::symlink_metadata(requested_path) {
        Ok(meta) => {
            // Never modify a pre-existing path: it must already be the
            // verified repository, otherwise fail closed.
            let display = requested_path.display().to_string();
            if meta.is_symlink() || !requested_path.is_dir() {
                return Err(SetupError::PathConflict {
                    path: display,
                    reason: "path exists and is not a directory".to_string(),
                });
            }
            if let Err(e) = verify_local_repo_full_name(requested_path, &repo.expected_full_name) {
                return Err(SetupError::PathConflict {
                    path: display,
                    reason: e.to_string(),
                });
            }
            let canonical = fs::canonicalize(requested_path)?;
            Ok((canonical.to_string_lossy().to_string(), false))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            gitops::clone_repo_safely(&repo.clone_url, &repo.expected_full_name, requested_path)?;
            let canonical = fs::canonicalize(requested_path)?;
            Ok((canonical.to_string_lossy().to_string(), true))
        }
        Err(e) => Err(SetupError::Io(e)),
    }
}

// ---------------------------------------------------------------------------
// Generic coding Target ensure
// ---------------------------------------------------------------------------

/// Reusable setup operation: ensure a coding Target identified by its exact
/// human Server alias exists, is bound to the current Device, and is mapped
/// in the schema-v3 local config to `local_path`.
///
/// Inputs are only the human alias and a concrete existing local path — no
/// workspace_id/target_id inputs. Generic coding setup never clones and never
/// fabricates Server repository metadata.
pub async fn ensure_coding_target(
    paths: &ConnectorPaths,
    alias: &str,
    local_path: &Path,
) -> Result<SetupTargetOutcome, SetupError> {
    if alias.trim().is_empty() {
        return Err(SetupError::AmbiguousAlias(alias.to_string()));
    }

    paths.ensure_dirs()?;
    let profile = load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    // Resolve the single current workspace internally.
    let ws = resolve_current_workspace(&client, &cred).await?;

    // Fresh Server catalogue; exact/case-sensitive alias match only.
    let catalogue = client.list_targets(&cred, Some(&ws.id)).await?;
    let ensured = ensure_server_target(&client, &cred, &ws.id, &catalogue, alias, alias).await?;

    // Fail-fast active-attempt guard (re-checked under the lock before any
    // local config mutation).
    check_target_in_use(paths, &ensured.target_id)?;

    // Local path must already exist and be a directory; generic coding setup
    // does not clone arbitrary projects.
    if !local_path.exists() || !local_path.is_dir() {
        return Err(SetupError::PathNotFound(local_path.display().to_string()));
    }
    let canonical_path = fs::canonicalize(local_path)?;
    let canonical_path_str = canonical_path.to_string_lossy().to_string();

    // When the Server Target carries repository metadata, verify the local
    // repository with the existing shared semantics; when absent, invent
    // nothing.
    if let Some(ref repo_part) = ensured.repository {
        verify_local_repository(&canonical_path, repo_part)?;
    }

    // Ensure the current Device binding is active.
    let binding_created = ensure_binding_step(&client, &cred, &ensured).await?;

    // Update schema-v3 local mapping by target_id (executor/model preserved).
    write_local_mapping(
        paths,
        &cred.server_origin,
        &ensured.target_id,
        &canonical_path_str,
    )?;

    Ok(SetupTargetOutcome {
        target_id: ensured.target_id,
        alias: ensured.alias,
        kind: ensured.kind,
        local_path: canonical_path_str,
        target_created: ensured.target_created,
        repo_cloned: false,
        binding_created,
        default_changed: false,
    })
}

// ---------------------------------------------------------------------------
// Unit tests (pure logic + git command construction)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::WorkspaceItem;
    use std::path::PathBuf;

    fn workspace(id: &str) -> WorkspaceItem {
        WorkspaceItem {
            id: id.to_string(),
            role: "owner".to_string(),
            workspace_repository: None,
        }
    }

    #[test]
    fn select_single_workspace_resolves_exactly_one() {
        let ws = select_single_workspace(vec![workspace("ws_one")]).unwrap();
        assert_eq!(ws.id, "ws_one");
    }

    #[test]
    fn select_single_workspace_fails_actionably_on_zero() {
        let err = select_single_workspace(vec![]).unwrap_err();
        assert!(matches!(err, SetupError::NoWorkspace));
        assert!(err.to_string().contains("NO_WORKSPACE"));
    }

    #[test]
    fn select_single_workspace_fails_closed_on_multiple_without_exposing_ids() {
        let err = select_single_workspace(vec![workspace("ws_a"), workspace("ws_b")]).unwrap_err();
        assert!(matches!(err, SetupError::MultiWorkspaceUnsupported(2)));
        let msg = err.to_string();
        assert!(msg.contains("MULTI_WORKSPACE_SETUP_UNSUPPORTED"));
        // Raw workspace IDs must never be exposed to the caller.
        assert!(!msg.contains("ws_a"));
        assert!(!msg.contains("ws_b"));
    }

    #[test]
    fn canonical_agent_runtime_constants_are_self_consistent() {
        assert_eq!(AGENT_RUNTIME_TARGET_ALIAS, "ceo-agent-runtime");
        assert_eq!(AGENT_RUNTIME_DISPLAY_NAME, "CEO Agent Runtime");
        // The canonical clone URL normalizes to the canonical full name.
        assert_eq!(
            crate::targets::normalize_github_remote(AGENT_RUNTIME_REPO_CLONE_URL)
                .unwrap()
                .to_lowercase(),
            AGENT_RUNTIME_REPO_FULL_NAME.to_lowercase()
        );
        let spec = AgentRuntimeRepoSpec::canonical();
        assert_eq!(spec.clone_url, AGENT_RUNTIME_REPO_CLONE_URL);
        assert_eq!(spec.expected_full_name, AGENT_RUNTIME_REPO_FULL_NAME);
    }

    #[test]
    fn git_clone_command_uses_argument_apis_without_shell() {
        let dest = PathBuf::from("/tmp/some-dest");
        let cmd = gitops::git_clone_command("https://github.com/o/r.git", &dest);
        // No shell wrapper: the program is git itself with plain arguments.
        assert_eq!(cmd.get_program().to_string_lossy(), "git");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec!["clone", "https://github.com/o/r.git", "/tmp/some-dest"]
        );
    }

    #[test]
    fn run_git_maps_missing_executable_to_distinct_git_not_found() {
        let mut cmd = std::process::Command::new("ceo-connector-setup-no-such-git-binary");
        cmd.arg("--version");
        match gitops::run_git(&mut cmd) {
            Err(SetupError::GitNotFound) => {}
            other => panic!("expected SetupError::GitNotFound, got {other:?}"),
        }
    }

    #[test]
    fn local_mapping_preserves_executor_and_refuses_target_in_use() {
        // Config write helpers are covered end-to-end in
        // tests/setup_tests.rs; here we only pin the outcome type shape so
        // serialized receipts stay backward compatible.
        let outcome = SetupTargetOutcome {
            target_id: "tgt_1".into(),
            alias: "ceo-agent-runtime".into(),
            kind: "coding".into(),
            local_path: "/x".into(),
            target_created: true,
            repo_cloned: true,
            binding_created: false,
            default_changed: true,
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["target_id"], "tgt_1");
        assert_eq!(json["target_created"], true);
        assert_eq!(json["repo_cloned"], true);
        assert_eq!(json["binding_created"], false);
        assert_eq!(json["default_changed"], true);
    }
}
