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
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

use crate::client::{
    ClientError, ConnectorClient, ConnectorTargetProjection, RegisterTargetInput,
    RegisterTargetRepoSource,
};
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
    /// true when this run created the local directory itself (generic coding
    /// setup with an explicit create confirmation); false when an existing
    /// directory was reused. Always false for Agent Runtime setup (which
    /// either reuses a verified checkout or reports `repo_cloned`).
    pub directory_created: bool,
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
    #[error(
        "Local config maps the checked-out path '{0}' to multiple Server Targets; refusing to pick one for legacy repository backfill (SETUP_BACKFILL_LOCAL_AMBIGUOUS)."
    )]
    AmbiguousLocalBackfill(String),
    #[error(
        "Git repository '{0}' identity matched multiple active coding Server Targets in the workspace; refusing to choose one (SETUP_REPOSITORY_AMBIGUOUS)."
    )]
    AmbiguousRepository(String),
    #[error(
        "Local checkout origin resolves to repository '{actual}', but the Server Target '{alias}' matched by name belongs to repository '{expected}'. Human names never decide Project identity; this add fails instead of binding a different repository (SETUP_REPOSITORY_IDENTITY_CONFLICT)."
    )]
    RepositoryIdentityConflict {
        alias: String,
        expected: String,
        actual: String,
    },
    #[error("Target '{alias}' exists on the Server with kind '{kind}', but setup requires kind 'coding' (SETUP_TARGET_WRONG_KIND).")]
    TargetWrongKind { alias: String, kind: String },
    #[error("Target '{0}' is disabled on server (TARGET_DISABLED)")]
    TargetDisabled(String),
    #[error("Target '{0}' is currently in use by active attempt (TARGET_IN_USE)")]
    TargetInUse(String),
    #[error("Local path '{0}' does not exist or is not a directory")]
    PathNotFound(String),
    #[error("The canonical CEO Agent Runtime Target ('ceo-agent-runtime') does not exist in your workspace yet. Run setup and choose the runtime install/connect step first (SETUP_RUNTIME_TARGET_MISSING).")]
    RuntimeTargetMissing,
    #[error("This device has no local CEO Agent Runtime checkout connected yet. Connect the runtime on this computer first, then configure its execution agent (SETUP_RUNTIME_NOT_CONNECTED).")]
    RuntimeNotConnected,
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

pub(crate) async fn resolve_current_workspace(
    client: &ConnectorClient,
    cred: &DeviceCredential,
) -> Result<crate::client::WorkspaceItem, SetupError> {
    let workspaces = client.list_workspaces(cred).await?;
    select_single_workspace(workspaces)
}

// ---------------------------------------------------------------------------
// Shared orchestration steps
// ---------------------------------------------------------------------------

/// Server-side Target ensure shared by the legacy setup flows. Resolves the
/// exact alias within the freshly fetched workspace catalogue:
/// - existing => require kind=coding, not disabled, reuse the immutable
///   target_id (no rename, no delete/recreate, no duplicate);
/// - absent => register exactly one coding Target (repository metadata stays
///   absent; the current register API cannot truthfully express external
///   repository metadata for these flows).
///
/// The Device binding is intentionally NOT ensured here; it is ensured after
/// the local repository/path steps succeed.
#[derive(Debug, Clone)]
pub(crate) struct EnsuredTarget {
    pub(crate) target_id: String,
    pub(crate) alias: String,
    pub(crate) kind: String,
    pub(crate) target_created: bool,
    /// Server-reported state of this device's binding at ensure time.
    pub(crate) this_device_binding_active: bool,
    /// True when the Server reports that this ensure run itself created the
    /// Device binding (register auto-binds the current device).
    pub(crate) binding_created_by_register: bool,
    pub(crate) is_default_agent_runtime: bool,
    /// Server repository metadata when present (coding flows verify it).
    pub(crate) repository: Option<crate::client::TargetRepositoryPart>,
}

pub(crate) async fn ensure_server_target(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    workspace_id: &str,
    catalogue: &[ConnectorTargetProjection],
    alias: &str,
    display_name: &str,
) -> Result<EnsuredTarget, SetupError> {
    ensure_server_target_with_repository(
        client,
        cred,
        workspace_id,
        catalogue,
        alias,
        display_name,
        None,
    )
    .await
}

