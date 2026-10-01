//! Git filesystem safety primitives for the setup application services.
//!
//! Contract (PROJECT-036 Slice 2):
//! - only `std::process::Command` argument APIs (no shell interpolation);
//! - a missing `git` executable fails distinctly with GIT_NOT_FOUND;
//! - cloning never touches a pre-existing destination: the clone lands in a
//!   uniquely named staging directory in the destination's parent, is
//!   verified (top-level + normalized origin), then atomically renamed into
//!   place. An ordinary clone/verification failure is best-effort cleaned up
//!   so a rerun is never poisoned by a half-installed destination;
//! - no broad temp janitor: only staging directories created by this module
//!   are ever removed.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use super::SetupError;
use crate::targets::verify_local_repo_full_name;

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Runs a git command, mapping a missing executable to the distinct
/// `GIT_NOT_FOUND` setup error.
pub(crate) fn run_git(cmd: &mut Command) -> Result<std::process::Output, SetupError> {
    cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SetupError::GitNotFound
        } else {
            SetupError::Io(e)
        }
    })
}

/// Fails with an actionable error when the `git` executable is unavailable.
pub(crate) fn require_git() -> Result<(), SetupError> {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    let output = run_git(&mut cmd)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(SetupError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

/// Builds the exact `git clone <source> <dest>` command (argument APIs only,
/// no shell). Split out so the canonical command construction is unit-testable
/// without executing network operations.
pub(crate) fn git_clone_command(source: &str, dest: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("clone").arg(source).arg(dest);
    cmd
}

fn staging_dir_name(dest: &Path) -> Result<String, SetupError> {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| SetupError::InvalidDestination(dest.display().to_string()))?;
    let unique = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    Ok(format!(
        ".{}.ceo-setup-{}.{}.{}.tmp",
        name,
        std::process::id(),
        unique,
        nanos
    ))
}

/// Clones `source` into `dest` with bounded crash safety:
///
/// 1. the destination must not exist (caller checks; re-checked before rename);
/// 2. the clone targets a unique hidden staging directory in the destination's
///    parent (same filesystem, so the final publish is an atomic rename);
/// 3. the staged clone is verified (repository top-level + normalized origin);
/// 4. the staging directory is renamed onto the destination;
/// 5. any ordinary clone/verification failure best-effort removes the staging
///    directory, leaving the destination absent so a rerun can recover.
pub(crate) fn clone_repo_safely(
    source: &str,
    expected_full_name: &str,
    dest: &Path,
) -> Result<(), SetupError> {
    require_git()?;

    if dest.symlink_metadata().is_ok() {
        // Defensive re-check; the caller normally routes existing paths to
        // verification instead of cloning.
        return Err(SetupError::PathConflict {
            path: dest.display().to_string(),
            reason: "refusing to overwrite an existing path".to_string(),
        });
    }

    let parent = dest
        .parent()
        .ok_or_else(|| SetupError::InvalidDestination(dest.display().to_string()))?;
    std::fs::create_dir_all(parent)?;

    let staging = parent.join(staging_dir_name(dest)?);
    let cleanup = |staging: &Path| {
        // Best-effort only: never broad, never touches pre-existing paths.
        let _ = std::fs::remove_dir_all(staging);
    };

    let mut cmd = git_clone_command(source, &staging);
    let output = run_git(&mut cmd)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        cleanup(&staging);
        return Err(SetupError::Git(stderr));
    }

    if let Err(e) = verify_local_repo_full_name(&staging, expected_full_name) {
        cleanup(&staging);
        return Err(e.into());
    }

    // Bounded race re-check: never publish over an existing destination.
    if dest.symlink_metadata().is_ok() {
        cleanup(&staging);
        return Err(SetupError::PathConflict {
            path: dest.display().to_string(),
            reason: "destination appeared while the clone was in progress".to_string(),
        });
    }

    std::fs::rename(&staging, dest)?;
    Ok(())
}
