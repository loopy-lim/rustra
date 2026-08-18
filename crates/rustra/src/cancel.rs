//! Invocation 취소 레지스트리 — 트랙 1 (AbortSignal ↔ Rust).
//!
//! `rustra_ffi_invoke_async` 로 시작된 호출에 발급된 invocation_id 로
//! 협력적 취소(cooperative cancellation)를 지원한다:
//!
//! - `register_invocation` — 새 ID 발급 + `Running` 등록
//! - `cancel_invocation`   — `Running` → `Cancelled` 전환 (스레드 강제 종료 없음)
//! - `complete_invocation` — 엔트리 제거 (레지스트리 누수 방지)
//! - `status`              — 핸들러 내부 폴링용 상태 조회
//!
//! 취소는 플래그 전환만 한다. 진행 중인 핸들러 스레드를 죽이지 않고,
//! dispatch 체크포인트에서 `Cancelled` 여부를 확인해 `RustraError::cancelled` 로 응답한다.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// 취소 대상 호출의 현재 상태.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// 알 수 없는 ID (완료 후 제거됐거나 발급된 적 없음).
    Unknown,
    /// 워커가 실행 중.
    Running,
    /// cancel 호출됨 — 다음 체크포인트에서 중단된다.
    Cancelled,
}

enum Entry {
    Running,
    Cancelled,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: Mutex<BTreeMap<u64, Entry>> = Mutex::new(BTreeMap::new());

/// 새 invocation을 등록하고 고유 ID를 발급한다.
pub fn register_invocation() -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    REGISTRY
        .lock()
        .expect("cancel registry mutex poisoned")
        .insert(id, Entry::Running);
    id
}

/// `Running` → `Cancelled` 전환. 취소 성공 시 true.
/// 이미 취소됐거나(멱등 no-op) 완료/알 수 없는 ID면 false.
pub fn cancel_invocation(id: u64) -> bool {
    match REGISTRY
        .lock()
        .expect("cancel registry mutex poisoned")
        .get_mut(&id)
    {
        Some(entry) if matches!(entry, Entry::Running) => {
            *entry = Entry::Cancelled;
            true
        }
        _ => false,
    }
}

/// 호출 완료 — 레지스트리에서 엔트리를 제거한다 (누수 방지).
pub fn complete_invocation(id: u64) {
    REGISTRY
        .lock()
        .expect("cancel registry mutex poisoned")
        .remove(&id);
}

/// 현재 상태 조회. 완료된(제거된) 호출은 `Unknown` 이다.
pub fn status(id: u64) -> Status {
    match REGISTRY
        .lock()
        .expect("cancel registry mutex poisoned")
        .get(&id)
    {
        Some(Entry::Running) => Status::Running,
        Some(Entry::Cancelled) => Status::Cancelled,
        None => Status::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_returns_unique_ids() {
        let a = register_invocation();
        let b = register_invocation();
        assert_ne!(a, b);
    }

    #[test]
    fn cancel_transitions_running_to_cancelled() {
        let id = register_invocation();
        assert!(
            cancel_invocation(id),
            "cancelling a Running invocation succeeds"
        );
        assert!(!cancel_invocation(id), "second cancel is a no-op");
    }

    #[test]
    fn complete_then_cancel_is_noop() {
        let id = register_invocation();
        complete_invocation(id);
        assert!(
            !cancel_invocation(id),
            "cannot cancel a Completed invocation"
        );
    }

    #[test]
    fn status_reflects_lifecycle() {
        let id = register_invocation();
        assert_eq!(status(id), Status::Running);
        cancel_invocation(id);
        assert_eq!(status(id), Status::Cancelled);
        complete_invocation(id);
        assert_eq!(status(id), Status::Unknown, "completion removes the entry");
    }

    #[test]
    fn unknown_id_is_unknown_status() {
        assert_eq!(status(u64::MAX), Status::Unknown);
    }

    #[test]
    fn registry_is_cleared_on_completion() {
        let id = register_invocation();
        complete_invocation(id);
        assert_eq!(status(id), Status::Unknown, "completion removes the entry");
    }

    // ── Task 1 review 에서 이연된 동시성 테스트 ──────────────────

    #[test]
    fn concurrent_registrations_issue_unique_visible_ids() {
        let handles: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| (0..64).map(|_| register_invocation()).collect::<Vec<_>>())
            })
            .collect();
        let mut all = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        let count = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), count, "all 256 ids must be unique");
        // 모두 조회 가능 (제거한 적 없음)
        for id in &all {
            assert_eq!(status(*id), Status::Running);
        }
    }

    #[test]
    fn cancel_vs_complete_race_is_always_consistent() {
        for _ in 0..200 {
            let id = register_invocation();
            let a = std::thread::spawn(move || cancel_invocation(id));
            let b = std::thread::spawn(move || complete_invocation(id));
            let cancelled = a.join().unwrap();
            b.join().unwrap();
            // 어떤 순서로 끝나도 Running 으로 되돌아가는 일은 없다:
            // - cancel 성공 후 complete 가 아직 실행 전 → Cancelled
            // - cancel 성공 후 complete 가 이어서 실행(엔트리 제거) → Unknown
            // - complete 가 먼저 (cancel 실패, 엔트리 제거됨) → Unknown
            // 셋 중 하나만 가능하며 Running 은 불가능하다.
            let s = status(id);
            assert!(
                s == Status::Cancelled || s == Status::Unknown,
                "terminal state must be Cancelled or Unknown, never Running (got {s:?})"
            );
            if !cancelled {
                // cancel 이 false 를 반환했다는 건 complete 가 먼저 엔트리를 제거했다는
                // 뜻 — 이 경로에서는 상태가 반드시 Unknown 이어야 한다.
                assert_eq!(s, Status::Unknown);
            }
        }
    }
}
