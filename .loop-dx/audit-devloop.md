# 감사 보고서: 빌드/테스트 개발 루프 및 스크립트 인체공학 (audit-devloop)

- 작업 ID: `audit-devloop`
- 대상: rustra-bridge 모노레포 (Rust 코어 + TS 코드젠/어댑터 브릿지)
- 읽기 범위: `package.json`, `packages/*/package.json`, `Cargo.toml`, `lefthook.yml`, `bunfig.toml`, `.github/workflows/**`, `scripts/**`, `CONTRIBUTING.ko.md`, `examples/*/tsconfig.json`
- 방법론: 스크립트 그래프 정적 분석(우산 스크립트 1회 실행 시 하위 스크립트 호출 횟수 집계) + 웜 상태 실측 + 컴파일된 테스트 산물 vs 스크립트 나열 목록 대조
- 심각도 기준: **상** = 이미 손실이 발생했거나 신뢰를 깨는 수준 / **중** = 반복 비용·추측 비용이 누적되는 수준 / **하** = 개선 여지가 있는 마찰(friction)

---

## 요약: 상위 3개 불편 포인트

### 1. [상] 수동 파일 나열 스크립트가 "침묵 속 테스트 누락"을 이미 만들고 있다

`test:ts:node`와 `packages/cli test`는 실행할 테스트 파일을 하드코딩하는데, 실제 컴파일 산물과 대조하면 **이미 드리프트가 발생해 일부 테스트가 어디에서도 실행되지 않는다**.

| 스크립트                           | 나열된 파일                             | 실제 존재                                                                 | 누락                                                                                                     |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `package.json` `test:ts:node`      | calculator 8개 + crud glob              | `dist-ts/examples/calculator/ts/`에 11개                                  | `devices`, `loose-invoke`, `typed-errors` — node 러너에서 미실행                                         |
| `packages/cli/package.json` `test` | dist-test 22개 + `bun test src/...` 4개 | dist-test에 29개                                                          | `generate-sync`, `generate-bound-context`, `generate-postcard-map` — **bun/node 어느 러너에서도 미실행** |
| `coverage:ts`                      | 8개 패키지의 `index.test.ts`만          | `packages/react`는 테스트 3개(`index`, `suspense-lifecycle`, `lifecycle`) | 커버리지 수치가 과대/과소 왜곡                                                                           |

`test:ts:bun`은 `examples/calculator/ts/*.test.ts` glob을 쓰므로 11개 전부 실행한다. 즉 **같은 테스트를 bun에서는 11개, node에서는 8개 돌리는 비대칭**이 현재 기준선이다. Node-패리티 검증이 목적인 스크립트가 스스로 그 목적을 달성하지 못한다. 새 테스트 파일을 추가하는 기여자는 스크립트를 수정해야 한다는 것을 알 길이 없고, 누락돼도 아무 경고가 없다.

**개선 아이디어**: (a) 나열을 glob으로 교체(`node --test dist-ts/examples/calculator/ts/*.test.js` — crud는 이미 이렇게 한다), (b) 유지해야 한다면 "tsconfig emit 산물 vs 스크립트 나열" 일치를 검증하는 게이트 스크립트 추가(`ci-gate.test.ts` 선례), (c) CLI처럼 bun 병행 목록이 있는 곳은 단일 소스(예: `test.files.json`)로 통합.

### 2. [상] 우산 스크립트 간 중복 실행과 범위 불일치 — 로컬 배터리와 CI가 다른 것을 검증한다

`test:local`(22단계)을 1회 실행하면 동일 작업이 반복 호출된다(웜 비용은 실측, 괄호):

| 중복 작업                                            | test:local 내 호출 횟수 | 호출 경로                                                      | 웜 1회 비용(실측)              |
| ---------------------------------------------------- | ----------------------- | -------------------------------------------------------------- | ------------------------------ |
| `bun run build`(9패키지 tsc 전체)                    | **2회**                 | 직접 + `test:packages` 내장                                    | 3.54s                          |
| `packages/cli build`                                 | **3회**                 | `test:codegen-fresh`, `test:bindings-fresh`, `test:onboarding` | (tsc 1회분)                    |
| `tsc -p examples/calculator`                         | **2회**                 | `test:ts:node`, `test:runtime:node`                            | 1.25s                          |
| `cargo build --release -p rustra-calculator-example` | **2회**                 | `test:runtime:node`, `test:runtime:bun`                        | 0.13s(웜) / 콜드 시 수십 초~분 |
| `cargo build`(debug)                                 | 1회                     | `test:ts:bun`                                                  | 0.62s(웜)                      |

