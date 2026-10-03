//! Guided interactive setup frontend (convergence).
//!
//! Convergence setup:
//! - Pre-flight checks: login, Git, Orca status.
//! - Runtime Device mapping resolution:
//!   * Verify/reuse if existing valid runtime mapping exists.
//!   * Explicit `--runtime-path`: validate and link.
//!   * Candidate discovery:
//!     - Exactly one verified official checkout => auto-link without prompt.
//!     - Multiple checkouts => concise failure requiring explicit `--runtime-path`.
//!     - Zero checkouts => propose `~/.ceo/ceo-agent-runtime`, with one yes/change-path decision.
//! - Runtime Agent preference:
//!   * Preserve existing configured logical Agent.
//!   * Otherwise configure default logical agent ("auto" or compact Orca-derived selector).
//!   * Never prompt for raw commands.
//! - Finish runs Doctor exactly once and mirrors its verdict.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::config::load_bound_profile;
use crate::doctor::DoctorReport;
use crate::paths::ConnectorPaths;
use crate::setup::{
    assess_agent_runtime_readiness, ensure_agent_runtime, SetupError, SetupReadiness,
    SetupTargetOutcome, AGENT_RUNTIME_REPO_FULL_NAME, AGENT_RUNTIME_TARGET_ALIAS,
};

// ---------------------------------------------------------------------------
// Constants / exact product strings
// ---------------------------------------------------------------------------

pub const SETUP_COMPLETE_LINE: &str = "Setup steps finished. Running doctor...";
pub const AGENT_RUNTIME_PATH_PROMPT: &str = "CEO Agent Runtime folder:";
pub const AGENT_RUNTIME_CONFLICT_ERROR: &str = "This path already exists and is not a CEO Agent Runtime checkout. Setup never overwrites or deletes existing files. Choose a different folder.";

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

/// Narrow prompt boundary used by setup. Production uses the real terminal
/// backend; tests use a scripted driver.
pub trait SetupUi {
    /// Prints an informational line.
    fn message(&mut self, line: &str);
    /// Prints an error line.
    fn error(&mut self, line: &str);
    /// Arrow-key + Enter single-choice menu over `options`; returns the chosen index.
    fn select(&mut self, prompt: &str, options: &[String]) -> Result<usize, UiError>;
    /// Editable single-line text with optional initial value and path completion.
    fn text(
        &mut self,
        prompt: &str,
        default: Option<&str>,
        complete_paths: bool,
    ) -> Result<String, UiError>;
}

/// Real terminal prompt backend (inquire/crossterm).
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
            input = input.with_initial_value(d);
        }
        if complete_paths {
            input = input.with_autocomplete(PathCompleter);
        }
        let answer = input.prompt().map_err(map_inquire_error)?;
        Ok(answer)
    }
}

/// Tab-completion autocompleter for path prompts.
#[derive(Clone)]
pub struct PathCompleter;

