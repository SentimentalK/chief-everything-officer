//! Guided interactive setup frontend (PROJECT-036 Slice 3).
//!
//! This module is the human onboarding frontend: arrow-key + Enter menus,
//! editable filesystem path prompts with Tab completion, and the login
//! handoff into the same wizard. It is a THIN frontend over the shared
//! non-interactive setup application services in [`crate::setup`]:
//!
//! - all Server mutations (target registration, binding, cloning, default
//!   runtime, schema-v3 config writes) happen exclusively inside
//!   `setup::ensure_agent_runtime` / `setup::ensure_coding_target`;
//! - all readiness decisions come from the shared read-only view model
//!   (`setup::assess_agent_runtime_readiness`), never from CLI guesses;
//! - Finish runs the existing Doctor exactly once and mirrors its verdict
//!   into the process exit status; this module never re-implements Doctor.
//!
//! Terminal interaction is confined behind the narrow [`SetupUi`] trait so
//! deterministic tests can drive the flows with a scripted frontend while
//! production uses the real terminal prompt implementation ([`TerminalUi`],
//! backed by the small `inquire` prompt crate — no full-screen TUI, no
//! numeric-only fallback, no shell execution of any input).

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::load_bound_profile;
use crate::doctor::DoctorReport;
use crate::paths::ConnectorPaths;
use crate::setup::{
    assess_agent_runtime_readiness, configure_agent_runtime_executor, ensure_agent_runtime,
    ensure_coding_target, ensure_coding_target_with_policy, CodingPathPolicy, SetupError,
    SetupReadiness, SetupTargetOutcome, AGENT_RUNTIME_REPO_FULL_NAME, AGENT_RUNTIME_TARGET_ALIAS,
};

// ---------------------------------------------------------------------------
// Menu labels / exact product strings
// ---------------------------------------------------------------------------

pub const SETUP_MENU_PROMPT: &str = "Set up this computer";

/// State-aware runtime menu labels (PROJECT-036 Slice 4). Server state and
/// Device-local state are intentionally different: a Server Target existing
/// does NOT mean this Device is locally configured, and the wording must say
/// which one a step connects.
pub const AGENT_RUNTIME_LABEL_INSTALL: &str = "Install CEO Agent Runtime";
pub const AGENT_RUNTIME_LABEL_CONNECT: &str = "Connect CEO Agent Runtime to this computer";
pub const AGENT_RUNTIME_LABEL_BASE: &str = "CEO Agent Runtime";
pub const CONFIGURED_MARK: &str = " [Configured]";
pub const AGENT_RUNTIME_LABEL_EXECUTOR_MARK: &str = " [Execution agent required]";
/// Neutral fallback used only when the shared readiness probe itself failed
/// (no state guess is made).
pub const AGENT_RUNTIME_LABEL_UNKNOWN_STATE: &str = "Set up CEO Agent Runtime";
pub const CODING_PROJECT_MENU_LABEL: &str = "Add a coding project";
pub const FINISH_MENU_LABEL: &str = "Finish";
pub const SETUP_COMPLETE_LINE: &str = "Setup steps finished. Running doctor...";

/// Explains the Server/Device distinction when the canonical runtime Target
/// already exists Server-side: this step connects THIS computer (local
/// checkout + local execution agent), it does not recreate Server config.
pub const AGENT_RUNTIME_EXISTING_EXPLANATION: &str = "CEO Agent Runtime already exists in your workspace. This step connects this computer by choosing/reusing a local checkout and local execution agent.";
/// Prompt for the exact runtime checkout folder (not an install parent).
pub const AGENT_RUNTIME_PATH_PROMPT: &str = "CEO Agent Runtime folder:";
pub const AGENT_RUNTIME_EXISTING_CHECKOUT_PROMPT: &str =
    "Found an existing CEO Agent Runtime checkout. Use it?";
pub const AGENT_RUNTIME_DERIVED_CHILD_PROMPT: &str =
    "This folder is not a CEO Agent Runtime checkout. Use the runtime folder inside it?";
pub const AGENT_RUNTIME_CONFLICT_ERROR: &str = "This path already exists and is not a CEO Agent Runtime checkout. Setup never overwrites or deletes existing files. Choose a different folder.";

pub const EXECUTOR_EXPLAIN_LINE: &str =
    "This computer still needs a local execution agent for CEO jobs.";
pub const EXECUTOR_NAME_PROMPT: &str = "Agent name:";
pub const EXECUTOR_COMMAND_PROMPT: &str = "Agent command:";
pub const EXECUTOR_SKIPPED_LINE: &str = "Execution agent configuration skipped. This computer is not fully set up yet; Finish will run doctor and show exactly what is missing.";
pub const AGENT_COMMAND_SUGGESTION: &str = "opencode";

pub const CODING_DIR_MISSING_PROMPT: &str = "Directory does not exist. Create it?";

// ---------------------------------------------------------------------------
// UI abstraction (narrow, testable prompt boundary)
// ---------------------------------------------------------------------------

#[derive(Error, Debug)]
pub enum UiError {
    #[error("Cancelled by user")]
    Cancelled,
    #[error("Interactive prompt failed: {0}")]
    Failed(String),
}

/// Narrow prompt boundary used by the setup wizard. Production uses the
/// real terminal backend; tests use a scripted driver, so no automated test
/// depends on a real terminal.
pub trait SetupUi {
    /// Prints an informational line.
    fn message(&mut self, line: &str);
    /// Prints an error line.
    fn error(&mut self, line: &str);
    /// Arrow-key + Enter single-choice menu over `options`; returns the
    /// chosen index. Ctrl+C / Esc => [`UiError::Cancelled`]. No numeric
    /// fallback exists.
    fn select(&mut self, prompt: &str, options: &[String]) -> Result<usize, UiError>;
    /// Editable single-line text. When `default` is provided it becomes the
    /// ACTUAL initial editable buffer value (not a placeholder default), so
    /// the visible text is the real input. `complete_paths` enables Tab
    /// filesystem path completion over the current buffer. Ctrl+C / Esc =>
    /// [`UiError::Cancelled`].
    fn text(
        &mut self,
        prompt: &str,
        default: Option<&str>,
        complete_paths: bool,
    ) -> Result<String, UiError>;
}

/// Real terminal prompt backend (inquire/crossterm). Plausibly portable to
/// macOS/Windows for PROJECT-032: everything used here is cross-platform
/// prompt behavior, not OS shell scripting.
pub struct TerminalUi;

impl SetupUi for TerminalUi {
    fn message(&mut self, line: &str) {
        println!("{line}");
    }

    fn error(&mut self, line: &str) {
        eprintln!("{line}");
    }

