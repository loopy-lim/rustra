[English](./gate-map.md) | 한국어

# 게이트 맵

이 저장소의 모든 품질 게이트를 한 문서에 모은다: lefthook pre-commit 훅, 루트
`package.json` 게이트 스크립트, GitHub Actions 워크플로 — 각각이 지키는 불변식,
로컬 실행 대략 비용, 그리고 `main` 브랜치 보호가 실제로 요구하는 필수 체크.

- **2026-09-20** 기준, 작업 트리와 라이브 브랜치 보호 설정에서 검증했다.
- 비용은 정성 등급(빠름/중간/느림)이며, 실측값이 있는 곳만 수치를 표기한다:
  웜 캐시 `cargo check --workspace` ≈ 8.4초, `bun run test:fast` ≈ 15초
  (2026-09-20 실측).
- 관련 문서: [CONTRIBUTING](../CONTRIBUTING.ko.md)(기여 흐름과 상황별 게이트
  표), [릴리스 절차](./release-procedure.ko.md)(릴리스 게이트와 필수 체크
  등록).

## 계층 1 — pre-commit (lefthook)

`lefthook.yml`에 정의되고 `bun install`의 `prepare` 스크립트로 설치된다.
스테이지된 파일만 검사한다(`{staged_files}`).

| 명령     | Glob                     | 실행                                       | 지키는 것                                        |
| -------- | ------------------------ | ------------------------------------------ | ------------------------------------------------ |
| eslint   | `packages/*/src/**/*.ts` | `bunx eslint --fix {staged_files}`         | 워크스페이스 패키지 TS 린트 규칙                 |
| prettier | `*.{ts,js,json,yml,md}`  | `bunx prettier --write {staged_files}`     | 포맷 일관성(CI에서 `format:check`으로 재검증)    |
| rustfmt  | `*.rs`                   | `rustfmt --edition 2024 -- {staged_files}` | Rust 포맷(CI에서 `cargo fmt --check`으로 재검증) |

참고:

- `parallel: true` — 세 명령이 동시에 실행된다.
- 세 명령 모두 `stage_fixed: true` — 훅이 고친 파일은 같은 커밋에 자동으로
  다시 스테이지된다.
- **pre-push 훅은 없다** — 로컬 커밋과 CI 사이에서 실행되는 것은 아무것도
  없다.
- 훅은 편의이지 게이트가 아니다: 포맷과 린트는 CI에서 재검증된다
  (`cargo fmt -- --check`, `bun run format:check`, `bun run lint`).

## 계층 2 — `package.json` 게이트 스크립트

아래 스크립트는 저장소 루트에서 `bun run <스크립트>`로 실행한다.
"지키는 것"은 스크립트가 실패하면 깨진 불변식이다.

