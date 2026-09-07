use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

const MAX_EVENT_FILE_BYTES: u64 = 50 * 1024 * 1024; // 50 MB limit

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleEvent {
    pub timestamp: DateTime<Utc>,
    pub job_id: String,
    pub attempt_id: String,
    pub stage: String,
    pub event: String,
    pub source: String,
    pub data: serde_json::Value,
}

#[derive(Clone)]
pub struct EventLogger {
    path: PathBuf,
    job_id: String,
    attempt_id: String,
    total_bytes_written: Arc<AtomicU64>,
    truncated: Arc<AtomicBool>,
}

impl EventLogger {
    pub fn new(attempt_dir: &Path, job_id: &str, attempt_id: &str) -> Self {
        let path = attempt_dir.join("events.jsonl");
        Self {
            path,
            job_id: job_id.to_string(),
            attempt_id: attempt_id.to_string(),
            total_bytes_written: Arc::new(AtomicU64::new(0)),
            truncated: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn log_event(
        &self,
        stage: &str,
        event_name: &str,
        source: crate::observability::logger::LogSource,
        data: serde_json::Value,
    ) {
        self.log(stage, event_name, source.as_tag(), data);
    }

    pub fn log(&self, stage: &str, event_name: &str, source: &str, data: serde_json::Value) {
        if self.truncated.load(Ordering::Relaxed) {
            return;
        }

        let event = LifecycleEvent {
            timestamp: Utc::now(),
            job_id: self.job_id.clone(),
            attempt_id: self.attempt_id.clone(),
            stage: stage.to_string(),
            event: event_name.to_string(),
            source: source.to_string(),
            data,
        };

        if let Ok(line) = serde_json::to_string(&event) {
            let line_bytes = format!("{}\n", line).into_bytes();
            let current = self.total_bytes_written.load(Ordering::Relaxed);
            if current + (line_bytes.len() as u64) > MAX_EVENT_FILE_BYTES {
                self.truncated.store(true, Ordering::Relaxed);
                let warning = format!(
                    "{{\"timestamp\":\"{}\",\"stage\":\"system\",\"event\":\"event_log_truncated\",\"source\":\"system\",\"data\":{{\"message\":\"events.jsonl reached 50MB limit\"}}}}\n",
                    Utc::now().to_rfc3339()
                );
                let _ = self.append_bytes(warning.as_bytes());
                return;
            }

            if self.append_bytes(&line_bytes).is_ok() {
                self.total_bytes_written
                    .fetch_add(line_bytes.len() as u64, Ordering::Relaxed);
            }
        }
    }

    fn append_bytes(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(bytes)?;
        file.flush()
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated.load(Ordering::Relaxed)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
