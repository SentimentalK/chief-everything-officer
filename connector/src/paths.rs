use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Environment variable overrides for testing or isolated executions.
pub const ENV_CONFIG_DIR: &str = "CEO_CONNECTOR_CONFIG_DIR";
pub const ENV_STATE_DIR: &str = "CEO_CONNECTOR_STATE_DIR";

#[derive(Debug, Clone)]
pub struct ConnectorPaths {
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
}

impl ConnectorPaths {
    /// Resolves default paths using environment overrides or standard Linux XDG conventions.
    pub fn resolve() -> Result<Self, std::io::Error> {
        let config_dir = if let Ok(dir) = std::env::var(ENV_CONFIG_DIR) {
            PathBuf::from(dir)
        } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            PathBuf::from(xdg).join("ceo").join("connector")
        } else if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home)
                .join(".config")
                .join("ceo")
                .join("connector")
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Neither XDG_CONFIG_HOME nor HOME environment variable is set",
            ));
        };

        let state_dir = if let Ok(dir) = std::env::var(ENV_STATE_DIR) {
            PathBuf::from(dir)
        } else if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
            PathBuf::from(xdg).join("ceo").join("connector")
        } else if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home)
                .join(".local")
                .join("state")
                .join("ceo")
                .join("connector")
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Neither XDG_STATE_HOME nor HOME environment variable is set",
            ));
        };

        Ok(Self {
            config_dir,
            state_dir,
        })
    }

    /// Creates a paths instance anchored in custom directories (primarily for tests).
    pub fn from_roots(config_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            config_dir: config_dir.into(),
            state_dir: state_dir.into(),
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }

    pub fn credential_file(&self) -> PathBuf {
        self.config_dir.join("credential.json")
    }

    pub fn enrollment_file(&self) -> PathBuf {
        self.state_dir.join("enrollment.json")
    }

    pub fn control_file(&self) -> PathBuf {
        self.state_dir.join("control.json")
    }

    pub fn active_attempt_file(&self) -> PathBuf {
        self.state_dir.join("active-attempt.json")
    }

    pub fn daemon_lock_file(&self) -> PathBuf {
        self.state_dir.join("daemon.lock")
    }

    pub fn state_lock_file(&self) -> PathBuf {
        self.state_dir.join("state.lock")
    }

    pub fn history_dir(&self) -> PathBuf {
        self.state_dir.join("history")
    }

    pub fn history_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.history_dir()
            .join(format!("{job_id}.{attempt_id}.json"))
    }

    pub fn outbox_dir(&self) -> PathBuf {
        self.state_dir.join("outbox")
    }

    pub fn outbox_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.outbox_dir()
            .join(format!("{job_id}.{attempt_id}.json"))
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.state_dir.join("runtime")
    }

    pub fn attempt_runtime_dir(&self, attempt_id: &str) -> PathBuf {
        self.runtime_dir().join(attempt_id)
    }

    pub fn managed_result_file(&self, attempt_id: &str) -> PathBuf {
        self.attempt_runtime_dir(attempt_id)
            .join("managed-result.json")
    }

    /// Ensures the attempt-specific runtime directory exists with 0700 permissions
    /// and that its hierarchy contains no symlinks.
    pub fn ensure_attempt_runtime_dir(&self, attempt_id: &str) -> std::io::Result<PathBuf> {
        let dir = self.attempt_runtime_dir(attempt_id);
        reject_control_ancestor_symlinks(&dir)?;
        fs::create_dir_all(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        Ok(dir)
    }

    /// Ensures that config, state, history, outbox, and runtime directories exist with 0700 permissions
    /// and ensures no component in the control hierarchy is a symlink.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        reject_control_ancestor_symlinks(&self.config_dir)?;
        reject_control_ancestor_symlinks(&self.state_dir)?;

        for dir in [
            &self.config_dir,
            &self.state_dir,
            &self.history_dir(),
            &self.outbox_dir(),
            &self.runtime_dir(),
        ] {
            fs::create_dir_all(dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

/// Rejects any path whose destination is an existing symlink.
pub fn reject_symlink_target(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("control path is a symlink: {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Rejects if any existing component in `dir` or its ancestors is a symlink.
pub fn reject_control_ancestor_symlinks(dir: &Path) -> std::io::Result<()> {
    let mut current = PathBuf::new();
    for component in dir.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("control ancestor is a symlink: {}", current.display()),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // If an intermediate directory does not exist yet, it will be created as a real dir.
                break;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_dirs_creates_0700_directories() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
        paths.ensure_dirs().unwrap();

        assert!(paths.config_dir.exists());
        assert!(paths.state_dir.exists());
        assert!(paths.history_dir().exists());
        assert!(paths.outbox_dir().exists());

        let mode = fs::metadata(&paths.config_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        let mode = fs::metadata(&paths.state_dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn rejects_symlink_target_and_ancestor() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("real_target");
        fs::create_dir_all(&target_dir).unwrap();

        let link_dir = temp.path().join("symlinked_dir");
        symlink(&target_dir, &link_dir).unwrap();

        let paths = ConnectorPaths::from_roots(link_dir.join("config"), temp.path().join("state"));
        assert!(paths.ensure_dirs().is_err());
    }
}
