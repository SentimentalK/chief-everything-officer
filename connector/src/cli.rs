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
        /// Server origin URL for self-hosted or custom deployments (e.g.
        /// https://ceo.example.com or http://127.0.0.1:4000). When omitted,
        /// the official CEO Server (https://ceo.sentimentalk.com) is used.
        #[arg(long)]
        server: Option<String>,

        /// Custom display name for this device
        #[arg(long)]
        name: Option<String>,

        /// Do not automatically open the browser for approval
        #[arg(long, default_value_t = false)]
        no_open: bool,

        /// Skip the guided setup handoff after successful authentication
        /// (explicit escape hatch for scripts/automation)
        #[arg(long, default_value_t = false)]
        no_setup: bool,
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

    /// Guided, interactive device setup (arrow-key menus)
    Setup,

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
        /// Target selector: exact target alias or exact target ID
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
        /// Target selector: exact target alias or exact target ID
        #[arg(long)]
        target_id: String,
        #[arg(long)]
        agent_id: String,
        #[arg(long)]
        agent_command: String,
    },
    /// Set or clear an optional per-target model override for the agent executor
    SetModel {
        /// Target selector: exact target alias or exact target ID
        #[arg(long)]
        target_id: String,
        /// Model ID to force for every newly launched execution on this target
        /// (verified Cursor contract, e.g. `gpt-5` or
        /// `claude-opus-4-8[context=1m,effort=high,fast=false]`)
        #[arg(long)]
        model: Option<String>,
        /// Clear any existing model override
        #[arg(long, default_value_t = false)]
        clear: bool,
    },
    /// Set the workspace default agent runtime target (server-side routing state)
    SetDefaultRuntime {
        /// Target selector: exact target alias or exact target ID
        #[arg(long)]
        target_id: String,
    },
    /// Rename a target's human alias (server-authoritative; no recreate)
    Rename {
        /// Current target selector: exact target alias or exact target ID
        selector: String,

        /// New alias (lowercase alphanumeric, hyphen, underscore; 1-64 chars,
        /// unique within the workspace)
        new_alias: String,

        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
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
    /// Cancel a job (server-authoritative, idempotent operator action)
    Cancel {
        /// Job ID (job-<uuid>)
        job_id: String,

        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}
