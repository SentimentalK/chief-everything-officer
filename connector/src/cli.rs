use clap::{Parser, Subcommand};

use crate::jobs::parse_state_filter;

#[derive(Parser, Debug)]
#[command(name = "ceo-connector")]
#[command(version)]
#[command(about = "Chief Everything Officer - Real Connector Execution Plane Daemon & CLI")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
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

    /// Job read commands (server read models)
    Job {
        #[command(subcommand)]
        sub: JobSubcommands,
    },

    /// Run environment and configuration diagnostics
    Doctor {
        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Redeliver a managed result to the server
    Redeliver {
        /// Job ID to redeliver
        job_id: String,

        /// Specific attempt ID to redeliver (optional if only one attempt exists)
        #[arg(long)]
        attempt: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum TargetSubcommands {
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
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long)]
        agent_command: Option<String>,
    },
    /// Bind an existing target to this device
    Bind {
        #[arg(long)]
        target_id: String,
        #[arg(long)]
        path: String,
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long)]
        agent_command: Option<String>,
    },
    /// Configure the agent executor for a target
    SetAgent {
        #[arg(long)]
        target_id: String,
        #[arg(long)]
        agent_id: String,
        #[arg(long)]
        agent_command: String,
    },
    /// Set the workspace default agent runtime target (server-side routing state)
    SetDefaultRuntime {
        #[arg(long)]
        target_id: String,
    },
    /// Remove this device's binding for a target
    Remove {
        #[arg(long)]
        target_id: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum JobSubcommands {
    /// List jobs visible to this device (newest first)
    List {
        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,

        /// Filter by lifecycle state: queued, claimed, running, expired, terminal
        #[arg(long, value_parser = parse_state_filter)]
        state: Option<String>,

        /// Filter by execution target ID (tgt_...)
        #[arg(long)]
        target_id: Option<String>,

        /// Maximum number of jobs to return (server-bounded)
        #[arg(long)]
        limit: Option<u32>,

        /// Pagination cursor from a previous next_cursor
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Show one job in detail
    Show {
        /// Job ID (job-<uuid>)
        job_id: String,

        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,

        /// Include task prompt/acceptance in the output
        #[arg(long, default_value_t = false)]
        include_task: bool,
    },
}
