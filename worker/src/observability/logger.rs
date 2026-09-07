use chrono::Utc;
use regex::Regex;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;

const MAX_LOG_FILE_BYTES: u64 = 20 * 1024 * 1024; // 20 MB limit
const MAX_LINE_BYTES: usize = 32 * 1024; // 32 KB line length cap

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSource {
    Launcher,
    Agent,
    Script,
    System,
    Doctor,
    Setup,
    Verifier,
}

impl LogSource {
    pub fn as_tag(&self) -> &'static str {
        match self {
            LogSource::Launcher => "launcher",
            LogSource::Agent => "agent",
            LogSource::Script => "script",
            LogSource::System => "system",
            LogSource::Doctor => "doctor",
            LogSource::Setup => "setup",
            LogSource::Verifier => "verifier",
        }
    }
}

#[derive(Clone)]
pub struct ProcessLogger {
    log_path: PathBuf,
    source: LogSource,
    echo_tx: Option<mpsc::Sender<String>>,
    dropped_lines: Arc<AtomicU64>,
    truncated: Arc<AtomicBool>,
    ansi_regex: Regex,
    redact_regexes: Vec<(Regex, &'static str)>,
}

impl ProcessLogger {
    pub fn new(
        attempt_dir: &Path,
        file_name: &str,
        source: LogSource,
        echo_tx: Option<mpsc::Sender<String>>,
    ) -> Self {
        let log_path = attempt_dir.join(file_name);
        let ansi_regex = Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap();

        let redact_regexes = vec![
            (
                Regex::new(r"(?i)bearer\s+[a-z0-9_\-\.]{10,}").unwrap(),
                "Bearer [REDACTED]",
            ),
            (
                Regex::new(r"AIza[0-9A-Za-z-_]{35}").unwrap(),
                "AIza[REDACTED]",
            ),
            (
                Regex::new(r"ghp_[A-Za-z0-9]{36}").unwrap(),
                "ghp_[REDACTED]",
            ),
            (
                Regex::new(r#"(?i)("password"|"token"|"secret")\s*:\s*"[^"]+""#).unwrap(),
                r#"$1: "[REDACTED]""#,
            ),
        ];

        Self {
            log_path,
            source,
            echo_tx,
            dropped_lines: Arc::new(AtomicU64::new(0)),
            truncated: Arc::new(AtomicBool::new(false)),
            ansi_regex,
            redact_regexes,
        }
    }

    pub fn dropped_lines_count(&self) -> u64 {
        self.dropped_lines.load(Ordering::Relaxed)
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated.load(Ordering::Relaxed)
    }

    pub fn sanitize(&self, line: &str) -> String {
        // Strip ANSI control sequences
        let cleaned = self.ansi_regex.replace_all(line, "");
        let mut result = cleaned.to_string();

        // Apply redactions
        for (pattern, replacement) in &self.redact_regexes {
            result = pattern.replace_all(&result, *replacement).to_string();
        }

        result
    }

    fn write_to_file(&self, text: &str) -> std::io::Result<()> {
        let path = &self.log_path;
        if let Ok(metadata) = fs::metadata(path) {
            if metadata.len() > MAX_LOG_FILE_BYTES {
                self.truncated.store(true, Ordering::Relaxed);
                let rotated = path.with_extension("log.1");
                let _ = fs::rename(path, rotated);
                let mut f = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(path)?;
                writeln!(
                    f,
                    "[{}] [LOG_TRUNCATED: Maximum file size limit reached, rotated]",
                    Utc::now().to_rfc3339()
                )?;
            }
        }

        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(text.as_bytes())?;
        file.flush()
    }

    pub fn log_line_with_source(&self, source: LogSource, raw_line: &str) {
        let sanitized = self.sanitize(raw_line);
        let timestamp = Utc::now().to_rfc3339();
        let formatted = format!("{} [{}] {}\n", timestamp, source.as_tag(), sanitized);

        let _ = self.write_to_file(&formatted);

        // Send to echo channel without blocking
        if let Some(tx) = &self.echo_tx {
            let display_line = format!("[{}] {}", source.as_tag(), sanitized);
            if tx.try_send(display_line).is_err() {
                self.dropped_lines.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn log_line(&self, raw_line: &str) {
        self.log_line_with_source(self.source, raw_line);
    }

    pub fn get_tail_snippet(&self, max_lines: usize) -> String {
        if let Ok(content) = fs::read_to_string(&self.log_path) {
            let lines: Vec<&str> = content.lines().collect();
            if lines.len() <= max_lines {
                return content;
            }
            lines[lines.len() - max_lines..].join("\n")
        } else {
            String::new()
        }
    }

    pub async fn drain_stream<R: AsyncRead + Unpin>(&self, mut stream: R) {
        let mut buf = [0u8; 8192];
        let mut line_buf = Vec::with_capacity(1024);

        while let Ok(n) = stream.read(&mut buf).await {
            if n == 0 {
                break;
            }

            for &b in &buf[..n] {
                if b == b'\n' {
                    if let Ok(line) = std::str::from_utf8(&line_buf) {
                        self.log_line(line.trim_end_matches('\r'));
                    }
                    line_buf.clear();
                } else {
                    if line_buf.len() < MAX_LINE_BYTES {
                        line_buf.push(b);
                    } else if line_buf.len() == MAX_LINE_BYTES {
                        // Truncate long line
                        if let Ok(line) = std::str::from_utf8(&line_buf) {
                            self.log_line(&format!("{}... [LINE_TRUNCATED]", line));
                        }
                        line_buf.clear();
                    }
                }
            }
        }

        if !line_buf.is_empty() {
            if let Ok(line) = std::str::from_utf8(&line_buf) {
                self.log_line(line.trim_end_matches('\r'));
            }
        }
    }
}

pub struct StreamEventDispatcher {
    events_path: PathBuf,
    stdout_logger: ProcessLogger,
    event_tx: mpsc::Sender<serde_json::Value>,
}

impl StreamEventDispatcher {
    pub fn new(
        events_path: PathBuf,
        stdout_logger: ProcessLogger,
        event_tx: mpsc::Sender<serde_json::Value>,
    ) -> Self {
        Self {
            events_path,
            stdout_logger,
            event_tx,
        }
    }

    pub async fn run<R: AsyncRead + Unpin>(self, stream: R) {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stream).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                // 1. Write raw line to events.jsonl without modification
                if let Ok(mut f) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.events_path)
                {
                    let _ = writeln!(f, "{}", trimmed);
                }

                // 2. Dispatch to state machine channel
                let _ = self.event_tx.send(val.clone()).await;

                // 3. Format for stdout logger
                if let Some(event_type) = val.get("event").and_then(|v| v.as_str()) {
                    match event_type {
                        "init" => {
                            self.stdout_logger.log_line_with_source(
                                LogSource::Launcher,
                                &format!(
                                    "Session initialized: conversation_id={}",
                                    val.get("conversation_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown")
                                ),
                            );
                        }
                        "step_update" => {
                            if let Some(step) = val.get("step_update") {
                                if let Some(delta) = step.get("text_delta").and_then(|v| v.as_str())
                                {
                                    if !delta.trim().is_empty() {
                                        self.stdout_logger.log_line_with_source(
                                            LogSource::Agent,
                                            delta.trim_end(),
                                        );
                                    }
                                } else if let Some(tool) =
                                    step.get("tool_name").and_then(|v| v.as_str())
                                {
                                    let state =
                                        step.get("state").and_then(|v| v.as_str()).unwrap_or("");
                                    self.stdout_logger.log_line_with_source(
                                        LogSource::Launcher,
                                        &format!("[tool:{}] {}", tool, state),
                                    );
                                }
                            }
                        }
                        "result" => {
                            self.stdout_logger.log_line_with_source(
                                LogSource::Launcher,
                                &format!(
                                    "Turn completed: status={}",
                                    val.get("result")
                                        .and_then(|r| r.get("status"))
                                        .and_then(|s| s.as_str())
                                        .unwrap_or("unknown")
                                ),
                            );
                        }
                        _ => {
                            self.stdout_logger.log_line(trimmed);
                        }
                    }
                } else {
                    self.stdout_logger.log_line(trimmed);
                }
            } else {
                // Non-JSON line from stdout
                self.stdout_logger.log_line(trimmed);
            }
        }
    }
}
