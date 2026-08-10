# 신뢰 테스트 강화 (Trust Test Hardening) — 설계

- **날짜**: 2026-08-11
- **상태**: 승인됨 (설계) → 구현 계획 진행 중
- **목표 문장**: "실제 사용자가 rustra-bridge를 믿고 쓴다"를 **테스트가 증명**하는 상태로 만든다.
- **접근법**: 단계적 하이브리드 (측정 → 수정 → 증명 → 강화)

---

## 1. 배경

세 영역(FFI·네이티브 경계 안전 / Rust↔TS 교차 와이어 호환 / TS 어댑터 에지·에러)에 대한 감사 결과, **단순 "테스트 부족"이 아니라 실제 결함(구현을 고쳐야만 하는 버그)** 이 다수 발견되었다. 따라서 테스트만 추가해서는 목표에 도달할 수 없으며, 결함 수정과 증명 테스트가 함께 필요하다.

코드 생성·proc macro 정확성은 이 설계의 **범위 외**이다(별도 작업).

---

## 2. 발견된 결함 (Defects)

| ID  | 결함                                                                                                                                                                  | 심각도  | 위치                                                                                                                | 유형      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| F1  | 패닉이 호스트 프로세스를 abort 시킨다. `catch_unwind`이 전무하여 핸들러 패닉이 `extern "C"` 경계를 넘어 unwind → abort                                                | 🔴 치명 | `crates/rustra/src/ffi.rs`, `examples/calculator/src/lib.rs` (`.expect()` 7곳: 577, 764, 821, 877, 949, 1003, 1045) | 결함      |
| F2  | `rustra_ffi_free` double-free / wrong-len 이 UB. 가드·테스트 전무                                                                                                     | 🔴      | `ffi.rs:263`                                                                                                        | 결함      |
| F3  | RN/Lynx JSON 엔진이 `Promise<T>` 계약 위반. `try/catch` 없어 sync throw로 새어나감 → `.catch()`로 못 잡음                                                             | 🔴      | `packages/react-native/src/index.ts:34`, `packages/lynx/src/index.ts:84`                                            | 결함      |
| F4  | 에러 클래스 불일치. Node/Bun/Tauri는 `RustraCommandError(.code)`, RN/Lynx는 plain `Error`(코드 유실). `createRkyvV2Engine` 내부에서도 unknown-command만 plain `Error` | 🟠      | 5개 어댑터 + `packages/types/src/index.ts:381`                                                                      | 결함      |
| F5  | contract hash가 런타임에 한 번도 검증 안 됨. `GENERATED_CONTRACT_HASH` 생성만 되고 소비 0 → 스키마 드리프트 조용히 통과                                               | 🟠      | `packages/cli/src/generate.ts:91`, 모든 어댑터                                                                      | 결함      |
| F6  | Rust↔TS 교차 와이어 round-trip이 전무. Rust↔Rust, TS↔TS만. TS static codec 테스트는 stub codec 사용. 양쪽 진실 일치를 증명할 인프라 자체가 없음                       | 🟠      | 테스트 인프라 부재                                                                                                  | 인프라    |
| F7  | postcard 필드 순서 드리프트 위험. schemars(알파벳순) vs postcard(선언순)가 수작업 컨벤션으로만 유지                                                                   | 🟡      | `packages/cli/src/generate.ts:132`, `examples/calculator/src/lib.rs:69`                                             | 잠재 결함 |
| F8  | `rustra_ffi_get_schema`만 `out_len` null 체크 누락 (형제 함수 172/200/234와 불일치)                                                                                   | 🟡      | `ffi.rs:280`                                                                                                        | 결함      |

> i64 정밀도(2^53/2^32 초과), 세 번째 postcard 구현인 C++ JSI codec 미검증 등 추가 항목은 Phase 3에서 다룬다.

---

## 3. 접근법: 단계적 하이브리드

```
Phase 0 (기준선 측정) → Phase 1 (결함 수정) → Phase 2 (교차 호환 증명) → Phase 3 (깊이 강화)
```

각 phase는 독립적으로 가치를 남긴다. 중간에 멈춰도 "측정만이라도 됨" / "치명 결함만이라도 제거됨" 등 부분 가치가 보존된다.

### Phase 0 — 기준선 측정 (Measure)

**목표**: 현재 상태를 테스트로 고정한다. 결함은 **명시적 failing/ignored 테스트**로 가시화하여 "알고 있는 깨진 것"과 "모르는 것"을 구분한다.

**산출물**:

- Rust `tests/trust_baseline_*.rs`: F1(패닉 → abort 예상), F2(free UB 예상), F8(null 체크) 등을 `#[ignore]` 또는 예상-실패 형태로 명시
- TS `*.test.ts` 확장: F3(sync throw), F4(에러 클래스), F5(contract 미검증)를 현재 동작으로 고정 + `todo`/xfail 표시

**끝나면 알 수 있는 것**: 정확히 어디가, 몇 건이 깨졌는지 정량 목록.

### Phase 1 — 결함 수정 (Fix)

