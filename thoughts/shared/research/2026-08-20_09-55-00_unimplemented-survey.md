---
date: 2026-08-20T09:55:00+09:00
researcher: loopy-lim
git_commit: d9215a4e7f463088bddb92b6a0d4027cccabc162
branch: main
repository: loopy-lim/rustra
topic: "구현되지 않은 부분 전수조사 (미구현 마커 + 문서-코드 갭 + 공개 API 갭)"
tags: [research, codebase, unimplemented, codegen, rkyv-v2, api-docs, onboarding]
status: complete
last_updated: 2026-08-20
last_updated_by: loopy-lim
---

# 리서치: 구현되지 않은 부분 전수조사 (미구현 마커 + 문서-코드 갭 + 공개 API 갭)

**날짜**: 2026-08-20T09:55:00+09:00
**연구자**: loopy-lim
**Git Commit**: d9215a4e7f463088bddb92b6a0d4027cccabc162
**Branch**: main (Lynx 제거 PR #16 병합 직후)
**Repository**: loopy-lim/rustra

## 연구 질문

"현재 구현이 안 되어 있는 부분이 너무 많다. 모든 부분을 체크하고 구현할 수 있도록 도와달라" — 3개 병렬 조사(코드 마커 전수조사 / 문서-코드 갭 / 공개 API 대비 구현 누락)로 전수조사.

## 요약

총 **26건**의 실질 미구현/결함을 확인했다. 크게 5개 범주:

1. **HIGH 결함 2건**: ① CLI rkyv 코드젠이 미지원 필드(`Option<T>`/`Vec<String>`/enum/map)를 **경고 없이 삭제**해 crud 예제 등에서 와이어 프레임 붕괴(잠복 결함, CI 미커버). ② `docs/rust-api-guide.md`의 26%(27건 중 7건)가 실제 매크로 시그니처와 불일치 — 문서대로 작성하면 컴파일 실패.
2. **의도적 유예(성능) 2건**: FFI caller-buffer fastpath(L), 코드젠 positional facade(M).
3. **부분 구현(동작하나 제한) 6건**: 취소 전파 JS 코덱 경로 한정, tier-3 `getLiveSchema` 조용한 빈 Map, invokeTypedBatch 취소 없음, rkyv V2 Rust Tier 3 JSON 폴백, RSS 측정 macOS 한정, Node transport 부재로 "5분 온보딩" 끊김.
4. **DX/문서 정합성 10건**: 호환성 매트릭스 문서 부재, `@rustra/react` 훅 사용 예제 0건, `--cpp-output` 미문서화, init 템플릿 버전 `^0.1.1` 고정(실제 0.1.3), compatibility-contract.md RN 서술 스테일, security-audit.md의 runner/ 참조, 마스터플랜 진척 표 스테일, docs/README.md 목록 누락, lynx dist 잔여물, RN B1 체크리스트 23항목 미폐쇄.
5. **고아 추상/잔여물 5건**: `RendererHost` trait 참조 구현 없음(Lynx 제거 잔해), F5 `contractHash` JSI 미노출(JSI 브릿지에 getContractHash 없음 → 항상 throw), `invokeAsync(payload,onDone)` 선언만 존재, `allOf`/integer enum 코드젠 미지원, auth/streaming `generated/` 스테일.

**긍정 발견**: `#[ignore]`/skip 테스트 0건, 프로덕션 `unimplemented!()` 0건, tauri feature 정상 컴파일, CLI 전 커맨드 동작, RN JSI 브릿지 핵심 메서드 전부 구현. 과거 계획(production-hardening 4트랙, follow-up 1/2/3, JSI 최적화, PR #14)은 완료노트가 성실하게 유지됨.

## 상세 분석

### 1. HIGH — 실제 동작 결함

#### 1-1. CLI rkyv 코드젠: 미지원 필드 무음 삭제 → 와이어 붕괴 (2개 조사 모두 확인)

- 근원: `packages/cli/src/generate.ts:165-184` `classifyPostcardField()`가 `array<string>`/`array<$ref>`/`anyOf(Item,null)`/`type:["string","null"]` 등에 `null` 반환
- 스킵 지점: `packages/cli/src/generate.ts:204` (optional 필드 무조건 `continue`), `:206` (`if (!kind) continue;` — 경고/에러 없음)
- 증상 (커밋된 생성물):
  - `examples/crud/generated/rkyv-codecs.ts:287` — `getItem` decode가 `result: {} as GetItemOutput` (item 필드 소실)
  - `examples/crud/generated/rkyv-codecs.ts:318` — `listItems` decode가 `{} as ListItemsOutput` (items 배열 통째로 소실)
  - `examples/crud/generated/rkyv-codecs.ts:325-332` — `updateItem` **요청** 인코딩이 `id`만 (optional name/value 삭제 → Rust postcard 디코드 시 EOF/오독)
- 구조 문제: 깨진 코덱이 `examples/crud/generated/rkyv-registry.ts:7`에 등록되어 엔진의 Tier 3 JSON 폴백(`packages/types/src/index.ts:780-795`, 코덱 미등록 시에만 동작)을 선점
- 잠복 이유: crud 테스트는 mockEngine(JSON)만 사용해 와이어 미경유. calculator 예제는 integer/bool/string/$ref만 사용
- 완료 조건 후보: (a) 라운드트립 불가 명령을 레지스트리에서 **제외** + 생성 경고(엔진 폴백이 처리 — 비용 최소), (b) `Option<T>`/`Vec<T>` postcard 와이어 구현, (c) 분류 실패 시 생성 에러. 권장: (a)

#### 1-2. rust-api-guide.md 26% 허위 (실제 cargo check로 검증)

| # | 문서 주장 | 실제 동작 | 비고 |
|---|---|---|---|
| A1 | 스칼라 멀티파라미터 `fn add(a: i64, b: i64)` 자동 래핑 (§2-1, 사용 예 9곳) | `#[command] supports at most one input data parameter` 컴파일 에러 | 신규 사용자 첫 예제부터 실패 |
| A2 | bare 반환 `-> i64` / unit 반환 생략 (§2-3) | `must return Result<O>` 에러 | 3가지 반환 패턴 중 2개 허위 |
| A3 | `#[bridge(rename_all = "...")]` 오버라이드 (§3) | attr 인자 무시 → `cannot find attribute 'bridge'` | `crates/rustra-macros/src/lib.rs:387` `_attr` 폐기 |
| A4 | `.generate_to(dir)` / `PackageBuilder::register` / `rustra::build()` 함수 (§4-5) | 전부 부재. 실제: `generate_typescript()?.write_to_dir()`, `command_fn()`, `build!` **매크로** | 문서 부록 예제(:596-627) 컴파일 불가 |
| A5 | 0-파라미터 커맨드 컴파일 에러 (§2-5, 역방향) | 실제로 `fn ping() -> Result<()>` 정상 | 문서가 실제보다 제한적 |

- 역방향(구현됐으나 문서 누락): `emit`/`set_event_sink` 이벤트 버스, FFI 전체, `grant_capability`, `alias_command_id`, `schema_version`, freeze, `tauri_support`
- 완료 조건: 가이드를 현재 매크로 시그니처에 맞게 재작성. (A1/A2는 매크로 확장 구현이 아니라 문서 수정이 정답 — 매크로는 의도적으로 단일 입력만 허용)

### 2. 의도적 유예 — 성능 후속 (계획 문서에 "별도 플랜" 명시)

- **A1 caller-buffer fastpath**: `docs/plans/2026-08-18-perf-close-nitro-gap.md` Task 7 + `docs/benchmarks.md:90`. Rust malloc→복사→JS memcpy 3중 복사 제거. 규모 L. 성능 이미 1.3x로 "충분히 좋음" 평가 — 채택 사례 후 투자 권장
- **A2 positional facade**: `docs/benchmarks.md:91`. 코드젠이 `__rustraNative.addNumbers(a,b)` positional 시그니처 생성. 전혀 없음(positional 관련 코드 0건). 규모 M

### 3. 부분 구현 (동작하나 범위 제한)

| 항목 | 위치 | 내용 | 규모 |
|---|---|---|---|
| 취소 전파 JS 코덱 한정 | `packages/types/src/index.ts:809-813` (`!onTypedPath &&`) | typed(tier 1)/tier 3는 얕은 취소. 전제(invokeTypedAsync id 노출+invokeCancel)는 follow-up 3 완료 → 조건 완화만으로 확장 가능 | S |
| tier-3 getLiveSchema | `packages/types/src/index.ts:392-395` | getSchema 미노출 시 빈 Map 조용 반환 → 명시 throw 필요 | S |
| invokeTypedBatch 취소 | `RustraJSIBridge.cpp` (동기 루프) | 폴백 경로만 취소 지원, 배치는 취소 지점 없음 | M |
| rkyv V2 Rust Tier 3 | `crates/rustra/src/rkyv_codec.rs:44` | 중첩 구조체/enum/Option 미지원 → JSON 문자열 폴백 (T1/T2 완전) | M~L |
| RSS 측정 macOS 한정 | `examples/benchmark/src/main.rs:546-547` | `#[cfg(not(macos))] None`. Linux `/proc/self/statm`, Windows `GetProcessMemoryInfo` 필요 | S |
| Node transport 부재 | `packages/node/src/index.ts` (33줄, transport 주입만) | getting-started가 `invokeCalculatorRuntime` 사용자 구현으로 남김 — "5분 온보딩" 끊김. `createNodeProcessTransport` 필요 | M |

### 4. DX/문서 정합성

- **호환성 매트릭스 문서 부재** (S): signal이 node/bun/tauri에서 조용히 드롭(node/bun `invoke`에 options 파라미터 자체 없음), `invokeBatch` rkyvV2 전용, 이벤트 RN 전용 — 어느 문서에도 표 없음. 메모리상 post-Lynx 우선순위 2순위
- **레퍼런스 앱 예제 부재** (M~L): `@rustra/react`(useCommand/useMutation/useEvent/RustraProvider)는 0.1.3 발행됐지만 사용 예제 0건. examples/는 전부 벤치마크/패턴 예제
- **`--cpp-output` 미문서화** (S): CLI 도움말(`packages/cli/src/index.ts:227-252`)에만 존재, RN 셋업 가이드·getting-started 0회 언급
- **init 템플릿 버전 고정** (S): `packages/cli/src/index.ts:195-196`이 `^0.1.1` 고정, 실제 패키지 0.1.3
- **compatibility-contract.md RN 서술 스테일** (S): :31, :67 "missing-native-module" — RN JSI 네이티브 모듈은 구현·실기 검증(0.95µs)·CI Release 완료 상태. 계약 문서라 낡은 내용이 해로움
- **security-audit.md runner/ 참조** (S): :17-18, :30이 삭제된 runner/ 경로 참조
- **마스터플랜 진척 표 스테일** (S): streaming/auth 예제·마이그레이션 가이드 ❌로 표기되나 실제 구현 완료
- **docs/README.md 목록 누락** (S): rust-api-guide/release-procedure/security-audit 빠짐
- **RN B1 체크리스트 23항목 미폐쇄** (S): CI/벤치마크로 사실상 대체됨 — 폐기 결정 필요
- **postcard 필드 순서 함정 미감지** (S): 알파벳 순 가정 위반 시 런타임까지 보이지 않음(`packages/cli/src/generate.ts:187-193`), 빌드 타임 경고 없음

### 5. 고아 추상/잔여물

- **RendererHost trait** (M): `crates/rustra/src/renderer_host.rs:116-136` 공개. 구현체는 `#[cfg(test)]` MockHost 유일, `surface_destroyed`는 `#[allow(dead_code)]`, examples/packages 소비 0건 — Lynx 제거 후 고아. 폐기 or 문서화 결정 필요
- **F5 contractHash JSI 미노출** (M): `RkyvV2EngineOptions.contractHash`(`packages/types/src/index.ts:356`)와 Rust FFI `rustra_ffi_contract_hash`(`crates/rustra/src/ffi.rs:768`)는 있으나 `RustraJSIBridge.cpp`에 `getContractHash` 없음 → 옵션 켜면 항상 `contract.unenforceable` throw
- **invokeAsync(payload,onDone): number** (선언만): `packages/types/src/index.ts:376`. RN은 별도 경로(invokeTypedAsync)로 동작하므로 영향 없으나 in-repo 구현체 없는 옵셔널 메서드
- **allOf/integer enum 코드젠 미지원** (S~M): `docs/internal/codegen.md:233-243` 명시. Rust·TS 모두 `allOf` 0건, enum은 string만(TS `codegen.ts:51` 전부 따옴표). 참고: 같은 표의 "oneOf 판별 필드(const)" 행은 문서가 낡음 — `const_literal`로 이미 구현됨
- **auth/streaming generated/ 스테일** (S): rkyv-codecs/registry 부재 — dual-path codegen 재실행 필요
- **Lynx 잔여물**: `packages/lynx/dist/`(비추적 빌드 산물, gitignore 확인됨), `Example.nitro.ts` 템플릿 TODO, trust_baseline_ffi.rs 모듈 독·"(T3 후속)" 마커 낡음

### 6. 검증에서 이상 없음 (참/거짓 필터링)

- `#[ignore]`/`.skip` 테스트 0건, 프로덕션 `unimplemented!()`/`todo!()` 0건
- tauri feature `cargo check` 통과 — 죽은 cfg 아님
- `onEvent` 부재 no-op(`packages/react-native/src/index.ts:398-401`)는 테스트로 고정된 의도적 호환 계약
- `invokeBatch` 미지원 throw는 기능 게이트
- CLI 전 커맨드(generate/init/diff/dev) 실제 실행 검증 성공 — init→cargo run→generate 파이프라인 5파일 생성
- `rustra dev --inspect`는 콘솔 안내만(주석에 "정직한 범위" 명시)
- RN JSI 브릣지 getSchema/onEvent/drainEvents/hasStaticCodec/invokeTyped(ById/Batch/Async)/invokeCancel 전부 구현
- rkyv V2 Tier 3 JSON 폴백은 설계상 계약(Rust 측 정상 처리) — 결함 아님

## 코드 참조

- `packages/cli/src/generate.ts:165-206` — classifyPostcardField null 분류 + 무음 스킵 (결함 1-1 근원)
- `examples/crud/generated/rkyv-codecs.ts:287,318,325-332,350` — 필드 소실된 생성물
- `packages/types/src/index.ts:356,376,392-395,780-795,809-813` — contractHash/invokeAsync 선언, getLiveSchema 빈 Map, Tier3 폴백, 취소 전파 조건
- `crates/rustra-macros/src/lib.rs:100-120,151-159,387` — 단일 입력/Result 강제/attr 폐기 (문서 불일치 대상)
- `crates/rustra/src/renderer_host.rs:116-136` — RendererHost 고아 trait
- `crates/rustra/src/rkyv_codec.rs:22,44` — Tier 3 JSON 폴백
- `crates/rustra/src/ffi.rs:768` — rustra_ffi_contract_hash (JSI 미배선)
- `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` — getContractHash 부재
- `docs/rust-api-guide.md` — 7건 허위/과소 서술
- `docs/compatibility-contract.md:31,67` — RN 스테일 서술

## 아키텍처 인사이트

- **잠복 결함의 공통 패턴**: crud/auth 예제 테스트가 mock 엔진(JSON)만 써서 JS 코덱 와이어를 경유하지 않음 → 코드젠 결함이 CI에 걸리지 않음. "생성물 round-trip 스모크 테스트"(생성 코덱으로 인코딩→Rust 디코드 or 스키마 대조)가 결함 1-1을 잡는 구조적 해법
- **문서 스테일성은 양방향**: rust-api-guide는 구현보다 앞서고(허위 기능 서술), compatibility-contract는 구현보다 뒤짐(RN 완료를 미완료로 서술). CI에 문서-코드 대조 게이트가 없어 둘 다 방치됨
- **고아 추상의 원인은 Lynx 제거**: RendererHost, contractHash 미배선, invokeAsync(payload,onDone) 모두 "인터페이스는 남고 소비자가 사라진" 패턴. 4표면 재편 시점에 keep/drop 결정이 자연스러움
- **엔진 Tier 3 폴백 선점 문제**: 레지스트리에 "깨진 코덱"이 등록되면 폴백이 동작 불가 — "부분 코덱은 등록하지 않는다"가 레지스트리 불변식이어야 함
- **온보딩 퍼널이 최우선**: 메모리(post-Lynx 우선순위: 온보딩→매트릭스→레퍼런스 앱)와 이번 조사가 일치. 결함 1-2(문서)와 C1(Node transport)이 신규 사용자 전환을 직접 차단

## 히스토리 컨텍스트 (thoughts/ 디렉토리)

- `thoughts/shared/research/2026-08-19_23-40-00_feasibility-multi-angle.md` §4(:95-114) — C1~C5 온보딩/DX 갭 최초 지적
- `thoughts/shared/plans/2026-08-19_production-readiness-audit-fixes.md` — PR #14 감사 수정 (완료)
- 메모리 `lynx-removed-2026-08-20.md` — post-Lynx 우선순위(온보딩→매트릭스→레퍼런스 앱)와 본 조사 일치
- 메모리 `jsi-fastpath-optimization-complete.md` — caller-buffer/positional facade 후속 트랙 (의도적 유예 확인)
- 메모리 `post-v1-growth-tracks.md` — 무중단 주입 별트랙 명시
- `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md` — 취소 전파 typed 확장 "별도 결정 사항"으로 유예 (B1)
- `docs/plans/2026-08-10-rn-b1-verification.md` — 23항목 미체크 체크리스트

## 관련 리서치

- `thoughts/shared/research/2026-08-19_23-40-00_feasibility-multi-angle.md` (온보딩/DX 갭의 선행 연구)
- `docs/research/2026-08-15-next-steps-analysis.ko.md` (과거 갭 분석 — gap-closure 체크박스는 현재 모두 해소 확인)

## 미해결 질문

- 결함 1-1의 수정 방향: (a) 미지원 명령 레지스트리 제외+경고(엔진 폴백 활용, 최소 비용) vs (b) `Option<T>`/`Vec<T>` postcard 와이어 전체 구현 — 성능/정확성 트레이드오프 결정 필요
- RendererHost trait의 존속 여부 (Tauri 표면에서 재소비할지, 폐기할지)
- `contractHash`를 JSI 브릿지에 배선할지, 옵션 자체를 문서상 "RN 미지원"으로 명시할지
- 무중단 핫 리로드 주입(레지스트리 실행 중 주입)의 착수 시점
- npm 플랫폼 패키지(native 산출물) 발행 여부 — 현재 npm은 순수 JS 10개뿐, cdylib는 CI 아티팽트에만 존재
- Android JSI fastpath 재검증(기기 의존)과 메모리 프로파일링 벤치마크 추가 여부
