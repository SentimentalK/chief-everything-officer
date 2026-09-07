use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct DoctorFixture {
    pub path: PathBuf,
    pub initial_sha256: String,
}

impl DoctorFixture {
    pub fn create(workspace: &Path, attempt_id: &str) -> Result<Self, std::io::Error> {
        let fixture_dir = workspace
            .join(".ceo")
            .join("doctor_fixtures")
            .join(attempt_id);
        std::fs::create_dir_all(&fixture_dir)?;

        let fixture_path = fixture_dir.join("fixture.txt");
        let initial_content = format!("PROTECTED_FIXTURE_NONCE_{}\n", uuid::Uuid::new_v4());

        let mut hasher = Sha256::new();
        hasher.update(initial_content.as_bytes());
        let initial_sha256 = format!("{:x}", hasher.finalize());

        std::fs::write(&fixture_path, initial_content)?;

        Ok(Self {
            path: fixture_path,
            initial_sha256,
        })
    }

    pub fn verify_unchanged(&self) -> Result<bool, std::io::Error> {
        if !self.path.exists() {
            return Ok(false);
        }
        let content = std::fs::read(&self.path)?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let current_sha256 = format!("{:x}", hasher.finalize());
        Ok(current_sha256 == self.initial_sha256)
    }

    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}