| 스크립트                       | 그룹           | 지키는 것                                                                                                                   | 비용            | 로컬 실행 참고                                             |
| ------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------- |
| `test`                         | umbrella       | release-tools, types, ts:bun, packages, cli, complex-codec-bench, bench-gate, functions 단위/E2E 묶음                       | 느림            | CI 미러가 아님 — CI TS 잡들이 상위집합이다                 |
| `test:fast`                    | umbrella       | 첫 신호: 워크스페이스 컴파일, calculator 타입 체크, CLI 단위 테스트                                                         | 빠름 (웜 ≈15초) | 대부분 `cargo check --workspace` 웜 ≈8.4초                 |
| `test:compat`                  | 호환 체인      | 전체 Rust↔TS 호환 매트릭스(ts:node + ts:bun + adapters + runtime)                                                           | 느림            | PR 전 최소 기준(CONTRIBUTING)                              |
| `test:ts:node`                 | 호환 체인      | 컴파일된 `dist-ts` 예제 테스트(calculator + crud)가 Node `--test`로 통과                                                    | 중간            | 두 예제에 `tsc` 먼저 실행                                  |
| `test:ts:bun`                  | 호환 체인      | 예제 TS 테스트가 Bun에서 디버그 calculator 바이너리로 통과                                                                  | 중간            | `rustra-calculator-example` 디버그 빌드 먼저               |
| `test:adapters`                | 호환 체인      | 어댑터 묶음: tauri + react-native(모의 transport) + RN 예제 타입 체크                                                       | 중간            | 아래 세 `test:adapter:*`/`test:app:react-native` 체인      |
| `test:adapter:tauri`           | 호환 체인      | 모의 transport로 Tauri 어댑터 동작 검증                                                                                     | 중간            | 빌드된 워크스페이스 필요                                   |
| `test:adapter:react-native`    | 호환 체인      | 모의 transport로 RN 어댑터 동작 검증(실 FFI 아님)                                                                           | 중간            | 빌드된 워크스페이스 필요                                   |
| `test:app:react-native`        | 호환 체인      | `examples/react-native-calculator` 타입 체크 통과                                                                           | 빠름            |                                                            |
| `test:runtime`                 | 호환 체인      | 실제 Rust↔TS 실행: node + bun + tauri 예제 앱                                                                               | 느림            | 내부에 릴리스 빌드 포함                                    |
| `test:runtime:node`            | 호환 체인      | 릴리스 FFI 바이너리로 Node 앱 E2E                                                                                           | 느림            | `cargo build --release` 먼저                               |
| `test:runtime:bun`             | 호환 체인      | 릴리스 바이너리로 Bun FFI 앱 실행                                                                                           | 느림            | `test:runtime:bun-ffi`와 동일 체인                         |
| `test:runtime:tauri`           | 호환 체인      | Tauri 예제 빌드 + 스모크 통과                                                                                               | 느림            | `examples/tauri-calculator` 빌드 + 스모크                  |
| `test:runtime:native`          | 호환 체인      | 네이티브 애드온/FFI 묶음: node-napi + bun-ffi                                                                               | 느림            | 아래 둘의 체인                                             |
| `test:runtime:node-napi`       | 호환 체인      | napi 디버그 애드온 빌드 + Node napi 앱 실행                                                                                 | 중간            | `bun run build:napi` 먼저                                  |
| `test:runtime:bun-ffi`         | 호환 체인      | 릴리스 바이너리로 Bun FFI 앱 실행                                                                                           | 느림            | `test:runtime:bun`과 동일 체인                             |
| `test:types`                   | 패키지 단위    | `@rustra/types` 빌드 + 엔진 코어 계약 테스트 통과                                                                           | 빠름            |                                                            |
| `test:packages`                | 패키지 단위    | 전 워크스페이스 패키지 빌드 + node/bun/tauri/react-native/testing/devtools/react 단위 테스트                                | 느림            | `packages/bun` FFI caller-buffer 계약 포함                 |
| `test:api-surface`             | 원천 진실      | 공개 Rust/TS export가 `api-surface/snapshot.json`과 일치(드리프트 게이트)                                                   | 중간            | `scripts/api-surface-rust` 파서 컴파일                     |
| `test:codegen-fresh`           | 원천 진실      | 커밋된 `examples/*/generated`가 현재 소스에서 재현됨                                                                        | 중간            | CLI 재빌드; 고칠 땐 예제에서 `bun run codegen`             |
| `test:bindings-fresh`          | 원천 진실      | UniFFI Swift/Kotlin 바인딩이 Rust 크레이트 대비 최신                                                                        | 중간            | CLI 재빌드 + 바인딩 재생성                                 |
| `test:architecture`            | 원천 진실      | 모듈 경계와 파일 라인 상한 유지                                                                                             | 빠름            |                                                            |
| `test:docs`                    | 원천 진실      | `docs:sync` 영역이 생성물과 byte-for-byte 일치, en/ko 미러 완전성, 설치 문서 vs 매니페스트                                  | 빠름            | 이 문서도 미러 게이트 스코프다                             |
| `test:onboarding`              | 원천 진실      | 신규 사용자 여정(init → doctor → codegen → demo)이 임시 디렉터리에서 동작                                                   | 중간            | `bun run build` 이후 실행                                  |
| `test:release-coherence`       | 릴리스 정합    | 패키지별 버전, 락파일, 내부 범위, CLI `rustraTemplate` 범위, LICENSE, fixed group                                           | 빠름            |                                                            |
| `test:release-tools`           | 릴리스 정합    | 릴리스 도구 스크립트 자체의 단위 테스트(coherence, packed consumer, api-surface, version-packages, gates, registry, safety) | 빠름            |                                                            |
| `test:registry-consumer`       | 릴리스 정합    | 레지스트리 컨슈머 게이트 스크립트의 단위 테스트                                                                             | 빠름            |                                                            |
| `verify:package:react-native`  | 릴리스 정합    | RN 네이티브 파일이 발행 tarball에 존재                                                                                      | 빠름            |                                                            |
| `verify:consumer:react-native` | 릴리스 정합    | packed(file:) 컨슈머가 RN 네이티브 소스를 해석                                                                              | 빠름            |                                                            |
| `verify:consumer:registry`     | 릴리스 정합    | 정확한 발행 버전(npm/crates.io)이 설치·실행됨(공개 레지스트리 수용)                                                         | 느림            | 네트워크; 수동 — `registry-consumer.yml` 참고              |
| `verify:release-gates`         | 릴리스 정합    | 후보 SHA가 요구되는 CI green 체크를 갖는지(GitHub API)                                                                      | 빠름            | `GH_TOKEN` 필요; `release.yml`이 강제하는 것과 같은 검사기 |
| `audit:prod`                   | 릴리스 정합    | npm prod 의존성 high 이상 취약점 없음                                                                                       | 빠름            | 네트워크                                                   |
| `audit:registry`               | 릴리스 정합    | 발행된 레지스트리 상태(정확한 버전, gitHead, crate SHA, 체크섬) 정합                                                        | 중간            | 네트워크; 발행 후 감사                                     |
| `test:complex-codec-bench`     | 벤치 영수증    | 복합 코덱 영수증 + track-b 벤치 하니스 회귀                                                                                 | 중간            | 벤치 스크립트의 단위 테스트                                |
| `test:bench-gate`              | 벤치 영수증    | Criterion 회귀 게이트 로직(`check-criterion-regression.mjs`) 계약 동작                                                      | 빠름            |                                                            |
| `test:app:streaming`           | 예제 앱        | 스트리밍 예제 빌드 + Node 앱 실행                                                                                           | 느림            | 내부에 cargo 빌드                                          |
| `test:app:auth`                | 예제 앱        | 인증 예제 빌드 + 앱 실행                                                                                                    | 느림            | 내부에 cargo 빌드                                          |
| `test:app:reference`           | 예제 앱        | 레퍼런스 앱이 crud 예제 크레이트로 실행                                                                                     | 느림            | 내부에 cargo 빌드                                          |
| `test:functions`               | functions      | 일반 함수 등록 엔드투엔드 통합                                                                                              | 중간            |                                                            |
| `lint`                         | aux (CI 스텝)  | `packages/*/src` ESLint 통과                                                                                                | 빠름            | CI `ts-checks` 잡이 실행                                   |
| `format:check`                 | aux (CI 스텝)  | `packages/*/src`에 prettier 차이 없음                                                                                       | 빠름            | CI `ts-checks` 잡이 실행                                   |
| `lint:rust`                    | aux (CI 스텝)  | 전 타깃 clippy 경고 0(`-D warnings`)                                                                                        | 중간            | CI `rust` 잡(Linux leg)이 실행                             |
| `fmt:rust:check`               | aux (CI 스텝)  | `cargo fmt` 차이 없음                                                                                                       | 빠름            | CI `rust` 잡(Linux leg)이 실행                             |
| `coverage:rust`                | aux (참고용)   | `rustra` + `rustra-macros` 커버리지 가시화                                                                                  | 느림            | `coverage.yml` 미러(게이트 아님)                           |
| `coverage:ts`                  | aux (참고용)   | 8개 패키지 단위 스위트의 커버리지 가시화                                                                                    | 중간            | `coverage.yml` 미러(게이트 아님)                           |
| `bench`                        | aux (벤치마크) | transport 벤치 수치(`bench:bun`과 같은 명령)                                                                                | 느림            |                                                            |
| `bench:complex`                | aux (벤치마크) | 복합 코덱 벤치 수치                                                                                                         | 느림            |                                                            |
| `bench:track-b`                | aux (벤치마크) | track-B 벤치 수치                                                                                                           | 느림            |                                                            |
| `bench:hosts`                  | aux (벤치마크) | 호스트(node/bun) 벤치 수치                                                                                                  | 느림            |                                                            |
| `bench:functions`              | aux (벤치마크) | 함수 디스패치 criterion 벤치                                                                                                | 느림            |                                                            |

