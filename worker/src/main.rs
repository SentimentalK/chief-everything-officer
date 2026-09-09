use ceo_worker::bridge::client::BridgeClient;
use ceo_worker::bridge::config::{load_api_key, BridgeConfig};
use ceo_worker::bridge::controller::Worker;
use ceo_worker::bridge::lease::{Clock, SystemBootClock};
use ceo_worker::config::{safe_attempt_dir, safe_job_dir, validate_id, WorkerConfig};
use ceo_worker::local_state::ExecutionLock;
use ceo_worker::observability::status::{JobStage, StatusTracker};
use ceo_worker::runner::{Runner, StopReason};
use ceo_worker::verifier::BusinessOutcome;
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{mpsc, watch};

#[derive(Parser)]
#[command(name = "ceo-worker")]
#[command(about = "CEO Worker Plane lightweight capability runner", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run doctor checks on a workspace
    Doctor {
        #[arg(short, long)]
        workspace: PathBuf,
        #[arg(short, long, default_value_t = false)]
        force: bool,
    },
    /// Run an agent task on a workspace
    Run {
        #[arg(short, long)]
        workspace: PathBuf,
        #[arg(short, long)]
        prompt_file: PathBuf,
        #[arg(short, long)]
        job_id: Option<String>,
        #[arg(short, long)]
        timeout: Option<u64>,
        #[arg(long, default_value_t = false)]
        no_stream: bool,
        #[arg(long, default_value_t = false)]
        force_doctor: bool,
    },
    /// Query the status of a job
    Status {
        #[arg(short, long)]
        workspace: PathBuf,
        #[arg(short, long)]
        job_id: String,
    },
    /// Inspect logs for a job
    Logs {
        #[arg(short, long)]
        workspace: PathBuf,
        #[arg(short, long)]
        job_id: String,
        #[arg(short, long)]
        attempt_id: Option<String>,
        #[arg(short, long, default_value_t = false)]
        follow: bool,
        #[arg(long, default_value = "stdout")]
        stream: String,
        #[arg(short, long, default_value = "all")]
        source: String,
        #[arg(short, long, default_value_t = false)]
        events: bool,
    },
    /// Read-only connectivity checks against the CEO server bridge
    Bridge {
        #[command(subcommand)]
        cmd: BridgeCmd,
    },
}

