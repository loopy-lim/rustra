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

/// Dev Tier C절 — debug 빌드는 카탈로그 밖 토큰을 경고와 함께 수용한다
/// (프로토타이핑). 선언은 스키마 devices 로 흐르고 doctor 가 릴리스 벽이 된다.
#[test]
#[cfg(debug_assertions)]
fn command_devices_accepts_unknown_token_in_debug_builds() {
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .command_devices("scan_tags", &[DeviceCapability::new("nfc-legacy-reader")])
        .build();
    // read 락은 live_schema() (write 락 시도) 전에 반납한다 — 잡은 채 호출하면
    // 자기 자신과 교착한다.
    {
        let state = package
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(
            state.commands.get("scan_tags").unwrap().device_requirements[0].as_str(),
            "nfc-legacy-reader"
        );
    }
    // 카탈로그는 ALL 그대로 — 미지 토큰이 카탈로그에 섞이지 않는다.
    let schema = package.live_schema();
    assert_eq!(
        schema["deviceCapabilities"]
            .as_array()
            .expect("catalog recorded")
            .len(),
        21
    );
    assert_eq!(schema["commands"][0]["devices"][0], "nfc-legacy-reader");
}

/// 릴리스 빌드 벽 — 카탈로그 밖 토큰은 등록 시점 패닉(doctor 검사와 이중).
#[test]
#[cfg(not(debug_assertions))]
#[should_panic(expected = "unknown device capability 'camra'")]
fn command_devices_panics_on_catalog_outside_token() {
    // "camra" — 오타. 릴리스 빌드는 loud-fail(타입화 에러 트랙과 같은 동기).
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

// ── 카탈로그 단일소싱 — 최상위 deviceCapabilities (Dev Tier B절) ──

/// 선언이 있으면 카탈로그 전체(ALL)가 최상위에 기록된다 — CLI 가 이 필드를
/// 단일 소싱해 수동 미러 없이 정렬·검증한다.
#[test]
fn schema_records_device_catalog_when_declared() {
    let schema = devices_package().live_schema();
    let catalog = schema["deviceCapabilities"]
        .as_array()
        .expect("declared package records the catalog");
    assert_eq!(catalog.len(), 21);
    assert_eq!(catalog[0], "camera");
    assert!(catalog.iter().any(|token| token == "bluetooth"));
}

/// 선언이 없으면 미기록 — 기존 패키지의 schema.json/계약 해시 불변(events 관례).
#[test]
fn schema_omits_device_catalog_when_undeclared() {
    let package = Package::builder("example.devices")
        .command("scan_tags", |input: serde_json::Value| {
            Ok::<_, RustraError>(input)
        })
        .build();
    let schema = package.live_schema();
    assert!(
        schema.get("deviceCapabilities").is_none(),
        "undeclared package must not record a catalog: {}",
        schema
    );
}
