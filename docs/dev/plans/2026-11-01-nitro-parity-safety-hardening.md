# Nitro 파리티 안전성 강화 계획

> 원 요청: "nitro만큼의 안전성을 가지고 있지 않은 것 같다. nitro를 참고해 안전성 확보를 모두 진행." (2026-11-01, 추가 지시 5건 포함)
> 기준 리비전: `d5d3ba87` (main, clean). 커밋·푸시는 이번 범위가 아니다 — 검증된 변경은 워킹 트리에 남긴다.

## Goal

nitro(margelo/nitro, `e91b20f7` 조사 기준)의 안전 기둥과 rustra의 실측 상태를 대조해 확인된 갭을 닫는다. rustra는 이미 nitro가 없는 fuzz/Miri/ASan·LSan/레지스트리 감사를 갖고 있다(역방향 우위 — 유지). 이번 계획은 nitro가 갖고 rustra가 없거나 약한 항목 + 사용자가 지정한 5건을 닫는다.

## 갭 분석 (nitro 기둥 ↔ rustra 실측 ↔ 결정)

| nitro 기둥                                                   | rustra 실측 (HEAD d5d3ba87)                                                                                                                                                                                                                                                                                                                                             | 결정                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PR 게이트 크로스플랫폼 CI 매트릭스                           | ci.yml gate 15잡 집계, 모바일 에뮬레이터 스모크 포함. 단 miri/sanitizer/fuzz는 주간+릴리스 전용 — PR에서 안 뜸                                                                                                                                                                                                                                                          | **T10** PR(path-filtered) 트리거 + gate 집계에 편입                                     |
| 샌티저 1급 시민 (iOS ASan+**TSan**, Android ASan)            | ASan+LSan(Rust debug/release) 있으나 **TSan 전무**. C++ 어댑터 표면은 소형 foreign-exception harness만 커버 — 대상 파일: `packages/react-native/native/cpp/RustraJSIBridge.cpp`(2,550줄), 생성 C++ 코덱(예: `examples/react-native-calculator/modules/rustra-jsi/generated/rustra-generated-codecs.cpp` 2,384줄), 코덱 테스트(`test-rustra-generated-codecs.cpp` 998줄) | **T7** tsan.yml 신설, **T8** C++ ASan+LSan+UBSan 통합(커버 범위는 T8 정의 참조)         |
| 코드젠 신선도(크로스 OS diff 게이트)                         | check-codegen-fresh 게이트 게이트블로킹. 크로스 OS 검증 없음(Windows 러너 미검증 — 후속 제안으로 분리, 이번 범위 아님)                                                                                                                                                                                                                                                  | 유지, 후속 기록                                                                         |
| 오류 형식 보장 (errors.test.ts — 3언어 동일 형식)            | 엔진 경계 tier2Outcome 정규화는 있으나 생성 코덱 자체가 bare `Error`(오프셋 없음), RN 생명주기 오류 plain Error                                                                                                                                                                                                                                                         | **T2** 코덱 오류 형식화+오프셋, **T3** RN 생명주기 구조화 코드                          |
| 정적 타입 경계 (틀린 구현은 컴파일 실패)                     | 생성 commands.ts는 타입 파라미터로 정적 경계를 만들지만, 그 경계를 검증하는 부정 컴파일 테스트 없음                                                                                                                                                                                                                                                                     | **T9** `@ts-expect-error` 정적 경계 픽스처                                              |
| 메모리 안전 실증 (55k 할당 GC 압력 테스트)                   | Rust: Miri/ASan 소유권 검증 완료(M0). JS 런타임 대규모 스트레스는 scriptc stress만 존재 — 후속 제안으로 분리                                                                                                                                                                                                                                                            | 유지, 후속 기록                                                                         |
| 릴리스 무결성 (OIDC 신뢰 퍼블리싱, 체크섬 매니페스트)        | SHA 고정 게이트+레지스트리 감사+provenance 있음. npm OIDC 전환은 npm 설정 필요(문서화만 가능)                                                                                                                                                                                                                                                                           | **T12** 릴리스 절차 문서화                                                              |
| 포맷/린트 멱등성                                             | prettier --check / cargo fmt --check 존재                                                                                                                                                                                                                                                                                                                               | 유지                                                                                    |
| 린트 엄격성 (`--max-warnings 0`, `noUncheckedIndexedAccess`) | eslint warn 실패 안 함, 타입체크 규칙 없음, tsconfig strict-only, Rust workspace lints 없음                                                                                                                                                                                                                                                                             | **T4** Rust lints, **T5** TS 플래그+eslint                                              |
| 워크플로 자체 검증 (actionlint)                              | actionlint 전무                                                                                                                                                                                                                                                                                                                                                         | **T6** gate 잡 선행 단계                                                                |
| 런타임 버전 합의 (NitroModules.version === package.json)     | contract-hash 게이트가 동일 역할(contract.mismatch fail-fast)                                                                                                                                                                                                                                                                                                           | 커버됨 — 작업 없음                                                                      |
| 작성자 규칙 문서 (Dispatcher, sync-vs-async)                 | async#[command]/events/channels 존재하나 "무거운 작업은 JS 스레드에서 비켜라" author 규칙 문서 없음                                                                                                                                                                                                                                                                     | **T11** author-rules 문서 EN/KO                                                         |
| 실기기 검증                                                  | iOS 시뮬레이터/Android 에뮬레이터 CI 스모크까지. 실기기는 수동 체크리스트(compatibility-matrix 명시)                                                                                                                                                                                                                                                                    | **환경 한계**: 실기기 없음 — 문서 상태 유지·명확화만(T12). BLOCKED 아님: 원래 수동 영역 |

