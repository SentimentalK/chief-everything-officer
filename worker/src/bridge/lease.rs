//! Boot-time clock and lease/deadline math for the bridge controller.
//!
//! Production timing is anchored to `clock_gettime(CLOCK_BOOTTIME)`, which —
//! unlike `CLOCK_MONOTONIC` — keeps counting across system suspend. Using only a
//! monotonic clock would silently lose the time that passed while the machine
//! slept and could let a lease run past its real expiry. The clock is injected
//! through the [`Clock`] trait so pure timing decisions are unit-testable
//! without shrinking the real 90s/300s lease constants.
//!
//! The controller never derives remaining lease from the local wall clock; it
//! trusts only server-issued deadlines converted into boot-time offsets.

use std::fmt;
use std::time::Duration;

/// A nanosecond-precision boot-time instant (time since boot).
pub type BootTime = Duration;

/// Failure reading the boot clock. A clock fault is a *control fault*: the
/// caller must never authorize new execution, must not treat the lease as
/// still valid, and must fall back to a confirmed stop line rather than to an
/// invented local time. It never silently returns zero or swaps to the wall
/// clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockError(pub String);

impl fmt::Display for ClockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "boot clock error: {}", self.0)
    }
}

impl std::error::Error for ClockError {}

/// Injectable source of boot-time. `SystemBootClock` is the production clock.
pub trait Clock: Send + Sync {
    /// Current boot time (nanoseconds since the kernel booted), or an error
    /// when the clock cannot be read safely.
    fn now_boot(&self) -> Result<BootTime, ClockError>;
}

/// Production clock backed by `clock_gettime(CLOCK_BOOTTIME)` (Linux).
pub struct SystemBootClock;

impl Clock for SystemBootClock {
    fn now_boot(&self) -> Result<BootTime, ClockError> {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // CLOCK_BOOTTIME is Linux-only. On non-Linux this crate targets Linux.
        #[cfg(target_os = "linux")]
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
        #[cfg(not(target_os = "linux"))]
        let rc = {
            let _ = &mut ts;
            -1
        };
        if rc != 0 {
            return Err(ClockError(format!(
                "clock_gettime(CLOCK_BOOTTIME): {}",
                std::io::Error::last_os_error()
            )));
        }
        if ts.tv_sec < 0 || !(0..1_000_000_000).contains(&ts.tv_nsec) {
            return Err(ClockError(format!(
                "clock_gettime returned an invalid instant (sec={}, nsec={})",
                ts.tv_sec, ts.tv_nsec
            )));
        }
        Ok(Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32))
    }
}

/// A test clock whose value is advanced explicitly. Satisfies [`Clock`].
pub struct ManualClock {
    inner: parking_lot::Mutex<BootTime>,
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new(Duration::from_secs(1000))
    }
}

impl ManualClock {
    pub fn new(start: BootTime) -> Self {
        Self {
            inner: parking_lot::Mutex::new(start),
        }
    }
    pub fn set(&self, t: BootTime) {
        *self.inner.lock() = t;
    }
    pub fn advance(&self, by: Duration) {
        *self.inner.lock() += by;
    }
}

impl Clock for ManualClock {
    fn now_boot(&self) -> Result<BootTime, ClockError> {
        Ok(*self.inner.lock())
    }
}

/// A test clock that always fails, so clock-fault propagation is unit-testable.
pub struct FailingClock;

impl Clock for FailingClock {
    fn now_boot(&self) -> Result<BootTime, ClockError> {
        Err(ClockError("injected clock failure".to_string()))
    }
}

// ---------------------------------------------------------------------------
// Lease scheduling constants
// ---------------------------------------------------------------------------

/// Margin before an actual lease expiry at which the controller stops issuing
/// new work (and cancels the current attempt if it would run past this point).
pub const STOP_MARGIN: Duration = Duration::from_secs(5);
/// How often a confirmed lease is refreshed with a heartbeat.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// Watchdog cadence: it re-reads the boot clock and the current stop deadline,
/// and is never blocked by an 8 s HTTP request.
pub const WATCHDOG_PERIOD: Duration = Duration::from_millis(100);
/// Total wall time a single claim-confirmation retry window may span before the
/// controller gives up and keeps ClaimIntent for a later process to resume.
pub const CLAIM_RECOVERY_WINDOW: Duration = Duration::from_secs(60);
/// Pause between discovery pages while the controller still has more to scan.
pub const PAGE_PAUSE: Duration = Duration::from_millis(250);
/// Poll interval when the discovery stream tail is reached.
pub const TAIL_POLL: Duration = Duration::from_secs(5);

