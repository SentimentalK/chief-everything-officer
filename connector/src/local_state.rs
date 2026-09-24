use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::paths::reject_symlink_target;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// An exclusive advisory flock held on a lock file.
///
/// Ownership lives in the kernel open file description; the lock is released
/// when the descriptor is closed (e.g. process exit), preventing permanently
/// held locks on crash.
#[derive(Debug)]
pub struct ExecutionLock {
    _file: File,
}

impl ExecutionLock {
    /// Attempts non-blocking acquisition of an exclusive flock.
    /// Returns `ErrorKind::WouldBlock` if another process holds the lock.
    pub fn acquire(lock_path: &Path) -> std::io::Result<Self> {
        reject_symlink_target(lock_path)?;
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;

        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }

        Ok(ExecutionLock { _file: file })
    }

    /// Checks whether the lock is currently held by another process without holding it.
    pub fn is_locked(lock_path: &Path) -> bool {
        match Self::acquire(lock_path) {
            Ok(_lock) => false,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => true,
            Err(_) => false,
        }
    }
}

/// fsyncs a directory so file addition/removal is durable across power loss.
pub fn sync_directory(dir: &Path) -> std::io::Result<()> {
    let d = File::open(dir)?;
    d.sync_all()
}

/// Removes a file and fsyncs its parent directory.
pub fn remove_durable(path: &Path) -> std::io::Result<()> {
    reject_symlink_target(path)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            sync_directory(parent)?;
        }
    }
    Ok(())
}

fn temp_sibling(target: &Path) -> PathBuf {
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("out");
    let unique = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    target.with_file_name(format!(
        ".{}.{}.{}.{}.tmp",
        name,
        std::process::id(),
        unique,
        nanos
    ))
}

/// Atomically and durably writes `contents` to `path` with 0600 mode.
pub fn atomic_write_durable(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    reject_symlink_target(path)?;
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path has no parent directory",
            ))
        }
    };
    fs::create_dir_all(parent)?;

    let tmp = temp_sibling(path);
    let write_res = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_res
}

/// Serializes `value` to pretty JSON and writes it via [`atomic_write_durable`].
pub fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    atomic_write_durable(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn atomic_write_and_read_durable() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("sub").join("state.json");
        atomic_write_durable(&target, b"{\"hello\": \"world\"}").unwrap();

        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "{\"hello\": \"world\"}"
        );
        let perms = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(perms, 0o600);
    }

    #[test]
    fn execution_lock_contention() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp.path().join("daemon.lock");

        let lock1 = ExecutionLock::acquire(&lock_path).unwrap();
        assert!(ExecutionLock::is_locked(&lock_path));

        let lock2_err = ExecutionLock::acquire(&lock_path).unwrap_err();
        assert_eq!(lock2_err.kind(), std::io::ErrorKind::WouldBlock);

        drop(lock1);
        assert!(!ExecutionLock::is_locked(&lock_path));

        let lock3 = ExecutionLock::acquire(&lock_path).unwrap();
        drop(lock3);
    }
}
