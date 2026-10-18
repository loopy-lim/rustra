//! Test-only bridge to the production event sink. No published ABI is added.
use rustra::ffi::{
    FfiEventCallback, rustra_ffi_event_sink_register, rustra_ffi_event_sink_unregister,
};
use std::ffi::c_void;

/// # Safety
/// The callback and its user data must satisfy the production sink contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_safety_callback_probe(
    callback: FfiEventCallback,
    data: *mut c_void,
) {
    let package = rustra::Package::builder("foreign.exception.probe").build();
    package.clone().register_ffi();
    unsafe { rustra_ffi_event_sink_register(callback, data) };
    package.emit("probe", 1_u32);
    package.emit("probe", 2_u32);
    unsafe { rustra_ffi_event_sink_unregister() };
}
