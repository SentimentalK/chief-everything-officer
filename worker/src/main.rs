use ceo_worker::config::WorkerConfig;
use ceo_worker::doctor::{run_doctor, DoctorStatus};
use ceo_worker::observability::status::StatusTracker;
use ceo_worker::runner::Runner;
use clap::{Parser, Subcommand};
use std::path::Path;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Parser)]
#[command(name = "ceo-worker")]
#[command(about = "CEO Worker Plane lightweight capability runner", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run doctor checks on a capability or the system
    Doctor {
        #[arg(short, long, default_value = "content.extract_url")]
        capability: String,
    },
    /// Run a capability task
    Run {
        #[arg(short, long, default_value = "content.extract_url")]
        capability: String,
        #[arg(short, long)]
        url: String,
        #[arg(short, long)]
        job_id: Option<String>,
        #[arg(long, default_value_t = false)]
        no_stream: bool,
    },
    /// Query the status of a job
    Status {
        #[arg(short, long)]
        job_id: String,
    },
    /// Inspect logs for a job
    Logs {
        #[arg(short, long)]
        job_id: String,
        #[arg(short, long)]
        attempt_id: Option<String>,
        #[arg(short, long, default_value_t = false)]
        follow: bool,
        #[arg(short, long, default_value = "all")]
        source: String,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let config = WorkerConfig::from_env();

    match cli.command {
        Commands::Doctor { capability } => {
            let cap_dir = config.capability_dir(&capability);
            if !cap_dir.exists() {
                eprintln!("Error: Capability directory not found at {:?}", cap_dir);
                std::process::exit(1);
            }
            match run_doctor(&cap_dir).await {
                Ok(report) => {
                    println!("{}", serde_json::to_string_pretty(&report).unwrap());
                    if report.status != DoctorStatus::Ready {
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("Doctor check failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Run {
            capability,
            url,
            job_id,
            no_stream,
        } => {
            let (echo_tx, echo_rx) = if !no_stream {
                let (tx, rx) = mpsc::channel(1024);
                (Some(tx), Some(rx))
            } else {
                (None, None)
            };

            // Spawn console printer if streaming is enabled
            let print_handle = echo_rx.map(|mut rx| {
                tokio::spawn(async move {
                    while let Some(line) = rx.recv().await {
                        println!("{}", line);
                    }
                })
            });

            let runner = Runner::new(config, echo_tx);
            let run_result = runner.run_job(&capability, &url, job_id).await;
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
                                art.name, art.size_bytes, art.sha256
                            );
                        }
                    }

                    if receipt.execution_status != "COMPLETED" {
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("Runner failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Commands::Status { job_id } => {
            let job_dir = config.job_dir(&job_id);
            if !job_dir.exists() {
                eprintln!(
                    "Job ID '{}' not found in {:?}",
                    job_id, config.workspace_dir
                );
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
            job_id,
            attempt_id,
            follow,
            source,
        } => {
            let job_dir = config.job_dir(&job_id);
            if !job_dir.exists() {
                eprintln!("Job ID '{}' not found.", job_id);
                std::process::exit(1);
            }

            let resolved_attempt_id = if let Some(att) = attempt_id {
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

            let log_file = config
                .attempt_dir(&job_id, &resolved_attempt_id)
                .join("stdout.log");
            if !log_file.exists() && !follow {
                eprintln!("Log file not found at {:?}", log_file);
                std::process::exit(1);
            }

            if follow {
                follow_log_file(&log_file, &source).await;
            } else {
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
}

fn filter_line_by_source(line: &str, source: &str) -> bool {
    if source == "all" {
        return true;
    }
    let tag = format!("[{}]", source.to_lowercase());
    line.contains(&tag)
}

async fn follow_log_file(path: &Path, source: &str) {
    use tokio::fs::File;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut waited = 0;
    while !path.exists() && waited < 30 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        waited += 1;
    }

    if !path.exists() {
        eprintln!("Log file did not appear within timeout.");
        return;
    }

    if let Ok(file) = File::open(path).await {
        let mut reader = BufReader::new(file);
        let mut line = String::new();

        loop {
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    // Check if file was rotated
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if filter_line_by_source(trimmed, source) {
                        println!("{}", trimmed);
                    }
                    line.clear();
                }
                Err(_) => break,
            }
        }
    }
}
