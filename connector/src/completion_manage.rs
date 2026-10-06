//! Persistent shell-completion installation for the stable `ceo-connector` command.
//!
//! This module edits one marked block in the user's shell profile. It does not
//! copy the binary, edit `PATH`, migrate Connector config, or call Orca, Git,
//! or the CEO Server. The block always invokes `COMPLETE=<shell> ceo-connector`
//! so the existing [`crate::completion`] engine remains the completion generator.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use crate::local_state;
use crate::platform;

/// Stable product command. Profiles reference this name, never an absolute path.
pub const COMMAND_NAME: &str = "ceo-connector";

const START_MARKER: &str = "# >>> ceo-connector completion >>>";
const END_MARKER: &str = "# <<< ceo-connector completion <<<";

/// Shells whose registration script `COMPLETE=<shell>` already knows how to emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    PowerShell,
}

impl ShellKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
            Self::PowerShell => "powershell",
        }
    }
}

impl std::fmt::Display for ShellKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which profile operation to perform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionAction {
    Install,
    Status,
    Uninstall,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CompletionManageError(String);

impl CompletionManageError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Accept `bash`, `zsh`, `fish`, and `powershell`. Any other value is rejected.
pub fn parse_shell_name(raw: &str) -> Result<ShellKind, String> {
    match raw {
        "bash" => Ok(ShellKind::Bash),
        "zsh" => Ok(ShellKind::Zsh),
        "fish" => Ok(ShellKind::Fish),
        "powershell" => Ok(ShellKind::PowerShell),
        other => Err(format!(
            "unsupported shell '{other}'; expected bash, zsh, fish, or powershell"
        )),
    }
}

/// Unix detection uses the `$SHELL` basename only.
///
/// Windows has no equally small signal, so detection fails and asks for
/// `--shell powershell` (and `--profile` when the profile path is needed).
pub fn detect_shell(
    shell_env: Option<&OsStr>,
    host_windows: bool,
) -> Result<ShellKind, CompletionManageError> {
    if host_windows {
        return Err(CompletionManageError::new(
            "cannot detect a shell on Windows. Re-run with --shell powershell and, if the profile cannot be inferred, --profile <path>.",
        ));
    }
    let Some(raw) = shell_env.filter(|value| !value.is_empty()) else {
        return Err(CompletionManageError::new(
            "SHELL is unset. Re-run with --shell bash, --shell zsh, --shell fish, or --shell powershell.",
        ));
    };
    let name = Path::new(raw)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    match name {
        "bash" => Ok(ShellKind::Bash),
        "zsh" => Ok(ShellKind::Zsh),
        "fish" => Ok(ShellKind::Fish),
        other => Err(CompletionManageError::new(format!(
            "SHELL basename '{other}' is not a supported shell. Re-run with --shell bash, --shell zsh, --shell fish, or --shell powershell."
        ))),
    }
}

/// Default per-user profile for `shell`.
///
/// PowerShell on Windows is not inferred: Documents-folder redirection makes
/// `$PROFILE` unreliable without asking PowerShell. Pass `--profile` there.
pub fn default_profile_path(
    shell: ShellKind,
    home: Option<&Path>,
    xdg_config_home: Option<&Path>,
    host_windows: bool,
) -> Result<PathBuf, CompletionManageError> {
    match shell {
        ShellKind::Bash => Ok(require_home(home)?.join(".bashrc")),
        ShellKind::Zsh => Ok(require_home(home)?.join(".zshrc")),
        ShellKind::Fish => Ok(config_dir(home, xdg_config_home)?
            .join("fish")
            .join("config.fish")),
        ShellKind::PowerShell => {
            if host_windows {
                return Err(CompletionManageError::new(
                    "cannot resolve a PowerShell profile path automatically on Windows. Re-run with --profile <path> (the value of $PROFILE).",
                ));
            }
            Ok(config_dir(home, xdg_config_home)?
                .join("powershell")
                .join("Microsoft.PowerShell_profile.ps1"))
        }
    }
}

fn require_home(home: Option<&Path>) -> Result<&Path, CompletionManageError> {
    home.filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            CompletionManageError::new(
                "cannot determine the home directory. Set HOME or pass --profile <path>.",
            )
        })
}

