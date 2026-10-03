//! Git repository identity resolution for fresh-device Project adds (Git Local Slice).
//!
//! A fresh Device normally does not know the immutable Server `target_id` of a
//! Project. Identity therefore resolves from the local Git checkout itself: the
//! `origin` remote is normalized into a provider/repository key
//! (`repository_provider` + `repository_full_name`), and the Server resolves an
//! existing active Target by that repository identity before any alias/name is
//! considered. Human alias/display names and local clone folder names are
//! presentation/selectors only and never decide dedupe or identity.
//!
//! Common supported SSH/HTTPS forms of the same repository normalize to the
//! same key, so a fresh-device add reuses the existing `target_id` regardless
//! of custom names or clone-folder differences. If the origin cannot be
//! resolved safely, add fails clearly instead of silently using a human name
//! as identity.

use thiserror::Error;

/// Provider external_id/full_name pair sent to the Server for
/// repository-first identity resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRepositoryIdentity {
    pub provider: String,
    pub external_id: String,
    pub full_name: String,
    /// Raw `git remote get-url origin` output this identity was derived from.
    pub origin_url: String,
}

#[derive(Error, Debug)]
pub enum RepoIdentityError {
    #[error("Git error: {0}")]
    Git(String),
    #[error(
        "Repository '{path}' has no 'origin' remote configured. Repository-first project identity requires a Git 'origin' remote; add one (git remote add origin ...) and rerun (REPOSITORY_ORIGIN_MISSING)."
    )]
    OriginMissing { path: String },
    #[error(
        "Unsupported Git remote URL '{url}': work/svn/local helpers are not valid project origins (REPOSITORY_UNSAFE_ORIGIN)."
    )]
    UnsafeOrigin { url: String },
    #[error(
        "Cannot resolve repository identity from remote URL '{url}': unsupported provider form. Supported forms are github.com HTTPS and SSH remotes (REPOSITORY_IDENTITY_UNRESOLVED)."
    )]
    Unresolved { url: String },
}

fn remote_parts(full_name: &str, url: &str) -> ResolvedRepositoryIdentity {
    ResolvedRepositoryIdentity {
        provider: "github".to_string(),
        external_id: full_name.to_lowercase(),
        full_name: full_name.to_string(),
        origin_url: url.to_string(),
    }
}

/// Normalizes a GitHub remote URL (HTTPS or SSH) into an `owner/repo` string.
/// Examples:
/// - https://github.com/owner/repo.git -> owner/repo
/// - https://github.com/owner/repo -> owner/repo
/// - https://github.com/owner/repo/ -> owner/repo
/// - git@github.com:owner/repo.git -> owner/repo
/// - ssh://git@github.com/owner/repo.git -> owner/repo
///
/// Returns `None` for non-GitHub hosts.
pub fn normalize_github_url_to_full_name(remote: &str) -> Option<String> {
    let trimmed = remote.trim();
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
    ] {
        if let Some(rest) = without_git.strip_prefix(prefix) {
            let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() == 2 {
                return Some(format!("{}/{}", parts[0], parts[1]));
            }
        }
    }
    if let Some(rest) = without_git.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    }
    None
}

/// Validates a remote URL against unsafe transports and provider forms.
/// Returns Err when the URL is clearly unsafe or unsupported; Ok otherwise
/// (derivation may still fail later for unmatched-but-safe URLs).
pub fn validate_remote_url(url: &str) -> Result<(), RepoIdentityError> {
    let trimmed = url.trim();
    if trimmed.contains("://") {
        if trimmed.starts_with("work://")
            || trimmed.starts_with("svn://")
            || trimmed.starts_with("local://")
        {
            return Err(RepoIdentityError::UnsafeOrigin {
                url: url.to_string(),
            });
        }
        Ok(())
    } else if let Some(idx) = trimmed.find(':') {
        let before = &trimmed[..idx];
        if before.contains('/') {
            // git@host:path scp-like syntax with a path in the user part
            return Err(RepoIdentityError::UnsafeOrigin {
                url: url.to_string(),
            });
        }
        Ok(())
    } else if trimmed.starts_with('.') || trimmed.starts_with('/') {
        Ok(())
    } else {
        Err(RepoIdentityError::UnsafeOrigin {
            url: url.to_string(),
        })
    }
}

