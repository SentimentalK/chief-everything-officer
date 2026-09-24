use clap::{Parser, Subcommand};
use std::process::ExitCode;

use ceo_connector::enrollment::{login_flow, logout_flow};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::status::{get_status, print_status};

#[derive(Parser)]
#[command(name = "ceo-connector")]
#[command(about = "Chief Everything Officer - Real Connector Execution Plane Daemon & CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Authenticate this device with the CEO Server
    Login {
        /// Server origin URL (e.g. https://ceo.example.com or http://127.0.0.1:4000)
        #[arg(long)]
        server: String,

        /// Custom display name for this device
        #[arg(long)]
        name: Option<String>,

        /// Do not automatically open the browser for approval
        #[arg(long, default_value_t = false)]
        no_open: bool,
    },

    /// Revoke this device's credential and logout locally
    Logout,

    /// Show current connector status
    Status {
        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Run the connector execution daemon
    Run,

    /// Pause job acquisition
    Pause,

    /// Resume job acquisition
    Resume,

    /// Target management commands
    Target {
        #[command(subcommand)]
        sub: TargetSubcommands,
    },

    /// Run environment and configuration diagnostics
    Doctor {
        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum TargetSubcommands {
    /// List configured targets
    List {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Register a new target and bind to this device
    Add {
        #[arg(long)]
        workspace: String,
        #[arg(long)]
        alias: String,
        #[arg(long)]
        display_name: String,
        #[arg(long)]
        kind: String,
        #[arg(long)]
        path: String,
        #[arg(long, default_value_t = false)]
        workspace_repository: bool,
    },
    /// Bind an existing target to this device
    Bind {
        #[arg(long)]
        target_id: String,
        #[arg(long)]
        path: String,
    },
    /// Remove this device's binding for a target
    Remove {
        #[arg(long)]
        target_id: String,
    },
}

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

    match cli.command {
        Commands::Login {
            server,
            name,
            no_open,
        } => {
            if let Err(e) = login_flow(&paths, &server, name, no_open).await {
                eprintln!("Login failed: {}", e);
                return ExitCode::FAILURE;
            }
        }
        Commands::Logout => {
            if let Err(e) = logout_flow(&paths).await {
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
            let adapter =
                std::sync::Arc::new(ceo_connector::scheduler::UnavailableExecutionAdapter);
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
            } => {
                if let Err(e) = ceo_connector::targets::target_add(
                    &paths,
                    &workspace,
                    &alias,
                    &display_name,
                    &kind,
                    &path,
                    workspace_repository,
                )
                .await
                {
                    eprintln!("Target add failed: {}", e);
                    return ExitCode::FAILURE;
                }
            }
            TargetSubcommands::Bind { target_id, path } => {
                if let Err(e) = ceo_connector::targets::target_bind(&paths, &target_id, &path).await
                {
                    eprintln!("Target bind failed: {}", e);
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
        Commands::Doctor { json } => {
            let report = ceo_connector::doctor::run_doctor(&paths, json).await;
            if !report.overall_passed {
                return ExitCode::FAILURE;
            }
        }
    }

    ExitCode::SUCCESS
}
