use std::process::ExitCode;

use ceo_connector::cli::{Cli, Commands, JobSubcommands, TargetSubcommands};
use ceo_connector::jobs::JobListFilters;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::status::{get_status, print_status};
use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let paths = match ConnectorPaths::resolve() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error resolving connector paths: {}", e);
            return ExitCode::FAILURE;
        }
    };

    // Shared one-time schema migration entrypoint (PROJECT-036 Slice 1B):
    // every product code path starts here, so a legacy v1/v2 config is
    // deterministically migrated to the schema v3 steady state (or fails
    // closed with an actionable error) before any command executes.
    if let Err(e) = ceo_connector::config::ensure_config_schema_current(&paths) {
        eprintln!("Config schema migration failed: {}", e);
        return ExitCode::FAILURE;
    }

    match cli.command {
        Commands::Login {
            server,
            name,
            no_open,
            no_setup,
        } => {
            // Omitted --server selects the official CEO Server; an explicit
            // --server remains the override for self-hosted deployments.
            let server_origin =
                match ceo_connector::enrollment::resolve_login_origin(server.as_deref()) {
                    Ok(o) => o,
                    Err(e) => {
                        eprintln!("Invalid --server origin: {}", e);
                        return ExitCode::FAILURE;
                    }
                };
            match ceo_connector::enrollment::login_flow(&paths, &server_origin, name, no_open).await
            {
                Ok(_outcome) => {
                    // Post-login onboarding handoff (PROJECT-036 Slice 3).
                    // Never invalidates the successful authentication above.
                    let interactive = ceo_connector::setup_frontend::is_interactive_terminal();
                    let mut ui = ceo_connector::setup_frontend::TerminalUi;
                    match ceo_connector::setup_frontend::post_login_handoff(
                        &paths,
                        no_setup,
                        interactive,
                        &mut ui,
                    )
                    .await
                    {
                        Ok(None) => {}
                        Ok(Some(ceo_connector::setup_frontend::SetupCompletion::Finished {
                            doctor_passed,
                        })) => {
                            if !doctor_passed {
                                return ExitCode::FAILURE;
                            }
                        }
                        Ok(Some(ceo_connector::setup_frontend::SetupCompletion::Cancelled)) => {
                            println!(
                                "Setup is incomplete. Resume anytime with `ceo-connector setup`."
                            );
                        }
                        Err(e) => {
                            eprintln!("Setup failed: {}", e);
                            return ExitCode::FAILURE;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Login failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
        }
        Commands::Logout => {
            if let Err(e) = ceo_connector::enrollment::logout_flow(&paths).await {
                eprintln!("Logout failed: {}", e);
                return ExitCode::FAILURE;
            }
        }
        Commands::Status { json } => match get_status(&paths) {
            Ok(s) => print_status(&s, json),
            Err(e) => {
                eprintln!("Failed to read status: {}", e);
                return ExitCode::FAILURE;
            }
        },
        Commands::Run => {
            let adapter = std::sync::Arc::new(ceo_connector::orca::OrcaExecutionAdapter::default());
            if let Err(e) = ceo_connector::daemon::run_daemon(&paths, adapter, None).await {
                eprintln!("Daemon terminated with error: {}", e);
                return ExitCode::FAILURE;
            }
        }
        Commands::Pause => {
            let _lock = match ceo_connector::local_state::ExecutionLock::acquire(
                &paths.state_lock_file(),
            ) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Failed to acquire state lock: {}", e);
                    return ExitCode::FAILURE;
                }
            };
            if let Err(e) = ceo_connector::local_state::atomic_write_json(
                &paths.control_file(),
                &serde_json::json!({
                    "schema_version": 1,
                    "paused": true
                }),
            ) {
                eprintln!("Failed to write control file: {}", e);
                return ExitCode::FAILURE;
            }
            println!("Connector job acquisition paused.");
        }
        Commands::Resume => {
            let _lock = match ceo_connector::local_state::ExecutionLock::acquire(
                &paths.state_lock_file(),
            ) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Failed to acquire state lock: {}", e);
                    return ExitCode::FAILURE;
                }
            };
            if let Err(e) = ceo_connector::local_state::atomic_write_json(
                &paths.control_file(),
                &serde_json::json!({
                    "schema_version": 1,
                    "paused": false
                }),
            ) {
                eprintln!("Failed to write control file: {}", e);
                return ExitCode::FAILURE;
            }
            println!("Connector job acquisition resumed.");
        }
        Commands::Target { sub } => match sub {
            TargetSubcommands::List { json } => {
                if let Err(e) = ceo_connector::targets::target_list(&paths, json).await {
                    eprintln!("Target list failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::Add {
                workspace,
                alias,
                display_name,
                kind,
                path,
                workspace_repository,
                agent_id,
                agent_command,
            } => {
                if let Err(e) = ceo_connector::targets::target_add(
                    &paths,
                    &workspace,
                    &alias,
                    &display_name,
                    &kind,
                    &path,
                    workspace_repository,
                    agent_id,
                    agent_command,
                )
                .await
                {
                    eprintln!("Target add failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::Bind {
                target_id,
                path,
                agent_id,
                agent_command,
            } => {
                if let Err(e) = ceo_connector::targets::target_bind(
                    &paths,
                    &target_id,
                    &path,
                    agent_id,
                    agent_command,
                )
                .await
                {
                    eprintln!("Target bind failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::SetAgent {
                target_id,
                agent_id,
                agent_command,
            } => {
                if let Err(e) = ceo_connector::targets::target_set_agent(
                    &paths,
                    &target_id,
                    &agent_id,
                    &agent_command,
                )
                .await
                {
                    eprintln!("Target set-agent failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::SetModel {
                target_id,
                model,
                clear,
            } => {
                // Exactly one of --model or --clear is required.
                let result = match (&model, clear) {
                    (Some(_), true) => {
                        eprintln!("Error: --model and --clear are mutually exclusive; provide exactly one.");
                        return ExitCode::FAILURE;
                    }
                    (None, false) => {
                        eprintln!(
                            "Error: provide exactly one of `--model <model-id>` or `--clear`."
                        );
                        return ExitCode::FAILURE;
                    }
                    (Some(m), false) => {
                        ceo_connector::targets::target_set_model(&paths, &target_id, Some(m)).await
                    }
                    (None, true) => {
                        ceo_connector::targets::target_set_model(&paths, &target_id, None).await
                    }
                };
                if let Err(e) = result {
                    eprintln!("Target set-model failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::SetDefaultRuntime { target_id } => {
                if let Err(e) =
                    ceo_connector::targets::target_set_default_runtime(&paths, &target_id).await
                {
                    eprintln!("Target set-default-runtime failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::Rename {
                selector,
                new_alias,
                json,
            } => {
                if let Err(e) =
                    ceo_connector::targets::target_rename(&paths, &selector, &new_alias, json).await
                {
                    eprintln!("Target rename failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::Remove { target_id } => {
                if let Err(e) = ceo_connector::targets::target_remove(&paths, &target_id).await {
                    eprintln!("Target remove failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
        },
        Commands::Job { sub } => match sub {
            JobSubcommands::List {
                json,
                state,
                target_id,
                limit,
                cursor,
            } => {
                let filters = JobListFilters {
                    state,
                    target_id,
                    limit,
                    cursor,
                };
                if let Err(e) = ceo_connector::jobs::job_list(&paths, filters, json).await {
                    eprintln!("Job list failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            JobSubcommands::Show {
                job_id,
                json,
                include_task,
            } => {
                if let Err(e) =
                    ceo_connector::jobs::job_show(&paths, &job_id, include_task, json).await
                {
                    eprintln!("Job show failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            JobSubcommands::Cancel { job_id, json } => {
                if let Err(e) = ceo_connector::jobs::job_cancel(&paths, &job_id, json).await {
                    eprintln!("Job cancel failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
        },
        Commands::Doctor { json } => {
            let report = ceo_connector::doctor::run_doctor(&paths, json).await;
            if !report.overall_passed {
                return ExitCode::FAILURE;
            }
        }
        Commands::Setup => {
            // Interactive-terminal contract: fail fast/actionably on a
            // non-TTY; never hang, never fall back to numeric menus.
            if !ceo_connector::setup_frontend::is_interactive_terminal() {
                eprintln!(
                    "Error: `ceo-connector setup` requires an interactive terminal (stdin and stdout attached to a TTY). Re-run it inside a normal terminal session. (SETUP_INTERACTIVE_TTY_REQUIRED)"
                );
                return ExitCode::FAILURE;
            }
            let mut ui = ceo_connector::setup_frontend::TerminalUi;
            match ceo_connector::setup_frontend::run_standalone_setup(
                &paths,
                &mut ui,
                &ceo_connector::setup_frontend::ProductionDoctor,
            )
            .await
            {
                Ok(exit) => return exit,
                Err(e) => {
                    eprintln!("Setup failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
        }
        Commands::Redeliver { job_id, attempt } => {
            if let Err(e) =
                ceo_connector::redelivery::run_redeliver(&paths, &job_id, attempt.as_deref()).await
            {
                eprintln!("Redelivery failed: {}", e);
                return ExitCode::FAILURE;
            }
        }
    }

    ExitCode::SUCCESS
}
