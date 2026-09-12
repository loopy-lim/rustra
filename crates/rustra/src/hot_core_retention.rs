//! Process-lifetime library retention diagnostics for development hot reload.

use std::sync::atomic::{AtomicU64, Ordering};

static LIBRARIES: AtomicU64 = AtomicU64::new(0);
static ARTIFACT_BYTES: AtomicU64 = AtomicU64::new(0);

/// A development session should restart after this many retained loads.
pub const RETAINED_LIBRARY_RESTART_INTERVAL: u64 = 32;

/// Cumulative retained loads; dropping a core does not unload its symbols.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetainedLibraryStats {
    pub libraries: u64,
    /// Sum of loaded artifact file sizes, not resident memory (RSS).
    pub artifact_bytes: u64,
}

impl RetainedLibraryStats {
    pub fn restart_recommended(&self) -> bool {
        self.libraries >= RETAINED_LIBRARY_RESTART_INTERVAL
    }
}

/// Returns process-wide diagnostics, including loads that failed symbol binding.
/// The counters may advance independently while another thread loads a library.
pub fn retained_library_stats() -> RetainedLibraryStats {
    RetainedLibraryStats {
        libraries: LIBRARIES.load(Ordering::Relaxed),
        artifact_bytes: ARTIFACT_BYTES.load(Ordering::Relaxed),
    }
}

pub(super) fn record_retained_library(artifact_bytes: u64) {
    ARTIFACT_BYTES.fetch_add(artifact_bytes, Ordering::Relaxed);
    let count = LIBRARIES.fetch_add(1, Ordering::Relaxed) + 1;
    if count.is_multiple_of(RETAINED_LIBRARY_RESTART_INTERVAL) {
        eprintln!(
            "rustra hot-core: {count} library loads retained for symbol safety; restart the development host to release them (artifact bytes: {}, not RSS)",
            ARTIFACT_BYTES.load(Ordering::Relaxed)
        );
    }
}