/// Backoff delays applied on transient claim/discovery transport failures.
pub const CLAIM_BACKOFF: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(10),
];

/// Backoff delays applied on heartbeat/start lease-write failures.
pub const HEARTBEAT_BACKOFF: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(5),
];

/// Pure backoff selection: `attempt` is the number of prior consecutive
/// failures. Returns the capped delay for that failure index.
pub fn backoff(schedule: &[Duration], attempt: usize) -> Duration {
    if schedule.is_empty() {
        return Duration::from_secs(1);
    }
    let idx = attempt.min(schedule.len() - 1);
    schedule[idx]
}

pub fn claim_backoff(attempt: usize) -> Duration {
    backoff(CLAIM_BACKOFF, attempt)
}

pub fn heartbeat_backoff(attempt: usize) -> Duration {
    backoff(HEARTBEAT_BACKOFF, attempt)
}

// ---------------------------------------------------------------------------
// Deadline math (pure; all inputs already validated by the client)
// ---------------------------------------------------------------------------

/// Converts the `remaining` (server-side) time until the effective deadline
/// into a local boot-time `stop_at`, anchored at the moment the request was
/// sent (`sent_boot`) rather than when its response arrived, so round-trip time
/// is conservatively subtracted. `stop_at = sent_boot + remaining - STOP_MARGIN`.
///
/// Returns `None` if the numbers overflow or if the stop point is already in
/// the past (the lease should be treated as immediately expired).
pub fn stop_at_from_remaining(sent_boot: BootTime, remaining: Duration) -> Option<BootTime> {
    if remaining < STOP_MARGIN {
        return Some(sent_boot); // treat as already at the stop line
    }
    let usable = remaining - STOP_MARGIN;
    sent_boot.checked_add(usable)
}

/// Whether `now` has reached or passed `stop_at`. Overflows treated as reached.
pub fn is_past_deadline(now: BootTime, stop_at: BootTime) -> bool {
    now >= stop_at
}

/// Whether a given `execution_deadline` boot-time is still ahead of `now` by at
/// least the stop margin; used before granting the execution permit.
pub fn execution_still_valid(now: BootTime, execution_deadline: BootTime) -> bool {
    execution_deadline
        .checked_sub(now)
        .map(|left| left >= STOP_MARGIN)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_at_conservatively_subtracts_margin() {
        let sent = Duration::from_secs(1000);
        let remaining = Duration::from_secs(30);
        // stop_at = 1000 + 30 - 5 = 1025
        assert_eq!(
            stop_at_from_remaining(sent, remaining),
            Some(Duration::from_secs(1025))
        );
    }

    #[test]
    fn stop_at_clamps_to_sent_when_almost_expired() {
        let sent = Duration::from_secs(1000);
        // remaining below margin -> stop now
        assert_eq!(
            stop_at_from_remaining(sent, Duration::from_secs(3)),
            Some(sent)
        );
    }

    #[test]
    fn deadline_checks() {
        assert!(is_past_deadline(
            Duration::from_secs(20),
            Duration::from_secs(20)
        ));
        assert!(!is_past_deadline(
            Duration::from_secs(19),
            Duration::from_secs(20)
        ));
    }

    #[test]
    fn execution_valid_requires_margin() {
        let now = Duration::from_secs(1000);
        assert!(execution_still_valid(now, Duration::from_secs(1000 + 6)));
        assert!(!execution_still_valid(now, Duration::from_secs(1000 + 4)));
        assert!(!execution_still_valid(now, Duration::from_secs(999)));
    }

    #[test]
    fn backoff_caps_at_schedule_tail() {
        assert_eq!(claim_backoff(0), Duration::from_secs(1));
        assert_eq!(claim_backoff(1), Duration::from_secs(2));
        assert_eq!(claim_backoff(4), Duration::from_secs(10));
        // beyond the schedule caps at the last element
        assert_eq!(claim_backoff(50), Duration::from_secs(10));
        assert_eq!(heartbeat_backoff(3), Duration::from_secs(5));
    }

    #[test]
    fn manual_clock_advances() {
        let c = ManualClock::new(Duration::from_secs(10));
        assert_eq!(c.now_boot().unwrap(), Duration::from_secs(10));
        c.advance(Duration::from_secs(90));
        assert_eq!(c.now_boot().unwrap(), Duration::from_secs(100));
    }
}
