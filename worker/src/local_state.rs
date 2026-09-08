//! Local execution lock and atomic-durable-write helpers shared by the bridge
//! controller, the legacy receipt writer, and status persistence.
//!
//! These helpers coordinate *CEO commands* only. They deliberately do not
//! isolate against editors, external scripts, or other processes running as the
//! same user: there is no claim of filesystem isolation here.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Relative path (under the canonical workspace) of the execution lock file.
pub const EXECUTION_LOCK_REL: &str = ".ceo/execution.lock";

/// Counter for unique temporary filenames within one process.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// An exclusive advisory lock held on the canonical workspace's
/// `.ceo/execution.lock` inode.
///
/// Acquisition is non-blocking (`flock(LOCK_EX | LOCK_NB)`). Ownership lives in
/// the open file description; the lock is released by the kernel when the file
/// descriptor is closed (including on process exit), so a crashed holder can
/// never leave the lock permanently taken. The file is created once and never
/// replaced, and releasing never deletes it, so a stale file cannot block a
/// later acquisition.
#[derive(Debug)]
pub struct ExecutionLock {
    _file: File,
}

impl ExecutionLock {
    /// Tries to acquire the exclusive lock. Succeeds only if no other process
    /// currently holds it. Returns `Err` with `ErrorKind::WouldBlock` when
    /// another holder owns the lock right now.
    ///
    /// The guard must be held (kept alive) for the whole time the caller wants
    /// exclusive access to the workspace.
    pub fn acquire(workspace: &Path) -> std::io::Result<ExecutionLock> {
        let ceo = workspace.join(".ceo");
        fs::create_dir_all(&ceo)?;
        let lock_path = ceo.join("execution.lock");
        // Open without truncate so we never replace the inode that a concurrent
        // holder may have flocked. Rust opens files with O_CLOEXEC by default.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;

        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            return Err(err);
        }
        Ok(ExecutionLock { _file: file })
    }

    /// Path of the lock file (diagnostics only; presence never implies lock).
    pub fn path(workspace: &Path) -> PathBuf {
        workspace.join(EXECUTION_LOCK_REL)
    }
}

/// fsyncs a directory so a rename that added/removed a directory entry is
/// durable across a power loss. A plain `flush()` + `rename` is *not* a power
/// failure guarantee by itself; only the parent-directory sync makes the
/// directory-entry change persistent.
fn sync_directory(dir: &Path) -> std::io::Result<()> {
    let d = File::open(dir)?;
    d.sync_all()
}

/// Uniquely named temporary sibling for atomic replacement.
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

/// Atomically and durably writes `contents` to `path`.
///
/// Algorithm: write a `create_new` 0600 temporary file in the same directory →
/// `fsync` the file → `rename` over the target → `fsync` the parent directory.
/// A `create_new` temp never follows a symlink, and `rename` replaces the
/// destination *directory entry* rather than writing through a symlink, so this
/// never follows a symlink on the target path. On any error the temp file is
/// removed and the previous target contents are left untouched.
pub fn atomic_write_durable(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "no parent dir",
            ))
        }
    };
    fs::create_dir_all(parent)?;

    let tmp = temp_sibling(path);
    let result = (|| -> std::io::Result<()> {
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

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Writes a serializable value via [`atomic_write_durable`].
pub fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let content = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    atomic_write_durable(path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_and_is_readable() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("state.json");
        atomic_write_durable(&path, b"hello").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn rewrites_replace_contents() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("f");
        atomic_write_durable(&path, b"one").unwrap();
        atomic_write_durable(&path, b"two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        // No stray temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(t.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn written_files_are_0600() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("secret");
        atomic_write_durable(&path, b"x").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn does_not_follow_target_symlink() {
        use std::os::unix::fs::symlink;
        let t = tempfile::tempdir().unwrap();
        let victim = t.path().join("victim");
        fs::write(&victim, "original").unwrap();
        let link = t.path().join("control.json");
        symlink(&victim, &link).unwrap();
        // rename replaces the symlink entry itself, leaving the victim intact.
        atomic_write_durable(&link, b"new").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "original");
        assert_eq!(fs::read_to_string(&link).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        // make sure the workspace dir is writable
        fs::set_permissions(t.path(), fs::Permissions::from_mode(0o700)).unwrap();

        let first = ExecutionLock::acquire(t.path()).unwrap();
        // Second acquisition must fail fast (would block).
        let second = ExecutionLock::acquire(t.path());
        assert!(second.is_err());
        assert_eq!(second.err().unwrap().kind(), std::io::ErrorKind::WouldBlock);
        drop(first);
        // After the holder drops, the lock is free even though the file remains.
        assert!(ExecutionLock::acquire(t.path()).is_ok());
        // The lock file still exists (never deleted on release).
        assert!(ExecutionLock::path(t.path()).exists());
    }
}