impl inquire::Autocomplete for PathCompleter {
    fn get_suggestions(&mut self, _input: &str) -> Result<Vec<String>, inquire::CustomUserError> {
        // Do NOT render passive directory-entry lists below the prompt while typing.
        Ok(Vec::new())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupCompletion {
    Finished { doctor_passed: bool },
    Cancelled,
}

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

/// Proposed Agent Runtime install path when no candidate is found:
/// `${HOME}/.ceo/ceo-agent-runtime`, or None when no home directory is available.
pub fn default_agent_runtime_path() -> Option<String> {
    default_agent_runtime_path_with_home(dirs::home_dir().as_deref())
}

pub fn default_agent_runtime_path_with_home(home: Option<&Path>) -> Option<String> {
    let home = home?;
    Some(
        home.join(".ceo")
            .join(AGENT_RUNTIME_TARGET_ALIAS)
            .to_string_lossy()
            .into_owned(),
    )
}

pub fn complete_path(input: &str) -> Vec<String> {
    let (head, prefix) = match input.rfind('/') {
        Some(idx) => (&input[..idx + 1], &input[idx + 1..]),
        None => ("", input),
    };

    let base: PathBuf = if head.is_empty() {
        PathBuf::from(".")
    } else if head.starts_with('~') {
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
// TTY / interactivity / executable discovery
// ---------------------------------------------------------------------------

pub fn is_interactive_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

pub fn executable_in_path(cmd: &str) -> bool {
    let bin = cmd.split_whitespace().next().unwrap_or(cmd);
    if bin.contains('/') || bin.contains('\\') {
        return Path::new(bin).is_file();
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            if executable_in_dir(&p, bin) {
                return true;
            }
        }
    }
    false
}

fn executable_in_dir(dir: &Path, bin: &str) -> bool {
    if dir.join(bin).is_file() {
        return true;
    }
    #[cfg(windows)]
    {
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if ext.is_empty() || !ext.starts_with('.') {
                continue;
            }
            if dir.join(format!("{bin}{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Runtime Path Resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePathResolution {
    Missing,
    VerifiedCheckout,
    ChildCheckout { child: PathBuf },
    ParentWithoutChild { child: PathBuf },
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

fn is_inside_git_work_tree(dir: &Path) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_fatal_setup_error(err: &SetupError) -> bool {
    matches!(
        err,
        SetupError::NotLoggedIn
            | SetupError::CredentialServerMismatch { .. }
            | SetupError::Config(_)
            | SetupError::Credential(_)
    )
}

fn render_outcome(ui: &mut dyn SetupUi, outcome: &SetupTargetOutcome) {
    ui.message("Setup step completed successfully:");
    ui.message(&format!(
        "  Agent Runtime target '{}' {}.",
        outcome.alias,
        if outcome.target_created {
            "was created"
        } else {
            "already existed and was reused"
        },
    ));
    ui.message(&format!(
        "  Local repository {} at '{}'.",
        if outcome.repo_cloned {
            "cloned"
        } else {
            "reused (existing verified copy)"
        },
        outcome.local_path,
    ));
    ui.message(&format!(
        "  This device is {} it.",
        if outcome.binding_created {
            "now bound to"
        } else {
            "already bound to"
        },
    ));
    ui.message(&format!(
        "  Workspace default Agent Runtime {}.",
        if outcome.default_changed {
            "set to this target"
        } else {
            "already set to this target"
        },
    ));
}

// ---------------------------------------------------------------------------
// Standalone & Guided Convergence Setup
// ---------------------------------------------------------------------------

pub async fn run_standalone_setup(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
    explicit_runtime_path: Option<&str>,
) -> Result<std::process::ExitCode, SetupFrontendError> {
    match run_setup_convergence(paths, ui, doctor, explicit_runtime_path).await? {
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

pub async fn run_setup_wizard(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
) -> Result<SetupCompletion, SetupFrontendError> {
    run_setup_convergence(paths, ui, doctor, None).await
}

pub async fn run_setup_convergence(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
    explicit_runtime_path: Option<&str>,
) -> Result<SetupCompletion, SetupFrontendError> {
    run_setup_convergence_with_home(paths, ui, doctor, explicit_runtime_path, None).await
}

pub async fn run_setup_convergence_with_home(
    paths: &ConnectorPaths,
    ui: &mut dyn SetupUi,
    doctor: &dyn DoctorRunner,
    explicit_runtime_path: Option<&str>,
    home_override: Option<&Path>,
) -> Result<SetupCompletion, SetupFrontendError> {
    // 1. Check login
    load_bound_profile(paths).map_err(|e| {
        ui.error("Not logged in. Please run `ceo-connector login` first.");
        SetupFrontendError::Setup(SetupError::from(e))
    })?;

    // 2. Check Git
    if !executable_in_path("git") {
        ui.error("Git was not found in PATH. Git is required for connector setup.");
        return Err(SetupFrontendError::Ui(
            "git executable not found in PATH".into(),
        ));
    }

    // 3. Check Orca
    let orca_client = crate::orca::client::OrcaCliClient::default();
    match orca_client.status().await {
        Ok(st) => {
            if let Some(res) = &st.result {
                if let Some(pid) = res.app.pid {
                    ui.message(&format!("Orca CLI check: ready (pid: {pid})"));
                } else {
                    ui.message("Orca CLI check: ready");
                }
            } else {
                ui.message("Orca CLI check: ready");
            }
        }
        Err(e) => {
            ui.message(&format!("Notice: Orca CLI check: {e}"));
        }
    }

    // 4. Runtime Device mapping resolution
    let readiness = assess_agent_runtime_readiness(paths).await;
    let has_valid_mapping = match &readiness {
        Ok(r) => r.device_connected,
        Err(_) => false,
    };

    let home_buf = home_override
        .map(|p| p.to_path_buf())
        .or_else(dirs::home_dir);

    if let Some(raw) = explicit_runtime_path {
        let expanded = expand_tilde_with_home(raw, home_buf.as_deref()).map_err(|msg| {
            ui.error(&format!("Cannot use path '{raw}': {msg}"));
            SetupFrontendError::Ui(msg)
        })?;
        match ensure_agent_runtime(paths, &expanded).await {
            Ok(outcome) => render_outcome(ui, &outcome),
            Err(e) => {
                if is_fatal_setup_error(&e) {
                    return Err(e.into());
                }
                ui.error(&format!(
                    "Could not link CEO Agent Runtime at '{}': {e}",
                    expanded.display()
                ));
                return Err(e.into());
            }
        }
    } else if has_valid_mapping {
        ui.message("Existing valid CEO Agent Runtime device mapping verified; reusing.");
    } else {
        let home = home_buf.ok_or_else(|| {
            ui.error(
                "Cannot determine user home directory; please specify `--runtime-path <path>`.",
            );
            SetupFrontendError::Ui("home directory undetermined".into())
        })?;

        let candidates = crate::setup::discover_agent_runtime_candidates(&home);
        if candidates.len() == 1 {
            let candidate = &candidates[0];
            ui.message(&format!(
                "Discovered official CEO Agent Runtime at '{}'; auto-linking...",
                candidate.display()
            ));
            match ensure_agent_runtime(paths, candidate).await {
                Ok(outcome) => render_outcome(ui, &outcome),
                Err(e) => {
                    if is_fatal_setup_error(&e) {
                        return Err(e.into());
                    }
                    ui.error(&format!("Could not link CEO Agent Runtime: {e}"));
                    return Err(e.into());
                }
            }
        } else if candidates.len() > 1 {
            let list = candidates
                .iter()
                .map(|c| format!("  - {}", c.display()))
                .collect::<Vec<_>>()
                .join("\n");
            ui.error(&format!(
                "Discovered multiple CEO Agent Runtime checkouts:\n{}\nPlease specify which one to use with `--runtime-path <path>`.",
                list
            ));
            return Err(SetupFrontendError::Ui(
                "multiple runtime candidates found; explicit --runtime-path required".into(),
            ));
        } else {
            let proposed = home.join(".ceo").join(AGENT_RUNTIME_TARGET_ALIAS);
            ui.message("No existing CEO Agent Runtime checkout was found.");
            let options = vec![
                format!("Use proposed path ({})", proposed.display()),
                "Change path".to_string(),
                "Cancel".to_string(),
            ];
            let choice = match ui.select("Choose CEO Agent Runtime install location", &options) {
                Ok(i) => i,
                Err(UiError::Cancelled) => return Ok(SetupCompletion::Cancelled),
                Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
            };

            let target_path = match choice {
                0 => proposed,
                1 => {
                    let raw = match ui.text(
                        AGENT_RUNTIME_PATH_PROMPT,
                        Some(&proposed.to_string_lossy()),
                        true,
                    ) {
                        Ok(text) => text,
                        Err(UiError::Cancelled) => return Ok(SetupCompletion::Cancelled),
                        Err(UiError::Failed(e)) => return Err(SetupFrontendError::Ui(e)),
                    };
                    let expanded = match expand_tilde_with_home(&raw, Some(&home)) {
                        Ok(p) => p,
                        Err(msg) => {
                            ui.error(&format!("Cannot use path '{raw}': {msg}"));
                            return Err(SetupFrontendError::Ui(msg));
                        }
                    };
                    match resolve_runtime_path_input(&expanded) {
                        RuntimePathResolution::Conflict => {
                            ui.error(AGENT_RUNTIME_CONFLICT_ERROR);
                            return Err(SetupFrontendError::Ui(
                                "selected path conflicts with existing files".into(),
                            ));
                        }
                        RuntimePathResolution::ChildCheckout { child } => child,
                        _ => expanded,
                    }
                }
                _ => return Ok(SetupCompletion::Cancelled),
            };

            match ensure_agent_runtime(paths, &target_path).await {
                Ok(outcome) => render_outcome(ui, &outcome),
                Err(e) => {
                    if is_fatal_setup_error(&e) {
                        return Err(e.into());
                    }
                    ui.error(&format!("Could not set up CEO Agent Runtime: {e}"));
                    return Err(e.into());
                }
            }
        }
    }

    // 5. Runtime Agent preference
    // preserve existing configured logical Agent
    // otherwise configure logical agent ("auto" or compact Orca-derived selector)
    // never ask raw command
    let current_readiness = assess_agent_runtime_readiness(paths).await;
    let needs_executor = match &current_readiness {
        Ok(r) => !r.executor_ready,
        Err(_) => true,
    };

    if needs_executor {
        match crate::setup::configure_agent_runtime_executor_logical(paths, "auto", None).await {
            Ok(outcome) => {
                ui.message(&format!(
                    "Configured execution agent for '{}': agent '{}' (follow Orca default policy).",
                    outcome.alias, outcome.agent_id
                ));
            }
            Err(e) => {
                if is_fatal_setup_error(&e) {
                    return Err(e.into());
                }
                ui.error(&format!("Could not configure execution agent: {e}"));
                return Err(e.into());
            }
        }
    } else {
        ui.message("Execution agent configuration verified (reused existing).");
    }

    // 6. Setup runs Doctor at completion
    ui.message(SETUP_COMPLETE_LINE);
    let report = doctor.run(paths).await;
    Ok(SetupCompletion::Finished {
        doctor_passed: report.overall_passed,
    })
}

// ---------------------------------------------------------------------------
// Login handoff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffAction {
    EnterWizard,
    AlreadyConfigured,
    NonInteractive,
    ProbeFailed,
    DisabledByFlag,
}

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
            match run_setup_wizard(paths, ui, &ProductionDoctor).await {
                Ok(completion) => Ok(Some(completion)),
                Err(e) => {
                    ui.error(&format!("Setup step failed: {e}. Authentication remains valid. Run `ceo-connector setup` to complete setup."));
                    Ok(None)
                }
            }
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
// Unit tests
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
        assert!(expand_tilde_with_home("~", None).is_err());
    }

    #[test]
    fn default_agent_runtime_path_uses_home_ceo() {
        let p = default_agent_runtime_path_with_home(Some(Path::new("/home/u"))).unwrap();
        assert_eq!(
            PathBuf::from(p),
            PathBuf::from("/home/u/.ceo/ceo-agent-runtime")
        );
        assert!(default_agent_runtime_path_with_home(None).is_none());
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

        assert_eq!(
            complete_path(&format!("{base_str}/")),
            vec![
                format!("{base_str}/codes/"),
                format!("{base_str}/my dir/"),
                format!("{base_str}/uni\u{301}code-dir/"),
            ]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/co")),
            vec![format!("{base_str}/codes/")]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/my dir")),
            vec![format!("{base_str}/my dir/")]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/uni\u{301}")),
            vec![format!("{base_str}/uni\u{301}code-dir/")]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/codes/")),
            vec![format!("{base_str}/codes/nested/")]
        );
        assert_eq!(
            complete_path(&format!("{base_str}/.hidd")),
            vec![format!("{base_str}/.hidden/")]
        );
        std::fs::write(base.join("file.txt"), "x").unwrap();
        assert!(complete_path(&format!("{base_str}/file")).is_empty());
        assert!(complete_path("/definitely/not/here/x").is_empty());
    }

    #[test]
    fn path_completer_tab_applies_highlighted_suggestion() {
        let mut completer = PathCompleter;
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

        let input = format!("{base_str}/al");
        let completion = completer.get_completion(&input, None).unwrap();
        assert_eq!(completion, Some(format!("{base_str}/alpha")));

        let input = format!("{base_str}/alphabet");
        let completion = completer.get_completion(&input, None).unwrap();
        assert_eq!(completion, Some(format!("{base_str}/alphabet/")));

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
    fn runtime_path_resolution_matches_contract() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();

        assert_eq!(
            resolve_runtime_path_input(&base.join("absent")),
            RuntimePathResolution::Missing
        );

        let repo = base.join("ceo-agent-runtime");
        init_test_runtime_repo(&repo);
        assert_eq!(
            resolve_runtime_path_input(&repo),
            RuntimePathResolution::VerifiedCheckout
        );

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

        let empty_parent = base.join("elsewhere");
        std::fs::create_dir_all(&empty_parent).unwrap();
        assert_eq!(
            resolve_runtime_path_input(&empty_parent),
            RuntimePathResolution::ParentWithoutChild {
                child: empty_parent.join(AGENT_RUNTIME_TARGET_ALIAS)
            }
        );

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