/// Repository-first Server Target ensure shared by the project add flow.
///
/// Resolution order (fresh-device Project identity):
/// 1. When `repo_source` is `Some(RegisterTargetRepoSource::RemoteUrl { .. })`,
///    resolve by normalized Git repository identity FIRST: the catalogue is
///    scanned for an existing active coding Target with the same provider and
///    canonical full_name (case-insensitive; the persisted external_id is the
///    lowercase form). A human alias/display name never decides dedupe; if the
///    repository-identity match has a different alias, the Server Target is
///    REUSED under its existing alias — no implicit rename.
/// 2. Otherwise fall back to the exact alias match within the workspace
///    catalogue (the authoritative contract for workspace_repository and
///    repository-less setup flows).
/// 3. No existing match: register at most ONE coding Target. With a remote_url
///    source the repository metadata is persisted for future fresh-device
///    resolution; the Server rejects a duplicate registration inside a
///    transaction (idempotent create race).
pub(crate) async fn ensure_server_target_with_repository(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    workspace_id: &str,
    catalogue: &[ConnectorTargetProjection],
    alias: &str,
    display_name: &str,
    repo_source: Option<RegisterTargetRepoSource>,
) -> Result<EnsuredTarget, SetupError> {
    // Step 1: repository-identity resolution (remote_url sources only).
    if let Some(RegisterTargetRepoSource::RemoteUrl {
        provider,
        full_name,
    }) = &repo_source
    {
        let wanted = full_name.to_lowercase();
        let repo_matches: Vec<&ConnectorTargetProjection> = catalogue
            .iter()
            .filter(|t| {
                !t.disabled
                    && t.kind == TARGET_KIND_CODING
                    && t.repository
                        .as_ref()
                        .map(|r| r.provider == *provider && r.full_name.to_lowercase() == wanted)
                        .unwrap_or(false)
            })
            .collect();

        match repo_matches.len() {
            1 => {
                let t = repo_matches[0];
                return Ok(EnsuredTarget {
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
                });
            }
            0 => {
                // Fall through to register (step 3) below.
            }
            _ => {
                return Err(SetupError::AmbiguousRepository(full_name.clone()));
            }
        }
    }

    // Step 2: exact, case-sensitive whole-string alias match within the
    // workspace. No fuzzy/prefix/case-folding semantics are defined locally;
    // the Server alias contract is the only authority.
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
            // A name-matched Target whose repository metadata belongs to a
            // DIFFERENT Git repository must never silently absorb this
            // checkout: names are presentation only.
            if let Some(RegisterTargetRepoSource::RemoteUrl {
                provider,
                full_name,
            }) = &repo_source
            {
                if let Some(repo) = &t.repository {
                    let wanted = full_name.to_lowercase();
                    if repo.provider != *provider || repo.full_name.to_lowercase() != wanted {
                        return Err(SetupError::RepositoryIdentityConflict {
                            alias: t.alias.clone(),
                            expected: repo.full_name.clone(),
                            actual: full_name.clone(),
                        });
                    }
                }
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
                repository: repo_source,
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

// ---------------------------------------------------------------------------
// Bounded legacy repository-identity backfill (one-time migration)
// ---------------------------------------------------------------------------

/// Bounded legacy repository-identity backfill for `project add`.
///
/// Bounded case (design rule 12): the resolved repository identity has NO
/// repository match in the workspace catalogue, but THIS Device's schema-v3
/// local config ALREADY maps the exact immutable target_id to the verified
/// local Git checkout being added, and the Server Target is an active coding
/// Target whose repository metadata is null AND whose this-device binding for
/// the exact target_id is active. Only then is the explicit Server attach
/// capability called; it independently fails closed on disabled targets,
/// wrong kinds, cross-workspace targets, missing/disabled this-device
/// bindings, non-null mismatches, and identity conflicts.
///
/// A fresh/unbound Device (no local mapping for the checkout) returns None
/// here: an alias match is never authority to backfill a legacy
/// repository-null Target.
///
/// Returns `Some(target_id)` when the bounded attach path ran (attached or
/// idempotently replayed) so the caller can refresh its catalogue snapshot;
/// `None` when the ordinary repository-first ensure flow should proceed
/// unchanged.
/// The verified local Git checkout context driving a bounded backfill:
/// canonical checkout path plus the normalized repository identity derived
/// from that same checkout's origin.
pub(crate) struct LegacyBackfillCheckout<'a> {
    pub(crate) canonical_path: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) full_name: &'a str,
}

