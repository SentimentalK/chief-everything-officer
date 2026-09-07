use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_ARTIFACT_BYTES: u64 = 50 * 1024 * 1024; // 50 MB limit

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BusinessOutcome {
    Verified,
    Unverified,
    Failed,
    NotStarted,
}

impl BusinessOutcome {
    pub fn description(&self) -> &'static str {
        match self {
            BusinessOutcome::Verified => "业务验证通过",
            BusinessOutcome::Unverified => "未执行业务验证或缺乏验证器",
            BusinessOutcome::Failed => "任务或验证失败",
            BusinessOutcome::NotStarted => "任务未开始",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactClaim {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskVerificationReport {
    pub outcome: BusinessOutcome,
    pub verified_artifacts: Vec<ArtifactClaim>,
    pub reason: String,
}

pub struct WorkspaceSnapshot {
    pub initial_files: HashSet<PathBuf>,
}

impl WorkspaceSnapshot {
    pub fn capture(workspace: &Path) -> Self {
        let mut initial_files = HashSet::new();
        Self::collect_files(workspace, &mut initial_files);
        Self { initial_files }
    }

    fn collect_files(dir: &Path, acc: &mut HashSet<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                // Skip .git and .ceo internal directories
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name == ".git" || name == ".ceo" {
                        continue;
                    }
                }
                if path.is_file() {
                    acc.insert(path);
                } else if path.is_dir() {
                    Self::collect_files(&path, acc);
                }
            }
        }
    }
}

pub struct GenericVerifier;