    fn select(&mut self, prompt: &str, options: &[String]) -> Result<usize, UiError> {
        let answer = inquire::Select::new(prompt, options.to_vec())
            .with_starting_cursor(0)
            .prompt()
            .map_err(map_inquire_error)?;
        options
            .iter()
            .position(|o| o == &answer)
            .ok_or_else(|| UiError::Failed("prompt returned an unknown option".into()))
    }

    fn text(
        &mut self,
        prompt: &str,
        default: Option<&str>,
        complete_paths: bool,
    ) -> Result<String, UiError> {
        let mut input = inquire::Text::new(prompt);
        // PROJECT-036 Slice 4: the default is placed into the ACTUAL editable
        // buffer (`with_initial_value`), not a gray placeholder default. The
        // visible text is the real input, so Tab completion operates on the
        // same full intended path the user sees, and Enter accepts it as-is.
        if let Some(d) = default {
            input = input.with_initial_value(d);
        }
        if complete_paths {
            input = input.with_autocomplete(PathCompleter);
        }
        let answer = input.prompt().map_err(map_inquire_error)?;
        Ok(answer)
    }
}

/// Tab-completion autocompleter for path prompts (real `Autocomplete`
/// implementation, unlike a bare suggestions closure whose `get_completion`
/// default is a no-op). On Tab:
/// - a highlighted suggestion replaces the input verbatim;
/// - otherwise the longest common prefix of the current suggestions replaces
///   the input when it extends the typed text (terminal-like unambiguous
///   completion); otherwise the input is left unchanged.
#[derive(Clone)]
struct PathCompleter;

impl inquire::Autocomplete for PathCompleter {
    fn get_suggestions(&mut self, input: &str) -> Result<Vec<String>, inquire::CustomUserError> {
        Ok(complete_path(input))
    }

    fn get_completion(
        &mut self,
        input: &str,
        highlighted_suggestion: Option<String>,
    ) -> Result<Option<String>, inquire::CustomUserError> {
        if let Some(suggestion) = highlighted_suggestion {
            return Ok(Some(suggestion));
        }
        let suggestions = complete_path(input);
        match longest_common_prefix(&suggestions) {
            Some(prefix) if prefix.chars().count() > input.chars().count() => Ok(Some(prefix)),
            _ => Ok(None),
        }
    }
}

/// Longest common prefix of `suggestions`, compared per `char` so Unicode
/// path components are never split mid-codepoint.
fn longest_common_prefix(suggestions: &[String]) -> Option<String> {
    let mut iter = suggestions.iter();
    let first = iter.next()?;
    let mut prefix: Vec<char> = first.chars().collect();
    for suggestion in iter {
        let mut common = 0;
        for (a, b) in prefix.iter().zip(suggestion.chars()) {
            if a != &b {
                break;
            }
            common += 1;
        }
        prefix.truncate(common);
        if prefix.is_empty() {
            break;
        }
    }
    Some(prefix.into_iter().collect())
}

fn map_inquire_error(err: inquire::InquireError) -> UiError {
    match err {
        inquire::InquireError::OperationCanceled | inquire::InquireError::OperationInterrupted => {
            UiError::Cancelled
        }
        other => UiError::Failed(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Frontend errors / completion verdict
// ---------------------------------------------------------------------------

#[derive(Error, Debug)]
pub enum SetupFrontendError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Setup(#[from] SetupError),
    #[error("{0}")]
    Ui(String),
}

/// How the wizard ended. `Finished` carries the existing Doctor's verdict
/// (run exactly once at Finish); `Cancelled` is a safe exit with no new
/// mutation beyond already completed atomic/idempotent operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupCompletion {
    Finished { doctor_passed: bool },
    Cancelled,
}

/// Injectable runner for the existing Doctor. Production wires
/// [`ProductionDoctor`]; tests inject a counting/reporting stub so
/// "Finish runs Doctor exactly once" is verifiable without a terminal.
#[async_trait::async_trait]
pub trait DoctorRunner: Send + Sync {
    async fn run(&self, paths: &ConnectorPaths) -> DoctorReport;
}

pub struct ProductionDoctor;

#[async_trait::async_trait]
impl DoctorRunner for ProductionDoctor {
    async fn run(&self, paths: &ConnectorPaths) -> DoctorReport {
        crate::doctor::run_doctor(paths, false).await
    }
}

// ---------------------------------------------------------------------------
// Path helpers: tilde expansion, defaults, Tab completion
// ---------------------------------------------------------------------------

/// Expands ONLY `~` and `~/...` using the existing home-directory resolution
/// capability. `~user` style paths are rejected explicitly (never resolved).
/// Other input (absolute or relative) is returned unchanged.
pub fn expand_tilde(input: &str) -> Result<PathBuf, String> {
    expand_tilde_with_home(input, dirs::home_dir().as_deref())
}

pub fn expand_tilde_with_home(input: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if trimmed == "~" {
        let home = home.ok_or_else(|| {
            "cannot determine the home directory; enter an absolute path instead".to_string()
        })?;
        return Ok(home.to_path_buf());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = home.ok_or_else(|| {
            "cannot determine the home directory; enter an absolute path instead".to_string()
        })?;
        return Ok(home.join(rest));
    }
    if trimmed.starts_with('~') {
        return Err(
            "'~user' style home paths are not supported; use '~/', an absolute path, or a relative path"
                .to_string(),
        );
    }
    Ok(PathBuf::from(trimmed))
}

/// Default Agent Runtime install path: `${HOME}/codes/ceo-agent-runtime`,
/// or None when no home directory is available.
pub fn default_agent_runtime_path() -> Option<String> {
    default_agent_runtime_path_with_home(dirs::home_dir().as_deref())
}

pub fn default_agent_runtime_path_with_home(home: Option<&Path>) -> Option<String> {
    let home = home?;
    Some(
        home.join("codes")
            .join(AGENT_RUNTIME_TARGET_ALIAS)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Default coding project path: `${HOME}/codes/<project-name>` when home is
/// available and the name can be used safely as one path component;
/// otherwise None (no default).
pub fn default_project_path(project_name: &str) -> Option<String> {
    default_project_path_with_home(project_name, dirs::home_dir().as_deref())
}

pub fn default_project_path_with_home(project_name: &str, home: Option<&Path>) -> Option<String> {
    let name = project_name.trim();
    if !is_safe_single_path_component(name) {
        return None;
    }
    let home = home?;
    Some(home.join("codes").join(name).to_string_lossy().into_owned())
}

/// True when `name` can be used as exactly one safe filesystem path
/// component (no separators, no traversal, no NUL, no surrounding
/// whitespace). This is a PATH-safety check only; the Server Target alias
/// contract stays the sole alias authority.
pub fn is_safe_single_path_component(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed != "."
        && trimmed != ".."
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
        && !trimmed.contains('\0')
}

/// Pure filesystem Tab completion for path prompts. Never executes any
/// shell; suggestions are directory entries read directly via the filesystem
/// API. Handles absolute, relative, and `~/...` input, preserving spaces and
/// Unicode components verbatim (no shell splitting, ever).
///
/// Directories are completed with a trailing `/`; hidden entries are only
/// suggested when the typed prefix starts with a dot.
pub fn complete_path(input: &str) -> Vec<String> {
    let (head, prefix) = match input.rfind('/') {
        Some(idx) => (&input[..idx + 1], &input[idx + 1..]),
        None => ("", input),
    };

    let base: PathBuf = if head.is_empty() {
        PathBuf::from(".")
    } else if head.starts_with("~") {
        // Includes exactly "~/..." (and "~" can never be a head since a head
        // always ends with '/'); unsupported "~user" heads yield no
        // suggestions rather than a surprise filesystem hit.
        match expand_tilde(head.trim_end_matches('/')) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        }
    } else {
        PathBuf::from(head)
    };

    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };

    let mut suggestions: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            entry.path().is_dir()
                && name.starts_with(prefix)
                && (prefix.starts_with('.') || !name.starts_with('.'))
        })
        .map(|entry| format!("{head}{}", entry.file_name().to_string_lossy()) + "/")
        .collect();
    suggestions.sort();
    suggestions
}