pub(crate) async fn maybe_backfill_legacy_repository_identity(
    client: &ConnectorClient,
    cred: &DeviceCredential,
    paths: &ConnectorPaths,
    workspace_id: &str,
    catalogue: &[ConnectorTargetProjection],
    checkout: LegacyBackfillCheckout<'_>,
) -> Result<Option<String>, SetupError> {
    let canonical_path = checkout.canonical_path;
    let provider = checkout.provider;
    let full_name = checkout.full_name;
    // 1. Repository identity already present in the workspace catalogue =>
    //    nothing to backfill; ensure_server_target_with_repository owns the
    //    reuse/ambiguity semantics.
    let wanted = full_name.to_lowercase();
    let repo_match_count = catalogue
        .iter()
        .filter(|t| {
            !t.disabled
                && t.kind == TARGET_KIND_CODING
                && t.repository
                    .as_ref()
                    .map(|r| r.provider == provider && r.full_name.to_lowercase() == wanted)
                    .unwrap_or(false)
        })
        .count();
    if repo_match_count > 0 {
        return Ok(None);
    }

    // 2. Local-config authority: the Device must ALREADY map the exact
    //    target_id to this verified checkout (schema-v3 config is keyed by
    //    the immutable target_id). A fresh/unbound Device has no such
    //    mapping and must never claim a legacy repository-null Target by
    //    human alias alone.
    let config = match LocalConfig::load(&paths.config_file())? {
        Some(c) => c,
        None => return Ok(None),
    };
    let mut mapped_target_ids: Vec<String> = config
        .targets
        .iter()
        .filter(|(_, lt)| lt.local_path == canonical_path)
        .map(|(tid, _)| tid.clone())
        .collect();
    mapped_target_ids.sort();
    mapped_target_ids.dedup();
    let target_id = match mapped_target_ids.len() {
        0 => return Ok(None),
        1 => mapped_target_ids.remove(0),
        _ => {
            return Err(SetupError::AmbiguousLocalBackfill(
                canonical_path.to_string(),
            ))
        }
    };

    // 3. The mapped target must be THIS workspace's active coding Target
    //    with NULL repository metadata. Anything else is not the bounded
    //    case: no backfill, and the ordinary repository-first/alias
    //    semantics of ensure_server_target_with_repository handle rejection
    //    downstream (fail closed).
    let Some(target) = catalogue.iter().find(|t| t.target_id == target_id) else {
        return Ok(None);
    };
    if target.disabled || target.kind != TARGET_KIND_CODING || target.repository.is_some() {
        return Ok(None);
    }

    // 4. Server-side binding authority for THIS device: the catalogue
    //    projection must show an ACTIVE this-device binding for the exact
    //    mapped target_id. A stale local mapping after detach/unbind is
    //    never authority to backfill; a binding owned by another device
    //    never authorizes this device; and the backfill never auto-binds
    //    (missing/disabled binding => no attach, fail closed).
    let binding_active = target
        .this_device_binding
        .as_ref()
        .map(|b| b.enabled)
        .unwrap_or(false);
    if !binding_active {
        return Ok(None);
    }

    // 5. Call the bounded Server attach capability; the Server performs the
    //    attach atomically and only under its own fail-closed guards
    //    (including its independent active this-device binding check).
    let res = client
        .attach_repository(cred, &target_id, workspace_id, provider, full_name)
        .await?;
    Ok(Some(res.target.id))
}