게이트가 아님(위 표 제외): `build`, `build:napi`, fixer(`lint:fix`, `format`,
`fmt:rust`), `clean:*`, `changeset`, `version`, `release`, `docs:api`,
`prepare`.

### `test:local` — "CI가 도는 것을 로컬에서 도린다" umbrella

`test:local`은 CI TS 잡들(`ts-checks` + `ts-tests` + `ts-runtime` — 구
`typescript` 메가잡의 2026-09-20 분할)의 로컬 실행 가능 스텝을 한 명령으로
미러링한다 (2026-09-20 추가):

> `bun run build` → `test:release-coherence` → `lint` → `format:check` →
> `audit:prod` → `test:ts:node` → `test:ts:bun` → `test:adapters` →
> `bun run --cwd packages/cli test` → `test:complex-codec-bench` →
> `test:bench-gate` → `test:api-surface` → `test:codegen-fresh` →
> `test:bindings-fresh` → `test:architecture` → `test:release-tools` →
> `test:registry-consumer` → `test:runtime:node` → `test:runtime:bun` →
> `test:packages` → `test:onboarding` → `test:docs`

로컬에서 미러링되지 않는 CI 전용 스텝: react-doctor, calculator/crud
`--noEmit` tsc 체크, bare RN 픽스처 codegen/typecheck, C++ 생성 코덱 테스트.
느린 실행을 예상하라 — 릴리스 빌드 두 번(`test:runtime:node`,
`test:runtime:bun`)을 포함한다.