웜 기준 낭비는 수 초지만, 클론 직후 콜드 루프에서는 cargo 두 프로파일 빌드 + tsc 전체가 단계마다 재대기된다. `test:compat`도 마찬가지로 `test:ts:node → test:runtime:node`에서 calculator tsc가 2회 실행된다.

더 큰 문제는 **범위 불일치**다:

- `test:local`에는 `test:types`(= `packages/types` 유닛 테스트 10개 파일 — 엔진 코어 계약)가 **없다**. `test:packages`도 types를 제외한 8개 패키지만 돌린다. 즉 "로컬 전체 배터리"가 코어 계약 테스트를 건너뛴다. CI(`ci.yml` ts-tests)는 명시 스텝으로 실행하므로 로컬 green → CI red가 가능한 패리티 구멍이다.
- 반대로 CI는 2026-09-20에 "구 test:compat 우산의 2회 재실행 문제"를 잡 분할로 정리했다(`ci.yml` 주석 명시). **CI는 우산 중복을 인지하고 제거했지만, 로컬 우산(`test:local`, `test:compat`)은 그대로 남아 있다.**

**개선 아이디어**: (a) `test:local`을 "셋업 1회(build, cargo 빌드) → 검증 전부" 2단계 구조로 재작성, (b) cli/codegen-fresh/bindings-fresh/onboarding이 각자 cli build 하는 것을 우산 셋업으로 승격, (c) `test:local`에 `test:types` 추가 또는 `test:packages`에 types 편입, (d) CI 주석의 "각 검증 정확히 1회" 원칙을 로컬 우산에도 적용.

### 3. [중] `test:fast`의 커버리지 격차 + 크로스플랫폼 함정, 그리고 무검증 상태

`test:fast` = `cargo check --workspace -q && tsc -p examples/calculator/tsconfig.json && bun run --cwd packages/cli test` (CONTRIBUTING 기준 웜 약 15초).

- **Linux에서 1단계가 실패할 수 있다**: `cargo check --workspace`는 `default-members`를 무시하고 macOS 전용 `examples/tauri-calculator/src-tauri`까지 검사한다(`Cargo.toml` 주석이 이 멤버를 bare 명령에서 뺀 이유를 설명). Linux 개발자의 첫 신호 루프가 환경 때문에 깨진다.
- **check는 산출물을 안 만든다**: 이후 `test:ts:bun`, `packages/bun test`가 요구하는 dylib/바이너리가 없으므로 "빠른 신호 → 실제 테스트" 전환 시 cargo build가 결국 다시 필요하다.
- **커버리지 격차**: crud 예제 미타입체크, 8개 패키지 유닛 테스트·예제 TS 테스트(bun/node 모두)·전체 게이트(codegen-fresh, api-surface 등) 미커버 — 이는 "fast"의 설계상 범위일 수 있으나, README의 `test:compat` PR 필수 문서와 사이 어느 단계도 제공되지 않는다(중간 단계 부재).
- **스크립트 자체가 무검증**: `test:fast`, `test:local` 어느 것도 CI 어디에서도 실행되지 않는다(`.github/workflows/` 전체에서 미참조). CI가 패리티를 강제하는 스크립트가 아니므로, 앞서 확인된 `test:types` 누락 같은 드리프트가 조용히 축적된다.

**개선 아이디어**: (a) `test:fast`의 cargo를 `cargo check --workspace --exclude rustra-tauri-calculator-example` 또는 default-members 존중 형태로 수정해 Linux 호환, (b) `test:types` 포함 검토(웜 수 초), (c) CI 어딘가(예: ts-checks 선두)에서 `test:fast`를 스모크 실행해 스크립트 자체를 게이트화.

