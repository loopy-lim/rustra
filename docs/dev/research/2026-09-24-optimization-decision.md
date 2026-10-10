---
date: 2026-09-24
researcher: loop-worker (decide)
git_commit: 58e1835e (작업 트리 기준, 미커밋 병렬 작업 제외)
topic: '비동기 잔여 격차·대형 트리 echo 개선 후보 선정 및 구현 범위 확정'
status: decision-complete
---

# 개선 후보 선정 결정

[후보 도출 문서](2026-09-24-async-and-echo-candidates.md)의 후보 A1·A2·E1·E2·E3 가운데 **구현 후보 2개(비동기 1·트리 echo 1)를 선정**하고, 나머지를 측정 플랜 문서화 대상 또는 조사 항목으로 분류한다. 이 문서는 결정만 포함하며 새 구현·측정을 하지 않는다. 구현·검증은 후속 워커가 이 문서의 범위로 수행한다.

## 1. 선정 기준과 진단 결과 반영

- **최우선 기준 — 로컬(호스트/Hermes) 검증 가능성.** 채택 판단이 호스트/Hermes 검증만으로 가능한 후보만 구현 후보로 선정한다. 채택 판정 자체가 실기기 A/B를 요구하는 후보는 구현 후보가 아니라 **측정 플랜 문서화 대상**으로 분류한다. 실기기 A/B는 이번 범위 밖이며, 채택 절차는 [이름 재사용 선례](2026-09-16-nitro-call-profile.md)(capability 마커 + 호스트/Hermes 검증 + AB/BA 측정 플랜 문서화)를 따른다.
- **진단 워커 결과 반영.** 진단 결과에 따라 iOS resident 8,191·버퍼 순서 효과의 원인 확정은 core-only 프로파일/GC 관측이 선행되어야 하므로 후보에서 제외하고 조사 항목으로 분리한다(후보 문서 4절 마지막 항과 동일). 이는 E1·A2 선정에 영향을 주지 않는다 — 두 후보 모두 해당 관측과 무관한 경로(응답 전송 소유권, JS 필드 라우트 조회)를 다룬다.

## 2. 선정 결과 요약

| 후보                                                       | 트랙      | 분류                               | 판단 근거                                                                                                                                                          |
| ---------------------------------------------------------- | --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A2** 필드 명령 라우트 세대 캐시 클로저 emit              | 비동기    | **구현 후보 (선정)**               | 순수 JS 변경. 조회·문자열 비교 제거 효과를 호스트/Hermes 마이크로벤치로 직접 확인 가능 — 실기기 없이 채택 판단 가능                                                |
| **A1** 네이티브 resolved-Promise 직결 진입                 | 비동기    | 측정 플랜 문서화 대상 (미선정)     | 후보 문서 자체가 채택 판정을 iOS AB/BA 5쌍 + Android v2 5회로 정의. Hermes 검증은 정확성·타이밍 계약이지 성능 채택 근거가 아님                                     |
| **E1** 큰 응답 probe-cache 2-FFI 왕복 제거(owned 핸드오프) | 트리 echo | **구현 후보 (선정)**               | 제거 대상이 결정적 메모리 통과(복사·비교·zero-fill·FFI 1회)라 환경 불변. C++/Rust/Hermes 계약 검증 + 호스트 할당·벤치 증거로 채택 판단 가능(이름 재사용 선례 준용) |
| **E2** 대형 요청 Writer 성장 재할당 축소                   | 트리 echo | 미선정 — E1 착지 후 후속 묶음 후보 | 효과 0.2–0.4%로 후보 문서가 단독 채택 기준 아님을 명시. 트리 echo 후보 1개 제한 내 E1이 우선                                                                       |
| **E3** C++ 숫자 시퀀스 벌크 경로                           | 트리 echo | 조사 항목 (계측 선행)              | 효과 미확정, 후보 문서가 "계측 결과 미미하면 즉시 기각"을 전제. 인라이닝 흡수 가능성을 호스트 계측으로 먼저 확인해야 함                                            |
| iOS resident 8,191·버퍼 순서 효과 원인                     | —         | 조사 항목 (프로파일/GC 관측 선행)  | 진단 워커 결과에 따른 제외                                                                                                                                         |