/// Reads the local `origin` remote URL of a Git repository (absolute source
/// paths only). Requires `path.is_dir()`; the caller decides whether that is
/// a failure.
pub fn get_local_origin_url(path: &std::path::Path) -> Result<String, RepoIdentityError> {
    if !path.is_dir() {
        return Err(RepoIdentityError::Git(format!(
            "Directory '{}' does not exist.",
            path.display()
        )));
    }
    let probe = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|e| RepoIdentityError::Git(format!("Failed to execute git: {e}")))?;
    if !probe.status.success() {
        return Err(RepoIdentityError::Git(format!(
            "Directory '{}' is not a Git repository.",
            path.display()
        )));
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| RepoIdentityError::Git(format!("Failed to execute git: {e}")))?;

    if !output.status.success() {
        return Err(RepoIdentityError::OriginMissing {
            path: path.display().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolves the Git repository identity of a local checkout from its `origin`
/// remote: origin URL -> unsafe/unsupported transport validation ->
/// normalized `owner/repo` (lowercase stored as external_id) with provider.
pub fn resolve_repository_identity(
    path: &std::path::Path,
) -> Result<ResolvedRepositoryIdentity, RepoIdentityError> {
    let origin_url = get_local_origin_url(path)?;
    let provider = derive_provider_from_origin(&origin_url)?;
    match provider {
        "github" => {
            let full_name = normalize_github_url_to_full_name(&origin_url).ok_or_else(|| {
                RepoIdentityError::Unresolved {
                    url: origin_url.clone(),
                }
            })?;
            Ok(remote_parts(&full_name, &origin_url))
        }
        _ => Err(RepoIdentityError::Unresolved {
            url: origin_url.clone(),
        }),
    }
}

fn derive_provider_from_origin(url: &str) -> Result<&'static str, RepoIdentityError> {
    validate_remote_url(url)?;
    let t = url.trim();
    let after_scheme = if let Some(rest) = t.strip_prefix("http://") {
        rest
    } else if let Some(rest) = t.strip_prefix("https://") {
        rest
    } else if let Some(rest) = t.strip_prefix("ssh://") {
        rest
    } else if t.contains('@') && !t.contains("://") {
        // scp-like: user@host:path
        t.split('@').nth(1).unwrap_or(t)
    } else {
        return Err(RepoIdentityError::Unresolved { url: t.to_string() });
    };

    // Strip an explicit userinfo (e.g. ssh://git@github.com/...).
    let after_userinfo = after_scheme
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(after_scheme);

    // Exact host match only: "github.com", optionally followed by a port or
    // a path; lookalike hosts ("github.com.evil.com") are NOT GitHub.
    let host = after_userinfo
        .split(['/', ':'])
        .next()
        .unwrap_or(after_userinfo);

    if host == "github.com" {
        Ok("github")
    } else {
        Err(RepoIdentityError::Unresolved { url: t.to_string() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_https_and_ssh_normalize_identically() {
        assert_eq!(
            normalize_github_url_to_full_name("https://github.com/Org/repo.git"),
            Some("Org/repo".to_string())
        );
        assert_eq!(
            normalize_github_url_to_full_name("https://github.com/Org/repo/"),
            Some("Org/repo".to_string())
        );
        assert_eq!(
            normalize_github_url_to_full_name("git@github.com:Org/repo.git"),
            Some("Org/repo".to_string())
        );
        assert_eq!(
            normalize_github_url_to_full_name("ssh://git@github.com/Org/repo.git"),
            Some("Org/repo".to_string())
        );
        assert_eq!(
            normalize_github_url_to_full_name("https://gitlab.com/org/repo.git"),
            None
        );
    }

    #[test]
    fn unsafe_and_non_github_origins_fail_clearly() {
        assert!(matches!(
            derive_provider_from_origin("work://x/../y"),
            Err(RepoIdentityError::UnsafeOrigin { .. })
        ));
        assert!(matches!(
            derive_provider_from_origin("svn://x/y/z"),
            Err(RepoIdentityError::UnsafeOrigin { .. })
        ));
        assert!(matches!(
            derive_provider_from_origin("/etc/passwd:x/y"),
            Err(RepoIdentityError::UnsafeOrigin { .. })
        ));
        // A real checkout without 'origin' fails clearly (covered end-to-end
        // by the project-add integration suite with a real git fixture);
        // resolving identity on a missing/unwritable path must also fail,
        // never silently produce a human-name identity.
        assert!(
            resolve_repository_identity(std::path::Path::new("/definitely-not-a-repo")).is_err()
        );
    }
}