---

## 상세 항목

### A. 루프 체인 / 중복

| #   | 항목                                                                                                                                                                                                                                                                   | 근거                                                                      | 심각도 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| A1  | `test:local` 22단계 체인에서 build ×2, cli build ×3, calculator tsc ×2, release cargo build ×2 중복                                                                                                                                                                    | `package.json` `test:local` 정적 전개 + 웜 실측(위 표)                    | 상     |
| A2  | `test:local`이 `test:types`(packages/types 유닛 10파일) 누락 — `test`/`test:packages`와도 불일치                                                                                                                                                                       | `package.json` 내 세 우산 정의 대조, `ci.yml` ts-tests는 명시 실행        | 상     |
| A3  | `test:compat` 내부에서 calculator tsc 2회(`test:ts:node` → `test:runtime:node`), CI는 이미 우산 분할로 해결했는데 로컬은 방치                                                                                                                                          | `package.json` `test:compat`/`test:runtime`, `ci.yml` 408~420줄 주석      | 중     |
| A4  | `test:fast`가 `--workspace`로 macOS 전용 tauri-calculator 포함 → Linux 루프 파손 가능                                                                                                                                                                                  | `Cargo.toml` `default-members` 주석, `package.json` `test:fast`           | 중     |
| A5  | `test:fast`의 `cargo check`는 링크 산출 미생성 → 후속 실제 테스트 시 재빌드 대기                                                                                                                                                                                       | `package.json` `test:fast`, `ci.yml` ts-tests의 "release dylib 필요" 주석 | 중     |
| A6  | 중간 밀도 레벨 부재: test:fast(≈15s)와 test:local(수 분~수십 분, 미실측)/test:compat 사이에 "패키지 유닛+예제 TS 테스트" 단계 없음                                                                                                                                     | `package.json` 우산 3종, `CONTRIBUTING.ko.md` 129행 표                    | 중     |
| A7  | `packages/*` 빌드가 비증분 — `tsconfig.base.json`에 `incremental` 없음(매번 전체 재컴파일, 웜 3.54s). calculator/crud만 `incremental: true`+tsbuildinfo. (`Cargo.toml` `[profile.dev] incremental=false`는 용량 사유의 의사결정으로 주석 명시 — 대비되는 TS 쪽 무결정) | `tsconfig.base.json`, `examples/calculator/tsconfig.json`, 실측           | 하     |

### B. 수동 파일 나열의 취약성

| #   | 항목                                                                                                                                                                                            | 근거                                                               | 심각도 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| B1  | `test:ts:node`가 calculator 8개만 나열 → `devices`/`loose-invoke`/`typed-errors`가 node에서 미실행(bun glob은 11개 전부)                                                                        | `package.json` vs `dist-ts/examples/calculator/ts/` 실측 대조      | 상     |
| B2  | `packages/cli test` dist-test 22개 나열 + bun 4개 → `generate-sync`/`generate-bound-context`/`generate-postcard-map` 3개 어디서도 미실행. 실제 bun:test 로직 보유(`generate-sync.test.ts` 확인) | `packages/cli/package.json`, `packages/cli/dist-test/` 대조        | 상     |
| B3  | `coverage:ts`가 8개 `index.test.ts`만 하드코딩 — react 패키지 3개 테스트 중 1개만 커버리지 반영                                                                                                 | `package.json` `coverage:ts`, `packages/react/package.json` `test` | 중     |
| B4  | `test:release-tools`도 9개 테스트 파일 수동 나열(동일 패턴의 잠재 드리프트)                                                                                                                     | `package.json` `test:release-tools`                                | 하     |

### C. 스크립트 네이밍 / 계층 일관성 (총 68개)

