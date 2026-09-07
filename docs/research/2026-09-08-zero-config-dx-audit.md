---
date: 2026-09-08 01:51 +0900
researcher: claude
git_commit: 5a33a206
branch: changeset-release/main
repository: loopy-lim/rustra
topic: "zero-config 실측 검증 + 첫 사용 흐름 벤치마킹 + DX 개선 후보 발굴"
tags: [research, dx, zero-config, onboarding, cli, codegen, benchmark]
status: complete
last_updated: 2026-09-08
last_updated_by: claude
---

# 리서치: zero-config 상태 감사 + DX 개선 후보 발굴

**날짜**: 2026-09-08 01:51 +0900
**연구자**: claude
**Git Commit**: 5a33a206 (changeset-release/main)
**기준 리서치**: `docs/research/2026-09-04-dx-friction-audit-refresh.md` (직전 DX 감사), `docs/research/2026-09-08-docs-usability-audit.md` (동일일 문서 사용성 감사 — 문서 영역 결손은 이쪽이 소관)
**발행 상태**: crates.io/npm 모두 0.8.0 (2026-09-06 발행, 워크스페이스 0.8.0과 일치 — 직전 감사의 "발행 간극" 해소 확인)

## 연구 질문

1. "zero-config"의 정의를 호스트별로 확정하고, 현재 Node/Bun/Tauri/RN 각각에서
   코드젠 클라이언트 사용 시작까지 **실제로 설정이 0개인지** 생성 엔트리·어댑터·
   examples 배선을 직접 읽어 검증한다. 0이 아닌 것은 불가피한지 판단한다.
2. 새 사용자의 "npm install → hello world" 단계 수를 Tauri commands·Nitro
   Modules·uniffi-rs와 비교하고, init/generate/codegen/doctor/dev CLI가 하는 일과
   안 하는 것을 정리한다.
3. 직전 감사 대비 **신규 관점**(에러 메시지 품질, 재생성 루프, 타입 에러 위치,
   문서-코드 드리프트 감지, 버전 업그레이드 경험, 디버깅 표면)에서 개선 후보를
   "문제 증거 → 개선안 → 비용" 형식으로 발굴한다.
4. 성능 지향 개선 중 사용자 체감(DX)에 속하는 것(코드젠 속도, 생성물 크기,
   런타임 초기화 비용)을 구분한다.

## 1. 요약

**zero-config 클레임은 코드 수준에서 4호스트 모두 참이었다** — 앱 코드는 엔진
생성·`configure()`·어댑터 import를 직접 쓰지 않고, 생성 호스트 엔트리가
`configureLazy` 부트스트랩을 소유한다(전 호스트 실측, §2). 다만 **신뢰성에
급이 있는 신규 결함 1건을 재현했다**: 부트스트랩의 release-우선 아티팩트 탐색이
stale `target/release` 산출물을 잡아, 방금 `cargo build`(debug)한 사용자가
`contract.mismatch`로 사망한다(§4-A1, Node/Bun 양쪽 재현 완료).

**첫 사용 흐름은 정량적으로 우수하다** — 스캐폴드 경로 6명령·수동 파일 편집
0건, 실측 총 ~12초(웜 레지스트리; codegen 0.20s/doctor 0.26s/demo 0.05s).
온보딩 게이트가 mutate→regen→rebuild→verify까지 11단계로 E2E 계약화했다.
경쟁자 비교에서 rustra의 차별점은 "Rust 단일 소스 → 타입 클라이언트 자동"과
doctor이고, 남은 비용축은 cargo build(불가피)와 codegen 단계(Nitro도 동일,
Tauri는 없지만 무타입)뿐이다.

**직전 감사의 "조용한 성공/실패" 트랙은 대부분 착지 확인** — stale 바이너리
힌트, init Next steps `cargo build`, registry 도달성 검사, 에러 서브클래스,
capability 무음 드랍 제거, positional facade 렌더러 수정 모두 현 트리에 있다.
**그러나 같은 결함 클래스의 새 인스턴스가 2건** 발견됐다: (a) RN 예제 2곳의
`rustBinary` 오지정이 `codegen:check`를 항상 실패시키고 비-check 모드에서는
스키마를 갱신 없이 조용히 재사용한다, (b) examples/calculator의 고아
`positional-facade.ts`가 수정 이전 렌더러 산물로 남아 있다.

### 상태 등급

| 영역 | 등급 | 근거 |
| --- | --- | --- |
| zero-config 달성(JS 설정 0개) | **A** | 4호스트 전부 생성 엔트리가 lazy bootstrap 소유, examples가 이를 사용 중 |
| zero-config 신뢰성(실패 경로) | **C+** | stale-release 탐색 함정(재현), RN 예제 probe 오지정, 어댑터 미설치 조용한 폴백 |
| 첫 사용 흐름 | **A-** | 6명령/12초/게이트 계약화. 감점: init이 node·RN 2호스트만 스캐폴드 |
| 재생성 루프(watch/dev) | **B+** | `rustra dev --config`가 Rust+config+schema 감시·reload 훅·parity 게이트. 감점: codegen 텍스트 모드가 drift 표시 숨김 |
| 에러 메시지 품질 | **B** | CLI did-you-mean/fix 안내 성숙. 감점: diff 무경로, Node mismatch 무힌트, 호스트 특정 문구 |
| 문서-코드 정합 | **B-** | docs:sync 게이트 존재하나 매트릭스 표 2개 중복 모순(en)/스테일 단일 표(ko), 버전 스니펫 0.6 방치 |
| 업그레이드 경험 | **B-** | doctor가 generatorVersion drift 감지. 감점: 0.7→0.8 마이그레이션 문서 부재 |