A1은 A2 착지 후의 상위 후보로 남는다(A2가 A1의 폴백 기반이 됨). A1의 AB/BA 측정 플랜은 [후보 문서 2절 A1](2026-09-24-async-and-echo-candidates.md)에 이미 정의되어 있으므로 이 문서에서 재정의하지 않는다.

## 3. 구현 후보 1 — A2: 필드 명령 라우트 세대 캐시 클로저 emit

**내용.** 필드 경로 생성 명령(`parityIndexed` 등)이 매 호출 `invokeFields`에서 라우트 배열 조회 + `route.command === command` 문자열 비교 + fieldCount 재확인을 반복하는 것을, `createGeneratedFields2`의 세대 정수 비교 패턴을 일반 필드 명령 emit에 적용해 "세대 비교 1회 + 캡처 클로저"로 줄인다. [기각된 closure 결합 선례](2026-09-16-nitro-parity-followup.md)와 달리 클로저 수를 줄이지 않아 재설정 후 호출 수 변화가 없다.

**구현 위치(파일).**

- `packages/types/src/global-fields.ts` — 1-필드용 팩토리 `createGeneratedFields1` 추가(104행 `createGeneratedFields2` 패턴 준용: `routeGeneration` 비교 + `resolveGeneratedFieldsSync` 재해결 + `invokeRoute` 캡처). 기존 `invokeGeneratedFields1..3`(70–102행)은 옵션 있음·폴백 경로로 유지.
- `packages/cli/src/generate-commands.ts` — 120행·194행의 emit 분기에서 1-필드 명령을 `createGeneratedFields1`로 emit(현재 2-필드만 팩토리, 1·3-필드는 `invokeGeneratedFieldsN` 헬퍼).
- `examples/react-native-calculator/generated/commands.ts` 및 bare RN 예제 생성물 — 동일 CLI로 재생성(122–123행 `parityIndexed`가 emit 변경 대상의 실례).

**검증 방법(로컬).**

1. `packages/types` 회귀: `bind-sync.test.ts`, `invoke-loose.test.ts`, `runtime-boundaries.test.ts` 통과 + 세대 무효화 케이스 추가(엔진 재구성 후 라우트 재해결, lazy `ensureConfigured` 경로, `options` 존재 시 기존 `invokeGenerated` 경로 유지, route null 폴백).
2. `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check` 및 `--bindings` — 재생성 일관성.
3. `run-hermes-sync-tests.sh` Hermes 스위트 — 네이티브 경로 무변경 확인(공개 경로 무회귀).
4. **채택 근거(호스트)**: 옵션 없는 생성 필드 명령 1종(예: `parityIndexed`)에 대해 emit 변경 전후를 호스트/Hermes 마이크로벤치로 비교해 호출당 조회·문자열 비교 제거를 확인한다. 동시에 호출 수 불변을 검증해 closure 선례 기각 사유와 구분한다. 기기 AB/BA 플랜은 후보 문서 A2 절의 플랜을 문서화만 수행한다.

**롤백 전략.** ABI·네이티브·capability 마커가 없는 순수 JS+코드젠 변경이다. 단일 커밋 `git revert` 후 동일 CLI로 생성물을 재생성하고 codegen check로 원복을 확인한다. 런타임 분기 잔여물이 없어 부분 롤백 지점도 필요 없다.

## 4. 구현 후보 2 — E1: 큰 응답 owned 응답 핸드오프(probe-cache 2-FFI 왕복 제거)

**내용.** 동기 tail의 512B 스택 버퍼 초과 응답에 대해 현재 (i) Rust가 응답을 probe 캐시에 저장(요청 전체 복사) → (ii) C++가 `largeBuf.resize()`(zero-fill 포함) → (iii) 2차 FFI에서 요청 전체 비교 후 응답 memcpy인 왕복을, 비동기 경로가 이미 쓰는 owned 응답 계약(`owned=1` + 정확한 (ptr, len) free 짝)으로 제거한다. 직렬화 패스(`to_slice` 우선, `serialized_size`+`to_extend` 폴백)와 핸들러 1회 실행 보장은 그대로 둔다 — [postcard bounded heap 기각](2026-09-16-nitro-parity-followup.md)과 무관하다.

**구현 위치(파일).**

