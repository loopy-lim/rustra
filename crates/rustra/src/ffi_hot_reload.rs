// ── 핫 리로드 주입 (A2, experimental) ───────────────────────────────────────
//
// 실험적 표면 — versioning-policy의 experimental 규칙 적용 (계약은 1.0 전
// 언제든 깨질 수 있다). 각 항목은 기존 명령 이름에 대응하며 `Package::replace()`
// 의미론을 따른다: command_id 보존 + live_schema 캐시 무효화 + 세대 진행.
// 새 명령 등록은 이 표면의 계약이 아니므로 이름이 없으면 loud 리포트(조용한
// 스킵 아님)로 건너뛴다.
//
// blob 형식: postcard 직렬화된 `Vec<(String, String)>` — (명령 이름, 와이어
// 서명 hex). 와이어 서명은 `command_wire_signature` (스키마 항목 JSON의
// SHA-256 hex — 계약 해시와 같은 해시 함수, 항목 빌더 단일 소스)이며, blob의
// 해시가 라이브 명령과 다른 항목은 건너뛰고 리포트에 남긴다 — 스키마가 다른
// 핸들러로 런타임 와이어를 깨는 것을 막는 게 이 표면의 존재 이유다.

/// 핫 리로드 주입 결과 — JSON으로 직렬화되어 호스트에 돌아간다.
///
/// - `ok`: 호출 자체의 성공(블롭 해석 + 적용 루프). false면 `error`가 기존
///   에러 코드 사다리의 문자열(`registry.frozen`, `ffi.not_registered`,
///   `command.invalid_args: …`)을 가진다.
/// - `applied` / `skipped`: 교체 경로를 밟은 항목 수 / 건너뛴 항목 목록.
///   스킵은 loud다 — 이름과 사유(기존 에러 코드 재사용: `command.not_found`,
///   `signature.mismatch`)와 가능하면 라이브 서명을 돌려준다.
/// - `schemaGeneration`: 적용이 있었으면 최종 세대 스냅샷, 없으면 null —
///   진행 중 컨텍스트가 `rustra_ffi_schema_generation` 과 대조할 수 있다.
#[derive(Debug, Clone, serde::Serialize)]
struct HotReloadReport {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    applied: Option<u32>,
    skipped: Vec<HotReloadSkip>,
    #[serde(rename = "schemaGeneration")]
    schema_generation: Option<u64>,
}

/// 리포트의 스킵 항목 — 사유는 기존 에러 코드 사다리를 재사용한다.
#[derive(Debug, Clone, serde::Serialize)]
struct HotReloadSkip {
    name: String,
    reason: &'static str,
    /// `signature.mismatch` 때만 채움 — 라이브 명령의 현재 와이어 서명.
    #[serde(skip_serializing_if = "Option::is_none")]
    actual: Option<String>,
}

impl HotReloadReport {
    fn error_frame(code: &'static str, message: impl std::fmt::Display) -> Self {
        Self {
            ok: false,
            error: Some(format!("{code}: {message}")),
            applied: None,
            skipped: Vec::new(),
            schema_generation: None,
        }
    }
}