#[derive(Subcommand)]
enum BridgeCmd {
    /// Verify identity, config, and task discovery for one workspace
    Check {
        /// Path to the bridge config JSON file
        #[arg(long)]
        config: PathBuf,
        /// Workspace alias to check (must exist in the config)
        #[arg(long)]
        workspace_ref: String,
        /// Exclusive stream cursor to start discovery from
        #[arg(long, default_value = "0-0")]
        after: String,
    },
    /// Resident worker: claim and run discovered jobs under server leases
    Run {
        /// Path to the bridge config JSON file
        #[arg(long)]
        config: PathBuf,
        /// Workspace alias to serve (must exist in the config)
        #[arg(long)]
        workspace_ref: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let config = WorkerConfig::from_env();

    match cli.command {
        Commands::Doctor { workspace, force } => {
            let lock = match ExecutionLock::acquire(&workspace) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!(
                        "doctor: another ceo-worker holds the workspace lock on {:?}: {e}",
                        workspace
                    );
                    std::process::exit(1);
                }
            };
            let _lock = lock;
            let runner = Runner::new(config, None);
            match runner
                .run_standalone_doctor_with_options(&workspace, force)
                .await
            {
                Ok(report) => {
                    println!("{}", serde_json::to_string_pretty(&report).unwrap());
                    if !report.ready {
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("Doctor failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Run {
            workspace,
            prompt_file,
            job_id,
            timeout,
            no_stream,
            force_doctor,
        } => {
            let lock = match ExecutionLock::acquire(&workspace) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!(
                        "run: another ceo-worker holds the workspace lock on {:?}: {e}",
                        workspace
                    );
                    std::process::exit(1);
                }
            };
            let _lock = lock;
            let (echo_tx, echo_rx) = if !no_stream {
                let (tx, rx) = mpsc::channel(1024);
                (Some(tx), Some(rx))
            } else {
                (None, None)
            };

            let print_handle = echo_rx.map(|mut rx| {
                tokio::spawn(async move {
                    while let Some(line) = rx.recv().await {
                        println!("{}", line);
                    }
                })
            });

            let runner = Runner::new(config, echo_tx);
            let run_result = runner
                .run_task_with_options(&workspace, &prompt_file, job_id, timeout, force_doctor)
                .await;
            drop(runner);

            if let Some(h) = print_handle {
                let _ = h.await;
            }

            match run_result {
                Ok(receipt) => {
                    println!("\n=== Task Receipt Summary ===");
                    println!("Job ID: {}", receipt.job_id);
                    println!("Attempt ID: {}", receipt.attempt_id);
                    println!("Execution Status: {}", receipt.execution_status);
                    println!("Business Outcome: {:?}", receipt.business_outcome);
                    println!("Duration: {} ms", receipt.timestamps.duration_ms);
                    if let Some(ref err) = receipt.error {
                        println!("Error [{}]: {}", err.code, err.message);
                    }
                    if !receipt.artifacts.is_empty() {
                        println!("Artifacts:");
                        for art in &receipt.artifacts {
                            println!(
                                "  - {} ({} bytes, sha256: {})",
                                art.path, art.size_bytes, art.sha256
                            );
                        }
                    }

                    if receipt.execution_status != "COMPLETED" {
                        std::process::exit(1);
                    }

                    if receipt.business_outcome == BusinessOutcome::Failed {
                        std::process::exit(1);
                    } else if receipt.business_outcome == BusinessOutcome::Unverified {
                        println!("\nNotice: Task completed execution, but artifacts are unverified by business verifier.");
                        std::process::exit(2);
                    }
                }
                Err(e) => {
                    eprintln!("FATAL: Runner failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Status { workspace, job_id } => {
            if let Err(e) = validate_id("job_id", &job_id) {
                eprintln!("Invalid job_id: {}", e);
                std::process::exit(1);
            }
            let job_dir = match safe_job_dir(&workspace, &job_id) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Invalid job path: {}", e);
                    std::process::exit(1);
                }
            };
            if !job_dir.exists() {
                eprintln!("Job ID '{}' not found in {:?}", job_id, workspace);
                std::process::exit(1);
            }
            match StatusTracker::load_status(&job_dir) {
                Ok(status) => {
                    println!("{}", serde_json::to_string_pretty(&status).unwrap());
                }
                Err(e) => {
                    eprintln!("Failed to read status: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Logs {
            workspace,
            job_id,
            attempt_id,
            follow,
            stream,
            source,
            events,
        } => {
            if let Err(e) = validate_id("job_id", &job_id) {
                eprintln!("Invalid job_id: {}", e);
                std::process::exit(1);
            }
            let job_dir = match safe_job_dir(&workspace, &job_id) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Invalid job path: {}", e);
                    std::process::exit(1);
                }
            };
            if !job_dir.exists() {
                eprintln!("Job ID '{}' not found in {:?}.", job_id, workspace);
                std::process::exit(1);
            }

            let resolved_attempt_id = if let Some(att) = attempt_id {
                if let Err(e) = validate_id("attempt_id", &att) {
                    eprintln!("Invalid attempt_id: {}", e);
                    std::process::exit(1);
                }
                att
            } else {
                match StatusTracker::load_status(&job_dir) {
                    Ok(st) => st.latest_attempt_id,
                    Err(e) => {
                        eprintln!("Failed to read latest attempt from status: {}", e);
                        std::process::exit(1);
                    }
                }
            };

            let attempt_dir = match safe_attempt_dir(&workspace, &job_id, &resolved_attempt_id) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Invalid attempt path: {}", e);
                    std::process::exit(1);
                }
            };

            if events {
                let event_file = attempt_dir.join("events.jsonl");
                if follow {
                    follow_file(&job_dir, &event_file, "all", true).await;
                } else if let Ok(content) = std::fs::read_to_string(&event_file) {
                    for line in content.lines() {
                        println!("{}", line);
                    }
                } else {
                    eprintln!("Events file not found at {:?}", event_file);
                    std::process::exit(1);
                }
                return;
            }

            let log_files: Vec<std::path::PathBuf> = match stream.as_str() {
                "stderr" => vec![attempt_dir.join("stderr.log")],
                "all" => vec![
                    attempt_dir.join("stdout.log"),
                    attempt_dir.join("stderr.log"),
                ],
                _ => vec![attempt_dir.join("stdout.log")],
            };

            if follow {
                if let Some(target) = log_files.first() {
                    follow_file(&job_dir, target, &source, false).await;
                }
            } else {
                for log_file in log_files {
                    if let Ok(content) = std::fs::read_to_string(&log_file) {
                        for line in content.lines() {
                            if filter_line_by_source(line, &source) {
                                println!("{}", line);
                            }
                        }
                    }
                }
            }
        }
        Commands::Bridge { cmd } => match cmd {
            BridgeCmd::Check {
                config,
                workspace_ref,
                after,
            } => {
                // bridge check is READ-ONLY: it never claims, starts, or beats
                // a job, and never creates attempt/cursor/receipt files.
                match bridge_check(&config, &workspace_ref, &after).await {
                    Ok(output) => {
                        println!("{}", serde_json::to_string_pretty(&output).unwrap());
                    }
                    Err(e) => {
                        eprintln!("bridge check failed: {}", e);
                        std::process::exit(1);
                    }
                }
            }
            BridgeCmd::Run {
                config,
                workspace_ref,
            } => {
                let code = bridge_run(&config, &workspace_ref).await;
                std::process::exit(code);
            }
        },
    }
}

/// Runs the resident `bridge run` worker until stopped.
async fn bridge_run(config_path: &Path, workspace_ref: &str) -> i32 {
    let cfg = match BridgeConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bridge run: config error: {e}");
            return 1;
        }
    };
    let canonical = match cfg.resolve_workspace(workspace_ref) {
        Some(p) => p.clone(),
        None => {
            eprintln!("bridge run: workspace_ref {workspace_ref:?} is not configured");
            return 1;
        }
    };
    let api_key = match load_api_key(&cfg.api_key_file) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("bridge run: {e}");
            return 1;
        }
    };

    // Acquire the workspace execution lock (held until this process exits).
    let _exec_lock = match ExecutionLock::acquire(&canonical) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!(
                "bridge run: another ceo-worker holds the workspace lock on {:?}: {e}",
                canonical
            );
            return 1;
        }
    };

    let client = match BridgeClient::new(cfg.server_base.clone(), api_key) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bridge run: failed to build bridge client: {e}");
            return 1;
        }
    };

    let worker_cfg = WorkerConfig::from_env();
    let runner = Runner::new(worker_cfg, None);
    let clock: Arc<dyn Clock> = Arc::new(SystemBootClock);
    let expected = cfg.expected_identity.clone();
    let worker = Worker::new(
        &cfg,
        expected,
        workspace_ref,
        canonical,
        client,
        clock,
        runner,
        String::new(),
    );

    // SIGINT/SIGTERM request a stop (cancel current, then exit 0).
    let (stop_tx, stop_rx) = watch::channel::<Option<StopReason>>(None);
    tokio::spawn(async move {
        let mut sigint = signal(SignalKind::interrupt()).ok();
        let mut sigterm = signal(SignalKind::terminate()).ok();
        let int = async {
            if let Some(s) = sigint.as_mut() {
                let _ = s.recv().await;
            }
        };
        let term = async {
            if let Some(s) = sigterm.as_mut() {
                let _ = s.recv().await;
            }
        };
        tokio::select! {
            _ = int => {}
            _ = term => {}
        }
        let _ = stop_tx.send(Some(StopReason::UserRequested));
    });

    let mut worker = worker;
    worker.run(stop_rx).await
}
async fn bridge_check(
    config_path: &Path,
    workspace_ref: &str,
    after: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let cfg = BridgeConfig::load(config_path)?;
    let workspace_dir = cfg
        .resolve_workspace(workspace_ref)
        .ok_or_else(|| format!("workspace_ref {workspace_ref:?} is not configured"))?;
    let api_key = load_api_key(&cfg.api_key_file)?;
    let client = BridgeClient::new(cfg.server_base.clone(), api_key)?;

    // 1. Confirm the live identity equals the configured binding BEFORE discovery.
    let identity = client
        .verify_identity(
            &cfg.expected_identity.user_id,
            &cfg.expected_identity.workspace_id,
        )
        .await?;
    // 2. Read one page of pending tasks for the resolved alias.
    let pending = client.pending(workspace_ref, after).await?;

    let jobs: Vec<serde_json::Value> = pending
        .jobs
        .iter()
        .map(|j| {
            serde_json::json!({
                "job_id": j.job_id,
                "workspace_ref": j.workspace_ref,
                "resource_id": j.resource_id,
                "created_at": j.created_at,
                "expires_at": j.expires_at,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "ok": true,
        "identity_verified": true,
        "user_id": identity.user_id,
        "workspace_id": identity.workspace_id,
        "workspace_ref": workspace_ref,
        "workspace": workspace_dir.display().to_string(),
        "jobs": jobs,
        "next_cursor": pending.next_cursor,
        "has_more": pending.has_more,
    }))
}

fn filter_line_by_source(line: &str, source: &str) -> bool {
    if source == "all" {
        return true;
    }
    let tag = format!("[{}]", source.to_lowercase());
    line.contains(&tag)
}

async fn follow_file(job_dir: &Path, path: &Path, source: &str, is_raw: bool) {
    use tokio::fs::File;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut waited = 0;
    while !path.exists() && waited < 30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        waited += 1;
    }

    if !path.exists() {
        eprintln!("Target log file did not appear within timeout: {:?}", path);
        return;
    }

    let file = match File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to open log file: {}", e);
            return;
        }
    };

    let mut pos = 0u64;
    let mut reader = BufReader::new(file);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // EOF reached: check for rotation
                if let Ok(metadata) = std::fs::metadata(path) {
                    if metadata.len() < pos {
                        // File was truncated or rotated: re-open from beginning
                        if let Ok(new_file) = File::open(path).await {
                            reader = BufReader::new(new_file);
                            pos = 0;
                            continue;
                        }
                    }
                }

                // Check terminal status
                if let Ok(status) = StatusTracker::load_status(job_dir) {
                    if matches!(
                        status.stage,
                        JobStage::Completed
                            | JobStage::Failed
                            | JobStage::Blocked
                            | JobStage::Cancelled
                            | JobStage::Interrupted
                            | JobStage::UnknownInterrupted
                    ) {
                        // Drain any newly written lines
                        while let Ok(n) = reader.read_line(&mut line).await {
                            if n == 0 {
                                break;
                            }
                            let trimmed = line.trim_end();
                            if is_raw || filter_line_by_source(trimmed, source) {
                                println!("{}", trimmed);
                            }
                            line.clear();
                        }
                        break;
                    }
                }

                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Ok(n) => {
                pos += n as u64;
                let trimmed = line.trim_end();
                if is_raw || filter_line_by_source(trimmed, source) {
                    println!("{}", trimmed);
                }
            }
            Err(_) => break,
        }
    }
}