### Top 개선 5 (우선순위 순)

1. **부트스트랩 후보 탐색에 계약 검증 폴백** — release 우선 탐색이 stale
   release 산출물을 잡는 함정(A1). mismatch 시 다음 후보(debug) 시도 후 최종
   실패 시에만 오류. 비용 M.
2. **RN 예제 `rustBinary` 오지정 정정 + codegen의 probe 갱신 무결성** —
   `codegen:check` 항상 실패 + 스키마 조용한 재사용(A2). 비용 XS(정정) /
   S-M(근본). 
3. **호환 매트릭스 중복·모순 표 제거 + ko 갱신** — 도입 의사결정 표면이 두
   개의 반대 답을 준다(A4). 비용 XS.
4. **codegen 텍스트 모드에 파일 목록·drift 표시** — `rustra codegen`(주력
   명령)이 무엇이 바뀌었는지 말해주지 않는다(A3). 비용 XS.
5. **Node `contract.mismatch` 에러에 fix 안내** — Bun 구현에 이미 좋은 문구가
   있어 패턴 적용만 남았다(A6). 비용 XS.

## 2. zero-config 실측 매트릭스

### 정의

> **zero-config** = 앱 코드가 첫 명령 호출까지 작성해야 하는 **호스트 엔진
> 설정 코드 0개**. 엔진 생성(`createXxxEngine`), 전역 등록(`configure(engine)`),
> 어댑터 수동 import를 앱이 직접 쓰지 않는다. 생성 호스트 엔트리
> (`generated/node.ts` 등)가 `configureLazy` 부트스트랩을 소유하고, 첫 호출에
> lazy 초기화가 계약 해시 검증까지 수행한다. `rustra.json`의 host 섹션은 빈
> 객체로 시작할 수 있다. `RUSTRA_NODE_BINARY`/`RUSTRA_BUN_LIBRARY`/
> `createTauriEngine({ invoke })`/custom transport는 명시적 escape hatch다.

근거 설계: `docs/plans/2026-08-24-cross-host-zero-config-design.md` (호스트별
진입점·탐색·escape hatch 표). lazy 슬롯 계약: `packages/types/src/global-config.ts`
(단일 엔진, 경쟁 등록 `registry.frozen` loud-fail, 이후 명시적 `configure()` 우선).

### 호스트 × 설정항목 매트릭스 (2026-09-08 실측)

| 설정항목 | Node | Bun | Tauri | React Native |
| --- | --- | --- | --- | --- |
| 앱의 엔진 생성/`configure()` | **0** (엔트리 side-effect import 1줄) | **0** (동일) | **0** (동일) | **0** (동일) |
| 생성 엔트리 | `node.ts` → `createNodeBootstrap` (init-entries.ts:70-89) | `bun.ts` → `createBunBootstrap` (:130-152) | `tauri.ts` → `createTauriBootstrap()` 무인자 (:154-162) | `react-native.ts` → `createRustraBootstrap({install: installRustraJSI, …})` (:5-22) |
| lazy 등록 지점 | node-bootstrap.ts:105 `configureLazy` | bun-ffi.ts:237 | tauri/src/index.ts:192 | react-native-core.ts:140 |
| 아티팩트 자동 탐색 | binary 후보 release→debug + cwd 조상 탐색 (node-bootstrap.ts:25-46) | cdylib 후보 + ABI probe (bun-ffi-library.ts:33-45) | `globalThis.__TAURI__.core.invoke` (tauri/src/index.ts:93-99) | autolink된 `globalThis.__rustraNative` (react-native-core.ts:171-181) |
| `rustra.json` host 섹션 | `{}`로 충분 | `{}`로 충분 | `{}`로 충분 | `{}`로 충분 (모노레포에서만 `rustManifest` 지정 — examples/react-native-bare-calculator/rustra.json 참고) |
| Rust 측 필요 작업 | `Package::builder().command_fn()` + main.rs stdio invoke 루프 — **전부 스캐폴드가 심음** | 좌동 + `[lib] crate-type cdylib` **수동 1줄** (init이 Bun 호스트 미지원) | `features=["tauri"]` + `tauri_support::register_with_events(pkg, Builder)` **1줄** | `[lib] staticlib` (init `--host react-native`이 심음) + 모듈 15파일은 코드젠 생성(react-native.ts:130-146) |
| 호스트 플랫폼 설정 | 없음 | 없음 | `tauri.conf.json` `app.withGlobalTauri: true` **1개** (또는 `createTauriEngine({invoke})` 명시) | autolink 설정 불요(생성됨). 단 코드젠 전 `bun install`로 `@rustra/react-native` 먼저 설치 필요 |
| npm 의존성 | 코드젠이 자동 주입(cli-generate-files.ts:146-152 `ensureHostDependencies`) | 동일 | 동일 | `ensureReactNativeDependency`가 workspace 연결 |
| escape hatch | `RUSTRA_NODE_BINARY` | `RUSTRA_BUN_LIBRARY` | `createTauriEngine({invoke})` | custom native transport |
| examples 실사용 증거 | calculator/apps/node-app.ts:1 | calculator/apps/bun-ffi-app.ts:1 ("bun FFI zero-config result: 42" 재현) | tauri-calculator/src/app.ts:1 | react-native-calculator/App.tsx:3, react-native-bare-calculator/App.tsx |

