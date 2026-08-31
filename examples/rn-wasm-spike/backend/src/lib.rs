//! Task A0 spike backend — a minimal rustra engine built for BOTH the native
//! staticlib path (baseline) and the wasm32-unknown-unknown path (loaded by
//! wasm3 inside the RN spike app).
//!
//! Design contract for this spike:
//! - The SAME command source produces both artifacts, so the contract hash and
//!   the postcard wire bytes must be identical across native and wasm.
//! - Only the SYNC FFI entries are exercised (`rustra_ffi_invoke_postcard`,
//!   `rustra_ffi_contract_hash`). The core's async worker pool
//!   (`ffi_pool.rs`, `std::thread::spawn`) is lazily initialized ONLY by the
//!   async entries — the sync entries never touch it, so it is never compiled
//!   INTO the call path the wasm host drives. Runtime-safety note for wasm:
//!   on wasm32-unknown-unknown without atomics, `std::thread::spawn` compiles
//!   but PANICS at runtime — therefore a successful `spike_invoke` call on
//!   wasm3 is itself the proof that no thread spawn happened on that path.
//!   The spike host must never call the async entries (`*_async`) on wasm.

use rustra::ffi::FfiFormat;
use rustra::prelude::*;

// ── Commands ─────────────────────────────────────────────────────────────
//
// `double` is the swap PoC target: the FIRST .wasm doubles, the swapped
// .wasm triples — same schema, same contract hash, different handler body.
// `add_numbers` mirrors the bare-calculator command so the wire shape is a
// known quantity.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoubleInput {
    pub n: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoubleOutput {
    pub value: i64,
}

#[command]
pub fn double(input: DoubleInput) -> Result<DoubleOutput> {
    Ok(DoubleOutput {
        value: input.n * SPIKE_FACTOR,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

/// Multiplier baked into the compiled engine binary. Default (v1) is 2; the
/// swapped v2 build (`--cfg spike_factor=3`, see scripts/build-v2.sh) bakes 3.
/// Identical schema/ids/contract hash either way — only handler logic moves.
#[cfg(not(feature = "factor3"))]
const SPIKE_FACTOR: i64 = 2;
#[cfg(feature = "factor3")]
const SPIKE_FACTOR: i64 = 3;

static CACHED_PACKAGE: std::sync::OnceLock<Package> = std::sync::OnceLock::new();

pub fn spike_package() -> Package {
    CACHED_PACKAGE
        .get_or_init(|| {
            let pkg =
                register!(Package::builder("examples.wasm-spike"), double, add_numbers).build();
            // Postcard default: `rustra_ffi_invoke` and the spike host both use
            // the postcard wire.
            pkg.register_ffi_with_default(FfiFormat::Postcard);
            pkg
        })
        .clone()
}

// ── Native C-ABI surface (staticlib + cdylib share these names) ───────────
//
// The RN host (Obj-C++/JNI) binds these exact symbols. On wasm they are the
// wasm exports; on native they are staticlib symbols. The generic core
// entries are re-exposed under `spike_*` names so the host binds ONE surface
// regardless of which engine build is loaded.

/// # Safety
///
/// `payload` must point to `payload_len` readable bytes; `out_len` a valid
/// write pointer. Returned buffer starts with the 8-byte core FFI header
/// ("TSUR" magic + u32 LE payload length) and must be freed with
/// [`spike_free`] using the FULL returned pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_invoke(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    spike_package();
    unsafe { rustra::ffi::rustra_ffi_invoke_postcard(payload, payload_len, out_len) }
}

/// # Safety
///
/// `out_len` must be a valid write pointer. Returns the contract hash as
/// UTF-8 bytes in the core FFI header layout; free with [`spike_free`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_contract_hash(out_len: *mut usize) -> *mut u8 {
    spike_package();
    unsafe { rustra::ffi::rustra_ffi_contract_hash(out_len) }
}

/// # Safety
///
/// Frees a buffer returned by [`spike_invoke`] or [`spike_contract_hash`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_free(ptr: *mut u8, len: usize) {
    unsafe { rustra::ffi::rustra_ffi_free(ptr, len) }
}

