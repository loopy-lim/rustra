[한국어](./0004-ffi-safety-preconditions.ko.md)

# ADR 0004 — FFI pointer preconditions and foreign exception ownership

- Status: Accepted
- Date: 2026-10-13
- Related: [Safety contract](../safety-contract.md), [ADR 0001](0001-record-track-a-contract-mechanization.md)

## Status

Accepted. Preserve the public ABI and release allocation path while correcting the
guarantee and verification boundaries.

## Context

The umbrella contract promised no UB even for malicious violations of the FFI
contract, while S3 and the implementation require valid pointers and correct ownership.
Reading a freed pointer's magic can itself be UB. S2 also incorrectly treated
`C-unwind` as a guaranteed foreign-exception abort. Rust panic tests are not C++
exception tests.

## Decision

1. Adversarial bytes are validated within the unsafe preconditions for pointer
   ranges, alignment, lifetime, concurrent access and paired frees. Arbitrary raw
   pointer validity is not certified.
2. The debug live tracker diagnoses and aborts misuse before dereference. Release
   retains its caller contract; do not add a global tracker and lock to the hot path.
3. A C++ `noexcept` callback wrapper catches exceptions, records them and returns,
   or explicitly aborts. Do not rely on a foreign exception reaching Rust `catch_unwind`.
4. Child-process tests verify actual debug misuse aborts. A C++ harness verifies
   host-side containment of a real throw and explicit abort, without executing release UB.
5. Extend core lib ASan/LSan with debug/release FFI integration tests. Keep the
   existing 1KiB fuzz campaign separate from large valid input, 1MiB boundary and
   recursive-depth coverage, each with raw logs and resource budgets.
6. S3 distinguishes owned responses from caller buffers and borrowed callbacks.
   S6 guarantees response encoding, not delivery after channel teardown. A host
   disposing a retained async channel must settle its own pending work.
   Foreign-runtime callbacks already queued before release can still drain; the
   consumer separately guards effects on disposed state.

## Consequences

The unconditional safety claim is withdrawn; the ABI, call overhead and existing
host obligations are unchanged. Exception containment belongs to host wrappers.
Implemented checks do not certify RN physical-device memory safety or execution on
every platform. Linux sanitizer completion requires logs from the same source.

Sources: [Rust FFI unwinding](https://doc.rust-lang.org/nomicon/ffi.html#ffi-and-unwinding),
[`catch_unwind`](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html#notes).
