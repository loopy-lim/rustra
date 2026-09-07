//! 플랫폼 상호운용 — 명령의 플랫폼 가용성을 표현하는 enum.
//!
//! 플랫폼 특화 명령(win32/objc2 호출 등)은 [`crate::PackageBuilder::command_platform`]
//! 로 선언한다. 설계 배경은 `docs/plans/2026-09-07-platform-interop-stabilization-design.md`
//! — 등록은 전 플랫폼에서 무조건 일어나므로 command_id·schema.json·계약 해시가
//! 플랫폼 무관하게 동일하고, 미지원 플랫폼에서의 호출은 `platform.unavailable`
//! 로 정확히 구분된다.

use serde::{Deserialize, Serialize};

/// 브리지 명령이 구현될 수 있는 대상 플랫폼.
///
/// 직렬화/schema.json 표기는 소문자(`"windows"`, `"macos"`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Android,
    Ios,
}

impl Platform {
    /// 알려진 전체 플랫폼 — 선언 순서가 schema.json `platforms` 배열의 정규 순서다.
    pub const ALL: [Platform; 5] = [
        Platform::Windows,
        Platform::Macos,
        Platform::Linux,
        Platform::Android,
        Platform::Ios,
    ];

    /// 소문자 표기 — schema.json `platforms` 항목과 동일 문자열.
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Macos => "macos",
            Platform::Linux => "linux",
            Platform::Android => "android",
            Platform::Ios => "ios",
        }
    }

    /// 컴파일 대상 플랫폼. `cfg!` 기반이라 런타임 비용은 없다.
    ///
    /// `None`은 브리지가 모르는 대상(예: wasm) — 플랫폼 선언 목록에 없는
    /// 플랫폼와 동일 취급(스텁 유지)한다.
    pub fn current() -> Option<Platform> {
        if cfg!(target_os = "windows") {
            Some(Platform::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Platform::Macos)
        } else if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else if cfg!(target_os = "android") {
            Some(Platform::Android)
        } else if cfg!(target_os = "ios") {
            Some(Platform::Ios)
        } else {
            None
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_str_roundtrip_matches_all() {
        // schema.json 표기와 as_str/serde 표기가 정확히 일치하는지 — 플랫폼 필드는
        // 이 문자열이 계약이 된다.
        for platform in Platform::ALL {
            assert_eq!(
                serde_json::to_string(&platform).unwrap(),
                format!("\"{}\"", platform.as_str()),
            );
        }
    }

    #[test]
    fn current_is_known_on_supported_targets() {
        // 이 테스트 스위트가 도는 대상(linux/macOS CI, 로컬 macOS)은 항상 알려진
        // 플랫폼이다. None은 wasm 등 미지원 대상에서만 정상이다.
        let current = Platform::current();
        if let Some(current) = current {
            assert!(Platform::ALL.contains(&current));
        }
    }
}
