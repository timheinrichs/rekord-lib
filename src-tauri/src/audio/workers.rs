//! How many files an analysis pass works on at once.
//!
//! The passes each spawn one ffmpeg child process per worker and hold the whole
//! decode in memory while it runs, so the width of a pass is bounded twice: by
//! how many cores may be busy without the UI thread starving, and by how much
//! RAM is actually free. A high-core, low-RAM machine otherwise either pegs
//! every core and makes the app unresponsive, or runs out of memory mid-batch.
//!
//! ## Debugging knob
//!
//! `REKORD_JOBS=<n>` overrides the computed width for every pass that uses this
//! module. It is meant for reproducing a throughput problem, so it wins over
//! both terms — but it is still clamped to [`OVERRIDE_MAX`], because a typo
//! that spawns a thousand ffmpeg processes is not a debugging aid.

/// Cores left to the OS and the UI thread.
const RESERVED_CORES: usize = 2;

/// Upper bound for `REKORD_JOBS`. High enough for any real experiment, low
/// enough that a mistyped value cannot fork-bomb the machine.
const OVERRIDE_MAX: usize = 64;

/// Assumed core count when the host will not say. Deliberately small: guessing
/// high is what this module exists to prevent.
const CORES_FALLBACK: usize = 4;

/// What the host offers right now. Read per pass rather than once at startup —
/// the free memory of a machine changes over a session, the core count does not,
/// and asking for both together keeps the call sites to one line.
#[derive(Debug, Clone, Copy)]
pub struct Host {
    pub cores: usize,
    pub available_bytes: u64,
}

impl Host {
    /// The machine this process is running on.
    pub fn detect() -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(CORES_FALLBACK);
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        Host {
            cores,
            available_bytes: sys.available_memory(),
        }
    }
}

/// How many workers a pass may run at once.
///
/// The result is the smaller of two budgets — cores minus [`RESERVED_CORES`],
/// and how many workers of `per_worker_bytes` fit in the free memory — then
/// clamped to `1..=cap`. `cap` is the value the pass was measured at, so the
/// budget can only ever *lower* the width: going above a measured number
/// without a new measurement would be a guess dressed up as a heuristic.
///
/// `override_jobs` (from `REKORD_JOBS`) replaces both terms and ignores `cap`,
/// which is the point of a debugging knob.
pub fn budget(
    host: Host,
    per_worker_bytes: u64,
    cap: usize,
    override_jobs: Option<usize>,
) -> usize {
    if let Some(n) = override_jobs {
        // Zero would stall the pass forever, so it reads as "no opinion".
        if n > 0 {
            return n.min(OVERRIDE_MAX);
        }
    }
    let by_cores = host.cores.saturating_sub(RESERVED_CORES).max(1);
    let fits = host.available_bytes / per_worker_bytes.max(1);
    let by_memory = usize::try_from(fits).unwrap_or(usize::MAX).max(1);
    by_cores.min(by_memory).min(cap.max(1)).max(1)
}

/// The `REKORD_JOBS` override, if it is set to something parseable.
pub fn override_jobs() -> Option<usize> {
    std::env::var("REKORD_JOBS").ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;

    fn host(cores: usize, available: u64) -> Host {
        Host {
            cores,
            available_bytes: available,
        }
    }

    #[test]
    fn cores_bind_on_a_machine_with_memory_to_spare() {
        // 8 cores, 32 GB free: two cores stay free, memory is never the limit.
        assert_eq!(budget(host(8, 32 * GIB), 96 * MIB, 8, None), 6);
    }

    #[test]
    fn the_cap_holds_even_when_the_host_could_do_more() {
        // A 16-core machine could run 14, but 8 is what the pass was measured
        // at — the budget lowers, it never raises.
        assert_eq!(budget(host(16, 64 * GIB), 96 * MIB, 8, None), 8);
    }

    #[test]
    fn memory_binds_on_a_high_core_low_ram_machine() {
        // This is the case the module exists for: 16 cores would say 14, but
        // 512 MB free only holds five 96 MB workers.
        assert_eq!(budget(host(16, 512 * MIB), 96 * MIB, 8, None), 5);
    }

    #[test]
    fn never_returns_zero() {
        // A single core, and less free memory than one worker needs. Zero
        // workers would mean the pass never finishes, so the floor is 1.
        assert_eq!(budget(host(1, 0), 96 * MIB, 8, None), 1);
        assert_eq!(budget(host(2, 4 * MIB), 96 * MIB, 8, None), 1);
        // A zero cap is a caller bug, not a reason to stall.
        assert_eq!(budget(host(8, 32 * GIB), 96 * MIB, 0, None), 1);
    }

    #[test]
    fn a_pass_that_needs_almost_nothing_is_bound_by_cores_only() {
        // The fingerprint pass decodes a fixed 120 s window, so even a small
        // machine has room for the full width.
        assert_eq!(budget(host(10, 2 * GIB), 8 * MIB, 8, None), 8);
    }

    #[test]
    fn the_override_wins_over_both_terms() {
        // Above what the cores allow, and above the cap.
        assert_eq!(budget(host(2, 256 * MIB), 96 * MIB, 8, Some(12)), 12);
        // And below, which is how a throughput problem gets reproduced.
        assert_eq!(budget(host(16, 64 * GIB), 96 * MIB, 8, Some(1)), 1);
    }

    #[test]
    fn an_override_of_zero_is_no_opinion_and_an_absurd_one_is_clamped() {
        assert_eq!(budget(host(8, 32 * GIB), 96 * MIB, 8, Some(0)), 6);
        assert_eq!(
            budget(host(8, 32 * GIB), 96 * MIB, 8, Some(100_000)),
            OVERRIDE_MAX
        );
    }

    #[test]
    fn detect_reports_a_usable_machine() {
        // Not asserting on the numbers themselves — only that neither term
        // comes back as a value that would make `budget` degenerate.
        let host = Host::detect();
        assert!(host.cores >= 1);
        assert!(budget(host, 96 * MIB, 8, None) >= 1);
    }
}