/// Ensures the current Device binding is enabled. Active => replay/no-op;
/// missing/disabled => existing bind API. A binding created by the register
/// call itself counts as newly created.
pub(crate) async fn ensure_binding_step(
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
        directory_created: false,
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
/// Inputs are only the human alias and a concrete local path — no
/// workspace_id/target_id inputs. Generic coding setup never clones and never
/// fabricates Server repository metadata.
pub async fn ensure_coding_target(
    paths: &ConnectorPaths,
    alias: &str,
    local_path: &Path,
) -> Result<SetupTargetOutcome, SetupError> {
    ensure_coding_target_with_policy(paths, alias, local_path, CodingPathPolicy::MustExist).await
}

/// Local directory policy for generic coding setup (PROJECT-036 Slice 4).
///
/// A missing local directory must be an explicit product decision BEFORE any
/// new Server Target registration/binding mutation:
/// - [`CodingPathPolicy::MustExist`]: the local path must already be an
///   existing directory (previous behavior);
/// - [`CodingPathPolicy::CreateIfMissing`]: an absent local directory is
///   safely created first (no git init, no repo fabrication) after the user
///   explicitly confirmed creation in the frontend; the frontend never
///   performs filesystem/server mutation itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodingPathPolicy {
    MustExist,
    CreateIfMissing,
}

/// Testable variant of [`ensure_coding_target`] with an explicit local
/// directory policy. Production callers must only pass
/// [`CodingPathPolicy::CreateIfMissing`] after the user explicitly confirmed
/// creating the missing directory. The local path is validated (and with
/// [`CodingPathPolicy::CreateIfMissing`] created) BEFORE any Server Target
/// registration/binding mutation, so a missing path can never leave avoidable
/// partial Server state.
pub async fn ensure_coding_target_with_policy(
    paths: &ConnectorPaths,
    alias: &str,
    local_path: &Path,
    policy: CodingPathPolicy,
) -> Result<SetupTargetOutcome, SetupError> {
    if alias.trim().is_empty() {
        return Err(SetupError::AmbiguousAlias(alias.to_string()));
    }

    paths.ensure_dirs()?;

    // Local-path validation/creation happens FIRST: zero Server mutation
    // happens before the local directory question is resolved.
    let (canonical_path_str, directory_created) = ensure_local_directory(local_path, policy)?;

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

    // When the Server Target carries repository metadata, verify the local
    // repository with the existing shared semantics; when absent, invent
    // nothing.
    if let Some(ref repo_part) = ensured.repository {
        verify_local_repository(Path::new(&canonical_path_str), repo_part)?;
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
        directory_created,
    })
}

/// Validates (and optionally creates) the local coding directory BEFORE any
/// Server mutation:
/// - existing directory => reused (`directory_created = false`);
/// - existing non-directory or symlink => fail closed, never overwritten;
/// - absent path => with [`CodingPathPolicy::MustExist`] fail clearly; with
///   [`CodingPathPolicy::CreateIfMissing`] safely create the directory
///   (plain directory creation, no git init, no repo fabrication) and report
///   `directory_created = true` so the frontend can render honestly.
///
/// If directory creation succeeds but a later Server mutation fails, the
/// created directory is honest partial local progress; reruns converge and
/// reuse it (`directory_created = false`).
fn ensure_local_directory(
    local_path: &Path,
    policy: CodingPathPolicy,
) -> Result<(String, bool), SetupError> {
    match fs::symlink_metadata(local_path) {
        Ok(meta) => {
            let display = local_path.display().to_string();
            if meta.is_symlink() {
                return Err(SetupError::PathConflict {
                    path: display,
                    reason: "path exists and is a symlink".to_string(),
                });
            }
            if !local_path.is_dir() {
                return Err(SetupError::PathConflict {
                    path: display,
                    reason: "path exists and is not a directory".to_string(),
                });
            }
            let canonical = fs::canonicalize(local_path)?;
            Ok((canonical.to_string_lossy().to_string(), false))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match policy {
            CodingPathPolicy::MustExist => {
                Err(SetupError::PathNotFound(local_path.display().to_string()))
            }
            CodingPathPolicy::CreateIfMissing => {
                fs::create_dir_all(local_path)?;
                let canonical = fs::canonicalize(local_path)?;
                Ok((canonical.to_string_lossy().to_string(), true))
            }
        },
        Err(e) => Err(SetupError::Io(e)),
    }
}

// ---------------------------------------------------------------------------
// Read-only setup readiness view model (PROJECT-036 Slice 3)
// ---------------------------------------------------------------------------

/// Read-only view of how far the canonical Agent Runtime setup has converged
/// for this device. Used ONLY to decide onboarding UX (state-aware labels in
/// the guided setup menu and the login handoff). Doctor remains the complete
/// diagnostics/readiness authority for Git, Orca, executor availability,
/// credentials, server health, etc.; this is NOT a second Doctor.
///
/// Server state and Device-local state are intentionally different (PROJECT-036
/// Slice 4): a Server Target existing does NOT mean this Device is locally
/// configured. The view model therefore distinguishes:
/// - `server_target_exists`: the canonical Server Target exists (logical
///   workspace identity, Server-owned);
/// - `device_connected`: this Device is locally connected to it (active
///   binding + workspace default + schema-v3 local mapping + verified
///   official local checkout);
/// - `executor_ready`: this Device has a valid local execution agent
///   configured for it (Device-owned launch configuration only — never
///   provider accounts, API keys, model routing/catalogues, or Orca
///   internals);
/// - `agent_runtime_configured`: this Device can actually reach daemon
///   eligibility for the canonical runtime, i.e. local official repo +
///   active binding/default + valid executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SetupReadiness {
    /// Canonical Server Target alias `ceo-agent-runtime` exists with
    /// kind=coding and is enabled (Server-owned logical identity only).
    pub server_target_exists: bool,
    /// Server Target exists AND this Device is locally connected to it:
    /// active binding, workspace default Agent Runtime, schema-v3 local
    /// mapping, and the mapped local path verifies as the official repo.
    pub device_connected: bool,
    /// This Device has a valid local execution agent (executor) configured
    /// for the canonical runtime Target.
    pub executor_ready: bool,
    /// Full daemon eligibility for the canonical runtime on this Device:
    /// `device_connected && executor_ready`.
    pub agent_runtime_configured: bool,
}

