use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Environment variable that replaces the entire Connector root.
///
/// Used for tests and isolated runs. When present and non-empty, all
/// Connector-owned durable state lives under exactly this directory.
pub const ENV_CONNECTOR_ROOT: &str = "CEO_CONNECTOR_ROOT";

#[derive(Debug, Clone)]
pub struct ConnectorPaths {
    /// Authoritative root for ALL Connector-owned local state.
    ///
    /// Every durable file and directory the Connector writes derives from
    /// this single root (default: `~/.ceo/connector`). There is no config/state
    /// split and no XDG decomposition.
    pub root_dir: PathBuf,
}

impl ConnectorPaths {
    /// Resolves the Connector root.
    ///
    /// Resolution order:
    /// 1. `CEO_CONNECTOR_ROOT` if present and non-empty
    /// 2. otherwise the user home directory + `.ceo/connector`
    ///
    /// Fails with an actionable error if the home directory cannot be
    /// determined; it never silently falls back to the current directory.
    pub fn resolve() -> Result<Self, std::io::Error> {
        if let Ok(root) = std::env::var(ENV_CONNECTOR_ROOT) {
            if !root.trim().is_empty() {
                return Ok(Self::from_root(root));
            }
        }

        let home = dirs::home_dir().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!(
                    "cannot determine the user home directory; set {} or HOME explicitly",
                    ENV_CONNECTOR_ROOT
                ),
            )
        })?;

        Ok(Self::from_root(home.join(".ceo").join("connector")))
    }

    /// Creates a paths instance anchored at a single root (primarily for tests).
    pub fn from_root(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.root_dir.join("config.json")
    }

    pub fn credential_file(&self) -> PathBuf {
        self.root_dir.join("credential.json")
    }

    pub fn enrollment_file(&self) -> PathBuf {
        self.root_dir.join("enrollment.json")
    }

    pub fn control_file(&self) -> PathBuf {
        self.root_dir.join("control.json")
    }

    pub fn active_attempt_file(&self) -> PathBuf {
        self.root_dir.join("active-attempt.json")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.root_dir.join("locks")
    }

    pub fn daemon_lock_file(&self) -> PathBuf {
        self.locks_dir().join("daemon.lock")
    }

    pub fn state_lock_file(&self) -> PathBuf {
        self.locks_dir().join("state.lock")
    }

    pub fn history_dir(&self) -> PathBuf {
        self.root_dir.join("history")
    }

    pub fn history_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.history_dir()
            .join(format!("{job_id}.{attempt_id}.json"))
    }

    pub fn outbox_dir(&self) -> PathBuf {
        self.root_dir.join("outbox")
    }

    pub fn outbox_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.outbox_dir()
            .join(format!("{job_id}.{attempt_id}.json"))
    }

    pub fn results_dir(&self) -> PathBuf {
        self.root_dir.join("results")
    }

    pub fn preserved_managed_result_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.results_dir()
            .join(format!("{job_id}.{attempt_id}.json"))
    }

    pub fn preserved_managed_result_meta_file(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.results_dir()
            .join(format!("{job_id}.{attempt_id}.meta.json"))
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.root_dir.join("runtime")
    }

    pub fn attempt_runtime_dir(&self, attempt_id: &str) -> PathBuf {
        self.runtime_dir().join(attempt_id)
    }

    pub fn managed_result_file(&self, attempt_id: &str) -> PathBuf {
        self.attempt_runtime_dir(attempt_id)
            .join("managed-result.json")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.root_dir.join("tmp")
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

    /// Ensures the root and all owned subdirectories (locks, history, outbox,
    /// results, runtime, tmp) exist with 0700 permissions and ensures no
    /// component in the hierarchy is a symlink.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        reject_control_ancestor_symlinks(&self.root_dir)?;

        for dir in [
            &self.root_dir,
            &self.locks_dir(),
            &self.history_dir(),
            &self.outbox_dir(),
            &self.results_dir(),
            &self.runtime_dir(),
            &self.tmp_dir(),
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
    fn ensure_dirs_creates_all_0700_directories() {
        let temp = tempfile::tempdir().unwrap();
        let paths = ConnectorPaths::from_root(temp.path().join("connector"));
        paths.ensure_dirs().unwrap();

        for dir in [
            paths.root_dir.clone(),
            paths.locks_dir(),
            paths.history_dir(),
            paths.outbox_dir(),
            paths.results_dir(),
            paths.runtime_dir(),
            paths.tmp_dir(),
        ] {
            let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "directory {:?} must be 0700", dir);
        }
    }

    #[test]
    fn rejects_symlink_target_and_ancestor() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("real_target");
        fs::create_dir_all(&target_dir).unwrap();

        let link_dir = temp.path().join("symlinked_dir");
        symlink(&target_dir, &link_dir).unwrap();

        let paths = ConnectorPaths::from_root(link_dir.join("connector"));
        assert!(paths.ensure_dirs().is_err());
    }

    #[test]
    fn exact_layout_under_single_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("connector");
        let paths = ConnectorPaths::from_root(&root);

        assert_eq!(paths.config_file(), root.join("config.json"));
        assert_eq!(paths.credential_file(), root.join("credential.json"));
        assert_eq!(paths.enrollment_file(), root.join("enrollment.json"));
        assert_eq!(paths.control_file(), root.join("control.json"));
        assert_eq!(
            paths.active_attempt_file(),
            root.join("active-attempt.json")
        );
        assert_eq!(paths.daemon_lock_file(), root.join("locks/daemon.lock"));
        assert_eq!(paths.state_lock_file(), root.join("locks/state.lock"));
        assert_eq!(paths.history_dir(), root.join("history"));
        assert_eq!(paths.outbox_dir(), root.join("outbox"));
        assert_eq!(paths.results_dir(), root.join("results"));
        assert_eq!(paths.runtime_dir(), root.join("runtime"));
        assert_eq!(paths.tmp_dir(), root.join("tmp"));
        assert_eq!(
            paths.managed_result_file("att-1"),
            root.join("runtime/att-1/managed-result.json")
        );
    }

    #[test]
    fn all_owned_paths_descend_from_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("connector");
        let paths = ConnectorPaths::from_root(&root);

        let owned: Vec<PathBuf> = vec![
            paths.config_file(),
            paths.credential_file(),
            paths.enrollment_file(),
            paths.control_file(),
            paths.active_attempt_file(),
            paths.locks_dir(),
            paths.daemon_lock_file(),
            paths.state_lock_file(),
            paths.history_dir(),
            paths.history_file("job", "att"),
            paths.outbox_dir(),
            paths.outbox_file("job", "att"),
            paths.results_dir(),
            paths.preserved_managed_result_file("job", "att"),
            paths.preserved_managed_result_meta_file("job", "att"),
            paths.runtime_dir(),
            paths.attempt_runtime_dir("att"),
            paths.managed_result_file("att"),
            paths.tmp_dir(),
        ];

        for path in &owned {
            assert!(
                path.starts_with(&paths.root_dir),
                "path {:?} must descend from the single root {:?}",
                path,
                paths.root_dir
            );
        }
    }

    #[test]
    fn resolve_honors_explicit_root_override() {
        let temp = tempfile::tempdir().unwrap();
        // SAFETY (test-only): no other test in this process calls resolve(),
        // so mutating this env var cannot race with other resolution logic.
        std::env::set_var(ENV_CONNECTOR_ROOT, temp.path().join("isolated-root"));
        let resolved = ConnectorPaths::resolve().unwrap();
        std::env::remove_var(ENV_CONNECTOR_ROOT);

        assert_eq!(resolved.root_dir, temp.path().join("isolated-root"));
        assert_eq!(
            resolved.config_file(),
            temp.path().join("isolated-root").join("config.json")
        );
        assert_eq!(
            resolved.daemon_lock_file(),
            temp.path()
                .join("isolated-root")
                .join("locks")
                .join("daemon.lock")
        );
    }
}
