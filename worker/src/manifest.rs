use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ManifestError {
    #[error("Failed to read manifest file at {path}: {source}")]
    IoError {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("Failed to parse manifest JSON at {path}: {source}")]
    JsonError {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("Manifest schema compilation failed: {0}")]
    SchemaCompilationError(String),
    #[error("Input validation failed: {0}")]
    InputValidationError(String),
    #[error("Entrypoint {name} ({path:?}) does not exist or is not executable")]
    InvalidEntrypoint { name: String, path: PathBuf },
    #[error("Manifest revision mismatch: task requires revision {task_revision}, but capability manifest has revision {manifest_revision}")]
    RevisionMismatch {
        task_revision: u32,
        manifest_revision: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeoutsConfig {
    pub setup_timeout: u64,
    pub submission_timeout: u64,
    pub execution_timeout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionConfig {
    pub profile: String,
    pub entrypoints: HashMap<String, String>,
    pub timeouts: Option<TimeoutsConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityManifest {
    pub schema_version: u32,
    pub capability_id: String,
    pub version: String,
    pub manifest_revision: u32,
    pub description: String,
    pub execution: ExecutionConfig,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInputParams {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub job_id: String,
    pub attempt_id: String,
    pub capability_id: String,
    pub manifest_revision: u32,
    pub params: TaskInputParams,
}

impl CapabilityManifest {
    pub fn load_from_dir(dir: &Path) -> Result<Self, ManifestError> {
        let manifest_path = dir.join("capability.json");
        let content =
            std::fs::read_to_string(&manifest_path).map_err(|e| ManifestError::IoError {
                path: manifest_path.clone(),
                source: e,
            })?;

        let manifest: Self =
            serde_json::from_str(&content).map_err(|e| ManifestError::JsonError {
                path: manifest_path.clone(),
                source: e,
            })?;

        // Validate entrypoints exist
        for (name, rel_path) in &manifest.execution.entrypoints {
            let entry_path = dir.join(rel_path);
            if !entry_path.exists() {
                return Err(ManifestError::InvalidEntrypoint {
                    name: name.clone(),
                    path: entry_path,
                });
            }
        }

        Ok(manifest)
    }

    pub fn validate_input(&self, input_value: &serde_json::Value) -> Result<(), ManifestError> {
        let validator = jsonschema::validator_for(&self.input_schema)
            .map_err(|e| ManifestError::SchemaCompilationError(e.to_string()))?;

        if let Err(error) = validator.validate(input_value) {
            return Err(ManifestError::InputValidationError(error.to_string()));
        }

        Ok(())
    }

    pub fn validate_task_input(&self, task: &TaskInput) -> Result<(), ManifestError> {
        if task.manifest_revision != self.manifest_revision {
            return Err(ManifestError::RevisionMismatch {
                task_revision: task.manifest_revision,
                manifest_revision: self.manifest_revision,
            });
        }

        let val = serde_json::to_value(&task.params)
            .map_err(|e| ManifestError::InputValidationError(e.to_string()))?;
        self.validate_input(&val)
    }
}