// ---------------------------------------------------------------------------
// TTY / interactivity
// ---------------------------------------------------------------------------

/// True when both stdin and stdout are attached to a TTY, i.e. suitable for
/// interactive arrow-key prompting. Used to fail `setup` fast/actionably and
/// to keep non-interactive login runs non-blocking.
pub fn is_interactive_terminal() -> bool {
    unsafe { libc::isatty(libc::STDIN_FILENO) == 1 && libc::isatty(libc::STDOUT_FILENO) == 1 }
}

// ---------------------------------------------------------------------------
// Top-level wizard
// ---------------------------------------------------------------------------

/// Standalone `ceo-connector setup` entry: runs the wizard and translates
/// its completion into the process exit status (Doctor verdict mirror).
pub async fn run_standalone_setup(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
) -> Result<std::process::ExitCode, SetupFrontendError> {
    match run_setup_wizard(paths, ui, doctor).await? {
        SetupCompletion::Finished { doctor_passed } => {
            if doctor_passed {
                Ok(std::process::ExitCode::SUCCESS)
            } else {
                Ok(std::process::ExitCode::FAILURE)
            }
        }
        SetupCompletion::Cancelled => {
            ui.message("Setup cancelled. Resume anytime with `ceo-connector setup`.");
            Ok(std::process::ExitCode::SUCCESS)
        }
    }
}

/// The guided setup wizard: top-level menu loop over the shared setup
/// application services. All prompts go through [`SetupUi`]; all mutations
/// go through `setup::*`; Finish invokes the injected Doctor exactly once.
pub async fn run_setup_wizard(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
) -> Result<SetupCompletion, SetupFrontendError> {
    run_setup_wizard_with_probe(paths, ui, doctor, &production_executable_probe).await
}

/// Injectable probe used to offer a convenient prefilled execution-agent
/// suggestion ONLY when the executable actually exists on this machine
/// (dogfood environment uses OpenCode; this is not a global allowlist — the
/// suggestion stays fully editable).
pub type ExecutableProbe = dyn Fn(&str) -> bool + Send + Sync;

/// Production probe: checks the real PATH for the executable.
pub fn production_executable_probe(command: &str) -> bool {
    executable_in_path(command)
}

fn executable_in_path(cmd: &str) -> bool {
    let bin = cmd.split_whitespace().next().unwrap_or(cmd);
    if bin.contains('/') {
        return Path::new(bin).is_file();
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            let full = p.join(bin);
            if full.is_file() {
                return true;
            }
        }
    }
    false
}

/// Like [`run_setup_wizard`] with an injectable executable probe (tests).
pub async fn run_setup_wizard_with_probe(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
    probe: &ExecutableProbe,
) -> Result<SetupCompletion, SetupFrontendError> {
    // Validate the logged-in profile up front (actionable; the wizard never
    // runs against a logged-out device).
    load_bound_profile(paths).map_err(SetupError::from)?;

    loop {
        // Read-only readiness for the state-aware label. A probe failure is
        // reported honestly and the menu stays usable with a neutral label.
        let readiness = match assess_agent_runtime_readiness(paths).await {
            Ok(r) => Some(r),
            Err(e) => {
                ui.message(&format!("Could not determine current setup status: {e}"));
                None
            }
        };

        let options = vec![
            agent_runtime_menu_label(readiness.as_ref()),
            CODING_PROJECT_MENU_LABEL.to_string(),
            FINISH_MENU_LABEL.to_string(),
        ];
        let choice = match ui.select(SETUP_MENU_PROMPT, &options) {
            Ok(i) => i,
            Err(UiError::Cancelled) => return Ok(SetupCompletion::Cancelled),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };

        match choice {
            0 => run_agent_runtime_flow(paths, ui, readiness.as_ref(), probe).await?,
            1 => run_coding_project_flow(paths, ui).await?,
            2 => {
                ui.message(SETUP_COMPLETE_LINE);
                let report = doctor.run(paths).await;
                return Ok(SetupCompletion::Finished {
                    doctor_passed: report.overall_passed,
                });
            }
            _ => return Err(SetupFrontendError::Ui("unknown menu selection".into())),
        }
    }
}