**목표**: xFail 표시된 결함을 고치고, 각 xFail을 통과 테스트로 전환한다. 우선순위 순으로 진행한다.

**수정 대상 (P0 → P2)**:

- **P0-F1**: `ffi.rs` dispatch 경로 + `examples/calculator` FFI 엔트리에 `catch_unwind` 추가 → 패닉을 `RustraError::internal`로 변환. `panic=unwind` 유지 전제.
- **P0-F3**: RN/Lynx JSON 엔진 본문을 async 래핑 + `try/catch` → 모든 실패 경로를 rejected `Promise<RustraCommandError>`로 정규화.
- **P1-F2**: `rustra_ffi_free` debug_assert 가드(double-free / wrong-len). `# Safety` 문서화 + 계약 테스트.
- **P1-F4**: 에러 클래스 통일. 모든 어댑터 + `createRkyvV2Engine` unknown-command 경로를 `RustraCommandError(code, message)`로 정규화.
- **P1-F5**: contract hash 런타임 검증 추가. engine 생성 시 hash 주입 옵션 + 불일치 시 명확한 에러.
- **P2-F8**: `rustra_ffi_get_schema`에 `out_len` null 체크 추가 (형제 함수와 일치).

**끝나면 알 수 있는 것**: 치명적 결함 제거됨. 호스트 크래시 / 계약 위반 / 에러 유실 없음.

### Phase 2 — 교차 호환 증명 (Prove)

**목표**: F6 인프라를 구축하고, Rust가 만든 바이트를 TS 실제 codec이 온전히 round-trip 함(그 역방향도)을 증명한다.

**Fixture 인프라 (snapshot 방식)**:

1. Rust 테스트가 calculator의 각 command encode 결과(성공 Tier1/2, Tier3, 에러 프레임)를 **hex 문자열**로 출력
2. checked-in 상수로 TS 테스트에 저장 (`packages/types/test-fixtures/` 또는 `generated/__wire_fixtures__`)
3. Rust snapshot 테스트: "현재 encode 결과 == checked-in hex" 검증 → 드리프트 즉시 포착
4. TS 테스트: checked-in hex를 바이트로 복원 → **실제 생성된 codec**(`addNumbersCodec` 등)으로 decode → 값 일치 단언

**교차 검증 대상**: 성공(원시/String/Vec/중첩/enum-with-data/Option), 에러 프레임, 잘린 페이로드, unknown id, large i64. **세 구현(Rust/TS/C++)을 같은 fixture로 한 번에 검증** — C++ JSI codec도 포함.

**끝나면 알 수 있는 것**: 양쪽(세쪽) 진실의 일치가 기계적으로 증명됨.

### Phase 3 — 깊이 강화 (Harden)

**목표**: 모서리 케이스까지 견고함을 증명한다.

**산출물**:

- proptest 확장: i64 전체 범위(2^53/2^32 초과 포함), 유니코드, 중첩 컨테이너
- 동시성: `extern "C"` 심보 다중 스레드, TS 동시 invoke 순서/재진입
- large payload(>1MiB), zero-len payload, malformed 응답
- 동시 `invokeBatch` 에러 전파
- 필드 순서 자동 검증(F7): 비-알파벳순 struct로 드리프트 감지 테스트

---

## 4. 범위 경계

**포함**:

- `crates/rustra` core (ffi, rkyv_codec, lib, renderer_host)
- `examples/calculator` (FFI 템플릿 코드 — 사용자가 복사해 쓰므로 신뢰 직결)
- C++ JSI codec (세 번째 postcard 구현, 같은 fixture로 교차 검증)
- 5개 TS 어댑터 + `packages/types` 공유 엔진

**비포함**:

- proc macro / codegen 정확성 (별도 작업)
- Phase B RendererHost 네이티브 구현 (아직 Rust 측 unsafe 코드 없음 — 별도 phase에서 재감사)

---

## 5. 성공 기준

1. Phase 0 끝: 결함 목록이 모두 테스트로 표현됨 (pass/fail/ignore 명시).
2. Phase 1 끝: 모든 결함 테스트가 녹색. F1(패닉) 테스트는 호스트 abort 없이 clean error 반환을 증명.
3. Phase 2 끝: checked-in fixture 기반 Rust↔TS↔C++ 교차 round-trip이 녹색. fixture 드리프트 시 Rust snapshot 테스트가 실패.
4. Phase 3 끝: proptest/동시성/large/malformed가 녹색. i64 전체 범위 round-trip 증명.

---

## 6. 리스크/메모

- F1 `catch_unwind` 추가는 성능 오버헤드(~µs)가 있으나 패닉 경로에만 해당. fast-path(정상) 영향 무시 가능.
- F5 contract 검증은 engine API 시그니처 변경 동반 — 하위 호환 옵션으로(default: 검증 안 함, opt-in) 도입 검토.
- fixture snapshot 방식은 "Rust encode가 바뀌면 fixture 갱신 필요" — CI에서 snapshot 일관성 검사로 자동화.