/// 핫 리로드 코어 — FFI 심볼과 (테스트에서) 로컬 패키지 양쪽에서 쓴다.
///
/// 잠금 규율: 항목별로 read lock(서명 조회) → `replace_runtime_route`(자체
/// write lock)를 반복한다. 전체 루프를 write lock 하나로 감싸면 서명 계산
/// (스키마 항목 직렬화+해시)도 lock 안에서 돌아 레지스트리를 길게 붙잡게
/// 된다. 항목 사이에 다른 mutation이 끼어도 각 항목의 적용은 여전히 원자적이다
/// — `replace_runtime_route` 가 자체 재검사를 가지기 때문이다.
fn run_hot_reload(package: Option<&Package>, blob: &[u8]) -> HotReloadReport {
    let Some(pkg) = package else {
        return HotReloadReport::error_frame(
            "ffi.not_registered",
            "package not registered; call register_ffi first",
        );
    };
    // 동결 1차 거부 — 동결된 엔진에 주입은 계약 위반이다. freeze는 락과
    // 직렬화해 publish 되므로 이 검사와 개별 교체 사이에 동결이 끼어도
    // 교체 쪽 재검사(`registry.frozen`)가 막는다.
    if pkg.is_frozen() {
        return HotReloadReport::error_frame(
            "registry.frozen",
            "package is frozen; runtime mutation disabled",
        );
    }
    let entries: Vec<(String, String)> = match postcard::from_bytes(blob) {
        Ok(entries) => entries,
        Err(error) => {
            return HotReloadReport::error_frame(
                "command.invalid_args",
                format!("hot reload blob decode: {error}"),
            );
        }
    };

    let mut applied = 0u32;
    let mut skipped = Vec::new();
    for (name, expected) in entries {
        // read lock으로 라이브 서명만 조회하고 즉시 놓는다 — 교체는 전용
        // 경로의 write lock이 담당한다.
        let live_signature = {
            let state = pkg
                .state
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .commands
                .get(&name)
                .map(|command| command_wire_signature(&name, command))
        };
        let Some(live_signature) = live_signature else {
            skipped.push(HotReloadSkip {
                name,
                reason: "command.not_found",
                actual: None,
            });
            continue;
        };
        if live_signature != expected {
            skipped.push(HotReloadSkip {
                name,
                reason: "signature.mismatch",
                actual: Some(live_signature),
            });
            continue;
        }
        match pkg.replace_runtime_route(&name, &expected) {
            // 경합에서 패정(동결/삭제/서명 변경)된 항목도 조용히 applied에
            // 넣지 않는다 — loud 리포트로 되돌린다.
            Ok(()) => applied += 1,
            Err(error) => skipped.push(HotReloadSkip {
                name,
                reason: error.code(),
                actual: None,
            }),
        }
    }

    let schema_generation = (applied > 0).then(|| pkg.schema_generation());
    HotReloadReport {
        ok: true,
        error: None,
        applied: Some(applied),
        skipped,
        schema_generation,
    }
}

/// 핫 리로드 주입. 각 항목은 기존 명령 이름에 대응하며 `Package::replace()`
/// 의미론을 따른다 — 일치 항목은 command_id를 유지한 채 교체 경로로 넘어가고
/// 라이브 스키마가 재계산된다. 실험적 표면 — versioning-policy의 experimental
/// 규칙 적용.
///
/// blob은 postcard 직렬화된 (이름, 와이어 서명 hex) 목록이다. 서명 불일치·
/// 미등록 이름 항목은 건너뛰되 리포트에 포함된다(loud — 조용한 스킵 아님).
///
/// 반환 버퍼는 JSON 리포트(`HotReloadReport` 참조)이며 `rustra_ffi_free` 로
/// 해제한다. `registry` 인자는 초기화된 엔진이다 — 코어 FFI 관례에 따라
/// 전역 컨텍스트(`register_ffi` 로 등록)를 쓴다.
///
/// # Safety
///
/// `handlers_blob` must point to at least `len` readable bytes.
/// `out_len` must be a valid, non-null write pointer. Caller must free the
/// returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_hot_reload(
    handlers_blob: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if handlers_blob.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let blob = unsafe { std::slice::from_raw_parts(handlers_blob, len) };
    let report = run_hot_reload(get_package(), blob);
    let json = serde_json::to_vec(&report).unwrap_or_else(|_| {
        // 직렬화는 문자열/숫자/bool 필드뿐이라 실패할 수 없다 — 방어적 폴백.
        br#"{"ok":false,"error":"internal: report serialization failed","applied":null,"skipped":[],"schemaGeneration":null}"#
            .to_vec()
    });
    alloc_response(json, out_len)
}
