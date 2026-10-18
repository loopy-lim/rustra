#![no_main]
//! Separate resource-bounded campaign: valid bytes, 1MiB limits and deep recursion.
#[path = "../../crates/rustra/tests/support/large_boundary_cases.rs"]
mod cases;
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| cases::exercise(data));
