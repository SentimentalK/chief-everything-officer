//! Unix/macOS implementations of the platform primitives.
//!
//! This module intentionally preserves the EXACT pre-PROJECT-032 behavior of
//! the shared Connector core on Linux and macOS: 0700 directories, 0600
//! sensitive files, symlink rejection, `flock`-style exclusive locks (via the
//! `fs2` crate instead of a direct `libc::flock` call), POSIX
//! rename-over-existing atomic publish, and parent-directory fsync
//! durability.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use super::PrivacyStatus;

// ---------------------------------------------------------------------------
// Private local state (POSIX modes)
// ---------------------------------------------------------------------------

/// Creates `path` (and parents) and enforces 0700 permissions on it.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// Opens (creating if absent) an exclusive-lock file with 0600 permissions.
pub fn open_private_lock_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
}

/// Creates a brand-new private (0600) file for writing; fails if it exists.
pub fn create_private_file_new(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

// ---------------------------------------------------------------------------
// Privacy diagnosis (Doctor read model)
// ---------------------------------------------------------------------------

/// Diagnoses whether a directory is private under the POSIX mode boundary.
pub fn diagnose_dir_privacy(path: &Path) -> io::Result<PrivacyStatus> {
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode == 0o700 {
        Ok(PrivacyStatus::Private {
            detail: "0700".into(),
        })
    } else {
        Ok(PrivacyStatus::Exposed {
            detail: format!("Permissions are 0{mode:o}, expected 0700"),
        })
    }
}

/// Diagnoses whether a sensitive file is private under the POSIX mode
/// boundary (0600).
pub fn diagnose_file_privacy(path: &Path) -> io::Result<PrivacyStatus> {
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode == 0o600 {
        Ok(PrivacyStatus::Private {
            detail: "0600".into(),
        })
    } else {
        Ok(PrivacyStatus::Exposed {
            detail: format!("Permissions are 0{mode:o}, expected 0600"),
        })
    }
}

// ---------------------------------------------------------------------------
// Durable write primitives
// ---------------------------------------------------------------------------

/// fsyncs a directory so file addition/removal is durable across power loss.
pub fn sync_directory(dir: &Path) -> io::Result<()> {
    let d = File::open(dir)?;
    d.sync_all()
}

/// Atomically publishes `temp` over `target` (POSIX rename semantics:
/// an existing target file is replaced in one atomic step; readers keep the
/// old inode; there is never a delete-then-rename gap).
pub fn publish_atomic(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

// ---------------------------------------------------------------------------
// Symlink / reparse-point defense
// ---------------------------------------------------------------------------

/// Rejects any path whose destination is an existing symlink.
pub fn reject_reparse_target(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("control path is a symlink: {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// True when `path` exists and is a symlink. Missing paths are not reparse
/// points (they will be created as real directories).
pub fn is_reparse_point(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.file_type().is_symlink()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Hostname discovery (display metadata only)
// ---------------------------------------------------------------------------

/// Portable hostname discovery for Unix/macOS. Preserves the previous
/// Linux behavior exactly (`HOSTNAME` env → `/etc/hostname` → `{USER}-device`
/// → `unknown-device`); `/etc/hostname` is a Linux-specific fallback and is
/// simply absent on macOS, where `HOSTNAME`/`USER` paths apply.
pub fn hostname() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(content) = std::fs::read_to_string("/etc/hostname") {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(user) = std::env::var("USER") {
        let trimmed = user.trim();
        if !trimmed.is_empty() {
            return format!("{trimmed}-device");
        }
    }
    "unknown-device".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_private_dir_enforces_0700() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("a").join("b");
        ensure_private_dir(&dir).unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn private_files_are_0600() {
        let temp = tempfile::tempdir().unwrap();
        let lock = temp.path().join("l.lock");
        let f = open_private_lock_file(&lock).unwrap();
        drop(f);
        let mode = fs::metadata(&lock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let new_file = temp.path().join("n.json");
        create_private_file_new(&new_file).unwrap();
        let mode = fs::metadata(&new_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn privacy_diagnosis_reports_modes() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("d");
        ensure_private_dir(&dir).unwrap();
        assert!(matches!(
            diagnose_dir_privacy(&dir).unwrap(),
            PrivacyStatus::Private { .. }
        ));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        match diagnose_dir_privacy(&dir).unwrap() {
            PrivacyStatus::Exposed { detail } => {
                assert!(detail.contains("0755"), "detail: {detail}");
            }
            other => panic!("expected Exposed, got {other:?}"),
        }
    }

    #[test]
    fn reject_reparse_target_and_ancestors_catch_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("real_target");
        fs::create_dir_all(&target_dir).unwrap();

        let link_dir = temp.path().join("symlinked_dir");
        symlink(&target_dir, &link_dir).unwrap();

        assert!(reject_reparse_target(&link_dir).is_err());
        assert!(reject_reparse_target(&target_dir).is_ok());
        use crate::platform::reject_reparse_ancestors;
        assert!(reject_reparse_ancestors(&link_dir.join("connector")).is_err());
        assert!(reject_reparse_ancestors(&target_dir.join("connector")).is_ok());
        // Non-existent paths stay acceptable (they will be created as real dirs).
        assert!(reject_reparse_target(&temp.path().join("absent")).is_ok());
    }

    #[test]
    fn publish_atomic_replaces_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("t.json");
        fs::write(&target, b"old").unwrap();
        let temp_file = temp.path().join("t.tmp");
        fs::write(&temp_file, b"new").unwrap();
        publish_atomic(&temp_file, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!temp_file.exists());
    }

    #[test]
    fn hostname_is_never_empty_and_is_trimmed() {
        let h = hostname();
        assert!(!h.trim().is_empty());
        assert_eq!(h.trim(), h);
    }
}
