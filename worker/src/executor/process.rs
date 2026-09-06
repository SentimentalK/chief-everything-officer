use crate::executor::adapter_trait::ManagedProcess;
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
}

impl ManagedProcess for GroupManagedProcess {
    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    fn kill_group(&mut self) -> Result<(), std::io::Error> {
        if let Some(pgid) = self.pgid {
            #[cfg(target_os = "linux")]
            unsafe {
                let ret = libc::kill(-pgid, libc::SIGTERM);
                if ret != 0 {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::ESRCH) {
                        return Err(err);
                    }
                }
            }
        }
        let _ = self.child.start_kill();
        Ok(())
    }

    fn force_kill_group(&mut self) -> Result<(), std::io::Error> {
        if let Some(pgid) = self.pgid {
            #[cfg(target_os = "linux")]
            unsafe {
                let ret = libc::kill(-pgid, libc::SIGKILL);
                if ret != 0 {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::ESRCH) {
                        return Err(err);
                    }
                }
            }
        }
        let _ = self.child.start_kill();
        Ok(())
    }

    fn wait(
        &mut self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ExitStatus, std::io::Error>> + Send + '_>,
    > {
        Box::pin(self.child.wait())
    }
}
