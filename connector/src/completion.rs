//! Shell completion for `ceo-connector`.
//!
//! Command, subcommand, and flag structure comes from the clap derive
//! definition. Project selectors additionally complete Server-owned aliases
//! for Target IDs present in this device's local config. Completion never
//! migrates or writes config, and it never calls Orca or Git.

use std::ffi::{OsStr, OsString};
use std::sync::Arc;

use clap::{Command, CommandFactory};
use clap_complete::engine::{ArgValueCompleter, CompletionCandidate};
use clap_complete::CompleteEnv;

use crate::cli::Cli;
use crate::client::ConnectorClient;
use crate::config::{normalize_server_origin, LocalConfig};
use crate::credential::DeviceCredential;
use crate::paths::ConnectorPaths;

/// Service a `COMPLETE=<shell>` request, if one is active, then return.
///
/// When completion is active this prints the registration script or the
/// completion candidates and exits. It does not resolve paths, migrate
/// config, or run the requested command. Registration generation does not
/// fetch Project aliases; the completion callback does, once.
pub fn serve_shell_completion() {
    CompleteEnv::with_factory(completion_command).complete();
}

/// Clap command used by [`CompleteEnv`].
///
/// Dynamic Project aliases are loaded only when this process is completing
/// words. Generating the shell registration script passes no words after
/// `--` and skips the catalogue request.
pub fn completion_command() -> Command {
    let args: Vec<OsString> = std::env::args_os().collect();
    let aliases = if dynamic_candidates_requested_from_args(&args) {
        match ConnectorPaths::resolve() {
            Ok(paths) => blocking_project_alias_candidates(&paths),
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    command_with_project_candidates(aliases)
}

/// True when clap's completion protocol is asking for word candidates.
///
/// Mirrors `CompleteEnv`: argv is ` <completer> -- <words>... `. An empty
/// word list is registration-script generation, which must not touch the
/// Server.
pub fn dynamic_candidates_requested_from_args(args: &[OsString]) -> bool {
    let Some((_, rest)) = args.split_first() else {
        return false;
    };
    let escape_index = rest
        .iter()
        .position(|arg| arg.as_os_str() == "--")
        .map(|index| index + 1)
        .unwrap_or(rest.len());
    escape_index < rest.len()
}

/// Build the clap command and attach Project-alias completion to selectors.
///
/// The candidate list is a hint. It is not installed as a value parser, so
/// manually typed target IDs and other selectors stay valid.
///
/// Panics if a known selector argument is no longer on the command. That is
/// a programming error: attaching the completer to a guessed positional
/// would complete the wrong argument.
pub fn command_with_project_candidates<I, S>(aliases: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let aliases = Arc::new(aliases.into_iter().map(Into::into).collect::<Vec<_>>());
    let completer = project_alias_completer(aliases);
    decorate_project_selectors(Cli::command(), &completer)
}

/// Read-only Project alias candidates for completion.
///
/// Returns aliases from the Server Target catalogue whose target IDs are
/// present in the local schema-v3 config. Missing credentials, a legacy
/// config that would require migration, and any Server or network failure
/// yield an empty list. This function does not write local state.
pub async fn load_project_alias_candidates(paths: &ConnectorPaths) -> Vec<String> {
    let Some((config, credential)) = read_completion_profile(paths) else {
        return Vec::new();
    };
    if config.targets.is_empty() {
        return Vec::new();
    }

    let Ok(client) = ConnectorClient::new(&credential.server_origin) else {
        return Vec::new();
    };
    let Ok(catalogue) = client.list_targets(&credential, None).await else {
        return Vec::new();
    };

    let mut aliases: Vec<String> = catalogue
        .into_iter()
        .filter(|target| config.targets.contains_key(&target.target_id))
        .map(|target| target.alias)
        .filter(|alias| !alias.is_empty())
        .collect();
    aliases.sort();
    aliases.dedup();
    aliases
}

fn blocking_project_alias_candidates(paths: &ConnectorPaths) -> Vec<String> {
    let paths = paths.clone();
    let join = std::thread::Builder::new()
        .name("ceo-connector-complete".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()?;
            Some(runtime.block_on(load_project_alias_candidates(&paths)))
        });
    match join {
        Ok(handle) => handle.join().ok().flatten().unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Strict read of the bound profile. Never migrates and never writes.
fn read_completion_profile(paths: &ConnectorPaths) -> Option<(LocalConfig, DeviceCredential)> {
    let credential = DeviceCredential::load(&paths.credential_file())
        .ok()
        .flatten()?;
    let config = LocalConfig::load(&paths.config_file()).ok().flatten()?;
    let origin = normalize_server_origin(&config.server_url).ok()?;
    if origin != credential.server_origin {
        return None;
    }
    Some((config, credential))
}

fn project_alias_completer(aliases: Arc<Vec<String>>) -> ArgValueCompleter {
    ArgValueCompleter::new(move |current: &OsStr| complete_project_aliases(&aliases, current))
}

fn complete_project_aliases(aliases: &[String], current: &OsStr) -> Vec<CompletionCandidate> {
    let Some(prefix) = current.to_str() else {
        return Vec::new();
    };
    aliases
        .iter()
        .filter(|alias| alias.starts_with(prefix))
        .map(|alias| CompletionCandidate::new(alias.clone()))
        .collect()
}

fn decorate_project_selectors(cmd: Command, completer: &ArgValueCompleter) -> Command {
    cmd.mut_subcommand("project", |project| {
        project
            .mut_subcommand("show", |show| attach_project_selector(show, completer))
            .mut_subcommand("set", |set| attach_project_selector(set, completer))
            .mut_subcommand("rename", |rename| {
                attach_project_selector(rename, completer)
            })
            .mut_subcommand("detach", |detach| {
                attach_project_selector(detach, completer)
            })
            .mut_subcommand("delete", |delete| {
                attach_project_selector(delete, completer)
            })
            .mut_subcommand("default-runtime", |default_runtime| {
                attach_project_selector(default_runtime, completer)
            })
    })
    .mut_subcommand("job", |job| {
        job.mut_subcommand("list", |list| attach_project_selector(list, completer))
    })
}

fn attach_project_selector(cmd: Command, completer: &ArgValueCompleter) -> Command {
    let command_name = cmd.get_name().to_owned();
    let mut found = false;
    let cmd = cmd.mut_args(|arg| {
        if arg.get_id().as_str() == "project" {
            found = true;
            arg.add(completer.clone())
        } else {
            arg
        }
    });
    if !found {
        panic!("completion selector argument `project` is undefined on command `{command_name}`");
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn package_version_is_2_5_6() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "2.5.6");
        assert_eq!(Cli::command().get_version(), Some("2.5.6"));

        let err = Cli::try_parse_from(["ceo-connector", "--version"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
        assert!(err.to_string().contains("2.5.6"));
    }

    #[test]
    fn registration_args_do_not_request_dynamic_candidates() {
        let registration = [OsString::from("ceo-connector")];
        assert!(!dynamic_candidates_requested_from_args(&registration));

        let registration_with_shell_noise =
            [OsString::from("ceo-connector"), OsString::from("--help")];
        assert!(!dynamic_candidates_requested_from_args(
            &registration_with_shell_noise
        ));
    }

    #[test]
    fn word_completion_args_request_dynamic_candidates() {
        let args = [
            OsString::from("ceo-connector"),
            OsString::from("--"),
            OsString::from("ceo-connector"),
            OsString::from("project"),
            OsString::from("show"),
            OsString::from("e"),
        ];
        assert!(dynamic_candidates_requested_from_args(&args));
    }

    #[test]
    fn empty_prefix_matches_every_alias_and_utf8_prefix_filters() {
        let aliases = vec![
            "chief-everything-officer".to_string(),
            "echolet".to_string(),
        ];
        let all = complete_project_aliases(&aliases, OsStr::new(""));
        let values: Vec<_> = all
            .iter()
            .map(|candidate| candidate.get_value().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            values,
            vec![
                "chief-everything-officer".to_string(),
                "echolet".to_string(),
            ]
        );

        let filtered = complete_project_aliases(&aliases, OsStr::new("e"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].get_value(), "echolet");
    }
}
