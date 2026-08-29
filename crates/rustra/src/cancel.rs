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
/// 포이즈닝 관용: 워커가 락을 잡은 채 패닉하면 이 뮤텍스는 포이즈닝되지만,
/// 내부 `BTreeMap` 은 구조적으로 유효하다(중간 상태 corruption 없음 —
/// 포이즈닝은 "락 보유 중 패닉 발생" 신호일 뿐). `.expect()` 로 전파하면
/// 이후 모든 호출이 패닉하고, FFI 경계에서는 프로세스 abort 다. ffi.rs 의
/// 이벤트 싱크 뮤텍스와 같은 `into_inner()` 관용으로 과거 패닉 이후에도
/// 취소/조회가 계속 동작하게 한다.
static REGISTRY: Mutex<BTreeMap<u64, Entry>> = Mutex::new(BTreeMap::new());

/// 새 invocation을 등록하고 고유 ID를 발급한다.
pub fn register_invocation() -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id, Entry::Running);
    id
}

/// `Running` → `Cancelled` 전환. 취소 성공 시 true.
/// 이미 취소됐거나(멱등 no-op) 완료/알 수 없는 ID면 false.
pub fn cancel_invocation(id: u64) -> bool {
    match REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&id);
}

/// 현재 상태 조회. 완료된(제거된) 호출은 `Unknown` 이다.
pub fn status(id: u64) -> Status {
    match REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&id)
    {
        Some(Entry::Running) => Status::Running,
        Some(Entry::Cancelled) => Status::Cancelled,
        None => Status::Unknown,
    }
}

#[cfg(test)]
#[path = "cancel_tests.rs"]
mod tests;