### 0이 아닌 것의 불가피성 판단

- **Node — 잔여 0개.** 엔트리 side-effect import(`import './generated/node.js'`)
  만이 암묵적 요구사항인데 스캐폴드 demo(src/index.ts)가 이미 심는다. 엔트리를
  빼먹었을 때의 오류 메시지가 "React Native entry"를 말하는 것은 결함(A8).
- **Bun — `[lib] crate-type = ["rlib","cdylib"]` 1줄.** 불가피하긴 하나
  `rustra init --host bun`이 심어줄 수 있어 불가피 아님(후보 A14). cdylib은
  FFI의 물리적 요건이라 "설정"이라기보다 빌드 타깃 선언에 가깝다.
- **Tauri — `withGlobalTauri: true` 1개 + Rust 등록 1줄.** withGlobalTauri는
  Tauri 플랫폼의 정책 플래그라 rustra가 대신 켤 수 없다(불가피). 미설정 시
  오류 안내가 정확하다("Enable app.withGlobalTauri, or pass { invoke }").
  Rust 등록 1줄은 Tauri Builder 체인의 소유권 문제로 불가피하며,
  `generate_handler!`를 매번 갱신하는 Tauri와 비교하면 오히려 유리(패키지
  단위 1회).
- **RN — 사실상 0개이나 전제가 많다.** (1) `bun install`이 코드젠보다
  선행해야 하는데 미설치 시 조용히 폴백한다(후보 A11 — 불가피 아님, 결함).
  (2) Rust staticlib 빌드(`rust:ios`/`rust:android` 스크립트)와 네이티브
  앱 빌드는 물리적으로 불가피. (3) Expo Go 불가 안내는 오류 메시지에
  포함돼 있어 양호.
- **`rustra.json`의 codegen 키(rustManifest/rustPackage/rustBinary)는
  examples 대부분이 명시하지만 전부 생략 가능하다** — `findCargoManifest` +
  단일 패키지 추론 + `selectCodegenBinary`의 `generate` 우선(cargo.ts:45-68)
 이 정답을 고른다. 오히려 RN 예제의 `rustBinary` 명시가 **오답을 고정**하는
  원인이 됐다(A2) — "불가피하지 않은 명시가 신뢰성을 해치는" 사례.

### 직전 감사 항목의 착지 확인 (2026-09-04 감사 대비)

