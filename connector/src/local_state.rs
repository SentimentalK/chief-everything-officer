use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::paths::reject_symlink_target;
use crate::platform;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// An exclusive advisory lock held on a lock file.
///
/// Ownership lives in the OS lock primitive (flock on Unix/macOS via the
/// `fs2` crate, `LockFileEx` on Windows); the lock is released when the
/// handle is closed (e.g. process exit), preventing permanently held locks
/// on crash.
#[derive(Debug)]
pub struct ExecutionLock {
    _file: File,
}

impl ExecutionLock {
    /// Attempts non-blocking acquisition of an exclusive lock.
    /// Returns `ErrorKind::WouldBlock` if another process holds the lock.
    pub fn acquire(lock_path: &Path) -> std::io::Result<Self> {
        reject_symlink_target(lock_path)?;
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = platform::open_private_lock_file(lock_path)?;
        platform::try_lock_exclusive(&file)?;

        Ok(ExecutionLock { _file: file })
    }

    /// Attempts acquisition with bounded synchronous retry on `WouldBlock`.
    pub fn acquire_with_retry(
        lock_path: &Path,
        max_duration: std::time::Duration,
        poll_interval: std::time::Duration,
    ) -> std::io::Result<Self> {
        let start = std::time::Instant::now();
        loop {
            match Self::acquire(lock_path) {
                Ok(lock) => return Ok(lock),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() >= max_duration {
                        return Err(e);
                    }
                    std::thread::sleep(poll_interval);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Attempts acquisition with bounded asynchronous retry on `WouldBlock`.
    pub async fn acquire_with_retry_async(
        lock_path: &Path,
        max_duration: std::time::Duration,
        poll_interval: std::time::Duration,
    ) -> std::io::Result<Self> {
        let start = std::time::Instant::now();
        loop {
            match Self::acquire(lock_path) {
                Ok(lock) => return Ok(lock),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() >= max_duration {
                        return Err(e);
                    }
                    tokio::time::sleep(poll_interval).await;
                }
                Err(e) => return Err(e),
            }
        }
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

/// Removes a file and syncs its parent directory where the platform allows
/// directory fsync (Unix/macOS; unavailable on Windows — see the platform
/// module's documented Windows durability envelope).
pub fn remove_durable(path: &Path) -> std::io::Result<()> {
    reject_symlink_target(path)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            platform::sync_directory(parent)?;
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

/// Atomically and durably writes `contents` to `path` with private
/// permissions (0600 on Unix/macOS, current-user-private ACL on Windows).
///
/// Durability sequencing (every platform): create a fresh temp sibling in
/// the target's parent (same filesystem) → write → file sync → atomic
/// publish/replace → best-available parent metadata durability. The target
/// is NEVER deleted before the publish: replacement is a single atomic
/// rename (POSIX) / `MoveFileExW(REPLACE_EXISTING)` (Windows), and a failed
/// publish leaves the prior valid file untouched.
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
        let mut file = platform::create_private_file_new(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        platform::publish_atomic(&tmp, path)?;
        platform::sync_directory(parent)?;
        Ok(())
    })();

    if write_res.is_err() {
        // Bounded cleanup of OUR OWN temp sibling only.
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

    #[cfg(unix)]
    #[test]
    fn atomic_write_and_read_durable() {
        use std::os::unix::fs::PermissionsExt;

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

    /// Portable across Linux/macOS/Windows: first write creates the file,
    /// every subsequent write atomically replaces the previous content.
    #[test]
    fn atomic_first_write_and_repeated_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("state.json");

        atomic_write_durable(&target, b"v1").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"v1");

        for round in 2..=5 {
            let content = format!("v{round}");
            atomic_write_durable(&target, content.as_bytes()).unwrap();
            assert_eq!(fs::read(&target).unwrap(), content.as_bytes());
        }

        // No temp siblings may survive successful replacements.
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
    }

    /// Portable: when the atomic publish fails (target is an existing
    /// directory), the prior state is preserved and the temp sibling is
    /// cleaned up.
    #[test]
    fn failed_publish_preserves_prior_state() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("state.json");
        fs::create_dir(&target).unwrap();

        assert!(atomic_write_durable(&target, b"new").is_err());
        assert!(target.is_dir(), "prior state (directory) must be intact");

        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
    }

    /// Unix: when the temp write itself fails (read-only parent), the prior
    /// valid file is preserved untouched. Probe-based skip for root.
    #[cfg(unix)]
    #[test]
    fn temp_write_failure_preserves_prior_file() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("ro");
        fs::create_dir(&dir).unwrap();
        let target = dir.join("state.json");
        atomic_write_durable(&target, b"good").unwrap();

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();

        let res = atomic_write_durable(&target, b"should-fail");
        if res.is_ok() {
            // Running as root: permission bits are not enforced and this
            // failure cannot be simulated; nothing to assert.
            return;
        }

        assert_eq!(fs::read(&target).unwrap(), b"good");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp leftovers: {leftovers:?}");
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

    /// Portable: release after drop allows re-acquisition, including in a
    /// fresh handle (process-lifetime release semantics).
    #[test]
    fn execution_lock_release_allows_reacquire() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp.path().join("state.lock");

        {
            let lock = ExecutionLock::acquire(&lock_path).unwrap();
            assert!(ExecutionLock::is_locked(&lock_path));
            drop(lock);
        }

        let again = ExecutionLock::acquire(&lock_path).unwrap();
        drop(again);
    }
}
