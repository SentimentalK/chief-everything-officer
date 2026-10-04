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

    /// Project management commands
    Project {
        #[command(subcommand)]
        sub: ProjectSubcommands,
    },

    /// Target management commands (low-level / compatibility)
    #[command(hide = true)]
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

    /// Guided, interactive device setup (convergence)
    Setup {
        /// Optional explicit agent runtime path to link
        #[arg(long)]
        runtime_path: Option<String>,
    },

    /// Redeliver managed results to the server
    Redeliver {
        /// Optional job ID to redeliver (omitted = smart redelivery scanning this device)
        job_id: Option<String>,

        /// Specific attempt ID to redeliver (optional if only one attempt exists)
        #[arg(long)]
        attempt: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum ProjectSubcommands {
    /// Add an existing Git project to this device and workspace
    Add {
        /// Local filesystem path to the project Git repository (defaults to current directory)
        path: Option<String>,

        /// Optional project name / alias override (defaults to Git remote or directory name)
        #[arg(long)]
        name: Option<String>,

        /// Execution agent ID (interactive selection if flag is given without a value)
        #[arg(long, num_args = 0..=1, default_missing_value = "")]
        agent: Option<String>,

        /// Optional model override (e.g. gpt-5, or 'auto' to clear)
        #[arg(long)]
        model: Option<String>,
    },

    /// List configured projects
    List {
        /// Show full Workspace Server Target catalogue, including unbound entries
        #[arg(long, default_value_t = false)]
        all: bool,

        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Show project details
    Show {
        /// Project selector: exact project alias, display name, or target ID
        project: String,

        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Update project configuration (path, agent, or model)
    Set {
        /// Project selector: exact project alias, display name, or target ID
        project: String,

        /// Update local filesystem path
        #[arg(long)]
        path: Option<String>,

        /// Execution agent ID (interactive selection if flag is given without a value; 'auto' to follow Orca default)
        #[arg(long, num_args = 0..=1, default_missing_value = "")]
        agent: Option<String>,

        /// Model override for this project ('auto' to clear)
        #[arg(long)]
        model: Option<String>,
    },

    /// Rename a project (server-authoritative alias)
    Rename {
        /// Project selector: exact project alias, display name, or target ID
        project: String,

        /// New project name / alias
        new_name: String,

        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Detach a project from this device (removes device binding and local configuration)
    Detach {
        /// Project selector: exact project alias, display name, or target ID
        project: String,
    },

    /// Workspace-level permanent deletion of a project (Server-authoritative)
    Delete {
        /// Project selector: exact project alias, display name, or target ID
        project: String,

        /// Skip the interactive confirmation prompt (required for
        /// non-interactive use)
        #[arg(long, default_value_t = false)]
        force: bool,

        /// Output in JSON format
        #[arg(long, default_value_t = false)]
        json: bool,
    },

    /// Remove a project binding from this device (deprecated: use 'detach')
    #[command(hide = true)]
    Remove {
        /// Project selector: exact project alias, display name, or target ID
        project: String,
    },

    /// Get or set the workspace default Agent Runtime project
    DefaultRuntime {
        /// Project selector to set as default (if omitted, shows current workspace default)
        project: Option<String>,
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

        /// Filter by project alias, display name, or target ID
        #[arg(long)]
        project: Option<String>,

        /// Filter by execution target ID (tgt_...) [compatibility]
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