/// State-aware menu label for the Agent Runtime entry, driven exclusively by
/// the shared read-only readiness view model (never CLI guesses):
/// - canonical Server Target absent => `Install CEO Agent Runtime`;
/// - Server Target exists but this Device is not locally connected =>
///   `Connect CEO Agent Runtime to this computer`;
/// - local checkout connected but executor missing => honest partial state
///   `CEO Agent Runtime [Execution agent required]`;
/// - local checkout + binding/default + executor ready =>
///   `CEO Agent Runtime [Configured]`.
pub fn agent_runtime_menu_label(readiness: Option<&SetupReadiness>) -> String {
    match readiness {
        None => AGENT_RUNTIME_LABEL_UNKNOWN_STATE.to_string(),
        Some(r) => match (r.server_target_exists, r.device_connected, r.executor_ready) {
            (false, _, _) => AGENT_RUNTIME_LABEL_INSTALL.to_string(),
            (true, false, _) => AGENT_RUNTIME_LABEL_CONNECT.to_string(),
            (true, true, false) => {
                format!("{AGENT_RUNTIME_LABEL_BASE}{AGENT_RUNTIME_LABEL_EXECUTOR_MARK}")
            }
            (true, true, true) => format!("{AGENT_RUNTIME_LABEL_BASE}{CONFIGURED_MARK}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Flow: Install / Connect the CEO Agent Runtime
// ---------------------------------------------------------------------------

/// Authentication/config corruption class failures where continuing setup is
/// unsafe. Everything else is treated as recoverable and returns the user to
/// the setup menu.
fn is_fatal_setup_error(err: &SetupError) -> bool {
    matches!(
        err,
        SetupError::NotLoggedIn
            | SetupError::CredentialServerMismatch { .. }
            | SetupError::Config(_)
            | SetupError::Credential(_)
    )
}

/// Read-only classification of a resolved runtime path input (PROJECT-036
/// Slice 4 path-UX contract). Pure filesystem/git inspection; never mutates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePathResolution {
    /// Absent path: the official repository can be cloned there.
    Missing,
    /// Existing verified official checkout: reuse it directly.
    VerifiedCheckout,
    /// Existing directory that itself contains a verified official checkout
    /// at the canonical child path (`<entered>/ceo-agent-runtime`): suggest
    /// that child (targeted guidance, not a generic error).
    ChildCheckout { child: PathBuf },
    /// Existing directory without the canonical child: propose the explicit
    /// derived child path for confirmation; the parent is never overwritten
    /// or deleted.
    ParentWithoutChild { child: PathBuf },
    /// Existing path that is not a verified runtime checkout: fail closed
    /// (setup never overwrites/deletes user files).
    Conflict,
}

pub fn resolve_runtime_path_input(resolved: &Path) -> RuntimePathResolution {
    match std::fs::symlink_metadata(resolved) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RuntimePathResolution::Missing,
        Ok(meta) => {
            if meta.is_symlink() || !resolved.is_dir() {
                return RuntimePathResolution::Conflict;
            }
            if verify_runtime_repo(resolved) {
                return RuntimePathResolution::VerifiedCheckout;
            }
            let child = resolved.join(AGENT_RUNTIME_TARGET_ALIAS);
            let child_exists = std::fs::symlink_metadata(&child)
                .map(|m| !m.is_symlink() && child.is_dir())
                .unwrap_or(false);
            if child_exists && verify_runtime_repo(&child) {
                RuntimePathResolution::ChildCheckout { child }
            } else if !child_exists && !is_inside_git_work_tree(resolved) {
                // A plain parent-like directory (e.g. `~/codes/`) proposes the
                // explicit derived child path; an existing unrelated git
                // repository (or any directory inside one) stays fail-closed.
                RuntimePathResolution::ParentWithoutChild { child }
            } else {
                RuntimePathResolution::Conflict
            }
        }
        Err(_) => RuntimePathResolution::Conflict,
    }
}

fn verify_runtime_repo(path: &Path) -> bool {
    crate::targets::verify_local_repo_full_name(path, AGENT_RUNTIME_REPO_FULL_NAME).is_ok()
}

/// True when `dir` is inside any Git work tree (repo toplevel or deeper).
/// Read-only probe used to keep existing unrelated repositories fail-closed
/// instead of proposing a derived child path inside them.
fn is_inside_git_work_tree(dir: &Path) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn run_agent_runtime_flow(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    readiness: Option<&SetupReadiness>,
    probe: &ExecutableProbe,
) -> Result<(), SetupFrontendError> {
    // State-aware intro: a Server Target already existing does NOT mean this
    // Device is locally configured. Explain the connect-this-computer step.
    if readiness.map(|r| r.server_target_exists).unwrap_or(false) {
        ui.message(AGENT_RUNTIME_EXISTING_EXPLANATION);
    } else {
        ui.message("Install the CEO Agent Runtime for this computer.");
    }
    let mut current_raw: Option<String> = None;

    loop {
        // 1. Path prompt for the EXACT checkout folder, with the full
        // intended default path as the actual editable buffer; Tab
        // completion operates on that visible buffer.
        let default = current_raw.clone().or_else(default_agent_runtime_path);
        let raw = match ui.text(AGENT_RUNTIME_PATH_PROMPT, default.as_deref(), true) {
            Ok(text) => text,
            Err(UiError::Cancelled) => return Ok(()),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };

        // 2. Expand ONLY ~ / ~/...; reject ~user clearly and re-prompt.
        let resolved = match expand_tilde(&raw) {
            Ok(p) if !p.as_os_str().is_empty() => p,
            Ok(_) => {
                ui.error("Path cannot be empty.");
                continue;
            }
            Err(msg) => {
                ui.error(&format!("Cannot use path '{raw}': {msg}"));
                continue;
            }
        };
        current_raw = Some(raw);

        // 3. Targeted path resolution (exact reuse / child suggestion /
        // derived child proposal / fail-closed conflict).
        let target_path: PathBuf = match resolve_runtime_path_input(&resolved) {
            RuntimePathResolution::Missing | RuntimePathResolution::VerifiedCheckout => resolved,
            RuntimePathResolution::ChildCheckout { child } => {
                ui.message(&format!(
                    "Found an existing CEO Agent Runtime checkout at '{}'.",
                    child.display()
                ));
                let options = vec![
                    "Use this checkout".to_string(),
                    "Edit path".to_string(),
                    "Cancel".to_string(),
                ];
                match ui.select(AGENT_RUNTIME_EXISTING_CHECKOUT_PROMPT, &options) {
                    Ok(0) => child,
                    Ok(1) => continue,
                    Ok(_) => return Ok(()),
                    Err(UiError::Cancelled) => return Ok(()),
                    Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                }
            }
            RuntimePathResolution::ParentWithoutChild { child } => {
                ui.message(&format!(
                    "'{}' is not a CEO Agent Runtime checkout; it was not modified.",
                    resolved.display()
                ));
                ui.message(&format!(
                    "Setup can place the runtime at '{}' by cloning the official repository there.",
                    child.display()
                ));
                let options = vec![
                    format!("Use {}", child.display()),
                    "Edit path".to_string(),
                    "Cancel".to_string(),
                ];
                match ui.select(AGENT_RUNTIME_DERIVED_CHILD_PROMPT, &options) {
                    Ok(0) => child,
                    Ok(1) => continue,
                    Ok(_) => return Ok(()),
                    Err(UiError::Cancelled) => return Ok(()),
                    Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                }
            }
            RuntimePathResolution::Conflict => {
                ui.error(AGENT_RUNTIME_CONFLICT_ERROR);
                let options = vec!["Edit path".to_string(), "Cancel".to_string()];
                match ui.select("How would you like to proceed?", &options) {
                    Ok(0) => continue,
                    Ok(_) => return Ok(()),
                    Err(UiError::Cancelled) => return Ok(()),
                    Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                }
            }
        };
        current_raw = Some(target_path.to_string_lossy().into_owned());

        // 4. Concise confirmation (arrow-select; Cancel returns to menu).
        ui.message("CEO Agent Runtime");
        ui.message(&format!("Path: {}", target_path.display()));
        let confirm = vec![
            "Continue".to_string(),
            "Edit path".to_string(),
            "Cancel".to_string(),
        ];
        let choice = match ui.select("Confirm the Agent Runtime install path", &confirm) {
            Ok(i) => i,
            Err(UiError::Cancelled) => return Ok(()),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };
        match choice {
            0 => {
                // 5. Delegate ONLY to the shared setup application service.
                match ensure_agent_runtime(paths, &target_path).await {
                    Ok(outcome) => {
                        render_outcome(ui, &outcome, true);
                        // 6. Fresh-device executor onboarding: close the
                        // Doctor/runnability gap with a minimal local launch
                        // configuration (agent name + command only).
                        let needs_executor = match assess_agent_runtime_readiness(paths).await {
                            Ok(r) => r.device_connected && !r.executor_ready,
                            Err(_) => false,
                        };
                        if needs_executor {
                            let configured = run_executor_config_flow(paths, ui, probe).await?;
                            if !configured {
                                ui.message(EXECUTOR_SKIPPED_LINE);
                            }
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        if is_fatal_setup_error(&e) {
                            return Err(e.into());
                        }
                        ui.error(&format!("Could not set up the CEO Agent Runtime: {e}"));
                        return Ok(());
                    }
                }
            }
            1 => continue,      // edit path: no mutation
            _ => return Ok(()), // cancel: back to top-level menu
        }
    }
}

/// Executor onboarding sub-flow (Device-local launch configuration ONLY):
/// prompts for the human agent name and command (never a target UUID) and
/// delegates to the shared `configure_agent_runtime_executor` core. Returns
/// `Ok(false)` when the user cancels — the runtime stays explicitly
/// incomplete and Finish/Doctor will report it honestly.
async fn run_executor_config_flow(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    probe: &ExecutableProbe,
) -> Result<bool, SetupFrontendError> {
    ui.message(EXECUTOR_EXPLAIN_LINE);
    // Convenient prefilled suggestion ONLY when the executable actually
    // exists on this machine; always editable; never a global allowlist.
    let suggestion = if probe(AGENT_COMMAND_SUGGESTION) {
        Some(AGENT_COMMAND_SUGGESTION)
    } else {
        None
    };

    loop {
        let name_raw = match ui.text(EXECUTOR_NAME_PROMPT, suggestion, false) {
            Ok(text) => text,
            Err(UiError::Cancelled) => return Ok(false),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };
        let name = name_raw.trim().to_string();
        if name.is_empty() {
            ui.error("Agent name cannot be empty.");
            continue;
        }

        let command_raw = match ui.text(EXECUTOR_COMMAND_PROMPT, suggestion, false) {
            Ok(text) => text,
            Err(UiError::Cancelled) => return Ok(false),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };
        let command = command_raw.trim().to_string();
        if command.is_empty() {
            ui.error("Agent command cannot be empty.");
            continue;
        }

        match configure_agent_runtime_executor(paths, &name, &command).await {
            Ok(outcome) => {
                render_executor_outcome(ui, &outcome);
                return Ok(true);
            }
            Err(e) => {
                if is_fatal_setup_error(&e) {
                    return Err(e.into());
                }
                // Recoverable validation/domain error: re-prompt honestly.
                ui.error(&format!("Could not configure the execution agent: {e}"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Flow: Add a coding project
// ---------------------------------------------------------------------------

async fn run_coding_project_flow(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
) -> Result<(), SetupFrontendError> {
    ui.message("Add a coding project for this computer.");
    let mut name: Option<String> = None;
    let mut resolved: Option<PathBuf> = None;

    loop {
        // 1. Project name (exact Server Target alias; the Server/setup core
        // alias contract is the only validation policy).
        if name.is_none() {
            let raw = match ui.text("Project name:", None, false) {
                Ok(text) => text,
                Err(UiError::Cancelled) => return Ok(()),
                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
            };
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                ui.error("Project name cannot be empty.");
                continue;
            }
            name = Some(trimmed);
        }
        let name_value = name.clone().unwrap_or_default();

        // 2. Project directory with Tab completion; default
        // `${HOME}/codes/<name>` when the name is a safe path component.
        if resolved.is_none() {
            let default = default_project_path(&name_value);
            let raw = match ui.text("Project directory:", default.as_deref(), true) {
                Ok(text) => text,
                Err(UiError::Cancelled) => return Ok(()),
                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
            };
            let expanded = match expand_tilde(&raw) {
                Ok(p) if !p.as_os_str().is_empty() => Some(p),
                Ok(_) => {
                    ui.error("Path cannot be empty.");
                    None
                }
                Err(msg) => {
                    ui.error(&format!("Cannot use path '{raw}': {msg}"));
                    None
                }
            };
            match expanded {
                Some(p) => resolved = Some(p),
                None => {
                    name = None; // re-enter name together with the path
                    continue;
                }
            }
        }
        let path_value = resolved.clone().unwrap_or_default();

        // 3. Missing directory is a PRODUCT FLOW, not a late error (PROJECT-036
        // Slice 4): decide BEFORE any Server Target registration/binding
        // mutation. The frontend performs read-only checks only; every
        // filesystem/server mutation is delegated to the shared core.
        let policy = match std::fs::symlink_metadata(&path_value) {
            Ok(meta) if meta.is_symlink() || !path_value.is_dir() => {
                ui.error(&format!(
                    "Path '{}' exists but is not a directory. Setup never overwrites or deletes existing files.",
                    path_value.display()
                ));
                let options = vec!["Edit path".to_string(), "Cancel".to_string()];
                match ui.select("How would you like to proceed?", &options) {
                    Ok(0) => {
                        resolved = None;
                        continue;
                    }
                    Ok(_) => return Ok(()),
                    Err(UiError::Cancelled) => return Ok(()),
                    Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                }
            }
            Ok(_) => CodingPathPolicy::MustExist,
            Err(_) => CodingPathPolicy::CreateIfMissing,
        };

        if policy == CodingPathPolicy::CreateIfMissing {
            ui.message(&format!("Path: {}", path_value.display()));
            let options = vec![
                "Create".to_string(),
                "Edit path".to_string(),
                "Cancel".to_string(),
            ];
            match ui.select(CODING_DIR_MISSING_PROMPT, &options) {
                Ok(0) => {
                    // Create confirmed: delegate to the shared setup
                    // application core, which safely creates the directory
                    // and then performs the exact-alias ensure/bind/mapping.
                    match ensure_coding_target_with_policy(
                        paths,
                        &name_value,
                        &path_value,
                        CodingPathPolicy::CreateIfMissing,
                    )
                    .await
                    {
                        Ok(outcome) => {
                            render_outcome(ui, &outcome, false);
                            return Ok(());
                        }
                        Err(e) => {
                            if is_fatal_setup_error(&e) {
                                return Err(e.into());
                            }
                            ui.error(&format!("Could not add the coding project: {e}"));
                            let options = vec![
                                "Edit name".to_string(),
                                "Edit path".to_string(),
                                "Back to setup menu".to_string(),
                            ];
                            match ui.select("How would you like to proceed?", &options) {
                                Ok(0) => name = None,
                                Ok(1) => resolved = None,
                                Err(UiError::Cancelled) => return Ok(()),
                                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                                _ => return Ok(()),
                            }
                        }
                    }
                }
                Ok(_) | Err(UiError::Cancelled) => return Ok(()), // cancel/edit exit: zero Server mutation
                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
            }
        } else {
            // 4. Existing directory: confirmation (arrow-select; Cancel
            // returns to menu), then the shared core with MustExist policy.
            ui.message("Coding project");
            ui.message(&format!("Name: {name_value}"));
            ui.message(&format!("Path: {}", path_value.display()));
            let confirm = vec![
                "Create / Bind".to_string(),
                "Edit name".to_string(),
                "Edit path".to_string(),
                "Cancel".to_string(),
            ];
            let choice = match ui.select("Confirm the coding project", &confirm) {
                Ok(i) => i,
                Err(UiError::Cancelled) => return Ok(()),
                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
            };
            match choice {
                0 => {
                    match ensure_coding_target(paths, &name_value, &path_value).await {
                        Ok(outcome) => {
                            render_outcome(ui, &outcome, false);
                            return Ok(());
                        }
                        Err(e) => {
                            if is_fatal_setup_error(&e) {
                                return Err(e.into());
                            }
                            // Recoverable input/domain error: correct it without
                            // restarting the whole setup process.
                            ui.error(&format!("Could not add the coding project: {e}"));
                            let options = vec![
                                "Edit name".to_string(),
                                "Edit path".to_string(),
                                "Back to setup menu".to_string(),
                            ];
                            match ui.select("How would you like to proceed?", &options) {
                                Ok(0) => name = None,
                                Ok(1) => resolved = None,
                                Err(UiError::Cancelled) => return Ok(()),
                                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                                _ => return Ok(()),
                            }
                        }
                    }
                }
                1 => name = None,
                2 => resolved = None,
                _ => return Ok(()), // cancel: back to top-level menu
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Typed outcome rendering (no raw IDs by default)
// ---------------------------------------------------------------------------

fn render_outcome(ui: &mut dyn SetupUi, outcome: &SetupTargetOutcome, is_runtime: bool) {
    ui.message("Setup step completed successfully:");
    ui.message(&format!(
        "  {} '{}' {}.",
        if is_runtime {
            "Agent Runtime target"
        } else {
            "Coding project target"
        },
        outcome.alias,
        if outcome.target_created {
            "was created"
        } else {
            "already existed and was reused"
        },
    ));
    if is_runtime {
        ui.message(&format!(
            "  Local repository {} at '{}'.",
            if outcome.repo_cloned {
                "cloned"
            } else {
                "reused (existing verified copy)"
            },
            outcome.local_path,
        ));
    } else {
        // Honest local-directory provenance: created vs reused.
        ui.message(&format!(
            "  Local directory {} at '{}'.",
            if outcome.directory_created {
                "created"
            } else {
                "reused (existing directory)"
            },
            outcome.local_path,
        ));
    }
    ui.message(&format!(
        "  This device is {} it.",
        if outcome.binding_created {
            "now bound to"
        } else {
            "already bound to"
        },
    ));
    if is_runtime {
        ui.message(&format!(
            "  Workspace default Agent Runtime {}.",
            if outcome.default_changed {
                "set to this target"
            } else {
                "already set to this target"
            },
        ));
    }
}

fn render_executor_outcome(ui: &mut dyn SetupUi, outcome: &crate::setup::ConfigureExecutorOutcome) {
    if outcome.executor_created {
        ui.message(&format!(
            "Execution agent configured for '{}': agent '{}' (command '{}').",
            outcome.alias, outcome.agent_id, outcome.command
        ));
    } else {
        // Never silently overwritten: the existing executor was reused.
        ui.message(&format!(
            "Execution agent for '{}' was already configured: agent '{}' (command '{}'); it was reused unchanged.",
            outcome.alias, outcome.agent_id, outcome.command
        ));
    }
    if outcome.model.is_some() {
        ui.message("  Existing model override preserved.");
    }
}

// ---------------------------------------------------------------------------
// Login handoff
// ---------------------------------------------------------------------------

/// Typed decision for the post-login setup handoff (pure, testable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffAction {
    EnterWizard,
    AlreadyConfigured,
    NonInteractive,
    ProbeFailed,
    DisabledByFlag,
}

/// Pure handoff decision. Never invents a workspace and never converts
/// readiness-probe failures into login failures.
pub fn login_handoff_action(
    no_setup: bool,
    interactive: bool,
    readiness: &Result<SetupReadiness, SetupError>,
) -> HandoffAction {
    if no_setup {
        return HandoffAction::DisabledByFlag;
    }
    if !interactive {
        return HandoffAction::NonInteractive;
    }
    match readiness {
        Ok(r) if r.needs_setup() => HandoffAction::EnterWizard,
        Ok(_) => HandoffAction::AlreadyConfigured,
        Err(_) => HandoffAction::ProbeFailed,
    }
}

/// Post-login onboarding handoff. Runs after a successful authentication
/// (fresh or reused credential); NEVER invalidates that success:
/// - `--no-setup` => no wizard, login finishes normally;
/// - non-interactive stdin/stdout => no prompts, next-step message only;
/// - readiness probe failure (e.g. Server unavailable) => actionable message
///   to run `ceo-connector setup` later; authentication stays successful;
/// - needs_setup => one concise handoff line, then the SAME setup frontend
///   used by `ceo-connector setup` (Finish/Doctor exit semantics apply).
///
/// Returns `Some(completion)` only when the wizard actually ran; `None`
/// means login should simply finish successfully.
pub async fn post_login_handoff(
    paths: &ConnectorPaths,
    no_setup: bool,
    interactive: bool,
    ui: &mut dyn SetupUi,
) -> Result<Option<SetupCompletion>, SetupFrontendError> {
    if no_setup {
        return Ok(None);
    }
    if !interactive {
        ui.message("Run `ceo-connector setup` in an interactive terminal to finish device setup.");
        return Ok(None);
    }

    let readiness = assess_agent_runtime_readiness(paths).await;
    match login_handoff_action(no_setup, interactive, &readiness) {
        HandoffAction::EnterWizard => {
            ui.message("This device has not finished setup yet. Starting guided setup...");
            let completion = run_setup_wizard(paths, ui, &ProductionDoctor).await?;
            Ok(Some(completion))
        }
        HandoffAction::ProbeFailed => {
            ui.message(&format!(
                "Could not check setup readiness: {}. Run `ceo-connector setup` once the Server is reachable.",
                readiness.unwrap_err()
            ));
            Ok(None)
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Unit tests (pure helpers; no terminal)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::AGENT_RUNTIME_REPO_CLONE_URL;
    use inquire::Autocomplete;

    #[test]
    fn expand_tilde_supports_home_and_tilde_slash_forms() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_tilde_with_home("~", Some(home)).unwrap(),
            PathBuf::from("/home/u")
        );
        assert_eq!(
            expand_tilde_with_home("~/codes/x", Some(home)).unwrap(),
            PathBuf::from("/home/u/codes/x")
        );
        assert_eq!(
            expand_tilde_with_home("~/", Some(home)).unwrap(),
            PathBuf::from("/home/u")
        );
        // Absolute and relative paths pass through unchanged.
        assert_eq!(
            expand_tilde_with_home("/opt/x", Some(home)).unwrap(),
            PathBuf::from("/opt/x")
        );
        assert_eq!(
            expand_tilde_with_home("rel/dir", Some(home)).unwrap(),
            PathBuf::from("rel/dir")
        );
    }

    #[test]
    fn expand_tilde_rejects_user_style_and_empty_input() {
        let home = Path::new("/home/u");
        let err = expand_tilde_with_home("~other/x", Some(home)).unwrap_err();
        assert!(err.contains("~user"));
        assert!(expand_tilde_with_home("", Some(home)).is_err());
        assert!(expand_tilde_with_home("   ", Some(home)).is_err());
    }

    #[test]
    fn expand_tilde_without_home_fails_actionably() {
        let err = expand_tilde_with_home("~/x", None).unwrap_err();
        assert!(err.contains("absolute path"));
        // `~` alone has the same actionable failure.
        assert!(expand_tilde_with_home("~", None).is_err());
    }

    #[test]
    fn default_agent_runtime_path_uses_home_codes() {
        let p = default_agent_runtime_path_with_home(Some(Path::new("/home/u"))).unwrap();
        assert_eq!(p, "/home/u/codes/ceo-agent-runtime");
        assert!(default_agent_runtime_path_with_home(None).is_none());
    }

    #[test]
    fn default_project_path_requires_safe_single_component() {
        let home = Path::new("/home/u");
        assert_eq!(
            default_project_path_with_home("my-app", Some(home)).unwrap(),
            "/home/u/codes/my-app"
        );
        // Unsafe names: no default rather than an invented path.
        for bad in ["", "  ", ".", "..", "a/b", "a\\b", "..\\x"] {
            assert!(
                default_project_path_with_home(bad, Some(home)).is_none(),
                "name {bad:?} must not produce a default path"
            );
        }
        // Surrounding whitespace is trimmed before the safety check.
        assert_eq!(
            default_project_path_with_home(" spaced ", Some(home)).unwrap(),
            "/home/u/codes/spaced"
        );
        assert!(default_project_path_with_home("my-app", None).is_none());
    }

    #[test]
    fn path_completion_handles_nested_spaces_unicode_without_shell() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let base_str = base.display().to_string();
        let names = ["codes", "my dir", "uni\u{301}code-dir", ".hidden"];
        for name in names {
            std::fs::create_dir_all(base.join(name)).unwrap();
        }
        std::fs::create_dir_all(base.join("codes").join("nested")).unwrap();

        // Listing a directory (trailing slash) completes its children;
        // hidden entries stay excluded for a non-dot prefix.
        assert_eq!(
            complete_path(&format!("{base_str}/")),
            vec![
                format!("{base_str}/codes/"),
                format!("{base_str}/my dir/"),
                format!("{base_str}/uni\u{301}code-dir/"),
            ]
        );
        // Prefix match preserves the typed head verbatim.
        assert_eq!(
            complete_path(&format!("{base_str}/co")),
            vec![format!("{base_str}/codes/")]
        );
        // Spaces and Unicode survive without shell splitting.
        assert_eq!(
            complete_path(&format!("{base_str}/my dir")),
            vec![format!("{base_str}/my dir/")]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/uni\u{301}")),
            vec![format!("{base_str}/uni\u{301}code-dir/")]
        );
        // Trailing slash lists the directory's children.
        assert_eq!(
            complete_path(&format!("{base_str}/codes/")),
            vec![format!("{base_str}/codes/nested/")]
        );
        // Hidden entries only appear when explicitly requested.
        assert_eq!(
            complete_path(&format!("{base_str}/.hidd")),
            vec![format!("{base_str}/.hidden/")]
        );
        // Files are never suggested (directories only).
        std::fs::write(base.join("file.txt"), "x").unwrap();
        assert!(complete_path(&format!("{base_str}/file")).is_empty());
        // Nonexistent base yields no suggestions and never executes anything.
        assert!(complete_path("/definitely/not/here/x").is_empty());
    }

    #[test]
    fn path_completer_tab_applies_highlighted_suggestion() {
        let mut completer = PathCompleter;
        // A highlighted suggestion is applied verbatim, even when a longer
        // unambiguous prefix would also be possible.
        let completion = completer
            .get_completion("~/co", Some("~/codes/".into()))
            .unwrap();
        assert_eq!(completion, Some("~/codes/".to_string()));
    }

    #[test]
    fn path_completer_tab_extends_unambiguous_prefix_without_highlight() {
        let temp = tempfile::tempdir().unwrap();
        let base_str = temp.path().display().to_string();
        for name in ["alpha", "alphabet"] {
            std::fs::create_dir_all(temp.path().join(name)).unwrap();
        }
        let mut completer = PathCompleter;

        // No highlight: Tab extends the input to the longest common prefix.
        let input = format!("{base_str}/al");
        let completion = completer.get_completion(&input, None).unwrap();
        assert_eq!(completion, Some(format!("{base_str}/alpha")));

        // A single suggestion is applied fully (it extends the input).
        let input = format!("{base_str}/alphabet");
        let completion = completer.get_completion(&input, None).unwrap();
        assert_eq!(completion, Some(format!("{base_str}/alphabet/")));

        // Input already equals the common prefix: no replacement.
        let input = format!("{base_str}/alpha");
        let completion = completer.get_completion(&input, None).unwrap();
        assert_eq!(completion, None);
    }

    #[test]
    fn path_completer_tab_without_suggestions_is_noop() {
        let mut completer = PathCompleter;
        assert_eq!(
            completer
                .get_completion("/definitely/not/here/x", None)
                .unwrap(),
            None
        );
    }

    #[test]
    fn longest_common_prefix_is_char_safe_for_unicode() {
        let a = "uni\u{301}code-dir/".to_string();
        let b = "uni\u{301}x/".to_string();
        assert_eq!(
            longest_common_prefix(&[a, b]).unwrap(),
            "uni\u{301}".to_string()
        );
        assert_eq!(longest_common_prefix(&[]), None);
        assert_eq!(
            longest_common_prefix(&["only/".to_string()]).unwrap(),
            "only/"
        );
    }

    #[test]
    fn handoff_decision_covers_all_branches() {
        let ready = Ok(SetupReadiness {
            server_target_exists: true,
            device_connected: true,
            executor_ready: true,
            agent_runtime_configured: true,
        });
        let unready = Ok(SetupReadiness::default());
        let probe_failed = Err(SetupError::GitNotFound);

        assert_eq!(
            login_handoff_action(true, true, &unready),
            HandoffAction::DisabledByFlag
        );
        assert_eq!(
            login_handoff_action(false, false, &unready),
            HandoffAction::NonInteractive
        );
        assert_eq!(
            login_handoff_action(false, true, &unready),
            HandoffAction::EnterWizard
        );
        assert_eq!(
            login_handoff_action(false, true, &ready),
            HandoffAction::AlreadyConfigured
        );
        assert_eq!(
            login_handoff_action(false, true, &probe_failed),
            HandoffAction::ProbeFailed
        );
    }

    #[test]
    fn runtime_menu_label_is_state_aware() {
        // Probe failed: neutral label, no state guess.
        assert_eq!(
            agent_runtime_menu_label(None),
            AGENT_RUNTIME_LABEL_UNKNOWN_STATE
        );
        // Server Target absent => Install.
        assert_eq!(
            agent_runtime_menu_label(Some(&SetupReadiness::default())),
            AGENT_RUNTIME_LABEL_INSTALL
        );
        // Server Target exists but Device not connected => Connect this
        // computer (no ambiguous Enable wording, no server recreation).
        assert_eq!(
            agent_runtime_menu_label(Some(&SetupReadiness {
                server_target_exists: true,
                ..Default::default()
            })),
            AGENT_RUNTIME_LABEL_CONNECT
        );
        // Connected checkout but executor missing => honest partial state.
        assert_eq!(
            agent_runtime_menu_label(Some(&SetupReadiness {
                server_target_exists: true,
                device_connected: true,
                executor_ready: false,
                agent_runtime_configured: false,
            })),
            format!("{AGENT_RUNTIME_LABEL_BASE}{AGENT_RUNTIME_LABEL_EXECUTOR_MARK}")
        );
        // Fully runnable device => [Configured].
        assert_eq!(
            agent_runtime_menu_label(Some(&SetupReadiness {
                server_target_exists: true,
                device_connected: true,
                executor_ready: true,
                agent_runtime_configured: true,
            })),
            format!("{AGENT_RUNTIME_LABEL_BASE}{CONFIGURED_MARK}")
        );
    }

    #[test]
    fn runtime_path_resolution_matches_contract() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();

        // Absent path => clone destination.
        assert_eq!(
            resolve_runtime_path_input(&base.join("absent")),
            RuntimePathResolution::Missing
        );

        // Existing verified official checkout => reuse directly.
        let repo = base.join("ceo-agent-runtime");
        init_test_runtime_repo(&repo);
        assert_eq!(
            resolve_runtime_path_input(&repo),
            RuntimePathResolution::VerifiedCheckout
        );

        // Parent-like directory containing the verified canonical child =>
        // targeted child suggestion.
        let parent = base.join("codes");
        std::fs::create_dir_all(&parent).unwrap();
        let child = parent.join(AGENT_RUNTIME_TARGET_ALIAS);
        init_test_runtime_repo(&child);
        assert_eq!(
            resolve_runtime_path_input(&parent),
            RuntimePathResolution::ChildCheckout {
                child: child.clone()
            }
        );

        // Parent-like directory without the canonical child => propose the
        // derived child path (never silently overwrite the parent).
        let empty_parent = base.join("elsewhere");
        std::fs::create_dir_all(&empty_parent).unwrap();
        assert_eq!(
            resolve_runtime_path_input(&empty_parent),
            RuntimePathResolution::ParentWithoutChild {
                child: empty_parent.join(AGENT_RUNTIME_TARGET_ALIAS)
            }
        );

        // Conflicting existing path (non-runtime file/repo) => fail closed.
        let file = base.join("plain-file.txt");
        std::fs::write(&file, "user data\n").unwrap();
        assert_eq!(
            resolve_runtime_path_input(&file),
            RuntimePathResolution::Conflict
        );
        let wrong_repo = base.join("wrong-repo");
        std::fs::create_dir_all(&wrong_repo).unwrap();
        git_init(&wrong_repo);
        git_remote(&wrong_repo, "https://github.com/other/wrong.git");
        assert_eq!(
            resolve_runtime_path_input(&wrong_repo),
            RuntimePathResolution::Conflict
        );

        // Child exists but is NOT the official checkout => still fail closed.
        let bad_child_parent = base.join("conflicting");
        std::fs::create_dir_all(bad_child_parent.join(AGENT_RUNTIME_TARGET_ALIAS)).unwrap();
        git_init(&bad_child_parent.join(AGENT_RUNTIME_TARGET_ALIAS));
        git_remote(
            &bad_child_parent.join(AGENT_RUNTIME_TARGET_ALIAS),
            "https://github.com/other/wrong.git",
        );
        assert_eq!(
            resolve_runtime_path_input(&bad_child_parent),
            RuntimePathResolution::Conflict
        );
    }

    fn git_init(dir: &Path) {
        let status = std::process::Command::new("git")
            .args(["init", "-b", "master"])
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn git_remote(dir: &Path, url: &str) {
        let status = std::process::Command::new("git")
            .args(["remote", "add", "origin", url])
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn init_test_runtime_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        git_init(path);
        git_remote(path, AGENT_RUNTIME_REPO_CLONE_URL);
        std::fs::write(path.join("README.md"), "fixture\n").unwrap();
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=t",
                "add",
                ".",
            ])
            .current_dir(path)
            .status()
            .unwrap();
        assert!(status.success());
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn executable_probe_checks_path_without_shell() {
        // `git` is guaranteed present in the test environment; a nonsense
        // binary is not.
        assert!(executable_in_path("git"));
        assert!(!executable_in_path("definitely-not-a-real-binary-xyz"));
    }

    #[test]
    fn fatal_setup_errors_are_the_auth_config_corruption_class() {
        assert!(is_fatal_setup_error(&SetupError::NotLoggedIn));
        assert!(is_fatal_setup_error(
            &SetupError::CredentialServerMismatch {
                expected: "a".into(),
                actual: "b".into(),
            }
        ));
        assert!(!is_fatal_setup_error(&SetupError::PathNotFound(
            "/x".into()
        )));
        assert!(!is_fatal_setup_error(&SetupError::AmbiguousAlias(
            "x".into()
        )));
        assert!(!is_fatal_setup_error(&SetupError::RuntimeNotConnected));
    }
}