## 공통 제약

- 공개 ABI/wire/계약 유지. 생성물은 코드젠으로 재생성(수동 편집 금지).
- Linux 단일 환경 검증. CI 원격 실행·Windows·실기기는 push 후 미검증으로 기록(저장소 선례: M0 계획 Ruling).
- deny/multiple-versions 는 gtk 계열 중복의 의도적 warn — 유지. wildcards 만 정책 정리.
- TDD 기본 아님. 회귀 위경계에만 테스트 추가.
- **태스크는 순서대로 수행한다**(공유 파일: ci.yml gate — T6 먼저, T10 나중; docs/gate-map.md — T7·T10·T12 순차; threat-model — T10(#6)·T12(#5)). T4(Rust)와 T5(TS)는 파일 소유권이 분리되어 병렬 가능. api-surface 스냅샷은 런타임 export를 검사하므로 T5의 타입플래그와 무관하고, T3(오류 코드 추가) 뒤에만 재생성한다.

## 수락 기준 (관찰 가능한 조건)

| AC    | 관찰 가능한 완료 조건                                                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | `fuzz` 워크스페이스 컴파일이 green이고, invoke_frame 타깃이 `panic in handler`로 정규화되는 오류를 만나면 libfuzzer 크래시로 승격(assert)한다 — 복제된 가드가 complex 타깃과 동일 계약임이 코드로 확인된다                                                                               |
| AC-2  | 생성된 frame-codecs의 디코드 실패 오류 메시지가 `offset N`을 포함한 고정 형식이고, tier2 정규화 결과의 error.message에서 실제 오프셋이 추출된다(테스트로 확인)                                                                                                                           |
| AC-3  | RN bootstrap 실패·`getRustraNative()` 미설치가 `code`를 가진 `RustraCommandError`로 throw되고, 기존 `catch (Error)` 소비 코드는 그대로 동작한다(테스트로 확인)                                                                                                                           |
| AC-4  | `cargo clippy --all-targets -- -D warnings`가 green이고, naming·macros 크레이트에서 unsafe는 컴파일 에러, 코어의 무보호 unwrap/expect는 clippy 에러가 된다                                                                                                                               |
| AC-5  | tsconfig.base에 nitro급 플래그가 켜져 전 패키지 `bun run build`가 green이고, `bun run lint`가 타입체크 규칙으로 `--max-warnings 0`에서 green이다                                                                                                                                         |
| AC-6  | gate 잡이 워크플로 전수 actionlint를 통과해야 성공하고, deny.toml wildcards 정책이 주석과 실제 동작이 일치한다                                                                                                                                                                           |
| AC-7  | tsan.yml이 sanitizer.yml과 동급(workflow_call+candidate_sha·주간 스케줄·receipt artifact)으로 존재하고 release 발행이 tsan 성공을 요구한다                                                                                                                                               |
| AC-8  | 위협 모델 open gap 목록·게이트맵·릴리스 절차·호환성 매트릭스의 검증 범위 문장이 실제 게이트와 일치한다(`test:docs` green)                                                                                                                                                                |
| AC-9  | 생성 C++ 코덱 테스트 3바이너리(tgen/tcodec/tsync)와 foreign-exception harness가 CI에서 ASan+LSan+UBSan으로 실행된다. RustraJSIBridge.cpp(2,550줄)는 Linux 빌드 가능성을 실측하고 불가하면 그 이유(folly/JSI 실헤더 의존)와 함께 후속으로 명시된다 — 전체 C++ 표면 커버를 선언하지 않는다 |
| AC-10 | `tsc -p examples/calculator`가 잘못된 타입 사용을 담은 `@ts-expect-error` 픽스처를 컴파일로 검증하고, 런타임 테스트 러너 글롭에는 잡음을 만들지 않는다                                                                                                                                   |
| AC-11 | crates/fuzz/safety 경로 변경 PR에서 miri·sanitizer·fuzz가 gate 집계(18잡)로 필수가 된다. docs 전용 PR은 설계된 skip만 허용된다                                                                                                                                                           |
| AC-12 | author 규칙 문서(EN/KO)가 실제 기능만 근거로 기술되고 docs-gate를 통과한다                                                                                                                                                                                                               |

## Tasks

### T1 — Frame fast-path 퍼즈 panic 가드 (AC-1)

**Files:** `fuzz/fuzz_targets/invoke_frame.rs`
**Interfaces:** complex 타깃과 동일한 `deny_panic_guard(result)` — `panic in handler` 정규화 오류를 libfuzzer 크래시로 승격.

- [x] invoke_frame 타깃에 가드 부착(complex_value.rs 패턴 복제, 근거 주석)
- [x] 검증: fuzz 워크스페이스 cargo check green + cargo-fuzz nightly 스모크 45초 11,147,569회 실행 무크래시

### T2 — 생성 코덱 디코드 오류 형식화 (AC-2)

**Files:** `packages/cli/src/codegen-postcard-{primitive,wide,text}.ts` 및 렌더러(코덱 템플릿), 재생성된 `examples/*/generated/frame-codecs.ts`, `packages/cli/src/generate.test.ts`
**Interfaces:** 런타임 계약 — 디코드 실패 오류 메시지가 `rustra: <what> out of bounds (offset <N>)` 형식을 갖는다. tier2Outcome의 `DECODE_OFFSET_HINT` 정규식이 실제 오프셋을 추출한다(전체 길이 fallback 아님). 생성 파일은 import 추가 없이 메시지 형식만 강화(standalone 유지).

- [x] 템플릿 헬퍼가 offset 포함 고정 형식을 throw(postcard-primitive/wide/text — encode 입력검증 오류는 접두사 없음 유지)
- [x] 7개 예제 생성물 재생성 후 codegen-fresh green
- [x] 회귀: cli generate.test 45 pass, examples 신규 codec-error-format.test(offset 9 단언), types/types·examples 전체 green

### T3 — RN 생명주기 오류 구조화 (AC-3)

**Files:** `packages/types/src/errors.ts`(코드 레지스트리), `packages/react-native/src/react-native-core.ts:176,247`, 각 패키지 테스트, `api-surface/snapshot.json`
**Interfaces:** bootstrap 실패·네이티브 미설치가 `RustraCommandError`(code: `bootstrap.failed` / `native.not_installed`, JS-only 코드 — `contract.mismatch` 선례)로 throw. catch 호환성: Error 확 subclass라 기존 catch 유지.

- [x] 코드 등록(error-codes-sync 스코프 밖 목록 포함) + throw 교체 + 메시지 보존
- [x] bun test types 311 pass / react-native 89 pass + api-surface --update 후 green

### T4 — Rust workspace lints (AC-4)

**Files:** 루트 `Cargo.toml`(`[workspace.lints]`), `crates/{rustra-naming,rustra-macros}/src/lib.rs`, crates/rustra 소스의 허용 주석
**Interfaces:** naming·macros 크레이트 `#![forbid(unsafe_code)]`(unsafe 0 확인 후), rustra 코어 `clippy::unwrap_used/expect_used = "deny"` — 경계에서 정당한 곳은 `#[allow] + 근거 주석`. 실측: 비테스트 unwrap 41 / expect 28.

- [x] forbid/deny 적용, 전 위반 정리(신뢰 경계 30곳 실제 오류 전파 전환 + 17곳 근거 allow + 테스트 스코프 allow — 위임 완료 보고)
- [x] 검증: clippy -D warnings / fmt --check / cargo test 3크레이트 452 pass / api-surface green. G3 독립 리뷰가 스크래치 레플리카로 lints arming 실증 + 전환 30곳 전수 대조(전부 unreachable 경로) 확인

### T5 — TS 정적 강화 (AC-5)

**Files:** `tsconfig.base.json`, `packages/types/tsconfig.json`(base extends 전환), `eslint.config.js`(type-checked 전환), 루트 `package.json`(lint 스크립트 `--max-warnings 0`), 위반 정리
**Interfaces:** nitro tsconfig 파리티 — `noUncheckedIndexedAccess, noImplicitReturns, noImplicitOverride, noFallthroughCasesInSwitch, forceConsistentCasingInFileNames` 추가. 프로브: types 3건. `exactOptionalPropertyTypes`(nitro도 미사용)·`noUnusedLocals`(예제 잡음) 제외.

- [x] 플래그 5종 활성 + 패키지 tsc 261건·예제 107건 전부 수리(indexed access 수정은 런타임 변화 — test:packages:check green으로 보존 확인)
- [x] eslint type-checked 전환 + no-floating-promises 1,831건 void 코덱모드 정리 + `--max-warnings 0` green(스코프 오프 블록: cli 14규칙·react-native-core 2규칙 — 제거 조건 명시)
- [x] 검증: 전 패키지 tsc 18프로젝트 0 error / `bun run lint` exit 0 / bun run build·test:packages:check·test:fast·test:api-surface 전부 0

### T6 — gate actionlint + deny.toml 정합 (AC-6)

**Files:** `.github/workflows/ci.yml`(gate 잡), `deny.toml`
**Interfaces:** gate 잡이 ci-gate.sh 집계 전에 고정 버전 actionlint으로 워크플로 전수 검사 — 신규 필수 잡 추가 없음(ci-gate 15목록 불변). deny.toml wildcards: 로컬 cargo-deny 실측 후 `"deny"` 승격(위반 의존성이 있으면 핀으로 정리) 또는 주석을 실제 정책으로 교정.

- [x] gate 잡 actionlint 단계(v1.7.12 핀) + check-test-list-parity 라이브 게이트 ts-checks 편입(로컬 green 실측)
- [x] deny.toml wildcards=deny 승격 + rustra-macros dev-dep workspace 상속 전환 → bans ok, clippy/check green

### T7 — TSan 워크플로 (AC-7)

**Files:** `.github/workflows/tsan.yml`(신설), `release.yml`(재사용 게이트 추가), `scripts/check-release-gates.mjs`(+test 기본 목록), `docs/gate-map.md`
**Interfaces:** sanitizer.yml 구조 복제 — nightly `-Zsanitizer=thread`, `-p rustra --lib`(ffi_pool·events 스레드 경로), workflow_call+candidate_sha, 주간 스케줄, 로그 artifact. 릴리스 기본 게이트 목록에 tsan 추가.

- [x] tsan.yml 작성(-Z build-std 필수 — 미계측 std는 뮤텍스 엣지를 숨겨 오탐, 로컬 실증) + release.yml needs 확장 + DEFAULT_WORKFLOWS 편입
- [x] 검증: 로컬 TSan build-std 227 lib 테스트 경고 0 green + check-release-gates 12/12 + actionlint. 부수 발견: nightly 1.101.0부터 사전컴파일 std×-Zsanitizer가 하드 에러 — sanitizer.yml에 allow-mismatch 플래그 복원(로컬 ASan 227 green)

### T8 — C++ 어댑터 ASan+LSan+UBSan 통합 (AC-9) [지시 #1]

**Files:** `examples/react-native-calculator/modules/rustra-jsi/ios/run-cpp-codec-tests.sh`(sanitizer 플래그 환경변수), `.github/workflows/sanitizer.yml`(cpp-codec job 신설)
**Interfaces:** 커버 대상은 Linux에서 JSI shim으로 빌드 가능한 3바이너리다 — 생성 C++ 코덱 교차 테스트(`test-rustra-generated-codecs.cpp` 998줄 + `rustra-generated-codecs.cpp` 2,384줄), 저수준 Writer/Reader(`test-rustra-codec.cpp`), sync core(`test-rustra-sync-core.cpp`). `RUSTRA_CPP_SANITIZERS=address,undefined`(ASan Linux 빌드는 LSan 포함)로 실행. `RustraJSIBridge.cpp`(2,550줄)는 `<folly/dynamic.h>`·`<jsi/jsi.h>` 실제 헤더를 요구하므로 Linux 빌드 가능성을 실측하고, 헤더 확보가 비현실적이면 기기/Xcode 빌드 영역(기존 수동 체크리스트)으로 후속 명시한다 — 전체 C++ 표면 커버 선언 금지.

- [x] 스크립트에 sanitizer 환경변수 지원 추가, 로컬 ASan+UBSan 3바이너리 green 실측 완료
- [x] RustraJSIBridge.cpp Linux 빌드 실측 — `<folly/dynamic.h>`·`<jsi/jsi.h>`(ReactCommon 벤더 헤더) 필요 + 예제 node_modules 부재로 standalone Linux 빌드는 별도 harness 프로젝트 규모. 기기/Xcode 빌드 영역(기존 수동 체크리스트)으로 후속 명시
- [x] sanitizer.yml cpp-codec job 반영 + actionlint

### T9 — 생성 TS 정적 경계 부정 테스트 (AC-10) [지시 #2]

**Files:** `examples/calculator/ts/static-boundary.test-d.ts`(신설)
**Interfaces:** `@ts-expect-error`로 잘못된 필드 타입/초과 프로퍼티/반환 타입 오용 3~5건 픽스처. 검증은 오직 `tsc -p examples/calculator/tsconfig.json`(test:fast·test:ts:node에 이미 배선) — 파일명을 `.test-d.ts`로 해 런타임 러너 글롭(`*.test.js`/`*.test.ts`)에서 의도적으로 **제외**된다(제외가 설계다 — 노출시키지 말 것). 픽스처는 런타임에 아무것도 실행하지 않는다.

- [x] 픽스처 작성(5건 부정) + examples tsc green + 러너 글롭 미포함 확인

### T10 — 안전 워크플로의 PR 필수화 (AC-11) [지시 #5]

**Files:** `miri.yml`/`sanitizer.yml`/`fuzz.yml`(pull_request 트리거 + paths 필터), `ci.yml`(gate needs 확장), `scripts/ci-gate.sh`(+test, 15→18), `docs/gate-map.md`, 위협 모델 open gap #6 갱신
**Interfaces:** crates/fuzz/scripts-safety 경로 변경 PR에서 miri/sanitizer/fuzz가 PR 잡으로 실행되고 gate가 집계한다. docs 전용 PR은 paths-filter로 skip 허용(모바일 4잡 선례). 브랜치 프로텍션은 `gate` 하나만 required면 충분(사용자 측 설정 확인 항목으로 문서화).

- [x] 구현 방식 확정: safety 워크플로에 pull_request 트리거를 추가하지 않고 ci.yml이 reusable workflow 호출 잡(miri/sanitizer/fuzz)으로 gate 집계 — 이중 실행 없이 paths 필터 계약(changes.code) 재사용
- [x] ci-gate 15→18 확장(filter_skippable 동일 조건) + ci-gate.test.ts 19 pass + 18-인자 green 실측 + actionlint

### T11 — 작성자 규칙 문서 (AC-12) [지시 #4]

**Files:** `docs/library-author-rules.md` + `.ko.md`, `docs/` 허브 링크
**Interfaces:** nitro Dispatcher/sync-vs-async에 상응하는 rustra author 규칙 — 무거운 작업은 async #[command], JS 스레드 블로킹 금지, 폴링 대신 events/channels(pollMs는 레거시 대응책), 얕은 취소·retryable 계약, capability 기본 허용 경고. 실제 기능 근거만 기술(docs-gate 바이트 비교 통과).

- [x] EN/KO 작성(8개 규칙 + 근거 표) + docs-gate green(80개 문서 쌍 정합)

### T12 — 문서·릴리스 정합 (AC-8) [지시 #3 반영]

**Files:** `docs/threat-model.md`(+ko), `docs/release-procedure.md`(+ko), `docs/gate-map.md`, `docs/compatibility-matrix.md`(+ko)
**Interfaces:** 위협 모델 stale 항목 수정(npm 어드바이저리는 2026-08-18부터 ts-checks 게이트 — open gap #5 제거, #6은 T10으로 해소), npm OIDC 신뢰 퍼블리싱 전환 절차 기록(npm 설정은 사용자 작업으로 명시), 실기기 검증 범위 문장 명확화 유지.

- [x] 문서 갱신(threat-model open gap 재번호·TSan/cpp-codec 반영, gate-map 19잡·actionlint, release-procedure TSan 게이트·npm OIDC 후속 기록) + `bun run test:docs` 37 pass

## AC ↔ Task ↔ 검증

| AC    | Task | 검증(V) | 명령/방법                                                                                   |
| ----- | ---- | ------- | ------------------------------------------------------------------------------------------- |
| AC-1  | T1   | V1      | fuzz ws cargo check (+cargo-fuzz 스모크 가능 시)                                            |
| AC-2  | T2   | V2      | `bun run build:cli && bun run test:codegen-fresh:check`, types/types 테스트                 |
| AC-3  | T3   | V3      | `bun run --cwd packages/types test`, `--cwd packages/react-native test`, `test:api-surface` |
| AC-4  | T4   | V4      | clippy -D warnings, fmt check, `cargo test -p rustra`                                       |
| AC-5  | T5   | V5      | 전 패키지 tsc, `bun run lint`, 영향 bun test                                                |
| AC-6  | T6   | V6      | actionlint 전수, cargo-deny bans, ci-gate.test.ts                                           |
| AC-7  | T7   | V7      | 로컬 TSan 실측 or BLOCKED 기록, check-release-gates.test.mjs                                |
| AC-8  | T12  | V8      | `bun run test:docs`                                                                         |
| AC-9  | T8   | V9      | 로컬 clang sanitizer 런 로그                                                                |
| AC-10 | T9   | V10     | tsc -p examples/calculator (expect-error 픽스처 포함) + node --test                         |
| AC-11 | T10  | V11     | ci-gate.test.ts(18잡), actionlint                                                           |
| AC-12 | T11  | V12     | `bun run test:docs`                                                                         |

## 미해결·후속 분리

- Windows 크로스 OS 코드젠 결정론 CI (nitro run-nitrogen.yml 파리티) — 검증 환경 부재로 후속.
- JS 런타임 대규모 메모리 스트레스(55k 스타일) — 어댑터 레벨 설계 필요, 후속.
- npm OIDC 신뢰 퍼블리싱 실전 전환 — npm 레지스트리 설정(사용자 작업).
- 브랜치 프로텍션 required check 확인 — GitHub 설정(사용자 작업, T10 문서화).
- 실기기 RN 검증 — 수동 체크리스트 유지(환경에 기기 없음).
- packages/cli type-checked 린트 부채 — eslint.config.js 스코프 오프 14규칙(실측 811건), 제거 조건 명시. 같은 조건으로 react-native-core.ts 2규칙.
- noUncheckedIndexedAccess 로컬 오버라이드 — packages/cli·examples/react-native-bare-calculator(생성물 89+18건), 위반 정리 시 제거.
- 예제 tsconfig 7종(auth·calculator·crud·reference-app·rn-experiment·streaming·tauri-calculator)이 tsconfig.base.json 을 상속하지 않아 nitro 파리티 플래그가 예제 프로젝트에 미적용 — 코드젠 렌더러가 플래그 클린해지면 상속 전환이 후속.
- RustraJSIBridge.cpp(2,550줄) sanitizer 커버 — folly/jsi 헤더 의존으로 Linux standalone 불가 실측. gate-map·threat-model에 수동 영역으로 기록됨.