impl SetupReadiness {
    /// Conservative onboarding decision: any missing runtime-setup fact
    /// means the device still needs guided setup.
    pub fn needs_setup(&self) -> bool {
        !self.agent_runtime_configured
    }
}

/// Probes the current Agent Runtime setup readiness. Returns Err only when
/// readiness cannot be determined (Server unreachable, invalid local state),
/// so the login handoff can keep a completed authentication successful while
/// reporting that the probe failed. Zero/multiple workspaces never invent a
/// workspace here: they simply report "not configured", and the explicit
/// setup errors surface when setup actually runs.
pub async fn assess_agent_runtime_readiness(
    paths: &ConnectorPaths,
) -> Result<SetupReadiness, SetupError> {
    let not_ready = SetupReadiness::default();

    // Logged-in bound profile (migrates/validates the schema-v3 config and
    // reuses the shared origin-mismatch semantics). Not logged in is a
    // missing fact (=> needs setup), not a probe failure.
    let profile = match load_bound_profile(paths) {
        Ok(p) => p,
        Err(ProfileError::NotLoggedIn | ProfileError::ConfigNotFound) => return Ok(not_ready),
        Err(e) => return Err(e.into()),
    };
    let cred = profile.credential;

    let client = match ConnectorClient::new(&cred.server_origin) {
        Ok(c) => c,
        Err(e) => return Err(SetupError::Client(e)),
    };

    let workspaces = match client.list_workspaces(&cred).await {
        Ok(w) => w,
        Err(e) => return Err(SetupError::Client(e)),
    };
    let workspace = match workspaces.len() {
        1 => &workspaces[0],
        _ => return Ok(not_ready),
    };

    let catalogue = match client.list_targets(&cred, Some(&workspace.id)).await {
        Ok(t) => t,
        Err(e) => return Err(SetupError::Client(e)),
    };
    let canonical = match catalogue
        .iter()
        .find(|t| t.alias == AGENT_RUNTIME_TARGET_ALIAS)
    {
        Some(t) => t,
        None => return Ok(not_ready),
    };
    if canonical.kind != TARGET_KIND_CODING || canonical.disabled {
        return Ok(not_ready);
    }

    // Server logical identity exists from here on.
    let server_target_exists = true;

    let binding_active = canonical
        .this_device_binding
        .as_ref()
        .map(|b| b.enabled)
        .unwrap_or(false);
    if !binding_active || !canonical.is_default_agent_runtime {
        return Ok(SetupReadiness {
            server_target_exists,
            ..not_ready
        });
    }

    let local = match profile.config.targets.get(&canonical.target_id) {
        Some(lt) => lt,
        None => {
            return Ok(SetupReadiness {
                server_target_exists,
                ..not_ready
            })
        }
    };
    let path = Path::new(&local.local_path);
    if !path.exists() || !path.is_dir() {
        return Ok(SetupReadiness {
            server_target_exists,
            ..not_ready
        });
    }
    if verify_local_repo_full_name(path, AGENT_RUNTIME_REPO_FULL_NAME).is_err() {
        return Ok(SetupReadiness {
            server_target_exists,
            ..not_ready
        });
    }

    // Local checkout is connected (binding + default + mapping + verified
    // official repo). Executor state is Device-owned launch configuration.
    let device_connected = true;
    let executor_ready = local.executor.is_some();

    Ok(SetupReadiness {
        server_target_exists,
        device_connected,
        executor_ready,
        agent_runtime_configured: device_connected && executor_ready,
    })
}