impl GenericVerifier {
    pub fn verify_attempt(
        workspace: &Path,
        attempt_dir: &Path,
        baseline: &WorkspaceSnapshot,
        agent_final_response: &str,
    ) -> TaskVerificationReport {
        // Look for completion.json or artifacts.json in attempt_dir
        let mut claims = Vec::new();

        let completion_path = if attempt_dir.join("completion.json").exists() {
            Some(attempt_dir.join("completion.json"))
        } else if workspace.join("completion.json").exists() {
            Some(workspace.join("completion.json"))
        } else {
            None
        };
        let artifacts_path = if attempt_dir.join("artifacts.json").exists() {
            Some(attempt_dir.join("artifacts.json"))
        } else if workspace.join("artifacts.json").exists() {
            Some(workspace.join("artifacts.json"))
        } else {
            None
        };

        if let Some(ref comp_path) = completion_path {
            if let Ok(content) = std::fs::read_to_string(comp_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(artifact) = val.get("artifact").and_then(|a| a.as_object()) {
                        if let Some(fname) = artifact.get("file_name").and_then(|f| f.as_str()) {
                            let p = if attempt_dir.join(fname).exists() {
                                attempt_dir.join(fname)
                            } else {
                                workspace.join(fname)
                            };
                            if let Ok(c) =
                                Self::inspect_artifact(workspace, attempt_dir, &p, baseline)
                            {
                                claims.push(c);
                            }
                        }
                    } else if let Some(list) = val.get("artifacts").and_then(|a| a.as_array()) {
                        for item in list {
                            if let Some(fname) = item.as_str() {
                                let p = if attempt_dir.join(fname).exists() {
                                    attempt_dir.join(fname)
                                } else {
                                    workspace.join(fname)
                                };
                                if let Ok(c) =
                                    Self::inspect_artifact(workspace, attempt_dir, &p, baseline)
                                {
                                    claims.push(c);
                                }
                            }
                        }
                    }
                }
            }
        } else if let Some(ref art_path) = artifacts_path {
            if let Ok(content) = std::fs::read_to_string(art_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(list) = val.get("artifacts").and_then(|a| a.as_array()) {
                        for item in list {
                            if let Some(p_str) = item.as_str() {
                                let p = PathBuf::from(p_str);
                                let resolved = if p.is_absolute() {
                                    p
                                } else if attempt_dir.join(&p).exists() {
                                    attempt_dir.join(&p)
                                } else {
                                    workspace.join(&p)
                                };
                                if let Ok(c) = Self::inspect_artifact(
                                    workspace,
                                    attempt_dir,
                                    &resolved,
                                    baseline,
                                ) {
                                    claims.push(c);
                                }
                            }
                        }
                    }
                }
            }
        }

        // If no structured artifact manifest was produced, inspect newly created files in workspace
        // and attempt_dir
        if claims.is_empty() {
            let mut current_files = HashSet::new();
            WorkspaceSnapshot::collect_files(workspace, &mut current_files);
            for path in current_files {
                if !baseline.initial_files.contains(&path) {
                    let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if fname != "completion.json"
                        && fname != "artifacts.json"
                        && !fname.starts_with('.')
                    {
                        if let Ok(c) =
                            Self::inspect_artifact(workspace, attempt_dir, &path, baseline)
                        {
                            claims.push(c);
                        }
                    }
                }
            }

            if let Ok(entries) = std::fs::read_dir(attempt_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if fname != "input.json"
                            && fname != "events.jsonl"
                            && fname != "stdout.log"
                            && fname != "stderr.log"
                            && fname != "receipt.json"
                            && fname != "status.json"
                            && fname != "agy.log"
                            && fname != "prompt_snapshot.md"
                            && fname != ".doctor_nonce.txt"
                        {
                            if let Ok(c) =
                                Self::inspect_artifact(workspace, attempt_dir, &path, baseline)
                            {
                                claims.push(c);
                            }
                        }
                    }
                }
            }
        }

        if claims.is_empty() {
            return TaskVerificationReport {
                outcome: BusinessOutcome::Unverified,
                verified_artifacts: Vec::new(),
                reason: format!(
                    "No explicit output artifacts declared or found in attempt. Agent response snippet: {}",
                    agent_final_response.chars().take(200).collect::<String>()
                ),
            };
        }

        // For this generic batch: if artifacts exist, are valid, non-stale, and pass basic checks
        // Check if an explicit assertion was made in completion.json
        let mut verified = false;
        if let Some(ref comp_path) = completion_path {
            if let Ok(content) = std::fs::read_to_string(comp_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let status_str = val
                        .get("business_status")
                        .or_else(|| val.get("status"))
                        .and_then(|s| s.as_str());
                    if status_str == Some("verified") {
                        verified = true;
                    }
                }
            }
        }

        if verified {
            TaskVerificationReport {
                outcome: BusinessOutcome::Verified,
                verified_artifacts: claims,
                reason: "Task completed and verified by explicit business status".to_string(),
            }
        } else {
            TaskVerificationReport {
                outcome: BusinessOutcome::Unverified,
                verified_artifacts: claims,
                reason:
                    "Artifacts produced and validated, but no explicit business verifier asserted"
                        .to_string(),
            }
        }
    }

    fn inspect_artifact(
        workspace: &Path,
        attempt_dir: &Path,
        path: &Path,
        baseline: &WorkspaceSnapshot,
    ) -> Result<ArtifactClaim, String> {
        if !path.exists() {
            return Err("Artifact file does not exist".to_string());
        }
        if !path.is_file() {
            return Err("Artifact is not a file".to_string());
        }

        // Must not be a stale file that already existed prior to execution
        if baseline.initial_files.contains(path) {
            return Err(format!(
                "Artifact {:?} was already present before task run (stale)",
                path
            ));
        }

        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let canonical_ws = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf());
        let canonical_att = attempt_dir
            .canonicalize()
            .unwrap_or_else(|_| attempt_dir.to_path_buf());

        if !canonical.starts_with(&canonical_ws) && !canonical.starts_with(&canonical_att) {
            return Err("Artifact path escapes workspace/attempt directory".to_string());
        }

        let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
        if meta.len() > MAX_ARTIFACT_BYTES {
            return Err(format!("Artifact size {} exceeds 50MB limit", meta.len()));
        }

        let mut file = File::open(&canonical).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        let sha256 = format!("{:x}", hasher.finalize());

        let rel_path = path
            .strip_prefix(workspace)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        Ok(ArtifactClaim {
            path: rel_path,
            size_bytes: meta.len(),
            sha256,
        })
    }
}
