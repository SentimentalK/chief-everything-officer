use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");

    let sha = std::env::var("GITHUB_SHA")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(short_sha)
        .or_else(git_short_sha)
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=CEO_WORKER_GIT_SHA={sha}");
}

fn short_sha(full: String) -> String {
    full.chars().take(12).collect()
}

fn git_short_sha() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