// ---------------------------------------------------------------------------
// Device-local executor configuration (PROJECT-036 Slice 4)
// ---------------------------------------------------------------------------

/// Typed outcome of configuring the Device-local executor for the canonical
/// Agent Runtime Target. Pure domain data: the caller owns presentation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConfigureExecutorOutcome {
    /// Immutable Server Target ID of the canonical runtime Target.
    pub target_id: String,
    /// Server-authoritative alias (equals the canonical constant).
    pub alias: String,
    /// The effective executor agent_id after this operation (the reused
    /// existing one when an executor already existed, never silently
    /// overwritten).
    pub agent_id: String,
    /// The effective executor command after this operation.
    pub command: String,
    /// true when this run wrote a new executor; false when an existing valid
    /// executor was reused (model preserved exactly).
    pub executor_created: bool,
    /// The model override in effect after this operation: None for a freshly
    /// configured executor (no model/provider/account setup here), or the
    /// existing preserved model when reusing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Reusable setup operation: configure the Device-local EXECUTOR (launch
/// configuration only) for the canonical Agent Runtime Target.
///
/// Boundary (PROJECT-036 Slice 4): this configures ONLY the local execution
/// agent needed by Connector/Orca — agent human name/id + command. It must
/// never configure provider accounts, API keys, model routing/catalogues,
/// Orca internals, or model overrides (a fresh executor is written with
/// `model = None`).
///
/// Semantics:
/// - resolves/reuses the canonical Target by Server authority (no Server
///   mutation happens in this operation);
/// - requires this Device's local mapping to already exist (the runtime
///   connect step must have run first);
/// - uses the same `state.lock` + under-lock config re-read + TARGET_IN_USE
///   safety as other local mutations;
/// - writes `LocalExecutorConfig(kind=orca_tui, agent_id, command, model=None)`;
/// - never silently overwrites an existing valid executor: it is reused and
///   reported with its existing model preserved exactly.
pub async fn configure_agent_runtime_executor(
    paths: &ConnectorPaths,
    agent_id: &str,
    command: &str,
) -> Result<ConfigureExecutorOutcome, SetupError> {
    paths.ensure_dirs()?;
    let profile = load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    // Resolve the canonical Target by Server authority (no mutation).
    let workspaces = client.list_workspaces(&cred).await?;
    let workspace = select_single_workspace(workspaces)?;
    let catalogue = client.list_targets(&cred, Some(&workspace.id)).await?;
    let canonical = catalogue
        .iter()
        .find(|t| t.alias == AGENT_RUNTIME_TARGET_ALIAS)
        .ok_or(SetupError::RuntimeTargetMissing)?;
    if canonical.kind != TARGET_KIND_CODING {
        return Err(SetupError::TargetWrongKind {
            alias: canonical.alias.clone(),
            kind: canonical.kind.clone(),
        });
    }
    if canonical.disabled {
        return Err(SetupError::TargetDisabled(canonical.target_id.clone()));
    }
    let target_id = canonical.target_id.clone();

    // The executor belongs to a Device-local mapping; the connect step must
    // have created it first.
    let existing_executor = profile
        .config
        .targets
        .get(&target_id)
        .ok_or(SetupError::RuntimeNotConnected)?
        .executor
        .clone();

    if let Some(existing) = existing_executor {
        // Never silently overwrite an existing valid executor: reuse and
        // report it, preserving the existing model exactly.
        return Ok(ConfigureExecutorOutcome {
            target_id,
            alias: canonical.alias.clone(),
            agent_id: existing.agent_id.clone(),
            command: existing
                .command
                .clone()
                .unwrap_or_else(|| existing.agent_id.clone()),
            executor_created: false,
            model: existing.model,
        });
    }

    // Validate through the existing LocalExecutorConfig validation policy.
    let executor = crate::config::LocalExecutorConfig::new(
        agent_id.trim().to_string(),
        command.trim().to_string(),
    )?;

    let _lock = acquire_state_lock(paths)?;

    // Re-checked under the lock: the active-attempt guard must never be
    // bypassed by a concurrent attempt start.
    check_target_in_use(paths, &target_id)?;

    // Re-read under the lock so concurrent set-agent/set-model changes can
    // never be overwritten by a stale snapshot.
    let mut config = match LocalConfig::load(&paths.config_file())? {
        Some(c) => c,
        None => LocalConfig::new(cred.server_origin.clone())?,
    };

    let entry = config
        .targets
        .get_mut(&target_id)
        .ok_or(SetupError::RuntimeNotConnected)?;

    // Under-lock idempotency: if a concurrent writer configured an executor
    // in the meantime, keep it (never silently overwrite).
    if let Some(existing) = entry.executor.clone() {
        return Ok(ConfigureExecutorOutcome {
            target_id,
            alias: canonical.alias.clone(),
            agent_id: existing.agent_id.clone(),
            command: existing
                .command
                .clone()
                .unwrap_or_else(|| existing.agent_id.clone()),
            executor_created: false,
            model: existing.model,
        });
    }

    entry.executor = Some(executor);
    config.save(&paths.config_file())?;
    Ok(ConfigureExecutorOutcome {
        target_id,
        alias: canonical.alias.clone(),
        agent_id: agent_id.trim().to_string(),
        command: command.trim().to_string(),
        executor_created: true,
        model: None,
    })
}

