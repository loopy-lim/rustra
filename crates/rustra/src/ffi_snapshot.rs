// Standard inspector snapshot FFI (B1) — scattered FFI entries를 하나의
// 스냅샷 모델로 재조립한다. 새 직렬화 형식을 만들지 않는다: contractHash 는
// `rustra_ffi_contract_hash`, schemaGeneration 은 `rustra_ffi_schema_generation`,
// commands/limits/stats 는 레지스트리·한도·이벤트 버스의 기존 내부를 읽어
// 하나의 serde_json blob 으로 조립한다.
//
// # experimental
//
// 이 FFI 와 스냅샷 blob 형태는 **experimental** 이다(docs/versioning-policy.md
// 실험 표면 표 참조) — 필드 추가는 하위호환으로 취급되지만, 형태 변경은
// 예고 없이 깨질 수 있다.
//
// NOTE: include! 로 ffi.rs 모듈에 붙는 파일이라 `use super::*` 를 쓰지 않는다
// — crate root 의 `Result` 별칭이 glob 로 유입되면 std Result 를 기대하는 기존
// include 파일들(ffi_dispatch 등)이 깨진다. 필요한 이름은 ffi.rs 스코프와
// crate root 경로로만 참조한다.

/// 스냅샷의 명령 한 줄 — wire 타입이 아니라 덤프 전용 표현.
#[derive(serde::Serialize)]
struct SnapshotCommand {
    id: u16,
    name: String,
    /// `required_capability` — 없으면 null.
    capability: Option<&'static str>,
}

/// `Package` 에서 스냅샷 JSON을 조립한다(FFI 진입과 테스트 None 경로가 공유).
///
/// 기존 내부의 단일 판독 경로:
/// - contractHash — `generated_contract_hash()` (generation 미포함 입력 해시,
///   `rustra_ffi_contract_hash` 와 동일 값)
/// - schemaGeneration — `schema_generation()` (`rustra_ffi_schema_generation` 과
///   동일 값)
/// - commands — 레지스트리 명령의 (command_id, name, required_capability)
/// - limits — 현재 페이로드 한도 (`rustra_ffi_get_max_payload` 과 동일 값)
/// - stats — 기존 카운터만: 등록 명령 수, 부여된 capability, 이벤트 버스
///   대기/드랍 누적. 새 계측기를 만들지 않는다.
fn assemble_snapshot(package: Option<&Package>) -> crate::Value {
    let Some(pkg) = package else {
        // 미등록 — get_schema 의 `{}` 폴백과 같은 온건한 degenerate 계약.
        return crate::json!({
            "packageId": crate::Value::Null,
            "contractHash": crate::Value::Null,
            "schemaGeneration": crate::Value::Null,
            "commands": [],
            "limits": { "maxPayloadBytes": max_payload_bytes() },
            "stats": {
                "registeredCommands": 0,
                "grantedCapabilities": [],
                "pendingEvents": 0,
                "droppedEvents": 0,
            },
        });
    };

    // read lock 1회로 commands/stats 를 함께 판독한다.
    let state = pkg
        .state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let commands: Vec<SnapshotCommand> = state
        .commands
        .iter()
        .map(|(name, command)| SnapshotCommand {
            id: command.command_id,
            name: name.clone(),
            capability: command.required_capability,
        })
        .collect();
    let registered = commands.len() as u64;
    let granted: Vec<String> = state.granted_capabilities.iter().cloned().collect();
    drop(state);

    // contractHash / schemaGeneration 은 기존 공개 메서드로 판독해
    // `rustra_ffi_contract_hash` / `rustra_ffi_schema_generation` 심벌과
    // 같은 입력·같은 알고리즘임을 구조적으로 보장한다.
    crate::json!({
        "packageId": pkg.id,
        "contractHash": pkg.generated_contract_hash(),
        "schemaGeneration": pkg.schema_generation(),
        "commands": commands,
        "limits": { "maxPayloadBytes": max_payload_bytes() },
        "stats": {
            "registeredCommands": registered,
            "grantedCapabilities": granted,
            "pendingEvents": pkg.event_bus().pending_len() as u64,
            "droppedEvents": pkg.event_bus().dropped_count(),
        },
    })
}

/// (B1, experimental) 현재 FFI 패키지의 표준 인스펙터 스냅샷을 JSON 바이트로
/// 반환한다. 산포된 스키마/한도/레지스트리 FFI 를 하나의 덤프 모델로 재조립한
/// 것 — 새 직렬화 형식이 아니라 기존 내부의 단일 조립 지점이다.
///
/// blob 필드:
/// - `packageId` — 등록된 패키지 id (미등록이면 null)
/// - `contractHash` — `rustra_ffi_contract_hash` 와 동일 값 (미등록 null)
/// - `schemaGeneration` — `rustra_ffi_schema_generation` 과 동일 값 (미등록 null)
/// - `commands` — `{id, name, capability}` 배열 (capability 는 null 또는 이름)
/// - `limits` — `{maxPayloadBytes}` (`rustra_ffi_get_max_payload` 과 동일 값)
/// - `stats` — `{registeredCommands, grantedCapabilities, pendingEvents, droppedEvents}`
///
/// 반환 버퍼는 `rustra_ffi_get_schema` 와 같은 8바이트 헤더 allocation 이므로
/// `rustra_ffi_free` 로 해제한다. 패키지가 미등록이면 null 계약 JSON을 반환한다
/// (null 포인터가 아니다 — 덤프 도구가 미등록 상태를 값으로 구분할 수 있게).
///
/// # Safety
///
/// `out_len` must be a valid, non-null write pointer. Caller must free the
/// returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_capture_snapshot(out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let snapshot = assemble_snapshot(get_package());
    let json = serde_json::to_vec(&snapshot).unwrap_or_else(|_| b"{}".to_vec());
    alloc_response(json, out_len)
}

#[cfg(test)]
#[path = "ffi_snapshot_tests.rs"]
mod snapshot_tests;