## 계층 3 — GitHub Actions

### `ci.yml` — 16개 잡

트리거: `main`으로의 push와 PR, 그리고 주간 월요일 cron(이때 `rust-audit`만
실행 — 다른 잡은 전부 `github.event_name != 'schedule'`으로 스킵, `gate`
집계 잡 포함). PR 실행은 같은 ref의 진행 중 실행을 취소한다; main push는
절대 취소하지 않는다.

| 잡                | 지키는 것                                                                                                                                                            | 필수 체크 (2026-09-20)                                                               | 로컬 등가물                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `changes`         | 경로 필터(dorny/paths-filter): docs 전용 PR에서만 `code=false` 출력, 그 외 이벤트는 `code=true` 강제                                                                 | 필수 아님(모바일 잡 `if`와 `gate`에 전달)                                            | —                                                                                                   |
| `rust-audit`      | 실행 가능한 RUSTSEC 권고 없음(`scripts/audit-rust.sh`; 문서화된 Tauri 2/GTK3 예외만 허용)                                                                            | **필수** (`rust-audit`)                                                              | `bash scripts/audit-rust.sh` (`cargo-audit` 필요)                                                   |
| `rust-deny`       | 라이선스/밴/출처 정책(`deny.toml`, cargo-deny)                                                                                                                       | 필수 아님                                                                            | `cargo deny check`                                                                                  |
| `rust` (매트릭스) | rustfmt + clippy + `cargo test --workspace`(+ `--release`, hot-core)는 Linux, 코어 크레이트는 macOS/Windows, 릴리스 cdylib 빌드                                      | **필수 ×3** (`rust (ubuntu-latest)`, `rust (macos-latest)`, `rust (windows-latest)`) | `cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace` |
| `rust-msrv`       | MSRV 1.88 계약: 코어 크레이트를 Rust 1.88에서 check + lib 테스트                                                                                                     | 필수 아님                                                                            | `rustup run 1.88 cargo check -p rustra -p rustra-macros`                                            |
| `rust-wasm32`     | `rustra`가 `wasm32-unknown-unknown`으로 컴파일됨                                                                                                                     | 필수 아님                                                                            | `cargo check -p rustra --target wasm32-unknown-unknown`                                             |
| `napi`            | napi 디버그 애드온 빌드 + Node napi 앱 실행(무검증이던 transport 경로)                                                                                               | 필수 아님                                                                            | `bun run test:runtime:node-napi`                                                                    |
| `ts-checks`       | 정적 TS 게이트: 빌드, 린트, 포맷, react-doctor(100/100), `audit:prod`, tsc, api-surface + codegen-fresh + bindings-fresh + architecture + docs + onboarding 게이트   | `gate` 경유 (구 `typescript`)                                                        | `bun run test:local` (검사 부분)                                                                    |
| `ts-tests`        | 빌드 산출을 소비하는 테스트: ts:node + ts:bun + adapters + CLI, 패키지 단위, bench-gate/release-tools/registry-consumer 게이트 유닛, C++ 코덱 테스트, bare RN 픽스처 | `gate` 경유 (구 `typescript`)                                                        | `bun run test:local` (테스트 부분)                                                                  |
| `ts-runtime`      | 실제 Rust↔TS 실행: 릴리스 빌드 기반 node + bun + tauri 예제 앱(구 `test:compat` 체인의 `test:runtime` 구간)                                                          | `gate` 경유 (구 `typescript`)                                                        | `bun run test:runtime`                                                                              |
| `rn-android`      | RN Android Release APK 빌드 + 에뮬레이터 스모크가 엔진 마커 단언; docs 전용 PR에서는 스킵                                                                            | **필수** (`rn-android`)                                                              | `bash scripts/ci-android-runtime-smoke.sh rn` (NDK + 에뮬레이터 필요)                               |
| `rn-ios`          | RN iOS Release 빌드 + 시뮬레이터 스모크가 엔진 마커 단언; docs 전용 PR에서는 스킵                                                                                    | **필수** (`rn-ios`)                                                                  | `bash scripts/ci-ios-runtime-smoke.sh` (macOS, 시뮬레이터)                                          |
| `uniffi-android`  | UniFFI Kotlin 바인딩이 에뮬레이터에서 로드·실행(행복 + divide-by-zero 에러 경로); docs 전용 PR에서는 스킵                                                            | 필수 아님                                                                            | `examples/uniffi-android-smoke` 흐름(단일 명령 등가물 없음)                                         |
| `uniffi-ios`      | UniFFI Swift 바인딩이 iOS 시뮬레이터에서 실행(동일 마커 계약); docs 전용 PR에서는 스킵                                                                               | 필수 아님                                                                            | `bash examples/uniffi-ios-smoke/build-and-run.sh`                                                   |
| `consumer-smoke`  | packed tarball이 클린 컨슈머에 설치·로드(ESM)되고 CLI `init`→codegen→run 흐름 동작                                                                                   | **필수** (`consumer-smoke`)                                                          | `bun run verify:package:react-native && bun run verify:consumer:react-native` (일부)                |
| `gate`            | 집계: 위 14개 잡이 전부 정확히 `success`여야 함; `skipped`는 실패(무음 green 방지) — 단, 네 모바일 잡의 스킵이 경로 필터 기인(docs 전용 PR)일 때만 예외              | **필수 아님** (2026-09-20 검증)                                                      | `node --experimental-strip-types --test scripts/ci-gate.test.ts`                                    |