| #   | 항목                                                                                                                                                                                                                    | 근거                                                              | 심각도 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| C1  | 완전 중복 스크립트 2쌍: `test:runtime:bun` ≡ `test:runtime:bun-ffi`, `bench` ≡ `bench:bun` (명령 문자열 동일). 어느 쪽이 정본인지 알 수 없고 `test:runtime:native`는 `-ffi` 쪽을 참조                                   | `package.json` 해당 4개 정의                                      | 중     |
| C2  | 3중 분류 충돌: `test:adapter:tauri`(mock 앱 실행) vs `test:runtime:tauri`(실제 빌드 스모크) vs `test:app:react-native`(typecheck만). "adapter/runtime/app" 접두어만으로 용도 추측 불가                                  | `package.json` 해당 3개 + `ci.yml` 주석의 구분 설명이 필요한 현실 | 중     |
| C3  | 러너가 이름에 박혀 스크립트 분열: `test:ts:node`/`test:ts:bun`은 같은 대상·다른 러너인데 별도 스크립트 → 내용 드리프트(B1이 실증)                                                                                       | `package.json`                                                    | 중     |
| C4  | "node"로 끝나는 스크립트 3종이 서로 다른 의미: `test:ts:node`(dist-ts 테스트) / `test:runtime:node`(FFI 앱 스모크) / `test:runtime:node-napi`(napi 앱)                                                                  | `package.json`                                                    | 하     |
| C5  | `test:app:streaming`/`auth`/`reference`는 어떤 우산(`test`/`test:local`/`test:compat`/`test:runtime`)에도 미편입 — package.json 전문 독해로만 발견 가능                                                                 | `package.json` 전체 대조                                          | 중     |
| C6  | 동사 불일치: `fmt:rust` vs `format`/`format:check`(prettier), `audit:prod`(의존성 감사) vs `audit:registry`(레지스트리 정합 검사) — 동일 동사, 무관한 도메인. `verify:*` 7종과 `test:registry-consumer`의 경계도 불명확 | `package.json`                                                    | 하     |
| C7  | `clean:build`가 `clean-local.sh` 기본 동작(target+dist 전체)을 가리켜 이름이 실제 범위보다 좁아 보임. `clean:deep`/`clean:dry`와의 대칭성도 불완전                                                                      | `package.json`, `scripts/clean-local.sh`                          | 하     |
| C8  | `scripts/audit-rust.sh`는 npm 스크립트로 노출 안 됨(CI 전용) — 로컬에서 동일 감사 재현 경로 미발견                                                                                                                      | `.github/workflows/ci.yml` 79행, `package.json` 부재              | 하     |

### D. 훅(lefthook)과 피드백 지연

| #   | 항목                                                                                                                                                                                                                | 근거                                                                  | 심각도 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| D1  | pre-commit은 포맷/lint 자동수정뿐(eslint/prettier/rustfmt, `parallel: true`, `stage_fixed`) — 컴파일·테스트 검증 전무. pre-push 훅 없음 → `test:fast`조차 push 전 강제되지 않아 CI 실패 피드백이 푸시 후 수 분 지연 | `lefthook.yml` (전체 17줄, pre-commit만 존재)                         | 중     |
| D2  | commit-msg 규약 검사 없음(컨벤셔널 커밋 미강제) — changeset/release 파이프라인과 무관한 메시지도 통과                                                                                                               | `lefthook.yml`                                                        | 하     |
| D3  | 훅이 `bunx eslint`/`bunx prettier`를 매 커밋 호출 — 콜드 bunx 해석 오버헤드 반복                                                                                                                                    | `lefthook.yml`                                                        | 하     |
| D4  | eslint 범위가 `packages/*/src/**/*.ts`로 한정(훅 glob과 `lint` 스크립트 모두) — `scripts/*.ts`, `examples/**/*.ts`는 로컬·CI 어디서도 eslint 미적용                                                                 | `lefthook.yml`, `package.json` `lint`, `ci.yml` ts-checks "Lint" 스텝 | 중     |

### E. 문서화 / 발견 가능성

