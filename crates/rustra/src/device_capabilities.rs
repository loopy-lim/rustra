//! 디바이스 역량 계약 — 커맨드가 전제하는 디바이스 역량 토큰의 닫힌 카탈로그.
//!
//! 카메라·블루투스·위치 같은 역량은 platform 게이팅(`platforms` 필드)과 축이
//! 다르다 — 같은 OS 안에서도 역량 유무(데스크톱에 NFC 없음)와 권한 상태(사용자
//! 거부)가 갈린다. rustra는 "이 명령이 어떤 역량을 전제하는가"를 선언 표면으로만
//! 담고, OS 권한 요청은 호스트 앱 몫이다(W3C Permissions API조차 `request()`를
//! 표준에서 제거했다 — point-of-use 요청 원칙). 설계:
//! `docs/plans/2026-09-08-device-capabilities-design.md` A절.
//!
//! - 토큰은 `&'static str`, kebab-case. W3C PermissionName 이 있는 것은 그
//!   표기를 따르고(`camera`, `clipboard-read`, …), 없는 것은 rustra 명명
//!   (`wifi`, `photo-library`, …).
//! - 카탈로그는 **버전닝된 닫힌 집합** — 새 토큰 추가는 rustra 릴리스를
//!   수반하는 계약 진화다. 카탈로그 밖 토큰은 등록 시점에 패닉(loud-fail —
//!   오타 방지 동기는 타입화 에러 트랙과 동일).
//! - OS 세부 권한 문자열(Android `NEARBY_DEVICES` 재편, iOS plist 키, macOS
//!   entitlement)은 토큰 뒤에 숨는다 — 교차표는 문서로만 유지
//!   (platform-permissions.md). 스키마·코드젠·와이어는 토큰만 안다.

/// 디바이스 역량 토큰 — 닫힌 카탈로그의 원소를 나타내는 마커 타입.
///
/// [`PackageBuilder::command_devices`](crate::PackageBuilder::command_devices)
/// 빌더와 `#[command(device(...))]` 속성의 원재료다. 선언은 schema.json
/// `devices` 필드의 원천이며, 런타임 자동 게이팅은 하지 않는다 — 선언은
/// 계약 문서다(설계 B/F절).
///
/// [`DeviceCapability::new`] 는 값만 싣고 검증하지 않는다(const 문맥 구성을
/// 위해) — 카탈로그 검증은 등록 시점에 loud-fail 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeviceCapability {
    token: &'static str,
}

impl DeviceCapability {
    /// 역량 토큰으로 마커를 만든다 — 카탈로그 검증은 등록 시점
    /// (`command_devices`) 몫이다.
    pub const fn new(token: &'static str) -> Self {
        Self { token }
    }

    /// 카탈로그 전체 21종 — 앞 6종은 W3C PermissionName 표기, 나머지는 rustra
    /// 명명. 선언 순서가 문서 교차표 순서와 일치한다.
    pub const ALL: [DeviceCapability; 21] = [
        DeviceCapability::new("camera"),
        DeviceCapability::new("microphone"),
        DeviceCapability::new("geolocation"),
        DeviceCapability::new("notifications"),
        DeviceCapability::new("clipboard-read"),
        DeviceCapability::new("clipboard-write"),
        DeviceCapability::new("wifi"),
        DeviceCapability::new("bluetooth"),
        DeviceCapability::new("battery"),
        DeviceCapability::new("nfc"),
        DeviceCapability::new("biometric"),
        DeviceCapability::new("haptics"),
        DeviceCapability::new("flashlight"),
        DeviceCapability::new("contacts"),
        DeviceCapability::new("calendar"),
        DeviceCapability::new("photo-library"),
        DeviceCapability::new("motion"),
        DeviceCapability::new("usb"),
        DeviceCapability::new("serial"),
        DeviceCapability::new("network-state"),
        DeviceCapability::new("screen-brightness"),
    ];

    /// 토큰이 카탈로그 안에 있는지 — 등록 시점 loud-fail 검증에 쓴다.
    pub fn is_valid(token: &str) -> bool {
        Self::ALL.iter().any(|capability| capability.token == token)
    }

    /// 토큰 문자열 — schema.json `devices` 항목과 동일 표기.
    pub const fn as_str(&self) -> &'static str {
        self.token
    }
}

impl std::fmt::Display for DeviceCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_holds_21_unique_tokens() {
        // 설계 A절의 21종 — 중복 토큰이 섞이면 선언 중복 판정이 카탈로그
        // 자체에서 이미 깨지므로 닫힌 집합의 유일성을 고정한다.
        assert_eq!(DeviceCapability::ALL.len(), 21);
        for (index, capability) in DeviceCapability::ALL.iter().enumerate() {
            assert!(
                DeviceCapability::is_valid(capability.as_str()),
                "catalog token must validate itself: {}",
                capability.as_str()
            );
            assert!(
                !DeviceCapability::ALL[..index]
                    .iter()
                    .any(|prev| prev.as_str() == capability.as_str()),
                "duplicate token in catalog: {}",
                capability.as_str()
            );
        }
    }

    #[test]
    fn is_valid_rejects_unknown_tokens() {
        assert!(!DeviceCapability::is_valid(""));
        assert!(!DeviceCapability::is_valid("Camera"));
        assert!(!DeviceCapability::is_valid("camera "));
        assert!(!DeviceCapability::is_valid("nearby-devices"));
        assert!(!DeviceCapability::is_valid("clipboard_read"));
        // 밑줄 표기도 카탈로그 표기(kebab-case)와 다르므로 거부된다.
        assert!(!DeviceCapability::is_valid("photo_library"));
    }
}