- `packages/react-native/native/cpp/RustraJSIBridge.cpp` — `typedInvokeTail`(282–337행)의 large 폴백 분기(308–317행)를 owned 진입 사용으로 교체. free 짝 계약은 동일 파일 1596–1660행 비동기 owned 콜백과 `rustra_ffi_free_owned_bytes`(2175행)의 선례를 재사용한다.
- `crates/rustra/src/command_into.rs` — 44–80행의 `DirectResponse::Buffered(response)` 생산은 유지하고, 이 Vec의 소유권을 caller에 넘기는 owned 반환 계약으로 연결.
- `crates/rustra/src/ffi_typed_buffer.rs`·`ffi_buffer_entries.rs` — 신규 owned 응답 FFI 진입(응답 Vec → (ptr, len, owned=1) 핸드오프). 62–98행 probe 캐시는 구형 코어/진입 부재 폴백으로 유지.
- **capability 마커**: 이름 재사용 선례(`RUSTRA_GENERATED_BOUND_CODEC_CONTEXT`, `packages/cli/src/generate-cpp-hpp.ts` emit) 준용 — 신규 진입은 코어 함수 테이블의 옵셔널 엔트리(null 검사)로 노출하고, 마커·진입 부재 시 기존 probe 경로로 컴파일·동작하는 폴백을 유지한다.

**검증 방법(로컬).**

1. `cargo test -p rustra` — owned 계약 검사 추가: free 짝이 정확히 (ptr, resp_len)로 1회 불릴 것, 핸들러 1회 실행, 오류 프레임·malformed 응답의 기존 예외 메시지 보존, 폴백 경로(진입 부재)에서 probe 캐시 동작 유지.
2. `cargo bench -p rustra --bench tree_route` 교대 A/B(독립 프로세스, [codec-scratch 프로토콜](2026-09-16-codec-scratch-and-frame.md) 준용) — 소형 응답 무회귀.
3. `run-cpp-codec-tests.sh` — 대형 응답 소유권·free 짝·에러 프레임 케이스 추가.
4. `run-hermes-sync-tests.sh` Hermes 스위트 — 공개 경로 무회귀 + 구형 헤더/코어 폴백 검증.
5. AddressSanitizer 실행(소유권·이중 free).
6. **채택 근거(호스트)**: [소형 맵 코덱 대조군 프로토콜](2026-09-16-nitro-parity-followup.md) 준용 — 실제 Hermes에서 대형 응답(8,191노드급) 경로 전후를 독립 프로세스로 비교하고 wire 바이트 동일성을 대조한다. 호스트 할당 카운트(`codec_allocations` 패턴)로 호출당 통과 바이트·할당 횟수 감소를 확인한다. 기기 AB/BA 플랜(이름 재사용 선례의 iOS 5쌍 + Android v2 5회)은 문서화만 수행한다.

**롤백 전략.** 신규 경로는 마커·옵셔널 진입으로 게이트되고 기존 probe 경로를 폴백으로 유지하므로, 롤백은 (1) C++ 소비 측의 신규 진입 사용 분기 제거, (2) Rust 신규 진입 미등록(테이블 null) 또는 제거, (3) 단일 커밋 revert 후 1–5번 검증 재실행의 3단계로 나뉜다. probe 캐시 코드가 폴백으로 남아 있어 revert 시 소유권 계약 전환이 없고, owned 프레임은 기존 `free_owned_bytes` 짝으로 정리되므로 롤백 시점에 누수 분기가 없다.

## 5. 범위 밖 확인

- 실기기 A/B 측정(채택 판정의 최종 기기 수치) — 플랜 문서화만 수행.
- A1 구현, E2 단독 구현, E3 벌크화 — 각 절의 분류대로 후속.
- resident DFS 본체·iOS 8,191 resident 배치 가설·버퍼 순서 효과 원인 — 프로파일/GC 관측 선행 조사 항목(후보 문서 4절과 진단 결과에 따름).
- wire v3·zero-copy 디코드·fixture 알고리즘 변경·JSI handle 캐시·ABI 일괄 교체 — 기존 비후보 규정 유지.

## 재현

이 문서는 결정만 포함하므로 새 실행은 없다. 인용 근거의 원본 재현은 [후보 문서의 재현 절차](2026-09-24-async-and-echo-candidates.md)를 따른다.