| #   | 항목                                                                                                                                                                                                                         | 근거                                                                                           | 심각도 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| E1  | `test:local`이 CONTRIBUTING·README·docs 어디에도 언급 없음(grep 0건). 22단계 로컬 배터리가 암묵 지식                                                                                                                         | `grep -rn 'test:local' CONTRIBUTING.ko.md README.ko.md docs/*.md` → 0건                        | 중     |
| E2  | CONTRIBUTING은 `test:compat`를 "PR 필수"로 안내 — 그러나 `test:adapters` 체인이 examples/react-native-calculator 의존성 설치를 전제로 한다는 사실은 CI에만 주석 존재, 로컬 사전조건 문서 없음 → 첫 실행이 의존성 에러로 실패 | `CONTRIBUTING.ko.md` 105/122/326행, `ci.yml` ts-tests "Install react-native example deps" 주석 | 중     |
| E3  | 훅은 `prepare: lefthook install`로 자동 설치되는 것은 양호. 단 `bunfig.toml`은 linker 설정뿐 — Node 22 요구 등 루프 전제는 문서로만 존재                                                                                     | `package.json` `prepare`, `bunfig.toml`, `CONTRIBUTING.ko.md` 20행                             | 하     |

### F. CI와의 관계

| #   | 항목                                                                                                                                                                                                     | 근거                                  | 심각도 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| F1  | CI ts-tests가 `test:local`/`test` 우산을 의도적으로 우회해 granular 스텝 실행 — 과거 우산 누락 사고(주석 5건: "umbrella test에만 있어 CI가 놓치고 있었다")가 문서화돼 있음. 로컬 우산은 이 교훈이 미적용 | `ci.yml` ts-checks/ts-tests 주석 다수 | 중     |
| F2  | CI에 rust-cache(Swatinem) 사용, 로컬은 캐시 전략 부재 + `[profile.dev] incremental=false`(의사결정 주석 있음) — 로컬 콜드/재빌드 비용이 CI보다 구조적으로 불리                                           | `ci.yml`, `Cargo.toml` profile 주석   | 하     |

---

## 실측 기록 (웜, macOS, 2026-09 기준 워킹카피)

| 명령                                                         | 실측  |
| ------------------------------------------------------------ | ----- |
| `cargo check --workspace -q`                                 | 3.71s |
| `bunx tsc -p examples/calculator/tsconfig.json`              | 1.25s |
| `bunx tsc -p examples/crud/tsconfig.json`                    | 1.19s |
| `bun run build` (패키지 9개)                                 | 3.54s |
| `cargo build -p rustra-calculator-example -q` (debug, 웜)    | 0.62s |
| `cargo build --release -p rustra-calculator-example -q` (웜) | 0.13s |

미실측 한계: `test:local`/`test:compat` 전체 벽시계는 실행하지 않았다(네트워크 감사 `audit:prod`, 에뮬레이터 의존 어댑터 단계 포함). 위 중복표는 정적 전개 + 부분 실측에 근거한다.

## 우선순위 매트릭스 (권장 착수 순)

1. **B1+B2**: 나열→glob 교체 또는 emit-vs-나열 일치 게이트 (상, 수정 비용 최소 — crud는 이미 glob 선례)
2. **A2**: `test:local`에 `test:types` 편입 (상, 한 줄)
3. **A1+A3**: 로컬 우산 재구성 — CI 주석의 "각 검증 1회" 원칙 이식 (상, 중비용)
4. **A4**: `test:fast` Linux 호환 (`--exclude` 또는 default-members) (중, 한 줄)
5. **E1+E2**: CONTRIBUTING에 `test:local` 문서화 + react-native 예제 사전조건 안내 (중, 문서)
6. **C1**: 중복 스크립트 2쌍 정본 지정·제거 (중, 호환 alias 유지 가능)
7. **D1**: pre-push 훅에 `test:fast` 부착 (중)
8. **D4/A5/A6/C2~C5**: 중기 개선 (중)

## 미해결 리스크

- `test:local` 전체 소요 미실측 — 우선순위 3번 착수 전 벽시계 실측 권장.
- B2의 미실행 3개 CLI 테스트가 "의도적 제외"(예: 깨지는 테스트의 암묵 보류)일 가능성은 배제하지 못함 — 히스토리 확인 필요.
- `test:fast` Linux 파손(A4)은 Cargo.toml 주석과 CI 매트릭스로부터의 추론이며 Linux 러너 재현 실측은 아님.
- lefthook 훅 실소요 시간은 커밋 규모 의존 — 미실측(구조적 평가만).