fn config_dir(
    home: Option<&Path>,
    xdg_config_home: Option<&Path>,
) -> Result<PathBuf, CompletionManageError> {
    if let Some(xdg) = xdg_config_home.filter(|path| !path.as_os_str().is_empty()) {
        return Ok(xdg.to_path_buf());
    }
    Ok(require_home(home)?.join(".config"))
}

/// One canonical managed block. The command token is always [`COMMAND_NAME`].
pub fn canonical_block(shell: ShellKind, newline: &str) -> String {
    let body = integration_line(shell);
    format!("{START_MARKER}{newline}{body}{newline}{END_MARKER}{newline}")
}

fn integration_line(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Bash => "source <(COMPLETE=bash ceo-connector)",
        ShellKind::Zsh => "source <(COMPLETE=zsh ceo-connector)",
        ShellKind::Fish => "COMPLETE=fish ceo-connector | source",
        ShellKind::PowerShell => {
            "$env:COMPLETE = \"powershell\"; ceo-connector | Out-String | Invoke-Expression; Remove-Item Env:\\COMPLETE"
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileState {
    NotInstalled,
    Installed,
    NeedsRepair,
    Malformed,
}

enum Topology {
    Absent,
    Region { start: usize, end: usize },
    Malformed,
}

struct LineSpan<'a> {
    text: &'a str,
    start: usize,
    next: usize,
}

fn line_spans(content: &str) -> Vec<LineSpan<'_>> {
    let bytes = content.as_bytes();
    let mut spans = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        while index < bytes.len() && bytes[index] != b'\n' {
            index += 1;
        }
        let mut text_end = index;
        if index < bytes.len() && bytes[index] == b'\n' {
            index += 1;
        }
        if text_end > start && bytes[text_end - 1] == b'\r' {
            text_end -= 1;
        }
        spans.push(LineSpan {
            text: &content[start..text_end],
            start,
            next: index,
        });
    }
    spans
}

/// Zero marker lines -> absent. Exactly one start/end pair in order -> one
/// region. Every other topology fails closed.
fn topology(content: &str) -> Topology {
    let lines = line_spans(content);
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if line.text == START_MARKER {
            starts.push(idx);
        } else if line.text == END_MARKER {
            ends.push(idx);
        }
    }
    if starts.is_empty() && ends.is_empty() {
        return Topology::Absent;
    }
    if starts.len() == 1 && ends.len() == 1 && starts[0] < ends[0] {
        return Topology::Region {
            start: lines[starts[0]].start,
            end: lines[ends[0]].next,
        };
    }
    Topology::Malformed
}

fn newline_for(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn profile_state(content: &str, shell: ShellKind) -> ProfileState {
    match topology(content) {
        Topology::Absent => ProfileState::NotInstalled,
        Topology::Malformed => ProfileState::Malformed,
        Topology::Region { start, end } => {
            let block = canonical_block(shell, newline_for(content));
            if content[start..end] == block {
                ProfileState::Installed
            } else {
                ProfileState::NeedsRepair
            }
        }
    }
}

enum EditError {
    Malformed,
}

fn install_text(content: &str, shell: ShellKind) -> Result<String, EditError> {
    match topology(content) {
        Topology::Malformed => Err(EditError::Malformed),
        Topology::Absent => Ok(append_block(content, shell)),
        Topology::Region { start, end } => {
            let block = canonical_block(shell, newline_for(content));
            if content[start..end] == block {
                Ok(content.to_string())
            } else {
                let mut out = String::with_capacity(content.len() - (end - start) + block.len());
                out.push_str(&content[..start]);
                out.push_str(&block);
                out.push_str(&content[end..]);
                Ok(out)
            }
        }
    }
}

fn append_block(content: &str, shell: ShellKind) -> String {
    let newline = newline_for(content);
    let block = canonical_block(shell, newline);
    let mut out = String::with_capacity(content.len() + newline.len() + block.len());
    out.push_str(content);
    if !content.is_empty() && !content.ends_with('\n') {
        out.push_str(newline);
    }
    out.push_str(&block);
    out
}

fn uninstall_text(content: &str) -> Result<String, EditError> {
    match topology(content) {
        Topology::Malformed => Err(EditError::Malformed),
        Topology::Absent => Ok(content.to_string()),
        Topology::Region { start, end } => {
            let mut out = String::with_capacity(content.len() - (end - start));
            out.push_str(&content[..start]);
            out.push_str(&content[end..]);
            Ok(out)
        }
    }
}

fn malformed_message(path: &Path) -> CompletionManageError {
    CompletionManageError::new(format!(
        "CEO Connector completion markers in {} are malformed or duplicated. Refusing to edit the profile. Leave at most one pair of `{START_MARKER}` and `{END_MARKER}`, then retry.",
        path.display()
    ))
}

struct CompletionHost {
    shell_env: Option<OsString>,
    home: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
    path_env: Option<OsString>,
    current_exe: PathBuf,
    host_windows: bool,
}

impl CompletionHost {
    fn from_process() -> Result<Self, CompletionManageError> {
        let current_exe = std::env::current_exe().map_err(|err| {
            CompletionManageError::new(format!(
                "cannot resolve the current executable ({err}). Place `{COMMAND_NAME}` on PATH and re-run."
            ))
        })?;
        let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME").and_then(|value| {
            if value.is_empty() {
                None
            } else {
                Some(PathBuf::from(value))
            }
        });
        Ok(Self {
            shell_env: std::env::var_os("SHELL"),
            home: dirs::home_dir(),
            xdg_config_home,
            path_env: std::env::var_os("PATH"),
            current_exe,
            host_windows: cfg!(windows),
        })
    }
}

