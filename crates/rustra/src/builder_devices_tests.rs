//! command_devices 빌더 단위 테스트 — lib.rs 의 `#[cfg(test)] mod` 스탠드얼론
//! 테스트 모듈 관례(builder_errors_tests.rs 참고).

use crate::device_capabilities::DeviceCapability;
use crate::{Package, RustraError};

fn devices_package() -> Package {
    Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices(
            "scan_tags",
            &[
                DeviceCapability::new("camera"),
                DeviceCapability::new("bluetooth"),
            ],
        )
        .build()
}

#[test]
fn command_devices_records_requirements() {
    let package = devices_package();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let command = state
        .commands
        .get("scan_tags")
        .expect("scan_tags registered");
    assert_eq!(command.device_requirements.len(), 2);
    assert_eq!(command.device_requirements[0].as_str(), "camera");
    assert_eq!(command.device_requirements[1].as_str(), "bluetooth");
}

/// 선언 없는 명령의 device_requirements 는 빈 벡터 — 기존 패키지 계약 불변.
#[test]
fn command_without_declaration_keeps_empty_requirements() {
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        state
            .commands
            .get("scan_tags")
            .unwrap()
            .device_requirements
            .is_empty(),
        "undeclared command must not carry device requirements"
    );
}

/// const 문맥 구성 — #[command(device(...))] 매크로가 생성하는 상수와 같은 형태.
#[test]
fn device_capability_composes_in_const_context() {
    const DEVICES: &[DeviceCapability] = &[
        DeviceCapability::new("camera"),
        DeviceCapability::new("clipboard-read"),
    ];
    assert_eq!(DEVICES[0].as_str(), "camera");
    assert_eq!(DEVICES[1].as_str(), "clipboard-read");
}

#[test]
fn devices_meta_if_is_noop_on_none_and_sets_on_some() {
    const DECLARED: &[DeviceCapability] = &[
        DeviceCapability::new("camera"),
        DeviceCapability::new("bluetooth"),
    ];

    // None — 선언 없는 #[command] 도 체인을 그대로 통과한다(platform_meta_if 관례).
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .devices_meta_if("scan_tags", None)
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        state
            .commands
            .get("scan_tags")
            .unwrap()
            .device_requirements
            .is_empty()
    );

    // Some — command_devices 와 동일하게 기록된다.
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .devices_meta_if("scan_tags", Some(DECLARED))
        .build();
    let state = package
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        state
            .commands
            .get("scan_tags")
            .unwrap()
            .device_requirements
            .len(),
        2
    );
}

#[test]
#[should_panic(expected = "command_devices: command 'nope' is not registered")]
fn command_devices_panics_on_unknown_command() {
    let _ = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices("nope", &[DeviceCapability::new("camera")])
        .build();
}

#[test]
#[should_panic(expected = "devices must not be empty")]
fn command_devices_panics_on_empty_slice() {
    let _ = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices("scan_tags", &[])
        .build();
}

#[test]
#[should_panic(expected = "unknown device capability 'camra'")]
fn command_devices_panics_on_catalog_outside_token() {
    // "camra" — 오타. 카탈로그 밖 토큰은 등록 시점 loud-fail(타입화 에러 트랙
    // 과 같은 동기 — 조용한 미기록보다 빌드 시점 발견).
    let _ = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices("scan_tags", &[DeviceCapability::new("camra")])
        .build();
}

#[test]
#[should_panic(expected = "duplicate device capability 'camera'")]
fn command_devices_panics_on_duplicate_token() {
    let _ = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices(
            "scan_tags",
            &[
                DeviceCapability::new("camera"),
                DeviceCapability::new("camera"),
            ],
        )
        .build();
}

// ── 스키마 엔트리 — 조건부 "devices" 필드 (platforms/errors 관례와 동일) ──

#[test]
fn schema_entry_includes_devices_when_declared() {
    let schema = devices_package().live_schema();
    let devices = schema["commands"][0]["devices"]
        .as_array()
        .expect("declared command records a devices array");
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0], "camera");
    assert_eq!(devices[1], "bluetooth");
    // 단순 문자열 배열 — 원소에 메타데이터 객체가 없다(YAGNI, 설계 B절).
    assert!(devices[0].is_string());
}

#[test]
fn schema_entry_omits_devices_when_undeclared() {
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .build();
    let schema = package.live_schema();
    // 선언 없는 명령 엔트리에 "devices" 키가 없어야 한다 — 기존 패키지의
    // schema.json/계약 해시 불변.
    assert!(
        schema["commands"][0].get("devices").is_none(),
        "undeclared command must not record a devices key: {}",
        schema["commands"][0]
    );
}

/// 계약 해시 불변 — `devices_meta_if(name, None)` 을 거친 패키지의 schema.json
/// 은 해당 호출 없이 빌드한 패키지와 바이트 단위로 동일하다(선언 없으면
/// 미기록 → register!/build! 체인이 늘 호출해도 무선언 패키지는 불변).
#[test]
fn devices_meta_if_none_keeps_schema_bytes_identical() {
    let builder = || {
        Package::builder("example.devices").command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
    };
    let with_call = builder().devices_meta_if("scan_tags", None).build();
    let without_call = builder().build();
    assert_eq!(
        with_call.generate_typescript().unwrap().schema_json,
        without_call.generate_typescript().unwrap().schema_json
    );
}
