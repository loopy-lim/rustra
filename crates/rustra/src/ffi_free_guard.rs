/// Debug-only allocation tracker for `rustra_ffi_free` misuse detection (F2).
///
/// `alloc_response` records every handed-out `(ptr, len)`; `rustra_ffi_free`
/// classifies a free request against this set before reconstructing the
/// `Box<[u8]>`. This surfaces two UB modes early, in debug/test builds only:
///
/// - **wrong-len free** — `ptr` is live but the caller's `len` mismatches the
///   allocation (reconstructs a `Box` with the wrong layout).
/// - **double-free / foreign pointer** — `ptr` is not live at all.
///
/// In release builds the tracker and its checks compile out entirely (no mutex,
/// no `HashSet`) — across an FFI boundary we cannot *soundly prevent* a caller
/// from misusing `unsafe`; we can only catch it during development. The tracker
/// is best-effort diagnostics, never a release guarantee.
///
/// The classifier returns a [`Verdict`] rather than panicking: a panic cannot
/// unwind through the `extern "C"` nounwind ABI of `rustra_ffi_free`, so the
/// extern entry point itself performs the loud failure (`abort`) on misuse.
#[cfg(debug_assertions)]
mod free_guard {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    #[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
    pub(super) enum AllocationKind {
        Header,
        Owned,
    }

    /// Classification of a `rustra_ffi_free` request against the live set.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Verdict {
        /// Exact `(ptr, len)` match — sound. Entry removed from the live set.
        Sound,
        /// `ptr` is live but under a different length (wrong-len free → UB).
        WrongLen,
        /// The pointer/length pair belongs to the other Rustra allocator.
        WrongAllocator,
        /// `ptr` is not live at all (double-free or foreign pointer → UB).
        NotLive,
    }

    fn live() -> &'static Mutex<HashSet<(usize, usize, AllocationKind)>> {
        static LIVE: OnceLock<Mutex<HashSet<(usize, usize, AllocationKind)>>> = OnceLock::new();
        LIVE.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// Record a freshly handed-out allocation.
    pub(super) fn record(ptr: *mut u8, len: usize, kind: AllocationKind) {
        let mut set = live().lock().expect("free_guard mutex poisoned");
        set.insert((ptr as usize, len, kind));
    }

    /// Classify a free request; on [`Verdict::Sound`] the entry is removed.
    ///
    /// Pure classification — never panics, so it is safe to call from inside the
    /// `extern "C"` boundary (which cannot unwind). The caller decides how to
    /// react to a misuse verdict.
    pub(super) fn check(ptr: *mut u8, len: usize, kind: AllocationKind) -> Verdict {
        let key = (ptr as usize, len, kind);
        let mut set = live().lock().expect("free_guard mutex poisoned");
        if set.remove(&key) {
            Verdict::Sound
        } else if set
            .iter()
            .any(|(p, entry_len, _)| *p == ptr as usize && *entry_len == len)
        {
            Verdict::WrongAllocator
        } else if set.iter().any(|(p, _, _)| *p == ptr as usize) {
            Verdict::WrongLen
        } else {
            Verdict::NotLive
        }
    }

    #[cfg(test)]
    mod tests {
        //! Verdict logic is exercised here (no extern boundary, no abort).
        //! Each test uses a unique synthetic pointer value so the shared global
        //! live set never collides across parallel tests.
        use super::{AllocationKind, Verdict, check, record};

        // 고유 synthetic 포인터 — dereference 되지 않고 key 로만 사용.
        const fn p(n: usize) -> *mut u8 {
            (0xdead_beef_0000 + n) as *mut u8
        }

        #[test]
        fn exact_match_is_sound_and_removes_entry() {
            record(p(0x10), 16, AllocationKind::Header);
            assert_eq!(check(p(0x10), 16, AllocationKind::Header), Verdict::Sound);
            // 이미 제거됨 → 같은 요청은 이제 NotLive.
            assert_eq!(check(p(0x10), 16, AllocationKind::Header), Verdict::NotLive);
        }

        #[test]
        fn same_ptr_different_len_is_wrong_len() {
            record(p(0x20), 32, AllocationKind::Header);
            assert_eq!(
                check(p(0x20), 33, AllocationKind::Header),
                Verdict::WrongLen,
                "ptr live under len=32 must classify len=33 as WrongLen"
            );
            // 정리: 올바른 len 으로 Sound 제거.
            assert_eq!(check(p(0x20), 32, AllocationKind::Header), Verdict::Sound);
        }

        #[test]
        fn second_free_is_not_live() {
            record(p(0x30), 8, AllocationKind::Owned);
            assert_eq!(check(p(0x30), 8, AllocationKind::Owned), Verdict::Sound);
            assert_eq!(
                check(p(0x30), 8, AllocationKind::Owned),
                Verdict::NotLive,
                "double-free must classify as NotLive"
            );
        }

        #[test]
        fn unknown_ptr_is_not_live() {
            assert_eq!(
                check(p(0x99), 64, AllocationKind::Header),
                Verdict::NotLive,
                "foreign pointer never recorded must be NotLive"
            );
        }

        #[test]
        fn exact_pair_from_other_allocator_is_rejected_without_removing_it() {
            record(p(0x40), 64, AllocationKind::Owned);
            assert_eq!(
                check(p(0x40), 64, AllocationKind::Header),
                Verdict::WrongAllocator
            );
            assert_eq!(check(p(0x40), 64, AllocationKind::Owned), Verdict::Sound);
        }
    }
}
