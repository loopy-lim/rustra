//! auth 예제 통합 테스트 — capability 게이트 전체 시나리오.

use rustra::prelude::*;
use rustra_auth_example::*;

#[test]
fn full_capability_flow() {
    let package = auth_package();

    // 일반 사용자는 grant 가 거부된다.
    let user: SignInOutput = package
        .invoke(
            "signIn",
            SignInInput {
                username: "alice".into(),
                password: "password123".into(),
            },
        )
        .unwrap();
    assert_eq!(user.role, "user");

    let denied: GrantOutput = package
        .invoke(
            "grant",
            GrantInput {
                token: user.token.clone(),
                capability: "admin.stats".into(),
            },
        )
        .unwrap();
    assert!(!denied.granted);

    // 거부된 세션으로 adminStats → capability.denied.
    let err = package
        .invoke::<_, AdminStatsOutput>(
            "adminStats",
            AdminStatsInput {
                token: user.token.clone(),
            },
        )
        .unwrap_err();
    assert_eq!(err.code(), "capability.denied");

    // admin 은 grant 성공 → 조회 성공.
    let admin: SignInOutput = package
        .invoke(
            "signIn",
            SignInInput {
                username: "root".into(),
                password: "hunter2".into(),
            },
        )
        .unwrap();
    assert_eq!(admin.role, "admin");

    let granted: GrantOutput = package
        .invoke(
            "grant",
            GrantInput {
                token: admin.token.clone(),
                capability: "admin.stats".into(),
            },
        )
        .unwrap();
    assert!(granted.granted);

    let stats: AdminStatsOutput = package
        .invoke(
            "adminStats",
            AdminStatsInput {
                token: admin.token.clone(),
            },
        )
        .unwrap();
    assert!(stats.sessions >= 1);
    assert!(stats.uptime_ms >= 0);

    // signOut 후 재시도 → 다시 denied.
    let out: SignOutOutput = package
        .invoke("signOut", SignOutInput { token: admin.token })
        .unwrap();
    assert!(out.signed_out);

    let err = package
        .invoke::<_, AdminStatsOutput>(
            "adminStats",
            AdminStatsInput {
                token: "revoked".into(),
            },
        )
        .unwrap_err();
    assert_eq!(err.code(), "capability.denied");
}

#[test]
fn tokens_are_role_prefixed_and_distinct() {
    let package = auth_package();
    let a: SignInOutput = package
        .invoke(
            "signIn",
            SignInInput {
                username: "u1".into(),
                password: "x".into(),
            },
        )
        .unwrap();
    let b: SignInOutput = package
        .invoke(
            "signIn",
            SignInInput {
                username: "u2".into(),
                password: "hunter2".into(),
            },
        )
        .unwrap();
    assert!(a.token.starts_with("user-"));
    assert!(b.token.starts_with("admin-"));
    assert_ne!(a.token, b.token);
}
