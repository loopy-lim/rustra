//! Generic FFI entry points for rustra packages.
//!
//! The implementation is kept in responsibility-sized files and included in
//! this module so the private FFI state remains one namespace. Public symbols
//! and the ABI contract stay unchanged.

use crate::Package;
use crate::package_codegen::command_wire_signature;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void};
use std::sync::{Mutex, OnceLock};

include!("ffi_prelude.rs");
include!("ffi_free_guard.rs");
include!("ffi_dispatch.rs");
include!("ffi_workers.rs");
include!("ffi_pool.rs");
include!("ffi_sync_entries.rs");
include!("ffi_buffer_entries.rs");
include!("ffi_async_entries.rs");
include!("ffi_lifecycle_entries.rs");
include!("ffi_typed_entries.rs");
include!("ffi_typed_buffer.rs");
include!("ffi_typed_async.rs");
include!("ffi_schema_entries.rs");
include!("ffi_snapshot.rs");
include!("ffi_event_core.rs");
include!("ffi_event_entries.rs");
include!("ffi_channel.rs");
include!("ffi_hot_reload.rs");

#[cfg(test)]
#[path = "ffi_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "ffi_hot_reload_tests.rs"]
mod hot_reload_tests;