/// Run a completion-management command against the real process environment.
///
/// Prints the user-facing result. Does not resolve Connector paths.
pub fn execute_completion(
    action: CompletionAction,
    shell: Option<ShellKind>,
    profile: Option<&Path>,
) -> Result<(), CompletionManageError> {
    let host = CompletionHost::from_process()?;
    let message = run_with_host(action, shell, profile, &host)?;
    println!("{message}");
    Ok(())
}

fn run_with_host(
    action: CompletionAction,
    shell: Option<ShellKind>,
    profile: Option<&Path>,
    host: &CompletionHost,
) -> Result<String, CompletionManageError> {
    let shell = match shell {
        Some(shell) => shell,
        None => detect_shell(host.shell_env.as_deref(), host.host_windows)?,
    };
    let profile = resolve_profile(shell, profile, host)?;
    if action == CompletionAction::Install {
        ensure_stable_command(
            &host.current_exe,
            lookup_command(host.path_env.as_deref(), host.host_windows).as_deref(),
        )?;
    }
    reject_profile_symlink(&profile)?;
    let existing = read_profile(&profile)?;
    let existed = existing.is_some();
    let content = existing.unwrap_or_default();
    let path_line = path_note(
        &host.current_exe,
        lookup_command(host.path_env.as_deref(), host.host_windows).as_deref(),
    );

    match action {
        CompletionAction::Status => Ok(render_status(
            shell,
            &profile,
            profile_state(&content, shell),
            &path_line,
        )),
        CompletionAction::Install => {
            let next = install_text(&content, shell).map_err(|_| malformed_message(&profile))?;
            if !existed || next != content {
                write_profile(&profile, &next)?;
            }
            Ok(render_install(shell, &profile, host.home.as_deref()))
        }
        CompletionAction::Uninstall => {
            let next = uninstall_text(&content).map_err(|_| malformed_message(&profile))?;
            if existed && next != content {
                write_profile(&profile, &next)?;
                Ok(render_removed(shell, &profile))
            } else {
                Ok(render_absent(shell, &profile))
            }
        }
    }
}

fn resolve_profile(
    shell: ShellKind,
    explicit: Option<&Path>,
    host: &CompletionHost,
) -> Result<PathBuf, CompletionManageError> {
    if let Some(profile) = explicit {
        if profile.as_os_str().is_empty() {
            return Err(CompletionManageError::new(
                "--profile must not be empty. Pass the shell profile file to edit.",
            ));
        }
        return Ok(profile.to_path_buf());
    }
    default_profile_path(
        shell,
        host.home.as_deref(),
        host.xdg_config_home.as_deref(),
        host.host_windows,
    )
}

fn reject_profile_symlink(path: &Path) -> Result<(), CompletionManageError> {
    platform::reject_reparse_target(path).map_err(|err| {
        CompletionManageError::new(format!("refusing to edit {}: {err}", path.display()))
    })
}