/// Configures the default agent runtime executor using logical agent ID and optional model,
/// without requiring a user-authored raw command.
pub async fn configure_agent_runtime_executor_logical(
    paths: &ConnectorPaths,
    agent_id: &str,
    model: Option<String>,
) -> Result<ConfigureExecutorOutcome, SetupError> {
    paths.ensure_dirs()?;
    let profile = load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    let workspaces = client.list_workspaces(&cred).await?;
    let workspace = select_single_workspace(workspaces)?;
    let catalogue = client.list_targets(&cred, Some(&workspace.id)).await?;
    let canonical = catalogue
        .iter()
        .find(|t| t.alias == AGENT_RUNTIME_TARGET_ALIAS)
        .ok_or(SetupError::RuntimeTargetMissing)?;
    if canonical.kind != TARGET_KIND_CODING {
        return Err(SetupError::TargetWrongKind {
            alias: canonical.alias.clone(),
            kind: canonical.kind.clone(),
        });
    }
    if canonical.disabled {
        return Err(SetupError::TargetDisabled(canonical.target_id.clone()));
    }
    let target_id = canonical.target_id.clone();

    let existing_executor = profile
        .config
        .targets
        .get(&target_id)
        .ok_or(SetupError::RuntimeNotConnected)?
        .executor
        .clone();

    if let Some(existing) = existing_executor {
        return Ok(ConfigureExecutorOutcome {
            target_id,
            alias: canonical.alias.clone(),
            agent_id: existing.agent_id.clone(),
            command: existing
                .command
                .clone()
                .unwrap_or_else(|| existing.agent_id.clone()),
            executor_created: false,
            model: existing.model,
        });
    }

    let executor = crate::config::LocalExecutorConfig::new_logical(
        agent_id.trim().to_string(),
        model.clone(),
    )?;

    let _lock = acquire_state_lock(paths)?;
    check_target_in_use(paths, &target_id)?;

    let mut config = match LocalConfig::load(&paths.config_file())? {
        Some(c) => c,
        None => LocalConfig::new(cred.server_origin.clone())?,
    };

    let entry = config
        .targets
        .get_mut(&target_id)
        .ok_or(SetupError::RuntimeNotConnected)?;

    if let Some(existing) = entry.executor.clone() {
        return Ok(ConfigureExecutorOutcome {
            target_id,
            alias: canonical.alias.clone(),
            agent_id: existing.agent_id.clone(),
            command: existing
                .command
                .clone()
                .unwrap_or_else(|| existing.agent_id.clone()),
            executor_created: false,
            model: existing.model,
        });
    }

    entry.executor = Some(executor);
    config.save(&paths.config_file())?;
    Ok(ConfigureExecutorOutcome {
        target_id,
        alias: canonical.alias.clone(),
        agent_id: agent_id.trim().to_string(),
        command: agent_id.trim().to_string(),
        executor_created: true,
        model,
    })
}

