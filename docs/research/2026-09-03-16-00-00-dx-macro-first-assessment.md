---
date: 2026-09-03 16:00:00 +0900
researcher: claude
git_commit: ebfac5e96cec542f29113ffdeecca188edbbcb0f
branch: main
repository: loopy-lim/rustra
topic: "rustra DX 객관 평가 — docs 없이 사용 가능한가, main.rs/lib.rs 보일러플레이트의 macro-first 흡수 가능성"
tags: [research, dx, macros, codegen, onboarding, competitive-analysis, boilerplate]
status: complete
last_updated: 2026-09-03
last_updated_by: claude
---

# 리서치: rustra DX 객관 평가 — docs 없이 사용 가능한가, macro-first 흡수 격차

**날짜**: 2026-09-03 16:00:00 +0900
**연구자**: claude
**Git Commit**: ebfac5e96cec542f29113ffdeecca188edbbcb0f (main)
**Branch**: main
**Repository**: loopy-lim/rustra

## 연구 질문

rustra의 객관적인 DX 경험은 어떤가? docs를 안 보고 거의 사용할 수 있을 정도로 가야 한다. 특히 main.rs/lib.rs에 치는 코드가 많은데, macro로 대체하는 게 더 나은 방향이 아닌가? (경쟁 도구의 macro-first 관례를 웹 조사 후 판정)

## 요약

**결론 1 — "docs 없이 부분 가능(가능에 가까움)".** `rustra init`이 컴파일되는 완성 스캐폴드(9파일)를 뽑아주고 그 여정(init → doctor → build → codegen → demo)이 CI 온보딩 게이트로 매 PR 검증된다(`scripts/onboarding-gate.mjs:26-70`). CLI 실수는 대부분 fail-closed + did-you-mean + 해결 명령 메시지다. 불가한 부분은 도메인 개념(와이어 호환 규칙, stdio 프로토콜 의도)과, 코드 주석에만 존재하는 함정들이다.

**결론 2 — main.rs/lib.rs 보일러플레이트에 대한 직관은 절반 맞다.** calculator 예제(3,083줄)가 겉보기 무게의 대부분은 (a) 벤치 레거시 FFI 심볼 700줄 — **전부 `RUSTRA_ENABLE_LEGACY_BENCHMARKS` ifdef 안**이므로 일반 사용자 불필요, (b) 테스트 ~1,000줄. 실제 사용자 최소 표면은 호스트별로 **Node ~30줄(stdio 프로토콜), Tauri 25줄, Bun/RN `native_entry!` 1줄**이다.

**결론 3 — macro-first 격차는 "매크로가 없어서"가 아니라 3곳에 있다** (경쟁 도구 비교로 확정):