- **착지 확인**: 스캐폴드 generate bin의 `RUSTRA_SCHEMA_OUT` 존중
  (init-template.ts:56 `var_os`), init Next steps `cargo build`(cli-init.ts:109),
  doctor `registry.reachability`(doctor-checks.ts:73-91), stale 바이너리 힌트
  (cli-codegen.ts:28-34, doctor freshness detail :319-327), 타임아웃/취소
  `TimeoutError`/`CancelledError` 서브클래스(cancel.ts 전체), positional
  facade 렌더러 수정(0df517eb — options 제거+async 헬퍼, RN 예제 생성물
  반영 확인), capability 무음 드랍 제거(builder_commands.rs 감사 #5 가드),
  calculator `generate` bin 신설(examples/calculator/src/bin/generate.rs),
  온보딩 게이트 확장(onboarding-gate.mjs:87-99).
- **여전(이번 감사 후보로 승계)**: 최상위 오타 커맨드 exit 1(A9),
  `codegen --config` 기본값 부재(A10), `generate --format json` 구형 shape
  (A16), `dev --inspect` 한국어 출력(A17).
- **신규(이번 감사 발견)**: A1 stale-release 탐색, A2 RN 예제 rustBinary,
  A3 codegen 텍스트 무음, A12 고아 positional-facade 등 §4 참조.

## 3. 첫 사용 흐름 분석

### 실측: 스캐폴드 경로 (Node, /tmp에서 전 과정 재현)

| 단계 | 명령 | 실측 시간 | 비고 |
| --- | --- | --- | --- |
| 1 | `rustra init hello` | ~0.1s | 9파일 스캐폴드(Cargo/package.json/rustra.json/demo 등), Next steps 6줄 안내 |
| 2 | `cd hello` | - | |
| 3 | `cargo build` | **9.97s** (레지스트리 웜) | 유일한 대기. 콜드 환경에선 의존성 다운로드로 수 분 — 흐름의 병목 전부 |
| 4 | `bun install` | 0.98s | 3패키지 |
| 5 | `bun run codegen` | 0.196s | cargo run probe 0.1s + TS 렌더 |
| 6 | `bun run demo` | 0.046s | "hello from TypeScript" |

합계 **약 12초(웜)** / 6명령 / **수동 파일 편집 0건**. `rustra doctor`는
0.26s, 신선 스캐폴드에서 schema 미생성 WARN + `fix:` 안내로 정확히 안내한다.
스키마 변경 사이클: lib.rs에 필드 추가 → `bun run codegen` 0.4s → 드리프트
시 "rebuild the runtime binary…" 힌트 출력 확인 → `cargo build` 0.16s → demo
회복. **도구 자체 오버헤드는 사실상 체감 불가능하며, 남은 체감 축은 첫 cargo
build뿐** — 직전 감사 결론이 그대로 유지된다.

`rustra dev --config` 실측: 초기 강제 재생성 후 Rust 소스·Cargo.toml/lock·
schema 감시 진입(dev.ts:283-322). reload 훅(`onReload`)과 wasm parity 게이트는
0.7 트랙 착지분.

### 명령 추가 비용 (hello world 이후)

Rust fn에 `#[rustra::command]` + `package()` 빌더에 `.command_fn(name)` —
**1파일 2줄** 편집 → `bun run codegen` → `cargo build`. TS측 편집 0건(타입
클라이언트 재생성). Tauri는 명령마다 `generate_handler!` 배열 갱신이 필요하고
uniffi는 UDL/바인딴 재실행이 필요하다 — rustra의 등록이 패키지 단위 1회라
증분 비용이 낮다.

### 경쟁 라이브러리 비교 (공개 문서 기준 단계수)

| | rustra (스캐폴드) | Tauri commands | Nitro Modules | uniffi-rs |
| --- | --- | --- | --- | --- |
| 최초 hello world | 6명령, 편집 0건 | Tauri 앱 생성 후 **3단계/명령**(매크로→`generate_handler!` 등록→`invoke()`) | `npx nitrogen init` → nitro.json → **TS 스펙 작성** → nitrogen 코드젠 → 네이티브 구현(C++/Swift/Kotlin) → 앱 통합 | UDL/proc-macro 작성 → Rust 구현 → `uniffi-bindgen` 언어별 실행 → Xcode/Gradle 빌드 페이즈 **수동 배선** |
| 스캐폴드 CLI | `rustra init`(9파일+demo) | `create-tauri-app`(앱 전체, 브릿지 아님) | 템플릿 부트스트랩 있음 | 없음 |
| 환경 진단 | `rustra doctor` 17+검사/`--format json`/매트릭스 | 없음 | 없음 | 없음 |
| 클라이언트 타입 | **명령별 완전 타입 자동** + 도메인 에러 코드 유니언(errors.ts) + JSDoc(Rust doc 전달) | 무타입(`invoke('이름', args)` stringly) | TS 스펙이 원천(소유 방향 반대) | 생성 바인딩 타입 |
| drift 감지 | `codegen --check` + doctor freshness + runtime contract hash 3층 | 해당 없음 | nitrogen 재실행 | 수동 |
| 남은 비용축 | 첫 cargo build, codegen 명령 1개 | 명령마다 등록 갱신, 무타입 | 네이티브 구현 필수, 스펙-구현 이중 관리 | bindgen 반복 실행 + 빌드 배선 |

해석: rustra는 "Tauri의 3단계 + 무타입" 대비 "등록 1회 + 완전 타입"을,
uniffi 대비 "빌드 배선 자동화"를, Nitro 대비 "명세 소유가 Rust(단일 소스)"를
판다. 첫 사용 병목이 도구가 아니라 cargo build라는 점에서 도구측 개선 여지는
실패 경로 품질에 집중되어 있다(직전 감사 결론 재확인).

### CLI 표면: 하는 일 / 안 하는 일

- **init**: 호스트 감지(package.json의 react-native 의존 → RN 섹션 추가,
  cli-init.ts:19-34), 기존 파일 덮어쓰기 거부+`--force`, `$schema` 참조 삽입.
  **안 하는 것**: bun/tauri 호스트 스캐폴드(`INIT_HOSTS`가 node/react-native
  뿐, cli-init.ts:11), init 직후 doctor 자동 실행.
- **codegen**: cargo probe 실행(스피너+경과), TS/C++/RN 스캐폴드 렌더,
  `(updated)` drift 표시, stale 바이너리 힌트, `--check`(임시 RUSTRA_SCHEMA_OUT
  재검증), `--explain`(표면 지도), `--format json`(schemaVersion:1, drift 필드).
  **안 하는 것**: 텍스트 모드 파일 목록 출력(A3), `--config` 기본값(A10),
  런타임 바이너리 재빌드(설계상 호스트 책임 — 힌트로 고지).
- **doctor**: 17+ 검사(rustc MSRV/cargo/registry/cpp/cmake/RN iOS·Android/
  tauri 플랫폼/섹션 빌드·계약·런타임 프로브/freshness), 매트릭스, exit 코드
  계약, `--strict`·`--format json`. **안 하는 것**: 생성물 바이트 검증
  (`codegen --check` 소관 — 역할 분리 명시됨).
- **dev**: dual-phase(config 모드: Rust+config+schema 감시, reload 훈, wasm
  타깃 오케스트레이션+parity 게이트). **안 하는 것**: 런타임 바이너리/네이티브
  앱 재빌드(호스트 onReload 책임 — 계약상 명시).
- **diff**: 스키마 진화 breaking 분석+exit 코드. **약점**: 입력 JSON 오류가
  무경로(A7).

## 4. 개선 후보 목록 (우선순위 + 비용)

형식: **증거 → 개선안 → 비용**(XS=<1h, S=반나절, M=수일, L=1주+).

### A. HIGH

**A1. stale release 우선 탐색 함정 — "방금 빌드했는데 out of sync"**
- 증거(재현 완료, 본 트리): `target/release`의 calculator 산출물이 00:31,
  `target/debug`가 01:38(최신)인 상태에서 `bun apps/node-app.ts` /
  `apps/bun-ffi-app.ts` 모두 `contract.mismatch`로 사망. 해상 로직:
  `packages/node/src/node-bootstrap.ts:31-38`와
  `packages/bun/src/bun-ffi-library.ts:33-40`이 디렉터리별로
  `release`를 `debug`보다 먼저 push하고 첫 번째 존재 후보를 채택. 생성
  엔트리도 같은 순서(`packages/cli/src/init-entries.ts:81-84,109-112`).
  ABI probe는 깨진 후보만 건너뛸 뿐(설계문 "stale 후보" 정의) 계약
  낡음은 검사하지 않는다. 언제 한 번이라도 `cargo build --release`
  (벤치마크 등)을 돈 사용자는 이후 모든 일반 빌드 흐름에서 이 함정에 빠진다.
- 개선안: bootstrap이 mismatch를 fatal로 만들기 **전에** 다음 후보를
  시도한다(계약 검증 기반 후보 선택 — 부트스트랩이 어차피 handshake 검증을
  하므로 선택 로직으로 승격). 최종 실패 시에만 오류, 그때 전체 후보
  경로+mtime을 보고한다. 대안(보조): mtime 최신 우선 정렬.
- 비용: **M** (node-bootstrap + bun-ffi 후보 루프 재구성, 스테일 release
  픽스처 테스트, 문서 경고 1줄). zero-config 신뢰성의 최대 단일 항목.

**A2. RN 예제 `rustBinary` 오지정 — codegen:check 항상 실패 + 스키마 조용한 재사용**
- 증거: `examples/react-native-calculator/rustra.json:8`과
  `examples/react-native-bare-calculator/rustra.json:8`이
  `rustBinary: "rustra-calculator-example"`(데모 main bin)를 지정. 실행
  실측: `bun run codegen`은 probe로 데모 main을 돌려 "2 + 3 = 5"를 출력하고
  schema.json은 **전혀 갱신하지 않은 채** 이전 calculator 스키마로 TS를
  재생성해 성공한다. `bun run codegen:check`는 RUSTRA_SCHEMA_OUT 미지원으로
  **항상 실패**("Rust codegen did not produce …"). 폴백 기본값이 `generate`
  우선(cargo.ts:48)이라 키를 지우는 것만으로 정답이 된다.
- 개선안: (XS) 두 예제에서 `rustBinary` 키 삭제 후 재생성. (S-M, 근본)
  codegen 비-check 모드도 probe를 임시 `RUSTRA_SCHEMA_OUT`으로 돌려 결과를
  config.schema 경로에 원자적으로 옮기면 "스키마를 못 쓰고 기존 파일
  재사용" 클래스가 원천 봉쇄된다(single-arrow 계약 강화).
- 비용: XS(정정) / S-M(근본). 직전 감사 #1과 동일 결함 클래스의 잔존 인스턴스.

**A3. `rustra codegen` 텍스트 모드가 무엇을 했는지 말하지 않는다**
- 증거: cli-codegen.ts:150-170은 `runGenerate(…, { quiet: true })`로 호출 —
  JSON 모드는 files+drift를 출력하지만 텍스트 모드는 `[rustra] TypeScript/C++:
  generate --config …` 한 줄로 끝. 파일 목록·`(updated)` 표기는
  `rustra generate --config`를 직접 쳤을 때만 보인다(실측). 사용자의 주력
  경로(codegen)에서 drift가 무음이다(stale 힌트는 갱신이 있을 때만).
- 개선안: 텍스트 모드에도 generate와 동일한 파일 목록+`(unchanged)/(updated)`
  표기를 내보낸다. `quiet` 옵션을 세분화하거나 codegen이 목록을 직접 출력.
- 비용: **XS**.

**A4. 호환 매트릭스 표 2개 중복 수록 — 서로 모순 (en), ko는 스테일 단일 표**
- 증거: `docs/compatibility-matrix.md`에 `| Feature |` 헤더가 2개(:9 신규
  표 — 채널 ✅, :21 구형 표 — Node/Bun/Tauri 채널 ❌). git 추적: 채널
  어댑터 머지 f18df822에서 1개→2개. ko판은 표 1개뿐이며 그것이 구형(❌)
  (`compatibility-matrix.ko.md:30`). docs-gate는 통과(마커 영역 밖).
  동일일 문서 사용성 감사 §4 결손 #2와 동일 지적 — 본 감사는 코드 대조로
  "신규 표가 옳다"를 확정했다(node-channels.ts, tauri_channels.rs, 89f1ce97).
- 개선안: 구형 표 삭제, ko판을 신규 표로 재작성(en/ko 쌍 정합).
- 비용: **XS**.

**A5. 버전 스니펫이 2릴리스째 방치 — `rustra = "0.6"` vs 발행 0.8.0**
- 증거: `README.md:166`, `README.ko.md:146`, `docs/getting-started.md:46`(+ko)
  모두 `rustra = "0.6"`. crates.io/npm latest는 0.8.0(2026-09-06 발행).
  `<!-- 발행 시 갱신: 0.7.0 라인 -->` 주석이 독자 facing 파일에 노출된 채.
  docs:sync 마커 밖이라 게이트가 못 잡는다(문서 감사 #1과 동일 지적).
- 개선안: 스니펫 0.8 갱신+TODO 주석 제거. 반복 방지로 릴리스 절차
  (docs/release-procedure.md)에 "설치 스니펫 갱신" 체크리스트 추가, 또는
  docs-gate에 "버전 리터럴이 packages/cli 버전과 일치" 검사 추가.
- 비용: **XS**(갱신) / S(게이트화).

### B. MEDIUM

**A6. Node `contract.mismatch` 에러에 fix 안내 없음 — Bun에는 이미 있다**
- 증거: `packages/node/src/node-bootstrap.ts:77-80`의 메시지는 해시 두 개만
  보고("contract hash mismatch: native=… vs expected=…"). 반면
  `packages/bun/src/bun-ffi.ts:59-61`는 "regenerate the TypeScript and native
  codecs, rebuild the Rust archive, then rebuild the native app"이라는 fix
  안내를 포함 — in-repo 선례 존재. A1과 결합하면 사용자가 가장 자주 만나는
  런타임 오류의 안내 품질이 호스트별로 갈린다.
- 개선안: Node 메시지에 동일 안내+시도한 후보 경로 추가. 에러 코드 상수
  레지스트리(errors.ts)에 코드별 fix 문구 표를 두는 것도 후속 확장점.
- 비용: **XS**.

**A7. `rustra diff` 입력 오류 무경로·무힌트**
- 증거: `packages/cli/src/cli-diff.ts:26-27`이 raw `JSON.parse` —
  `diff --old /dev/null --new schema.json` 실측 결과 `Error: JSON Parse error:
  Unexpected EOF`. generate 경로(cli-generate-files.ts:61-76)는 경로+재생성
  힌트를 갖춘 패턴이 이미 있다.
- 개선안: 동일 래핑 패턴 적용(어느 파일이·왜·무엇을 할지).
- 비용: **XS**.

**A8. 미구성 엔진 오류의 호스트 특정 문구**
- 증거: `packages/types/src/global-config.ts:76-79` — 엔트리 import를 빼먹으면
  "import the generated **React Native** entry"라고 안내한다. Node/Bun/Tauri
  사용자에게 잘못된 호스트를 지시한다.
- 개선안: "import your generated host entry (node.ts/bun.ts/tauri.ts/
  react-native.ts)" 호스트 중립 문구.
- 비용: **XS**.

**A9. 최상위 오타 커맨드 exit 1 — exit-2 계약 구멍 (직전 #9 잔존)**
- 증거: `packages/cli/src/cli-main.ts:63-68`은 unknown command를
  `process.exitCode = 1`로 종료. 플래그 오타는 exit 2(실측), cli-usage-error.ts
  헤더의 계약("호출을 잘못한" 오류=exit 2)과 불일치. did-you-mean은 이미 좋다.
- 개선안: `UsageError`로 전환. CI가 usage류와 런타임 실패를 구분하는 계약 정합.
- 비용: **XS**.

**A10. `codegen --config` 기본값 부재 — doctor와 비대칭 (구 M12 잔존)**
- 증거: `packages/cli/src/cli-options.ts:39-41` — `rustra codegen`(무인자)이
  "codegen requires --config <path>"로 실패(실측). `rustra doctor`는
  `rustra.json` 기본 해석(실측).
- 개선안: `./rustra.json` 존재 시 기본 채택. examples 대부분이 파일명
  rustra.json으로 관례화돼 있다.
- 비용: **XS**.

**A11. RN 코드젠 전 어댑터 미설치가 조용히 폴백한다**
- 증거: `packages/cli/src/react-native.ts:70-106`
  `resolveReactNativeAdapterNative`은 완전하나 버전 불일치인 경우만 loud
  fail하고, 미설치(경로 자체가 없음)면 검증 없이 기본 경로
  `node_modules/@rustra/react-native/native`를 반환한다. 생성된 podspec/
  gradle이 존재하지 않는 경로를 가리키고 첫 loud 실패는 pod install/gradle
  시점 — "bun install을 먼저 하라"는 안내가 없다.
- 개선안: 폴백 반환 전 existsSync 검사 1개 + "install @rustra/react-native
  (bun install) first" 안내.
- 비용: **XS**.

**A12. 고아 생성물: examples/calculator의 positional-facade.ts가 수정 이전 렌더러 산물**
- 증거: `examples/calculator/generated/positional-facade.ts`에 `void options;`
  26곳 + 동기 throw 헬퍼 — 0df517eb(감사 #6/#7 수정) **이전** 출력. calculator의
  rustra.json에 `positional: true`가 없어 이 파일은 codegen이 재생성·체크하지
  않는다(RN 2예제의 동일 파일은 수정 후 출력으로 확인). docs가 이 파일을
  인용하면 결함 코드를 가르치게 된다.
- 개선안: 파일 삭제(권장 — config가 positional을 요구하지 않음) 또는
  `positional: true` 추가 후 재생성.
- 비용: **XS**.

**A13. rkyv registry eager import — RN 번들 크기가 전체 명령 수에 비례**
- 증거: `examples/calculator/generated/rkyv-registry.ts:9-`가 **모든** 코덱을
  import해 Map을 즉시 구성(31명령 기준 rkyv-codecs.ts 94KB ≈ 3KB/명령).
  bun/RN 생성 엔트리가 이를 정적 import한다(init-entries.ts:100,134). Node/
  Tauri 엔트리(JSON 경로)는 registry를 import하지 않아 문제 없음 — 정작
  번들 크기가 가장 예민한 RN에서만 전체 코덱이 번들에 들어간다.
  `@rustra/types`는 `sideEffects: false`지만 registry가 전체를 참조해
  트리셰이킹이 무력화된다.
- 개선안: registry를 lazy 팩토리 Map(`Map<string, () => Codec>`)으로 렌더하거나,
  사용 명령만 등록하는 옵트인(엔트리별 서브셋 registry)을 제공. 100명령급
  패키지에서 수백 KB 절감.
- 비용: **M**(생성 포맷+네이티브 협상 경로 회귀).

**A14. `rustra init --host`가 bun/tauri를 지원하지 않는다**
- 증거: `packages/cli/src/cli-init.ts:11` `INIT_HOSTS = ['node','react-native']`.
  Bun 신규 사용자는 `[lib] crate-type cdylib` 1줄을 문서로 배워 수동 추가해야
  한다(§2). Tauri는 rustra.json `tauri: {}` + Rust 1줄 + withGlobalTauri를
  각각 흩어진 문서에서 조립해야 한다(문서 감사 P2 여정과 동일 지적).
- 개선안: bun 변형(libSection cdylib + demo를 bun.ts 경로로)과 tauri 변형
  (host 섹션 + Cargo features + 안내 출력) 추가. 템플릿 엔진은 이미
  hosts.reactNative 분기를 갖고 있어 확장 축이 잡혀 있다.
- 비용: **S-M**.

**A15. 마이그레이션 문서가 0.5→0.6에서 멈춤 — 업그레이드 안내 공백**
- 증거: `docs/migrations/`의 최신 항목이 0.5-to-0.6. 0.7(hot-reload/inspector
  트랙, legacy subscribeEvent 제거 — react-native CHANGELOG 0.7.0 breaking
  포함)과 0.8(타입화 에러 코드젠 등)에 대한 안내가 없다. doctor는
  generatorVersion drift를 감지하지만(doctor-checks.ts:303-304) 안내가
  "Run rustra codegen"뿐이라 마이그레이션 문서로 연결되지 않는다.
- 개선안: 릴리스 절차에 "breaking/제거 포함 시 migrations/NN-to-NN 문서"
  의무화 + doctor의 version drift 경고에 문서 링크 추가.
- 비용: **S**.

### C. LOW

**A16. `generate --format json`이 구형 shape (구 M9 잔존)**
- 증거: `packages/cli/src/cli-generate.ts:35-43` — `{command, checked,
  outputPath, files}`에 `schemaVersion` 없음. doctor/codegen/diff는
  `schemaVersion: 1`(cli-json-format.ts)으로 통일돼 있다(실측).
- 개선안: 동일 래퍼로 통일. 비용: **XS**.

**A17. `rustra dev --inspect` 힌트가 한국어 하드코딩 (구 L18 잔존)**
- 증거: `packages/cli/src/dev.ts:150-151` — 2줄 한국어 console.log. 다른 CLI
  출력은 영문.
- 개선안: 영문 전환(또는 메시지 카탈로그). 비용: **XS**.

**A18. `generate --watch`는 schema.json만 감시**
- 증거: `packages/cli/src/cli-generate.ts:136-144` — Rust 소스 변경은 감시
  대상 아님. `rustra dev --config`가 실루프(dev.ts:283-322)라 기능 중복은
  없으나, `--watch` 이름이 "Rust까지 본다"로 오독될 수 있다.
- 개선안: 도움말에 "schema-only; for the full Rust loop use rustra dev"
  1줄. 비용: **XS**.

### D. 성능 지향 중 DX 영역 (질문 4)

- **코드젠 속도 — 조치 불요(실측 양호)**: 31명령 TS 9파일 0.196s, RN
  풀경로(TS+C++ 코덱+모듈 스캐폴드) 0.248s. 벤치마크 예제가 코드젠 속도를
  상시 측정 중(examples/benchmark). 개선 여지가 사용자 체감 밖.
- **생성물 크기 — A13이 본 축**: rkyv-codecs.ts 94KB(31명령) + registry
  eager 참조로 RN 번들에 전량 유입. 트리셰이킹 무력화 구조(lazy 팩토리)
  개선이 유일한 실체 후보.
- **런타임 초기화 비용 — 조치 불요**: RN은 엔진당 capability mask 1회
  캐시(2026-08-23 설계), Node는 프로세스당 child 1회 spawn, Tauri는 무상태.
  초기화 지연에 대한 사용자 보고·벤치 근거 없음. 단 **A1이 초기화 신뢰성
  문제**로서 체감 지연(오류→재빌드→재시도)의 최대 원인이다.

## 5. 권고 슬라이스

**슬라이스 1 — "조용한 성공 제거 + 정합" 일괄 (전부 XS, 반나절 트랙)**
A2(정정), A3, A4, A5(갱신), A6, A7, A8, A9, A10, A11, A12. 직전 DX 트랙과
동일 브레드의 잔존·신규 인스턴스로, 한 changeset으로 적립 가능. 각각 이미
in-repo 선례(generate의 에러 래핑, bun-ffi의 fix 안내, doctor의 기본 config)를
따르는 것이어서 설계 비용이 0에 수렴한다.

**슬라이스 2 — zero-config 신뢰성 (다음 트랙 본체)**
A1(후보별 계약 검증 폴백) + A2 근본(probe 원자적 갱신). zero-config의
클레임이 "동작한다"에서 "실패 경로에서도 정직하다"로 올라가는 축. 스테일
release 픽스처를 만드는 회귀 테스트 포함.

**슬라이스 3 — 확장 (0.9+)**
A13(RN lazy registry — 성능 트랙과 접점), A14(init bun/tauri), A15(업그레이드
안내 체계), A16~A18(사소). A13은 perf 트랙 번들 크기 지표와, A14~A15는 문서
감사의 구조 제안(P2/P3 여정)과 함께 가는 것이 저렴하다.

**명시적 범위 밖**: 문서 사용성 전반(페르소나 여정, 읽기 순서, 예제 연결)은
`docs/research/2026-09-08-docs-usability-audit.md` 소관 — 본 문서는 코드
대조가 필요한 매트릭스·버전 스니펫 2건만 이곳에서 확정했다. Tauri WebView
실사용 조작·모바일 실기기 성능은 기존 runtime proof 추적 유지.

## 재현 메모 (차기 검증용)

- A1: `cd examples/calculator && touch src/lib.rs && cargo build` 후
  `target/release`가 남아 있는 상태에서 `bun apps/node-app.ts` — mismatch
  재현. `RUSTRA_BUN_LIBRARY=<debug dylib> bun apps/bun-ffi-app.ts`는 성공.
- A2: `cd examples/react-native-calculator && bun run codegen:check` —
  "Rust codegen did not produce …" 확정 실패. 비-check 모드는 "2 + 3 = 5"
  출력 후 성공(스키마 미갱신).
- A3/A10/A16: 본문 실측 명령 그대로.
- 첫 사용 흐름 전체: `/tmp`에 `rustra init` → 본문 §3 표의 6명령.

## 관련 리서치

- `docs/research/2026-09-04-dx-friction-audit-refresh.md` — 직전 감사(조용한 성공/실패)
- `docs/research/2026-09-08-docs-usability-audit.md` — 동일일 문서 사용성 감사
- `docs/plans/2026-08-24-cross-host-zero-config-design.md` — zero-config 설계 원전
- `docs/plans/2026-08-23-rn-generated-auto-routing-design.md` — RN 생성 API 라우팅
- `docs/research/2026-09-07-competitive-landscape.md` — 경쟁 비교(기능 축)

## 출처 (경쟁자 비교)

- [Tauri 2 — Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/)
- [Nitro Modules — How to build a Nitro Module](https://nitro.margelo.com/docs/getting-started/how-to-build-a-nitro-module) / [Creating a Nitro Module](https://nitro.margelo.com/docs/concepts/nitro-modules)
- [UniFFI user guide](https://mozilla.github.io/uniffi-rs/) / [Foreign-language Bindings tutorial](https://mozilla.github.io/uniffi-rs/0.27/tutorial/foreign_language_bindings.html) / [docs.rs uniffi_bindgen](https://docs.rs/uniffi_bindgen/latest)