참고:

- `gate` 집계 잡은 브랜치 보호가 단일 체크만 요구할 수 있게 존재하고, 깨진
  체인이 green으로 읽히지 않게 skipped를 실패로 친다. 유일한 예외
  (2026-09-20): docs 전용 PR에서는 네 모바일 에뮬레이터 잡
  (`rn-android`, `rn-ios`, `uniffi-android`, `uniffi-ios`)이 `changes` 경로
  필터로 스킵되며, `gate`(이벤트 이름과 필터 출력을 받는
  `scripts/ci-gate.sh` 경유)는 정확히 이 스킵만 통과로 인정한다. 그 외 모든
  스킵은 여전히 gate를 실패시킨다 — 예컨대 `ts-checks`/`ts-tests`/`ts-runtime`
  잡 실패로 인한 `consumer-smoke` 스킵은 그대로 red다. GitHub은 스킵 상태로 끝난
  필수 체크를 요건 충족으로 보므로 docs 전용 스킵이 머지를 막지 않는다. 라이브
  보호는 2026-09-20 부터 정확히 `gate` 하나를 요구한다 —
  [현재 필수 체크](#현재-필수-체크) 참고.

### 기타 워크플로

| 워크플로                              | 트리거                                     | 지키는 것                                                                     | 필수 체크 | 로컬 등가물                                                                         |
| ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `release.yml`                         | main에서 CI 성공(`workflow_run`) 또는 수동 | 발행은 언제나 green CI SHA에서만: 후보 고정, 발행 전 게이트 재확인            | 아니오    | `bun run verify:release-gates` (같은 검사기)                                        |
| `miri.yml` (release 경유 + 주간)      | workflow_call, 주간 일요일 cron, 수동      | `rustra`의 unsafe/순수 로직 경로 UB(lib, frame_wire, field_order_drift)       | 아니오    | `bash scripts/run-safety-check.sh lib cargo miri test -p rustra --lib` (nightly)    |
| `sanitizer.yml` (release 경유 + 주간) | workflow_call, 주간 일요일 cron, 수동      | 메모리 오염/누수: `cargo test -p rustra --lib`에 ASan+LSan                    | 아니오    | nightly `-Zsanitizer=address`로 같은 명령                                           |
| `fuzz.yml` (release 경유 + 주간)      | workflow_call, 주간 토요일 cron, 수동      | 프레임 디코드 경로가 무작위 입력에 버티는지(3 타깃 × 10분 + 시드 corpus 재생) | 아니오    | `cargo fuzz run invoke_frame ...` (nightly, `fuzz/` 크레이트)                       |
| `coverage.yml`                        | main push, 수동                            | 참고용 — 명시적으로 게이트 아님("가시화"): Rust llvm-cov + TS c8 요약         | 아니오    | `bun run coverage:rust` / `bun run coverage:ts`                                     |
| `bench.yml`                           | main push(경로 필터), 수동                 | 성능 회귀 예산: criterion vs 이전 베이스라인, 10% 임계                        | 아니오    | `cargo bench` 후 `bun scripts/check-criterion-regression.mjs --max-regression 0.10` |
| `registry-consumer.yml`               | 수동 전용                                  | 정확한 발행 버전이 macOS에서 설치·동작, 영수증 아티팩트                       | 아니오    | `bun run verify:consumer:registry`                                                  |

`miri.yml`, `sanitizer.yml`, `fuzz.yml`는 재사용 워크플로다: 주간 스케줄로도
도리고, 모든 `release.yml` 발행의 필수 의존으로도 도린다
([릴리스 절차](./release-procedure.ko.md) 전제 조건 참고).

## 언제 어떤 게이트를

| 상황                            | 무엇이 도는지                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 모든 `git commit`(자동)         | lefthook pre-commit: 스테이지 파일에 eslint --fix, prettier --write, rustfmt(자동 재스테이지)                                                                         |
| pre-push                        | 없음 — pre-push 훅 미구성                                                                                                                                             |
| 로컬 편집 루프                  | `bun run test:fast` (웜 ≈15초)                                                                                                                                        |
| 상황별(docs, codegen, 표면...)  | CONTRIBUTING의 [Which Gate When](../CONTRIBUTING.ko.md) 표(`test:docs`, `test:codegen-fresh`, `test:api-surface`, `test:architecture`, `test:release-coherence`, ...) |
| PR 열기 전                      | 최소 `bun run test:compat`; 만진 것에 따라 위 상황별 게이트 추가                                                                                                      |
| docs 전용 변경                  | `bun run test:docs` (docs:sync 영역 + en/ko 미러 — 이 파일도 스코프); docs 전용 PR에서는 네 모바일 에뮬레이터 CI 잡이 자동 스킵된다                                   |
| main에서만(절대 PR 게이트 아님) | `bench.yml`(경로 필터), `coverage.yml`                                                                                                                                |
| 릴리스 전용                     | `release.yml` 경유 `miri` + `sanitizer` + `fuzz`, registry-consumer(수동), 발행 후 `audit:registry` — [릴리스 절차](./release-procedure.ko.md) 참고                   |

모바일/에뮬레이터 스위트(`rn-android`, `rn-ios`, `uniffi-*`)는 쓸 만한 로컬
등가물이 없다; 이들은 CI에 의지한다.

## 현재 필수 체크

**2026-09-20 (적용됨):** `main` 브랜치 보호는 정확히 하나의 컨텍스트 —
`["gate"]` — 만 필수로 요구한다. 같은 날 오전 감사가 이전 상태를 기록한 뒤
전환을 적용했으므로 두 상태 모두 이 문서에 남는다:

- **전환 전(2026-09-20 오전):** 8개 개별 컨텍스트 — `rust-audit`,
  `rust (ubuntu-latest)`, `rust (macos-latest)`, `rust (windows-latest)`,
  `typescript`, `rn-android`, `rn-ios`, `consumer-smoke`. 이 체계에서는 위
  ci.yml 표의 "필수" 표기가 곧 머지 블로커였다.
- **전환 후(2026-09-20 적용, `strict: false` 유지):** 필수 컨텍스트는 `gate`
  하나. `gate`가 12개 잡 전부를 `needs`로 요구하므로 머지 조건 집합은
  **넓어졌다** — 구 required 밖이던 `rust-msrv`, `rust-wasm32`, `rust-deny`,
  `napi`, `uniffi` 2잡이 포함된다. 위 표의 "필수" 열은 이력으로 읽고, 모든 잡은
  **집계를 경유해** 머지를 막는다.
- **2026-09-20 (같은 날, 이후):** `typescript` 메가잡을 `ts-checks`,
  `ts-tests`, `ts-runtime` 3잡으로 분할했다(gate `needs`: 코드 잡 12 → 14개).
  분할이 안전한 이유는 필수 체크가 `gate` 하나뿐이기 때문이다 — `gate`의
  `needs`와 `scripts/ci-gate.sh`가 함께 갱신되는 한(`scripts/ci-gate.test.ts`가
  양쪽 일치를 loud 하게 검증) 잡 이름은 자유롭게 바꿀 수 있다. TS 잡들은 docs
  전용 PR에서 스킵되지 않는 구 계약도 그대로 유지한다.

한 단계 재검증:

```bash
gh api repos/loopy-lim/rustra/branches/main/protection --jq '.required_status_checks.contexts'
```

향후 감사가 알아야 할 사실:

- 8개 개별 컨텍스트로의 롤백과 변경 절차는
  [릴리스 절차](./release-procedure.ko.md) Step 3.5에 문서화돼 있다.
- docs 전용 PR에서는 모바일 에뮬레이터 잡(`rn-android`, `rn-ios`,
  `uniffi-android`, `uniffi-ios`)이 `skipped` 상태로 끝난다(`changes` 경로
  필터); `gate`는 정확히 이 스킵만 통과로 인정해 green을 유지하고 머지 요건도
  충족된다. docs 전용 PR도 머지된다 — 설계된 동작이지 보호 설정의 regression이
  아니다.
- CI 잡을 추가/제거할 때는 이 맵과 `gate`의 `needs`(+ `scripts/ci-gate.sh`)를
  함께 갱신한다 — 이제 집계 잡이 곧 머지 계약이다.
