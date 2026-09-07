//! platform_command 빌더 단위 테스트 — builder_platform.rs 의 include! 문맥과
//! 분리된 스탠드얼론 테스트 모듈(lib.rs 의 `#[cfg(test)] mod` 관례).

use crate::Package;
use crate::platform::Platform;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct InfoOut {
    pub kind: String,
}

fn current_platform() -> Platform {
    Platform::current().expect("tests run on a known platform")
}

#[test]
fn platform_command_registers_stub_on_all_platforms_with_stable_surface() {
    // 현재 플랫폼은 지원 목록에서 제외 — 어느 대상에서 돌어도 스텁 경로가
    // 관측된다(지원 플랫폼 누락 패닉은 별도 테스트).
    let others: Vec<Platform> = Platform::ALL
        .into_iter()
        .filter(|p| *p != current_platform())
        .take(2)
        .collect();
    let pkg = Package::builder("test.platform")
        .platform_command::<(), InfoOut>("nativeInfo", &others)
        .build();
    // command.not_found 가 아니라 platform.unavailable — 계약상 존재하지만
    // 이 플랫폼(테스트 대상)에서는 구현이 없다.
    let err = pkg
        .invoke_json("nativeInfo", serde_json::json!(null))
        .unwrap_err();
    assert_eq!(err.code(), "platform.unavailable");
    assert!(err.message().contains("nativeInfo"));
    // 스키마에는 platforms 가 기록된다(전 플랫폼 동일).
    let schema = pkg.live_schema().to_string();
    assert!(schema.contains("\"platforms\""));
    assert!(schema.contains(others[0].as_str()));
}

#[test]
fn platform_impl_replaces_stub_and_keeps_contract() {
    let current = current_platform();
    let pkg = Package::builder("test.platform.impl")
        .platform_command::<(), InfoOut>("nativeInfo", &[current])
        .platform_command_impl("nativeInfo", |_input: ()| {
            Ok(InfoOut {
                kind: "impl".to_string(),
            })
        })
        .build();
    let out = pkg
        .invoke_json("nativeInfo", serde_json::json!(null))
        .unwrap();
    assert_eq!(out["kind"], "impl");
}

#[test]
#[should_panic(expected = "platform_command_impl")]
fn platform_impl_on_unsupported_platform_panics() {
    let other = Platform::ALL
        .into_iter()
        .find(|p| *p != current_platform())
        .expect("at least two platforms exist");
    Package::builder("test.platform.misplaced")
        .platform_command::<(), InfoOut>("nativeInfo", &[other])
        .platform_command_impl("nativeInfo", |_input: ()| {
            Ok(InfoOut {
                kind: "x".to_string(),
            })
        })
        .build();
}

#[test]
#[should_panic(expected = "platform_command_impl was never called")]
fn missing_impl_on_supported_platform_panics_at_build() {
    let current = current_platform();
    let _ = Package::builder("test.platform.missing")
        .platform_command::<(), InfoOut>("nativeInfo", &[current])
        .build();
}

#[test]
#[should_panic(expected = "handler types mismatch")]
fn impl_type_mismatch_panics() {
    let current = current_platform();
    #[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    struct WrongOut {
        pub different: u32,
    }
    let _ = Package::builder("test.platform.mismatch")
        .platform_command::<(), InfoOut>("nativeInfo", &[current])
        .platform_command_impl("nativeInfo", |_input: ()| Ok(WrongOut { different: 1 }))
        .build();
}

#[test]
fn empty_platform_list_panics() {
    let result = std::panic::catch_unwind(|| {
        let _ = Package::builder("test.platform.empty")
            .platform_command::<(), InfoOut>("nativeInfo", &[])
            .build();
    });
    assert!(result.is_err());
}
