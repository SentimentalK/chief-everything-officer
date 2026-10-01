//! Thin centralized platform boundary for genuinely OS-specific primitives.
//!
//! PROJECT-032 Slice A contract:
//! - ALL `#[cfg(target_os = ...)]` / `#[cfg(unix)]` / `#[cfg(windows)]`
//!   branching for filesystem, lock, privacy, reparse-point, browser, and
//!   hostname primitives lives in THIS module tree (`unix.rs` / `windows.rs`).
//!   Shared business modules call the narrow helpers below; they never
//!   scatter new platform branches.
//! - Shared product semantics are unchanged: the same single Connector root,
//!   the same exclusive-lock behavior (`WouldBlock` contention, bounded
//!   retries, descriptor/process lifetime release), the same durable
//!   temp-sibling → fsync → atomic publish write path.
//! - Unix behavior is preserved exactly (0700 dirs / 0600 files, symlink
//!   rejection, rename-over-existing publish, parent directory fsync).
//! - Windows gets honest equivalents: current-user-private ACLs instead of
//!   POSIX modes, reparse-point (symlink/junction) rejection instead of
//!   symlink rejection, `MoveFileExW(REPLACE_EXISTING)`-backed atomic replace
//!   instead of POSIX rename, and a documented durability envelope.

use std::fs::File;
use std::path::Path;

use fs2::FileExt;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

// ---------------------------------------------------------------------------
// Platform identity
// ---------------------------------------------------------------------------

/// Stable Server-facing platform string: `linux` / `macos` / `windows`.
/// Display metadata only; enrollment never branches product logic on it.
pub fn platform_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// Privacy diagnosis (Doctor read model)
// ---------------------------------------------------------------------------

/// Result of a platform privacy diagnosis for one filesystem path.
/// `detail` is a short, platform-appropriate, actionable description that
/// flows into the existing Doctor human/JSON message strings unchanged in
/// shape (name / severity / message).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrivacyStatus {
    /// The path is private under this platform's security boundary.
    Private {
        /// e.g. `0700` (POSIX) or `current-user-private ACL` (Windows).
        detail: String,
    },
    /// The path is NOT private under this platform's security boundary.
    Exposed {
        /// e.g. `Permissions are 0755, expected 0700` (POSIX) or the
        /// offending ACL fact (Windows).
        detail: String,
    },
}

// ---------------------------------------------------------------------------
// Reparse-point (symlink / junction / mount point) defense
// ---------------------------------------------------------------------------

/// Ancestor components that are part of OS-managed trusted prefixes are
/// allowed to be reparse points: on macOS, `$TMPDIR` lives under the system
/// symlink `/var -> /private/var`, and the user home chain is OS-managed.
/// Planted symlinks INSIDE the trusted prefix (i.e. in the Connector-owned
/// territory between home and connector root) are still rejected.
fn is_trusted_prefix_component(current: &Path) -> bool {
    let mut trusted: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        trusted.push(home);
    }
    trusted.push(std::env::temp_dir());
    trusted.iter().any(|t| t.starts_with(current))
}

/// Rejects if any existing component in `path` or its ancestors is a reparse
/// point (symlink/junction/mount point), except for components that belong
/// to the OS-managed home/temp prefix chains (see
/// [`is_trusted_prefix_component`]).
pub fn reject_reparse_ancestors(path: &Path) -> std::io::Result<()> {
    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        current.push(component);
        if is_reparse_point(&current)? && !is_trusted_prefix_component(&current) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "control ancestor is a symlink or reparse point: {}",
                    current.display()
                ),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Exclusive advisory lock (shared primitive, per-OS backend)
// ---------------------------------------------------------------------------

/// Attempts a NON-BLOCKING exclusive advisory lock acquisition on `file`.
///
/// - Returns `Ok(())` when this handle now holds the lock exclusively.
/// - Returns `ErrorKind::WouldBlock` when another process (or another handle
///   in this process) holds the lock.
/// - The lock is released when the handle is closed (including process
///   exit/crash), so a crashed holder can never permanently wedge the daemon.
///
/// Unix backend: `flock(LOCK_EX | LOCK_NB)` via the small mature `fs2`
/// crate (identical semantics to the previous direct `libc::flock` call).
/// Windows backend: `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK |
/// LOCKFILE_FAIL_IMMEDIATELY)` via the same crate — an honest per-handle
/// exclusive advisory lock with process-lifetime release.
pub fn try_lock_exclusive(file: &File) -> std::io::Result<()> {
    match file.try_lock_exclusive() {
        Ok(()) => Ok(()),
        Err(e) => {
            // fs2 surfaces contention as the platform's lock-denied error
            // (EWOULDBLOCK on Unix, ERROR_LOCK_VIOLATION on Windows).
            let contended = fs2::lock_contended_error().raw_os_error();
            if e.raw_os_error().is_some() && e.raw_os_error() == contended {
                Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "exclusive lock is held by another process/handle",
                ))
            } else {
                Err(e)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-platform best-effort browser opening
// ---------------------------------------------------------------------------

/// Best-effort opens `url` in the user's default browser on every supported
/// OS. Uses the small mature `open` crate: `xdg-open`/`gio` on Linux, `open`
/// on macOS, and `ShellExecuteW` on Windows — never a shell command line, so
/// no interpolation of any user-controlled content ever happens.
///
/// Auth correctness NEVER depends on this succeeding: callers treat every
/// failure as best-effort and the enrollment URL remains printed verbatim.
pub fn open_url_best_effort(url: &str) -> std::io::Result<()> {
    open::that_detached(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_name_is_one_of_the_supported_values() {
        assert!(matches!(
            platform_name(),
            "linux" | "macos" | "windows" | "unknown"
        ));
    }

    /// Cross-platform regression: the OS-managed temp prefix chain (macOS
    /// `/var -> /private/var` etc.) must be accepted; only planted reparse
    /// points inside user-controlled territory are rejected.
    #[test]
    fn os_temp_prefix_ancestors_are_accepted() {
        let temp = tempfile::tempdir().unwrap();
        let deep = temp.path().join("a/b/c");
        assert!(reject_reparse_ancestors(&deep).is_ok());
    }
}
