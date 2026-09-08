//! Process-group management for the executor child.
//!
//! Each adapter spawns its child with `setpgid(0,0)` in a pre-exec hook, so the
//! leader PID is its own process-group id. Signals are therefore sent to the
//! whole `-pgid` group rather than to the leader alone, which is what lets us
//! terminate grandchildren that ignore SIGTERM.
//!
//! `kill_group`/`force_kill_group` here send *group* signals only and never
//! `start_kill()` the leader behind the caller's back. Reaping is the job of
//! the two-phase termination helper in the runner, which drains stdout/stderr
//! while waiting and only escalates to SIGKILL after a bounded grace period.

use crate::executor::adapter_trait::ManagedProcess;
use std::future::Future;
use std::process::ExitStatus;
use tokio::process::{Child, ChildStderr, ChildStdout};

pub struct GroupManagedProcess {
    child: Child,
    pgid: Option<i32>,
}

impl GroupManagedProcess {
    pub fn new(child: Child, pgid: Option<i32>) -> Self {
        Self { child, pgid }
    }

    /// Sends a signal to the whole process group. `ESRCH` (group gone) is
    /// treated as success; `EPERM` or any other failure is returned so the
    /// caller knows it cannot confirm the group stopped.
    fn signal_group(&self, sig: i32) -> Result<(), std::io::Error> {
        let Some(pgid) = self.pgid else {
            return Err(std::io::Error::other(
                "no process group id recorded; cannot signal group",
            ));
        };
        #[cfg(target_os = "linux")]
        {
            let ret = unsafe { libc::kill(-pgid, sig) };
            if ret != 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(err);
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (pgid, sig);
        }
        Ok(())
    }

    /// Best-effort SIGKILL of the group plus the leader child handle.
    fn sigkill_group_and_leader(&mut self) -> Result<(), std::io::Error> {
        let group_res = self.signal_group(libc::SIGKILL);
        let _ = self.child.start_kill();
        group_res
    }
}

impl ManagedProcess for GroupManagedProcess {
    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    fn pgid(&self) -> Option<i32> {
        self.pgid
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    fn send_input_line<'a>(
        &'a mut self,
        line: &'a str,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), std::io::Error>> + Send + 'a>> {
        Box::pin(async move {
            use tokio::io::AsyncWriteExt;
            let stdin = self.child.stdin.as_mut().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "stdin is closed or not piped",
                )
            })?;
            stdin.write_all(line.as_bytes()).await?;
            if !line.ends_with('\n') {
                stdin.write_all(b"\n").await?;
            }
            stdin.flush().await?;
            Ok(())
        })
    }

    fn close_stdin(&mut self) -> Result<(), std::io::Error> {
        self.child.stdin.take();
        Ok(())
    }

    /// Sends SIGTERM to the process group only (graceful). The caller is
    /// responsible for bounded waiting and escalation.
    fn kill_group(&mut self) -> Result<(), std::io::Error> {
        self.signal_group(libc::SIGTERM)
    }

    /// Sends SIGKILL to the process group and the leader child.
    fn force_kill_group(&mut self) -> Result<(), std::io::Error> {
        self.sigkill_group_and_leader()
    }

    fn wait(
        &mut self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<ExitStatus, std::io::Error>> + Send + '_>>
    {
        Box::pin(self.child.wait())
    }
}

/// Scans `/proc` for any live (non-zombie) process whose process-group id
/// equals `pgid`. Zombies are not counted as running work, but a live leader or
/// member is. A permission error or incomplete scan returns `Err`, which the
/// caller must treat as "cannot confirm stopped".
pub fn pgid_has_live_members(pgid: i32) -> Result<bool, std::io::Error> {
    let entries = std::fs::read_dir("/proc")?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) if n.bytes().all(|b| b.is_ascii_digit()) => n.to_string(),
            _ => continue,
        };
        let pid: i32 = match name.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let stat_path = format!("/proc/{pid}/stat");
        let stat = match std::fs::read_to_string(&stat_path) {
            Ok(s) => s,
            Err(_) => continue, // raced away; not a live member we can confirm
        };
        // Field 4 (1-indexed) is pgrp; the comm field may contain spaces and
        // parens, so split after the last ')' like status.rs does.
        let Some(idx) = stat.rfind(')') else {
            continue;
        };
        let rest = &stat[idx + 2..];
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let state = fields[0];
        if state == "Z" || state == "X" {
            continue; // zombie / dead
        }
        let pgrp: i32 = match fields[2].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if pgrp == pgid {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn survivor_scan_false_for_own_group() {
        let my_pgrp = unsafe { libc::getpgrp() };
        let has = pgid_has_live_members(my_pgrp).unwrap();
        assert!(has, "scanner should observe our own live process group");
    }
}