fn read_profile(path: &Path) -> Result<Option<String>, CompletionManageError> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            CompletionManageError::new(format!(
                "profile {} is not valid UTF-8; refusing to edit it",
                path.display()
            ))
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_message("read", path, &err)),
    }
}

fn write_profile(path: &Path, contents: &str) -> Result<(), CompletionManageError> {
    reject_profile_symlink(path)?;
    let previous_mode = fs::metadata(path).ok().map(|meta| meta.permissions());
    local_state::atomic_write_durable(path, contents.as_bytes())
        .map_err(|err| io_message("write", path, &err))?;
    restore_profile_mode(path, previous_mode)
}

fn restore_profile_mode(
    path: &Path,
    previous: Option<fs::Permissions>,
) -> Result<(), CompletionManageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = previous.unwrap_or_else(|| fs::Permissions::from_mode(0o644));
        fs::set_permissions(path, perms).map_err(|err| io_message("set permissions on", path, &err))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, previous);
        Ok(())
    }
}

fn io_message(action: &str, path: &Path, err: &std::io::Error) -> CompletionManageError {
    CompletionManageError::new(format!("cannot {action} {}: {err}", path.display()))
}

/// Prove the running executable is the `ceo-connector` found on `PATH`.
fn ensure_stable_command(
    current_exe: &Path,
    path_hit: Option<&Path>,
) -> Result<(), CompletionManageError> {
    let Some(path_hit) = path_hit else {
        return Err(CompletionManageError::new(format!(
            "`{COMMAND_NAME}` is not on PATH. Place this executable on PATH as `{COMMAND_NAME}` before installing shell completion. Completion is installed for the stable command name, not for an absolute path."
        )));
    };
    if same_executable(current_exe, path_hit) {
        return Ok(());
    }
    Err(CompletionManageError::new(format!(
        "PATH resolves `{COMMAND_NAME}` to {}, but this process is {}. Completion installation targets the stable `{COMMAND_NAME}` command and will not select, rewrite, or repair the other binary.",
        path_hit.display(),
        current_exe.display()
    )))
}

fn same_executable(current: &Path, found: &Path) -> bool {
    match (fs::canonicalize(current), fs::canonicalize(found)) {
        (Ok(current), Ok(found)) => current == found,
        _ => false,
    }
}

fn path_note(current: &Path, found: Option<&Path>) -> String {
    match found {
        None => format!("PATH {COMMAND_NAME}: not found"),
        Some(found) if same_executable(current, found) => format!(
            "PATH {COMMAND_NAME}: matches this executable ({})",
            current.display()
        ),
        Some(found) => format!(
            "PATH {COMMAND_NAME}: {} (this executable is {})",
            found.display(),
            current.display()
        ),
    }
}

