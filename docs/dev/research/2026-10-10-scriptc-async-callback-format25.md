---
date: 2026-10-10
researcher: loop-worker (scriptc async/callback format 2–5 조사)
git_commit: 332a7be6 (scriptc CI 게이트·버전 핀 커밋)
topic: 'scriptc 표면의 async/이벤트/채널 심볼을 ffi_format 2–5로 표현하는 셈(shim) 조사'
status: research-complete
---

# scriptc async/callback — ffi_format 2–5 셈 조사

**결론: 표현 가능하다 — 그러나 기존 심볼로는 아니고, 계약 3개를 바꾼 `*_scriptc`
형제 심볼셋이 필요하다.** scriptc(0.2.1, 조사 시점 핀)의 ffi_format 2–5 계약은
Rust의 `extern "C" fn` + `*mut c_void` 모델과 정확히 같은 모양을 하되, rustra의
기존 async/event/channel 진입은 (1) 콜백에 소유 포인터를 주고 (2) 이벤트 콜백이
`C-unwind` ABI이며 (3) 취소 토큰을 out-파라미터로 내놓는다 — 셋 모두 scriptc 매니페
스트가 표현할 수 없는 것들이다. 셈은 "소유→차용, C-unwind→C, out-param→u64 반환"
의 세 가지이고 나머지는 그대로 매핑된다.

## 배경

`rustra codegen`의 scriptc 스테이지는 현재 sync caller-buffer envelope만 노출한다
(`rustra_ffi_invoke_json_into_len`). async 완료 콜백 4종, 이벤트 싱크 2종, 채널 4종은
`packages/cli/src/cli-generate-scriptc.ts`의 `scriptcExcludedSymbols`에서 사유와 함께
제외됐다 — "format 2+ callback descriptor", "format 5 foreign-thread contract"가 그
사유다. 이 문서는 그 제외가 셈으로 해소 가능한지를 scriptc 공식 FFI 문서
(scriptc.dev/ffi, 2026-10-10 확인)와 rustra 실제 시그니처를 맞대어 판정한다.

## format 사다리 (scriptc.dev/ffi 요약)

| format | 추가되는 것                                                                                                                                                                   | rustra 해당                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1      | 값 파라미터                                                                                                                                                                   | 현재 발행 표면 (sync invoke)                                      |
| 2      | call-scoped 콜백 함수 포인터 + context 엔트리 (`extern "C" fn` + `*mut c_void` 모델, 위치 명시)                                                                               | 콜백 모양 자체                                                    |
| 3      | 콜백 파라미터에 `cstring`/`string`/`bytes` — **네이티브 데이터를 트램펄린이 복사**, 클로저는 새 소유 스토리지 수령                                                            | 응답/이벤트 페이로드 전달                                         |
| 4      | `lifetime: "retained"` (동일 스레드) + 짝 release 바인딩 (`release: "<fn>:<id>"`)                                                                                             | event sink register/unregister 쌍                                 |
| 5      | `invoke: "foreign"` — retained + void 반환 + context 필수. 트램펄린은 스크립트 코드를 실행하지 않고 복사 후 이벤트 루프에 적재(FIFO, 루프 턴당 1전달), live 등록은 루프를 ref | Rust 워커 스레드에서 쏘는 모든 콜백                               |
| 6      | `f32`/`i8`/`u16`/`i16` + outbound `mutable-bytes`                                                                                                                             | (해당 없음 — caller-buffer envelope이 이미 format 6+ 요구로 해결) |
| 7      | `i64`/`u64`/`pointer` (bigint) — 직접 호출과 동일 스레드 콜백에서만; **foreign 콜백 파라미터에서는 거부**                                                                     | u32 핸들·u64 토큰                                                 |

## rustra 시그니처 vs format 5 계약