/// Allocates `len` scratch bytes INSIDE the engine's own (linear) memory and
/// returns the offset. The wasm host (wasm3) cannot call Rust allocator
/// functions with host pointers, so the protocol is:
/// 1. `ptr = spike_alloc(req_len)` — host only
/// 2. host writes request bytes into `memory[ptr .. ptr + req_len]`
/// 3. `len_ptr = spike_alloc(8)`; host zero-fills 8 bytes there
/// 4. `resp = spike_invoke(ptr, req_len, len_ptr)` — resp pointer (wasm mem)
/// 5. host reads `memory[resp .. resp + u32le(memory[len_ptr..])]`
/// 6. `spike_free(resp, len)` / `spike_free(ptr, req_len)`
///
/// # Safety
///
/// No pointer dereference — returns an offset. The allocation must be
/// released with [`spike_unstage`] (same length) or intentionally leaked
/// (scratch reuse across calls is fine for the spike's single-threaded host).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_alloc(len: usize) -> usize {
    use std::alloc::{Layout, alloc};
    if len == 0 {
        return 0;
    }
    let layout = Layout::from_size_align(len, 16).expect("spike_alloc layout");
    unsafe { alloc(layout) as usize }
}

/// # Safety
///
/// Releases a buffer from [`spike_alloc`]. Pass the SAME `len` used at alloc
/// time, exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_unstage(offset: usize, len: usize) {
    if offset == 0 || len == 0 {
        return;
    }
    use std::alloc::{Layout, dealloc};
    let layout = Layout::from_size_align(len, 16).expect("spike_unstage layout");
    unsafe { dealloc(offset as *mut u8, layout) };
}

/// Semantic version of the ENGINE LOGIC baked at compile time. The wire
/// contract (schema/hash/ids) is identical between engine versions; this
/// constant is how the swap PoC proves behavior changed while the contract
/// stayed fixed.
///
/// # Safety
///
/// No requirements.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn spike_engine_version() -> u32 {
    SPIKE_FACTOR as u32
}

// ── Host round-trip test (native rlib path) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// postcard({command: String, args_json: String}) — core envelope.
    fn postcard_envelope(command: &str, args: serde_json::Value) -> Vec<u8> {
        let env = (command.to_string(), serde_json::to_string(&args).unwrap());
        postcard::to_allocvec(&env).unwrap()
    }

    /// Calls the core postcard FFI entry in-process and returns the payload
    /// bytes (header stripped), mirroring the on-device host protocol.
    fn invoke(command: &str, args: serde_json::Value) -> Vec<u8> {
        spike_package();
        let payload = postcard_envelope(command, args);
        let mut out_len: usize = 0;
        let ptr = unsafe {
            rustra::ffi::rustra_ffi_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len)
        };
        assert!(!ptr.is_null());
        let resp = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
        unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
        resp
    }

    #[test]
    fn postcard_round_trip_double() {
        let resp = invoke("double", serde_json::json!({ "n": 21 }));
        // NOTE: `alloc_response` returns a pointer PAST the 8-byte internal
        // header (header sits BEFORE the pointer; `out_len` = payload len).
        // The visible bytes are the raw postcard response frame:
        // FfiPostcardResponse { ok, result_json: Option<String>, error: Option<String> }
        //   ok=true(1) | Some(1) | varint-len | json bytes | None(0)
        let expected: Vec<u8> = [1u8, 1, 12]
            .iter()
            .copied()
            .chain(br#"{"value":42}"#.iter().copied())
            .chain([0u8])
            .collect();
        assert_eq!(resp, expected);
    }

    #[test]
    fn postcard_round_trip_add_numbers() {
        let resp = invoke("addNumbers", serde_json::json!({ "a": 40, "b": 2 }));
        assert_eq!(
            resp,
            [1u8, 1, 12]
                .iter()
                .copied()
                .chain(br#"{"value":42}"#.iter().copied())
                .chain([0u8])
                .collect::<Vec<u8>>()
        );
    }

    #[test]
    fn contract_hash_is_stable_and_nonempty() {
        let mut out_len: usize = 0;
        let ptr = unsafe { spike_contract_hash(&mut out_len) };
        assert!(!ptr.is_null());
        let hex = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
        unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
        let hex = std::str::from_utf8(&hex).unwrap();
        assert_eq!(hex.len(), 64); // sha-256 hex, header-free payload
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        let mut out_len2: usize = 0;
        let ptr2 = unsafe { spike_contract_hash(&mut out_len2) };
        let hex2 = unsafe { std::slice::from_raw_parts(ptr2, out_len2) }.to_vec();
        unsafe { rustra::ffi::rustra_ffi_free(ptr2, out_len2) };
        assert_eq!(hex.as_bytes(), hex2);
    }

    /// The engine-version contract: `spike_engine_version` reports the baked
    /// multiplier so the swap PoC can prove the engine (not the schema)
    /// changed.
    #[test]
    fn engine_version_matches_factor() {
        assert_eq!(unsafe { spike_engine_version() }, 2);
        assert_eq!(SPIKE_FACTOR, 2);
    }
}
