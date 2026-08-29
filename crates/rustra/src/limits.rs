//! Runtime limits shared by the core and its host-facing FFI layer.

use std::sync::atomic::{AtomicUsize, Ordering};

/// Default maximum encoded request/response size: 1 MiB.
pub const DEFAULT_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

static MAX_PAYLOAD_BYTES: AtomicUsize = AtomicUsize::new(DEFAULT_MAX_PAYLOAD_BYTES);

/// Returns the current payload limit.
#[inline]
pub fn max_payload_bytes() -> usize {
    MAX_PAYLOAD_BYTES.load(Ordering::Relaxed)
}

/// Updates the payload limit for subsequent calls.
#[inline]
pub fn set_max_payload_bytes(bytes: usize) {
    MAX_PAYLOAD_BYTES.store(bytes, Ordering::Relaxed);
}