| 심볼                                          | 콜백 시그니처                                                                            | 판정                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rustra_ffi_invoke_json_async`                | `(*mut c_void user_data, *mut u8 ptr, usize len)` — **소유**, 호출자가 `rustra_ffi_free` | context 위치는 명시라 OK(`{context}` 엔트리). `ptr,len`은 `bytes` 클래스(`const uint8_t*, size_t`)와 ABI 동일하나 **소유 계약이 충돌** — scriptc는 트램펄린이 복사한 뒤 closure에 새 스토리지를 주므로 아무도 free하지 않아 호출마다 누수 |
| `rustra_ffi_event_sink_register`              | `(*mut c_void, name: *const c_char, payload: *const c_char)` — `extern "C-unwind"`       | `cstring` 2개는 format 3 클래스로 OK. 그러나 `C-unwind` 함수 포인터는 plain `extern "C"` 트램펄린과 타입이 다르고, scriptc는 경계를 넘는 풀기(unwind)를 금한다 — scriptc용으로는 `"C"` ABI 형제가 필요                                    |
| `rustra_ffi_channel_create`                   | `(*mut c_void, handle: u32, payload: *const c_char)` → `u32`                             | 가장 근접. u32 핸들 = 스칼라, cstring 페이로드 = format 3, u32 반환 = 직접 호출. 소유/ABI만 정리하면 바로 매핑                                                                                                                            |
| `rustra_ffi_channel_create_bytes`             | `(*mut c_void, handle: u32, payload: *const u8, payload_len: usize)` → `u32`             | `bytes` 클래스와 정확히 같은 모양 — 차용 수명만 문서화되면 무셈 매핑                                                                                                                                                                      |
| 취소: `rustra_ffi_invoke_cancel(u64) -> bool` | —                                                                                        | **이미 표현 가능** (format 7 직접 호출). 빠진 것은 async 진입의 `invocation_id: *mut u64` out-param뿐                                                                                                                                     |

## 셈 설계 — `*_scriptc` 형제 심볼셋

세 가지 계약 변경, 기존 심볼은 그대로(Node/RN 표면 유지):

1. **소유→차용**: `rustra_ffi_invoke_json_async_scriptc`는 Rust가 응답 버퍼를
   소유한 채 트램펄린을 호출하고, **트램펄린 반환 후 스스로 free**한다. scriptc의
   foreign 트램펄린은 호출 스레드에서 동기로 복사하고 즉시 반환하므로 복사 시점이
   보장된다 — 호출마다 누수가 없고 콜백 클로저는 복사본을 자유히 retain한다.
2. **C-unwind→C**: 이벤트 싱크의 scriptc 형제(`rustra_ffi_event_sink_register_scriptc`)
   콜백은 plain `extern "C"`. scriptc 트램펄린은 예외를 경계에서 0 반환으로 흡수하므로
   풀기가 경계를 넘지 않는다.
3. **out-param→u64 반환**: async 형제는 발급한 invocation 토큰을 **u64 반환**으로
   노출한다(format 7 직접 호출) — 기존 `rustra_ffi_invoke_cancel(u64) -> bool`에
   그대로 흘러들어간다. 채널 생성은 이미 u32 반환이라 변경 없음.

매니페스트 모양(코드젠이 쓸 형태, async 예시):

```json
{
  "ffi_format": 7,
  "functions": [
    {
      "name": "invokeJsonAsyncScriptc",
      "symbol": "rustra_ffi_invoke_json_async_scriptc",
      "params": [
        "bytes",
        {
          "callback": {
            "id": "onComplete",
            "params": [{ "context": "onComplete" }, "bytes"],
            "returns": "void",
            "lifetime": "retained",
            "invoke": "foreign"
          }
        },
        { "context": "onComplete" }
      ],
      "returns": "u64"
    }
  ]
}
```

이벤트 싱크는 `release` 참조가 있는 unregister 쌍으로, 채널은 u32 핸들 반환 +
`bytes` 콜백으로 같은 꼴이다. foreign 등록은 루프를 ref하므로 구독(이벤트·채널)이
프로세스를 살려두는 것은 의도된 동작이고, paired release가 내린다.

## 전달 시맨틱 — 문서에 명시할 것

- fire-and-forget FIFO: 전달은 최소 루프 턴 1회 지연, microtask·타이머와 얽힌다.
  실시간(오디오 DSP 등) 부적합을 명시한다.
- 콜백이 스스로 release 가능; 이미 적재된 전달은 핀 해제 전에 배수된다.
- 클로저 예외는 이벤트 루프 콜백 규칙을 따른다(미처리) — TS 앱이 오류를 소유한다.
- `bytes` 복사는 트램펄린에서 1회 — 대형 응답의 제로카피는 이 표면의 목표가 아니다
  (대형 구조는 resident 라우트/가이드 §12로 회피).

## 계단식 플랜 (게이트와 함께)

1. **Rust 형제 진입** — `rustra_ffi_invoke_json_async_scriptc` (차용 콜백, plain C,
   u64 토큰 반환). 게이트: borrow 시맨틱 단정 테스트(트램펄린 수신 바이트 == 응답
   전체, 반환 후 free 검증 — `ffi_concurrency.rs` 선례) + 누수 게이트(할당 카운트).
2. **코드젠 발행** — `cli-generate-scriptc`가 위 descriptor를 ffi_format 7 매니페스트
   와 시그니처-only 선언에 발행; `scriptcExcludedSymbols`에서 해소된 심볼 제거.
   게이트: cli 단위 테스트(cli-generate-scriptc.test.ts 선례) + 예제 재생성 산물 검사.
3. **예제·런타임 게이트** — calculator scriptc-app에 async 케이스 추가,
   `run.sh` 단정 확장(`test:runtime:scriptc`가 async 완료를 실증). 이벤트 싱크 형제가
   착지하면 이벤트 수신도 같은 게이트에 합류.
4. **채널** — `channel_create_bytes` 매핑(무셈에 가깝다) + run.sh 단정 확장.

## 리스크·비목표

- scriptc 0.2.x는 실험 단계다 — 핀(`SCRIPTC_VERSION=0.2.1`)을 올릴 때 descriptor
  스키마가 바뀌면 SC5xxx 진단으로 빌드가 크게 실패하고, CI의 `test:runtime:scriptc`
  게이트가 이를 잡는다. 매니페스트 발행기는 핀 버전과 함께 움직인다.
- 소유 포인터 반환은 scriptc 전체가 미지원("no owned pointer returns")이므로,
  owned 응답 경로(`rustra_ffi_invoke` 계열)의 scriptc 노출은 이 조사의 범위 밖이다 —
  caller-buffer/차용 셈이 정답이다.
- 전달 지연(루프 턴)은 핫 루프용이 아니라 완료·구독 통지용이다. 핫 루프는 기존
  sync envelope을 유지한다.