/// Bounded search for existing CEO Agent Runtime checkouts in sensible user home
/// and common code roots. Checks if the official normalized Git remote matches
/// AGENT_RUNTIME_REPO_FULL_NAME.
pub fn discover_agent_runtime_candidates(home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut to_check = Vec::new();

    // 1. Direct locations
    to_check.push(home.join(".ceo").join(AGENT_RUNTIME_TARGET_ALIAS));
    to_check.push(home.join(AGENT_RUNTIME_TARGET_ALIAS));

    // 2. Common code roots at depth 1
    let common_roots = [
        "codes",
        "code",
        "src",
        "Projects",
        "projects",
        "workspace",
        "workspaces",
        "dev",
        "git",
        "github",
        "repos",
    ];
    for root_name in &common_roots {
        let root = home.join(root_name);
        to_check.push(root.join(AGENT_RUNTIME_TARGET_ALIAS));
        if root.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&root) {
                for entry in entries.flatten() {
                    if entry.file_name() == AGENT_RUNTIME_TARGET_ALIAS {
                        to_check.push(entry.path());
                    }
                }
            }
        }
    }

    for path in to_check {
        if path.is_dir() {
            if let Ok(canonical) = std::fs::canonicalize(&path) {
                if verify_local_repo_full_name(&canonical, AGENT_RUNTIME_REPO_FULL_NAME).is_ok()
                    && !candidates.contains(&canonical)
                {
                    candidates.push(canonical);
                }
            }
        }
    }

    candidates
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
            directory_created: false,
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["target_id"], "tgt_1");
        assert_eq!(json["target_created"], true);
        assert_eq!(json["repo_cloned"], true);
        assert_eq!(json["binding_created"], false);
        assert_eq!(json["default_changed"], true);
        // Typed outcome distinguishes local directory creation vs reuse so
        // frontends can render honest partial progress.
        assert_eq!(json["directory_created"], false);
    }

    #[test]
    fn configure_executor_outcome_json_shape_is_stable() {
        let created = ConfigureExecutorOutcome {
            target_id: "tgt_1".into(),
            alias: "ceo-agent-runtime".into(),
            agent_id: "opencode".into(),
            command: "opencode".into(),
            executor_created: true,
            model: None,
        };
        let json = serde_json::to_value(&created).unwrap();
        assert_eq!(json["executor_created"], true);
        // Fresh executor has no model field at all (no model/provider setup).
        assert!(json.get("model").is_none());

        let reused = ConfigureExecutorOutcome {
            executor_created: false,
            model: Some("gpt-5".into()),
            ..created
        };
        let json = serde_json::to_value(&reused).unwrap();
        assert_eq!(json["executor_created"], false);
        assert_eq!(json["model"], "gpt-5");
    }

    #[test]
    fn readiness_state_combinations_drive_onboarding_labels() {
        // Server Target absent => install.
        let absent = SetupReadiness::default();
        assert!(!absent.server_target_exists);
        assert!(absent.needs_setup());

        // Server Target exists but Device not connected => connect.
        let server_only = SetupReadiness {
            server_target_exists: true,
            ..Default::default()
        };
        assert!(server_only.server_target_exists);
        assert!(!server_only.device_connected);
        assert!(server_only.needs_setup());

        // Connected checkout but executor missing => honest partial state.
        let no_executor = SetupReadiness {
            server_target_exists: true,
            device_connected: true,
            executor_ready: false,
            agent_runtime_configured: false,
        };
        assert!(!no_executor.agent_runtime_configured);
        assert!(no_executor.needs_setup());

        // Fully runnable device => configured.
        let ready = SetupReadiness {
            server_target_exists: true,
            device_connected: true,
            executor_ready: true,
            agent_runtime_configured: true,
        };
        assert!(!ready.needs_setup());
    }
}
