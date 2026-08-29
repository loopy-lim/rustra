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

// ── 레지스트리 락 포이즈닝 관용 ───────────────────────────
// 워커가 락을 잡은 채 패닉해도(포이즈닝) 이후 API 가 abort 대신 정상
// 동작하는지. in-crate 테스트라 private static(REGISTRY) 으로 직접 포이즈닝.

#[test]
fn poisoned_registry_still_serves_invocations() {
    let id = register_invocation();
    // 의도적 포이즈닝 — 락을 잡은 채 패닉
    let _ = std::panic::catch_unwind(|| {
        let _guard = REGISTRY.lock().unwrap();
        panic!("intentional poison");
    });
    // 관용 처리 후: status/cancel/complete 가 패닉하지 않고 동작한다
    assert_eq!(status(id), Status::Running);
    assert!(cancel_invocation(id));
    assert_eq!(status(id), Status::Cancelled);
    complete_invocation(id);
    assert_eq!(status(id), Status::Unknown);
    // 신규 등록·조회도 정상
    let fresh = register_invocation();
    assert_eq!(status(fresh), Status::Running);
}

// ── Task 1 review 에서 이연된 동시성 테스트 ──────────────────

#[test]
fn concurrent_registrations_issue_unique_visible_ids() {
    let handles: Vec<_> = (0..4)
        .map(|_| std::thread::spawn(|| (0..64).map(|_| register_invocation()).collect::<Vec<_>>()))
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
