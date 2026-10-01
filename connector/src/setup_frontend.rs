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
    assess_agent_runtime_readiness, ensure_agent_runtime, ensure_coding_target, SetupError,
    SetupReadiness, SetupTargetOutcome, AGENT_RUNTIME_TARGET_ALIAS,
};

// ---------------------------------------------------------------------------
// Menu labels / exact product strings
// ---------------------------------------------------------------------------

pub const SETUP_MENU_PROMPT: &str = "Set up this computer";
pub const AGENT_RUNTIME_MENU_LABEL: &str = "Enable CEO Agent Runtime";
pub const CODING_PROJECT_MENU_LABEL: &str = "Add a coding project";
pub const FINISH_MENU_LABEL: &str = "Finish";
pub const CONFIGURED_MARK: &str = " [Configured]";
pub const SETUP_COMPLETE_LINE: &str = "Setup complete. Running doctor...";

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
    /// Editable single-line text with optional default and optional Tab
    /// filesystem path completion. Ctrl+C / Esc => [`UiError::Cancelled`].
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
        if let Some(d) = default {
            input = input.with_default(d);
        }
        if complete_paths {
            input = input.with_autocomplete(move |current: &str| {
                let suggestions: Vec<String> = complete_path(current);
                Ok::<Vec<String>, inquire::CustomUserError>(suggestions)
            });
        }
        let answer = input.prompt().map_err(map_inquire_error)?;
        Ok(answer)
    }
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
    // Validate the logged-in profile up front (actionable; the wizard never
    // runs against a logged-out device).
    load_bound_profile(paths).map_err(SetupError::from)?;

    loop {
        // Read-only readiness for the configured marker. A probe failure is
        // reported honestly and the menu stays usable unmarked.
        let configured = match assess_agent_runtime_readiness(paths).await {
            Ok(SetupReadiness {
                agent_runtime_configured,
            }) => Some(agent_runtime_configured),
            Err(e) => {
                ui.message(&format!("Could not determine current setup status: {e}"));
                None
            }
        };

        let options = vec![
            agent_runtime_menu_label(configured),
            CODING_PROJECT_MENU_LABEL.to_string(),
            FINISH_MENU_LABEL.to_string(),
        ];
        let choice = match ui.select(SETUP_MENU_PROMPT, &options) {
            Ok(i) => i,
            Err(UiError::Cancelled) => return Ok(SetupCompletion::Cancelled),
            Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
        };

        match choice {
            0 => run_agent_runtime_flow(paths, ui).await?,
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

/// Menu label for the Agent Runtime entry; the `[Configured]` marker comes
/// exclusively from the shared read-only readiness view model.
pub fn agent_runtime_menu_label(configured: Option<bool>) -> String {
    match configured {
        Some(true) => format!("{AGENT_RUNTIME_MENU_LABEL}{CONFIGURED_MARK}"),
        _ => AGENT_RUNTIME_MENU_LABEL.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Flow: Enable CEO Agent Runtime
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

async fn run_agent_runtime_flow(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
) -> Result<(), SetupFrontendError> {
    ui.message("Enable the CEO Agent Runtime for this computer.");
    let mut current_raw: Option<String> = None;

    loop {
        // 1. Path prompt with Tab completion; edit loop re-offers the last
        // accepted input as the default.
        let default = current_raw.clone().or_else(default_agent_runtime_path);
        let raw = match ui.text(
            "Path to install the CEO Agent Runtime:",
            default.as_deref(),
            true,
        ) {
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

        // 3. Concise confirmation (arrow-select; Cancel returns to menu).
        ui.message("CEO Agent Runtime");
        ui.message(&format!("Path: {}", resolved.display()));
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
                // 4. Delegate ONLY to the shared setup application service.
                match ensure_agent_runtime(paths, &resolved).await {
                    Ok(outcome) => {
                        render_outcome(ui, &outcome, true);
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

        // 3. Confirmation (arrow-select; Cancel returns to menu).
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
                // 4. Delegate ONLY to the shared setup application service.
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
        ui.message(&format!("  Local path in use: '{}'.", outcome.local_path));
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
    fn handoff_decision_covers_all_branches() {
        let ready = Ok(SetupReadiness {
            agent_runtime_configured: true,
        });
        let unready = Ok(SetupReadiness {
            agent_runtime_configured: false,
        });
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
    fn configured_marker_follows_readiness_only() {
        assert_eq!(
            agent_runtime_menu_label(Some(true)),
            format!("{AGENT_RUNTIME_MENU_LABEL}{CONFIGURED_MARK}")
        );
        assert_eq!(
            agent_runtime_menu_label(Some(false)),
            AGENT_RUNTIME_MENU_LABEL
        );
        assert_eq!(agent_runtime_menu_label(None), AGENT_RUNTIME_MENU_LABEL);
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
    }
}