fn lookup_command(path_env: Option<&OsStr>, host_windows: bool) -> Option<PathBuf> {
    let path_env = path_env.filter(|value| !value.is_empty())?;
    let names = executable_names(COMMAND_NAME, host_windows);
    for dir in std::env::split_paths(path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_names(command: &str, host_windows: bool) -> Vec<String> {
    let mut names = vec![command.to_string()];
    if !host_windows {
        return names;
    }
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in raw.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        let suffix = if ext.starts_with('.') {
            ext.to_string()
        } else {
            format!(".{ext}")
        };
        if !command
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase())
        {
            names.push(format!("{command}{suffix}"));
        }
    }
    names
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn render_install(shell: ShellKind, profile: &Path, home: Option<&Path>) -> String {
    let activation = activation_command(shell, profile, home);
    format!(
        "Installed CEO Connector completion for {shell}.\nProfile: {}\nNew shell sessions will activate completion automatically.\nActivate completion in this already-running shell by running:\n{activation}",
        profile.display()
    )
}

fn render_removed(shell: ShellKind, profile: &Path) -> String {
    format!(
        "Removed CEO Connector completion for {shell}.\nProfile: {}",
        profile.display()
    )
}

fn render_absent(shell: ShellKind, profile: &Path) -> String {
    format!(
        "CEO Connector completion is not installed for {shell}.\nProfile: {}",
        profile.display()
    )
}

fn render_status(shell: ShellKind, profile: &Path, state: ProfileState, path_line: &str) -> String {
    let state_text = match state {
        ProfileState::Installed => "installed",
        ProfileState::NotInstalled => "not installed",
        ProfileState::NeedsRepair => "needs repair",
        ProfileState::Malformed => "malformed",
    };
    let mut message = format!(
        "Shell: {shell}\nProfile: {}\nCompletion: {state_text}\n{path_line}",
        profile.display()
    );
    if state == ProfileState::Malformed {
        message.push_str(
            "\nCEO Connector completion markers are duplicated or unpaired. Install and uninstall will not edit this profile until exactly one marker pair remains.",
        );
    }
    message
}

fn activation_command(shell: ShellKind, profile: &Path, home: Option<&Path>) -> String {
    let shown = quote_shell_word(&tilde_path(profile, home));
    match shell {
        ShellKind::PowerShell => format!(". {shown}"),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Fish => format!("source {shown}"),
    }
}

fn tilde_path(profile: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home.filter(|path| !path.as_os_str().is_empty()) {
        if let Ok(relative) = profile.strip_prefix(home) {
            if relative.as_os_str().is_empty() {
                return "~".to_string();
            }
            let mut out = String::from("~");
            for component in relative.components() {
                match component {
                    std::path::Component::Normal(part) => {
                        out.push('/');
                        out.push_str(&part.to_string_lossy());
                    }
                    _ => return profile.display().to_string(),
                }
            }
            return out;
        }
    }
    profile.display().to_string()
}

fn quote_shell_word(word: &str) -> String {
    if word
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '"' | '\'' | '$' | '`'))
    {
        format!("\"{}\"", word.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        word.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_parsing_accepts_supported_names_and_rejects_others() {
        assert_eq!(parse_shell_name("bash").unwrap(), ShellKind::Bash);
        assert_eq!(parse_shell_name("zsh").unwrap(), ShellKind::Zsh);
        assert_eq!(parse_shell_name("fish").unwrap(), ShellKind::Fish);
        assert_eq!(
            parse_shell_name("powershell").unwrap(),
            ShellKind::PowerShell
        );
        let err = parse_shell_name("nushell").unwrap_err();
        assert!(err.contains("unsupported shell"));
        assert!(parse_shell_name("Bash").is_err());
        assert!(parse_shell_name("").is_err());
    }

    #[test]
    fn unix_shell_detection_uses_shell_basename_only() {
        assert_eq!(
            detect_shell(Some(OsStr::new("/bin/bash")), false).unwrap(),
            ShellKind::Bash
        );
        assert_eq!(
            detect_shell(Some(OsStr::new("/usr/bin/zsh")), false).unwrap(),
            ShellKind::Zsh
        );
        assert_eq!(
            detect_shell(Some(OsStr::new("/usr/local/bin/fish")), false).unwrap(),
            ShellKind::Fish
        );
        let missing = detect_shell(None, false).unwrap_err().to_string();
        assert!(missing.contains("--shell"), "{missing}");
        let unsupported = detect_shell(Some(OsStr::new("/bin/sh")), false)
            .unwrap_err()
            .to_string();
        assert!(unsupported.contains("--shell"), "{unsupported}");
        assert!(unsupported.contains("sh"), "{unsupported}");
        let windows = detect_shell(Some(OsStr::new("/bin/bash")), true)
            .unwrap_err()
            .to_string();
        assert!(windows.contains("--shell"), "{windows}");
    }

    #[test]
    fn canonical_block_references_bare_command_name() {
        let exe = std::env::current_exe().unwrap().display().to_string();
        let expected = [
            (
                ShellKind::Bash,
                "source <(COMPLETE=bash ceo-connector)",
            ),
            (
                ShellKind::Zsh,
                "source <(COMPLETE=zsh ceo-connector)",
            ),
            (
                ShellKind::Fish,
                "COMPLETE=fish ceo-connector | source",
            ),
            (
                ShellKind::PowerShell,
                "$env:COMPLETE = \"powershell\"; ceo-connector | Out-String | Invoke-Expression; Remove-Item Env:\\COMPLETE",
            ),
        ];
        for (shell, body) in expected {
            let block = canonical_block(shell, "\n");
            assert_eq!(block, format!("{START_MARKER}\n{body}\n{END_MARKER}\n"));
            assert!(block.contains(COMMAND_NAME));
            assert!(!block.contains(&exe), "{block}");
            assert!(!block.contains("/opt/"), "{block}");
            assert!(!block.contains("/usr/bin/"), "{block}");
        }
    }

    #[test]
    fn profile_targets_follow_per_user_conventions() {
        let home = Path::new("/home/user");
        assert_eq!(
            default_profile_path(ShellKind::Bash, Some(home), None, false).unwrap(),
            home.join(".bashrc")
        );
        assert_eq!(
            default_profile_path(ShellKind::Zsh, Some(home), None, false).unwrap(),
            home.join(".zshrc")
        );
        assert_eq!(
            default_profile_path(ShellKind::Fish, Some(home), None, false).unwrap(),
            home.join(".config/fish/config.fish")
        );
        assert_eq!(
            default_profile_path(ShellKind::PowerShell, Some(home), None, false).unwrap(),
            home.join(".config/powershell/Microsoft.PowerShell_profile.ps1")
        );
        let xdg = Path::new("/xdg");
        assert_eq!(
            default_profile_path(ShellKind::Fish, Some(home), Some(xdg), false).unwrap(),
            xdg.join("fish/config.fish")
        );
        let windows = default_profile_path(ShellKind::PowerShell, Some(home), None, true)
            .unwrap_err()
            .to_string();
        assert!(windows.contains("--profile"), "{windows}");
    }

    #[test]
    fn install_into_empty_profile_creates_one_block_and_repeat_is_idempotent() {
        let (host, home) = aligned_host();
        let message = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert!(message.contains("source ~/.bashrc"), "{message}");
        assert!(
            message.contains("New shell sessions will activate completion automatically"),
            "{message}"
        );
        assert!(!message.to_lowercase().contains("already active"));
        let bashrc = home.join(".bashrc");
        let once = fs::read(&bashrc).unwrap();
        assert_eq!(count_marker(&once), 1);
        let text = String::from_utf8(once.clone()).unwrap();
        assert!(text.contains("source <(COMPLETE=bash ceo-connector)"));
        assert!(!text.contains(&host.current_exe.display().to_string()));

        let again = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert!(again.contains("source ~/.bashrc"), "{again}");
        assert_eq!(fs::read(&bashrc).unwrap(), once);
        assert!(!home.join(".ceo").exists());
    }

    #[test]
    fn install_repairs_stale_block_and_preserves_user_lines() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        let original = format!(
            "export KEEP_BEFORE=1\necho \"# >>> ceo-connector completion >>>\"\n{START_MARKER}\nsource <(COMPLETE=bash /opt/old/ceo-connector)\n{END_MARKER}\n# KEEP_AFTER\n"
        );
        fs::write(&bashrc, &original).unwrap();

        run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        let updated = fs::read_to_string(&bashrc).unwrap();
        assert_eq!(updated.matches(START_MARKER).count(), 2);
        assert!(updated.contains("export KEEP_BEFORE=1\n"));
        assert!(updated.contains("echo \"# >>> ceo-connector completion >>>\"\n"));
        assert!(updated.contains("# KEEP_AFTER\n"));
        assert!(updated.contains("source <(COMPLETE=bash ceo-connector)\n"));
        assert!(!updated.contains("/opt/old/ceo-connector"));
        assert_eq!(
            updated
                .matches("source <(COMPLETE=bash ceo-connector)")
                .count(),
            1
        );
    }

    #[test]
    fn uninstall_removes_only_the_managed_block() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        let head = "export KEEP_BEFORE=1\n";
        let tail = "# KEEP_AFTER\n";
        let original = format!("{head}{}{tail}", canonical_block(ShellKind::Bash, "\n"));
        fs::write(&bashrc, &original).unwrap();

        let message = run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert!(message.contains("Removed"), "{message}");
        assert_eq!(
            fs::read_to_string(&bashrc).unwrap(),
            format!("{head}{tail}")
        );
    }

    #[test]
    fn uninstall_absent_is_a_noop() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        let original = "export KEEP=1\n";
        fs::write(&bashrc, original).unwrap();
        let message = run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert!(message.contains("not installed"), "{message}");
        assert_eq!(fs::read_to_string(&bashrc).unwrap(), original);

        let missing = home.join("missing-rc");
        let message = run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            Some(&missing),
            &host,
        )
        .unwrap();
        assert!(message.contains("not installed"), "{message}");
        assert!(!missing.exists());
    }

    #[test]
    fn uninstall_works_after_the_executable_moves() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        fs::write(&bashrc, canonical_block(ShellKind::Bash, "\n")).unwrap();
        let mut moved = host;
        moved.current_exe = home.join("not-the-binary");
        moved.path_env = Some(home.as_os_str().to_os_string());
        run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            None,
            &moved,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&bashrc).unwrap(), "");
    }

    #[test]
    fn malformed_markers_fail_closed_without_writing() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        let original = format!(
            "export KEEP_UNTOUCHED=1\n{START_MARKER}\nstale\n{START_MARKER}\nstale-2\n{END_MARKER}\n"
        );
        fs::write(&bashrc, &original).unwrap();
        let before = fs::read(&bashrc).unwrap();

        let install = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap_err();
        assert!(
            install.to_string().contains("Refusing to edit"),
            "{install}"
        );
        assert_eq!(fs::read(&bashrc).unwrap(), before);

        let uninstall = run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap_err();
        assert!(
            uninstall.to_string().contains("Refusing to edit"),
            "{uninstall}"
        );
        assert_eq!(fs::read(&bashrc).unwrap(), before);

        let unpaired = format!("{END_MARKER}\nexport KEEP_UNTOUCHED=1\n");
        fs::write(&bashrc, &unpaired).unwrap();
        let before = fs::read(&bashrc).unwrap();
        assert!(run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host
        )
        .is_err());
        assert_eq!(fs::read(&bashrc).unwrap(), before);
    }

    #[test]
    fn status_reports_absent_installed_and_needs_repair() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");

        let absent =
            run_with_host(CompletionAction::Status, Some(ShellKind::Bash), None, &host).unwrap();
        assert_state(&absent, "not installed");
        assert!(absent.contains("Shell: bash"), "{absent}");
        assert!(absent.contains(bashrc.to_str().unwrap()), "{absent}");
        assert!(!bashrc.exists());

        fs::write(&bashrc, canonical_block(ShellKind::Bash, "\n")).unwrap();
        let installed =
            run_with_host(CompletionAction::Status, Some(ShellKind::Bash), None, &host).unwrap();
        assert_state(&installed, "installed");

        fs::write(
            &bashrc,
            format!(
                "{START_MARKER}\nsource <(COMPLETE=bash /opt/old/ceo-connector)\n{END_MARKER}\n"
            ),
        )
        .unwrap();
        let repair =
            run_with_host(CompletionAction::Status, Some(ShellKind::Bash), None, &host).unwrap();
        assert_state(&repair, "needs repair");

        fs::write(
            &bashrc,
            format!("{START_MARKER}\n{START_MARKER}\n{END_MARKER}\n"),
        )
        .unwrap();
        let malformed =
            run_with_host(CompletionAction::Status, Some(ShellKind::Bash), None, &host).unwrap();
        assert_state(&malformed, "malformed");
    }

    #[test]
    fn install_allows_the_path_command_and_refuses_missing_or_different_binaries() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let current = write_exe(&root.path().join("current"), COMMAND_NAME);
        let other = write_exe(&root.path().join("other"), COMMAND_NAME);
        let empty = root.path().join("empty");
        fs::create_dir_all(&empty).unwrap();

        let ok_host = host_for(&home, current.parent().unwrap(), &current);
        run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &ok_host,
        )
        .unwrap();
        assert!(home.join(".bashrc").is_file());

        let fresh = tempfile::tempdir().unwrap();
        let home = fresh.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let missing = host_for(&home, &empty, &current);
        let err = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &missing,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("not on PATH"), "{err}");
        assert!(!home.join(".bashrc").exists());

        let mismatch = host_for(&home, other.parent().unwrap(), &current);
        let err = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &mismatch,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains(&current.display().to_string()), "{err}");
        assert!(err.contains(&other.display().to_string()), "{err}");
        assert!(err.contains("stable"), "{err}");
        assert!(!home.join(".bashrc").exists());

        let status = run_with_host(
            CompletionAction::Status,
            Some(ShellKind::Bash),
            None,
            &mismatch,
        )
        .unwrap();
        assert!(status.contains(&current.display().to_string()), "{status}");
        assert!(status.contains(&other.display().to_string()), "{status}");
        assert_state(&status, "not installed");
    }

    #[cfg(unix)]
    #[test]
    fn install_treats_a_path_symlink_to_the_same_executable_as_a_match() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let real = write_exe(&root.path().join("real"), COMMAND_NAME);
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(&real, bin.join(COMMAND_NAME)).unwrap();
        let host = host_for(&home, &bin, &real);
        run_with_host(CompletionAction::Install, Some(ShellKind::Zsh), None, &host).unwrap();
        let zshrc = fs::read_to_string(home.join(".zshrc")).unwrap();
        assert!(zshrc.contains("source <(COMPLETE=zsh ceo-connector)\n"));
        assert!(!zshrc.contains(&real.display().to_string()));
    }

    #[test]
    fn fish_and_powershell_profiles_use_shell_native_lines() {
        let (host, home) = aligned_host();
        run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Fish),
            None,
            &host,
        )
        .unwrap();
        let fish = fs::read_to_string(home.join(".config/fish/config.fish")).unwrap();
        assert_eq!(fish, canonical_block(ShellKind::Fish, "\n"));

        let mut ps_host = host;
        ps_host.host_windows = false;
        let profile = home.join("Microsoft.PowerShell_profile.ps1");
        let message = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::PowerShell),
            Some(&profile),
            &ps_host,
        )
        .unwrap();
        assert!(
            message.contains(&format!(". {}", profile.display()))
                || message.lines().any(|line| line.starts_with(". ")),
            "{message}"
        );
        let body = fs::read_to_string(&profile).unwrap();
        assert!(body.contains("COMPLETE = \"powershell\""));
        assert!(body.contains("ceo-connector"));
        assert!(!body.contains(&ps_host.current_exe.display().to_string()));

        let windows = CompletionHost {
            host_windows: true,
            ..ps_host
        };
        let err = run_with_host(
            CompletionAction::Install,
            Some(ShellKind::PowerShell),
            None,
            &windows,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("--profile"), "{err}");
    }

    #[test]
    fn crlf_user_lines_survive_install_and_uninstall() {
        let (host, home) = aligned_host();
        let bashrc = home.join(".bashrc");
        fs::write(&bashrc, "export KEEP=1\r\n").unwrap();
        run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        let installed = fs::read_to_string(&bashrc).unwrap();
        assert!(installed.starts_with("export KEEP=1\r\n"));
        assert!(installed.contains("source <(COMPLETE=bash ceo-connector)\r\n"));
        run_with_host(
            CompletionAction::Uninstall,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&bashrc).unwrap(), "export KEEP=1\r\n");
    }

    #[test]
    fn explicit_shell_overrides_detection() {
        let mut host = aligned_host().0;
        host.shell_env = Some(OsString::from("/bin/zsh"));
        let home = host.home.clone().unwrap();
        run_with_host(
            CompletionAction::Install,
            Some(ShellKind::Bash),
            None,
            &host,
        )
        .unwrap();
        assert!(home.join(".bashrc").is_file());
        assert!(!home.join(".zshrc").exists());
    }

    fn assert_state(message: &str, state: &str) {
        assert!(
            message
                .lines()
                .any(|line| line == format!("Completion: {state}")),
            "{message}"
        );
    }

    fn count_marker(bytes: &[u8]) -> usize {
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        text.matches(START_MARKER).count()
    }

    fn aligned_host() -> (CompletionHost, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let root = root.keep();
        let home = root.join("home");
        let bin = root.join("bin");
        fs::create_dir_all(&home).unwrap();
        let exe = write_exe(&bin, COMMAND_NAME);
        (host_for(&home, &bin, &exe), home)
    }

    fn host_for(home: &Path, bin: &Path, current: &Path) -> CompletionHost {
        CompletionHost {
            shell_env: None,
            home: Some(home.to_path_buf()),
            xdg_config_home: None,
            path_env: Some(bin.as_os_str().to_os_string()),
            current_exe: current.to_path_buf(),
            host_windows: false,
        }
    }

    fn write_exe(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&path, perms).unwrap();
        }
        path
    }
}