1. **등록 목록 이원화** — `register!` 튜플 25개 + `.command_fn` 체인 6개가 같은 파일의 두 목록으로 갈라져 있고 순서 함정(register! id = 등록 순서)은 코드 주석에만 존재. Tauri가 실제로 같은 결함으로 커뮤니티 비판을 받은 구조(tauri#15597/#15940)와 동형. tauri-specta v2의 `collect_commands!`가 정석 해법.
2. **`#[bridge_type]` 미채택 스포츠코트** — 매크로는 이미 derive 4종 + camelCase 자동화를 제공하는데(`macro_bridge_type.rs:17-44`) init 템플릿과 calculator 예제가 수동 derive를 쓴다. 사용자가 보는 "5-derive 반복"은 실제로는 이미 해소된 문제의 재연출.
3. **stdio 프로토콜 스캐폴드의 무설명 동봉** — Node 호스트 필수 ~30줄(init main.rs)이 stdin JSON 라우팅 + `__rustra_contract` 프로브인데 매크로화 후보 1순위지만 현재는 초심자 첫 파일에 설명 없이 놓임.

자동 수집(inventory/linkme)은 **기각 권고** — 순서 비보장이 "id = 등록 순서" 와이어 계약과 정면 충돌하고, linkme는 Android 미지원.

## 상세 분석

### 1. 사용자가 실제로 작성하는 표면 (호스트별 최소)

| 호스트 | 사용자 Rust 작성물 | 근거 |
|---|---|---|
| Node | lib.rs(커맨드 정의) + main.rs stdio invoke 프로토콜 ~30줄(`__rustra_contract` 포함) | node-core.ts가 사용자 bin을 spawn해 stdin JSON으로 invoke (`packages/node/src/node-core.ts:60-99`), `__rustra_contract`로 contract hash 획득 (`node-core.ts:94`) |
| Bun | lib.rs + `native_entry!(package_fn)` 1줄 | Bun FFI가 코어 `rustra_ffi_*` 심볼만 바인딩 (`packages/bun/src` — `rustra_ffi_invoke_rkyv_v2`, `rustra_ffi_contract_hash`, `rustra_mobile_init` 등 전부 프레임워크 제공) |
| React Native | lib.rs + `native_entry!` 1줄 + `[lib] staticlib` | RN JSI 브리지 헤더의 필수 extern은 코어 심볼뿐 (`packages/react-native/native/cpp/RustraJSIBridge.hpp:23-66`); `rustra_mobile_init`이 `native_entry!`가 발행 (`crates/rustra/src/entry.rs:12-26`); 모듈 스캐폴드(podspec/CMake)는 CLI가 앱 크레이트명으로 생성 |
| Tauri | main.rs 25줄 — `register_with_events(pkg, Builder)` 1줄 + run | `examples/tauri-calculator/src-tauri/src/main.rs:19-24` |
| 스키마 프로브 bin | `generate_typescript()?.write_schema_to_dir()` 2줄 | README 퀵스타트와 init 템플릿 `src/bin/generate.rs` (`init-template.ts:50`) |

**calculator 예제 3,083줄의 해부**: 커맨드 정의 ~800줄(29 커맨드, 대부분 Input/Output 구조체 쌍 — 로직 2줄에 구조체 ~12줄), legacy 벤치 FFI ~700줄(ifdef 안 — `RustraJSIBridge.hpp:56`의 `#if defined(RUSTRA_ENABLE_LEGACY_BENCHMARKS)`로 확인), bincode 수동 코덱 ~200줄(벤치 전용), 테스트 ~1,000줄. **일반 사용자가 복사할 것은 0줄.**

### 2. 매크로 표면의 현재 상태 (crates/rustra-macros, 574줄 전수 검토)

- **`#[bridge_type]`** (`macro_bridge_type.rs:16-45`): `derive(Debug, Serialize, Deserialize, JsonSchema)` + `#[serde(rename_all = "camelCase")]` 자동 추가. 기존 rename_all 있으면 존중. **이미 derive 흡수를 한다.**
- **`#[command]`** (`macro_command.rs:15-198`): snake→lowerCamel 자동 네이밍(`_command` 접미사 제거), async 지원, `State<T>` 주입, doc comment 보존, capability 속성(`#[command(capability = "...")]`)이 메타 상수로 register!에 자동 연결(문자열 재결합 오타 패닉 제거), 타입 바운드 컴파일 타임 검증(`_check_command_bounds`, `macro_command.rs:184-194`). 명시적 진단: 다중 데이터 파라미터 거부(:78-84), `Result<O>` 명시 강제(:29-44), `self` 거부(:58-62).
- **`register!`** (`macro_register.rs:49-94`): `.command + .command_doc + .require_capability_if` 체인 자동 생성 — capability·doc 연결 흡수.
- **`build!`** (`macro_build.rs:62-96`): `register!(Package::builder(name), ...).build()` 축약.
- **`native_entry!`/`mobile_entry!`** (`entry.rs:12-40`): `rustra_mobile_init` 심볼 + Apple `__mod_init_func` constructor 발행.

**갭**: (a) fn doc comment → TS JSDoc 전달은 2026-08-29 감사 때부터 죽은 코드로 지적된 상태 그대로(`__RUstra_doc_` 상수를 읽는 소비자가 TS 코드젠에 없음). (b) `#[bridge_type]` 없이 수동 derive하면 camelCase 누락이 **어디서도 검증되지 않음** — snake_case 스키마가 자기일관적으로 생성돼 런타임까지 조용함. (c) docs `rust-api-guide.md:140`이 `#[diagnostic::on_unimplemented]` 친절 에러를 보여주지만 실제 크레이트에는 존재하지 않음(grep 0건 검증) — JsonSchema 누락 시 표준 E0277만 노출.

### 3. 온보딩 경로 (init/doctor/codegen)

- **init**: 9파일 생성(`Cargo.toml, src/lib.rs, src/main.rs, src/bin/generate.rs, src/index.ts, package.json, rustra.json, .gitignore, tsconfig.json` — `cli-init.ts:73-83`). 기존 파일 있으면 거부 + `--force`. rustra.json은 `{$schema, schema, output, node:{}}` 최소 4키.
- **rustra.json**: 필수는 `schema`+`output` 2키뿐(`config.ts:118-127`), 미지 키 fail-closed(`config.ts:5-23`), 오타 Levenshtein 제안(`cli-suggest.ts:33-45`), 파일 없으면 "Run `rustra init <dir>`" 메시지(`config.ts:85-92`). 단 제너레이터 bin이 복수면 `codegen.rust_binary_ambiguous`로 멈춤 — 3키(`codegen.{rustManifest,rustPackage,rustBinary}`) 수동 세팅은 예제를 베껴야 하는 암묵지.
- **doctor**: 6 기본 검사 + 4 config 검사(스테일 generated 포함) + RN/Tauri 조건부 검사, exit 코드 체계 명확(`doctor-types.ts:107-113`).
- **CI 온보딩 게이트**: init→doctor→build→codegen→demo를 매 PR 실동행 검증(`.github/workflows/ci.yml:259-266`). **"문서가 아니라 게이트로 계약한다"는 이 저장소의 원칙이 온보딩에는 이미 적용돼 있음.**

### 4. 실수 시나리오별 포착 지점

| 실수 | 포착 지점 | 품질 |
|---|---|---|
| 커맨드를 register!에 안 넣음 | **컴파일 통과** → TS 함수 미생성(TS 컴파일 에러) → Rust invoke 시 런타임 `command.not_found` (`error.rs:48-55`) | **가장 조용한 실패** — 정적 게이트 없음 |
| Input에 JsonSchema derive 누락 | 컴파일 타임 E0277 (`macro_command.rs:184-194`) | 표준 에러뿐, docs가 약속한 친절 메시지 미구현 |
| 파라미터 2개 / Result 누락 / self | 매크로 명시적 진단 (`macro_command.rs:78,40,58`) | 양호 — span 포함 |
| register! 순서 변경 | **컴파일러·doctor 무음**, `rustra diff`만 `command_id_changed` breaking + exit 1 (`schema-diff.ts:264-311`) | diff 미도입 시 런타임 오라우팅 장애 |
| camelCase 누락(수동 derive) | **무음** — snake_case 스키마 자기일관 생성 | 스타일 드리프트 + TS 필드명 노출 |
| rustra.json 오타 | fail-closed + did-you-mean | 양호 |
| stale generated | doctor warn + `codegen --check` fail | 양호 |

### 5. 경쟁 도구 macro-first 벤치마크 (1차 소스 검증, 환각 이슈 3건 기각 후)

| 도구 | 정의 위치 | 등록 목록 | TS 바인딩 | 목록 이원화 |
|---|---|---|---|---|
| Tauri v2 | Rust fn | **수동** (`generate_handler![...]`, setter라 재호출 불가) | 없음 | **있음 — 비판 실증: tauri#15597(81커맨드 ~100줄 모놀리식 블록, 플러그인 분리 시 ACL 런타임 거절), tauri#15940(빌드 스크립트 목록과 이원화 → "silently unreachable", "No warnings at build time")** |
| tauri-specta v2 | Rust fn | `collect_commands![...]` 1목록 | **debug 런타임 자동 export** (`#[cfg(debug_assertions)] builder.export(...)`) | 소거 — v1의 이원화에서 v2로 통합된 발전 |
| napi-rs | Rust fn | **목록 자체가 없음** (runtime registration, ctor 기반) | 빌드 CLI가 .d.ts | 없음 |
| Nitro | TS spec | spec이 곧 목록 | TS가 원본(역방향) | 없음 |
| tarpc/jsonrpsee | Rust trait | trait이 곧 목록 (`into_rpc()` 1줄 결선) | 없음 | 없음 |
| tonic | proto IDL | proto가 곧 목록 | 없음 | 없음 (IDL 간접층 비용) |

자동 수집 원리 및 함정: **inventory** — "no guarantee about the order that plugins of the same type are visited" (순서 비보장 명시), dlopen 시 동적 등록. **linkme** — link_section 수집, life-before-main 없음, 초기자 const 필수, 플랫폼 표에 **Android 부재**. **ctor** — napi-derive가 optional 채택. 선례: apistos는 inventory로 중앙 목록 제거, poem-openapi/dropshot은 명시적 목록 유지.

### 6. 이번 조사에서 확인된 결함/부채 (2026-08-29 감사 이후 잔존분)

1. **docs가 약속한 `on_unimplemented` 친절 에러 미구현** (`docs/rust-api-guide.md:140` vs 코드 grep 0건) — 문서를 읽은 사용자가 오히려 혼란. docs-gate는 docs:sync 리전만 검증하므로 이 산문 주장은 게이트 밖.
2. **fn doc → TS JSDoc 죽은 코드 잔존** (`__RUstra_doc_` 소비자 없음 — 8/29 감사와 동일).
3. **`#[bridge_type]` 미사용 스포츠코트**: init 템플릿(`init-template.ts:48`)과 calculator 예제가 수동 derive — 개선 API가 있는데 대표 표면이 따라가지 않음.
4. **register! 누락 무음**: "정의됐지만 등록 안 된 #[command]" 정적 검사 부재 (Tauri #15940 비판에 대한 직접 면역 포인트).

## 코드 참조

- `crates/rustra-macros/src/macro_bridge_type.rs:16-45` — derive 4종 + camelCase 자동화 (이미 존재하는 derive 흡수)
- `crates/rustra-macros/src/macro_command.rs:100-129` — 네이밍 규칙 + capability 메타 상수
- `crates/rustra-macros/src/macro_build.rs:83-88` — register!가 doc/capability 체인 흡수
- `crates/rustra/src/entry.rs:12-40` — native_entry!/mobile_entry! (Apple constructor)
- `packages/node/src/node-core.ts:60-99` — Node가 사용자 bin spawn + `__rustra_contract`
- `packages/react-native/native/cpp/RustraJSIBridge.hpp:23-76` — RN 필수 심볼 = 코어 FFI뿐, calculator 심볼은 legacy ifdef
- `examples/tauri-calculator/src-tauri/src/main.rs:19-24` — Tauri 최소 접착(25줄)
- `examples/calculator/src/lib.rs:760-807` — register! 25개 + .command_fn 체인 6개의 목록 이원화 + 순서 함정 주석
- `packages/cli/src/init-template.ts:47-63` — init 스캐폴드(수동 derive 사용)
- `packages/cli/src/config.ts:5-23,85-92,118-127` — fail-closed config 검증
- `scripts/onboarding-gate.mjs:26-70` — CI 온보딩 게이트 본체
- `docs/rust-api-guide.md:140` — on_unimplemented 주장 (코드 미구현)

## 아키텍처 인사이트

1. **rustra의 macro-first 수준은 이미 napi-rs에 근접, Tauri보다 앞선다.** 등록+capability+doc이 매크로 1줄(`build!`)로 끝나고, derive도 `#[bridge_type]` 1줄로 끝난다. 겉보기 장황함의 원인은 매크로 부재가 아니라 (a) 대표 예제가 개선 API를 안 씀, (b) Node stdio 프로토콜만 매크로화 안 됨.
2. **"목록은 하나"가 업계 정답 패턴** — tauri-specta v2, napi-rs, tarpc, jsonrpsee 모두 단일 목록(또는 무목록). rustra의 `register!`+`.command_fn` 체인 분리는 이 기준으로 유일한 이원화이며, buffered/buffer_command_fn 같은 수정자를 목록 안으로 흡수하는 게 정석 방향(예: `build!("pkg", add_numbers, buffered::bench_echo_bytes, ...)`).
3. **자동 수집은 채택 부적격** — "id = 등록 순서" 와이어 계약과 inventory의 순서 비보장이 충돌, linkme의 Android 부재는 RN 지원 프레임워크인 rustra에 치명적. 명시적 단일 목록이 와이어 안정성을 유지하는 절충안.
4. **debug 런타임 export(tauri-specta 패턴)는 현재 codegen CLI와 양립 가능** — 개발 루프는 export 자동화, CI는 `generate --check` 결정론 게이트. 현재 0.6 트랙의 `rustra dev`가 절반쯤 이 방향에 있음.
5. **매크로가 못 흡수하는 것** (업계 공통): 런타임 구동 배관(tarpc spawn 루프, tonic Server::builder), 툴체인 플래그, 플랫폼 예외(Windows 무-constructor → `ensure_registered()` 패턴). Node stdio 프로토콜은 이 중 "런타임 구동 배관"에 해당하나, **코어가 `rustra_ffi_invoke` 계열 심볼을 이미 일반화했으므로 stdio 프로토콜도 코어 제공 매크로/함수로 흡수 가능한 유일한 잔여 보일러플레이트**.

## 권고 순위 (구현 관점)

1. **목록 일원화** — `build!`/`register!`가 buffer/ordinary 수정자를 흡수해 단일 목록화 (calculator의 두 목록 + 순서 주석 소멸). Tauri #15940형 이원화 결함의 근본 제거.
2. **Node stdio 프로토콜 매크로화** — `rustra::stdio_main!(package_fn)` 류로 init main.rs 30줄 → 3줄. 신규 사용자 첫 파일에서 가장 어려운 부분 제거.
3. **스포츠코트 정합** — init 템플릿 + calculator를 `#[bridge_type]`로 전환(제품은 이미 준비됨). 눈에 보이는 5-derive 반복 소멸.
4. **on_unimplemented 구현 또는 docs 수정** — docs가 약속한 친절 E0277 메시지를 실제로 (`CommandInput`/`CommandOutput` 트레잇에 attribute 부착).
5. **미등록 `#[command]` 정적 경고** — 정의됐으나 어떤 목록에도 없는 함수를 unused 진단이나 doctor가 잡게.
6. **fn doc → TS JSDoc 완성** — 8/29부터 지적된 죽은 코드 회수.
(자동 수집(inventory/linkme)은 위 근거로 기각 권고.)

## 관련 리서치

- `docs/research/2026-08-29-22-46-49-dx-audit.md` — 선행 DX 감사(5일 전). 이번 조사는 "macro-first 격차"와 "경쟁 도구 정량 비교"를 추가하고, CLI 인체공학 항목 일부가 hurdle-reduction 트랙으로 해소됐음을 확인(fail-closed config, did-you-mean, --help 등).
- `docs/research/2026-08-29-20-56-04-architecture-review.md`

## 미해결 질문

1. 목록 일원화 시 `alias_command_id` 호환 표면을 어떻게 유지할지 (와이어 계약 변경 없이 매크로 문법만 확장 가능한지).
2. stdio 프로토콜 매크로화 시 `__rustra_contract` 커스텀 분기(사용자 데모 main)와의 충돌 처리.
3. `#[bridge_type]` 전환의 예제/템플릿 파급 범위 (docs:sync 리전과 generated 재생성 동반 필요).
