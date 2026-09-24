# 온보딩/첫 빌드 경험 감사 (새 기여자 관점)

- 작업 ID: `audit-onboarding`
- 기준 커밋: 2026-09-24 working tree (rustra-bridge 모노레포)
- 관점: 저장소를 처음 clone한 기여자가 첫 빌드/테스트 성공까지 가는 경로
- 방법: CONTRIBUTING·README·docs·package.json·scripts/onboarding-gate.mjs·doctor.config.json·Cargo.toml·.github/workflows/ci.yml를 실제 인용하며 단계별 추적

---

## 1. 요약 — 상위 3개 불편 포인트

| #   | 불편 포인트                                                              | 짜증 지수 | 핵심 근거                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------ | :-------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **첫 권장 명령과 PR 필수 명령이 Linux에서 Tauri 시스템 의존성으로 막힘** |    상     | `package.json:15` `test:fast`가 `cargo check --workspace -q` → workspace 멤버인 macOS 전용 `examples/tauri-calculator/src-tauri`까지 검사. 필요한 `libwebkit2gtk-4.1-dev` 등 8개 패키지는 `.github/workflows/ci.yml:108,165`에만 적혀 있고 CONTRIBUTING·docs 어디에도 없음 |
| 2   | **`test:local` 22단계 체인의 대량 중복 빌드 + 매 실행 콜드 cargo 빌드**  |    상     | `package.json:16` 기준 워크스페이스 TS 빌드 2회, `packages/cli` 빌드 5회, calculator `tsc` 2회, cargo 빌드 4회. 그중 `test:onboarding`이 매번 `mkdtempSync`로 만든 temp dir에서 스캐폴드 `cargo build` 2회(build+rebuild) — 캐시 재사용 불가                               |
| 3   | **툴체인/런타임 버전 핀과 가드 부재**                                    |    중     | `rust-toolchain.toml` 없음(CI는 1.95.0, MSRV 잡은 1.88.0), `.nvmrc`/`.node-version` 없음, `node --experimental-strip-types`는 Node ≥22.6 필요한데 미문서·무가드, Bun 1.4.0은 `packageManager` 핀만 있고 로컬 강제 없음                                                     |

문서 품질 자체(CONTRIBUTING 요구사항 절, getting-started 전제 조건 표, development-hurdles)는 상당히 좋다. 문제는 문서가 아니라 **스크립트 체인과 환경 가드**에 집중되어 있다.

---

## 2. 새 기여자 첫 빌드 여정 단계별 추적

### 단계 0 — 문서 발견

- `README.md:822-824` — Contributing 섹션은 링크 하나뿐: `See [CONTRIBUTING.md](CONTRIBUTING.md).` 발견성은 OK.
- `CONTRIBUTING.ko.md:9-13`(요구사항) — "사용자용 전제 조건은 [시작하기](docs/getting-started.ko.md#전제-조건)의 표가 단일 원천"이라며 Rust 1.88+ MSRV, Bun 1.4.0(`packageManager`), Node 22.x를 명시. 이 구성은 우수하다.
- `docs/getting-started.ko.md:20-31`(전제 조건 표) — Rust 1.88+, Bun 1.4+, Node 22.x, Cargo+링커, iOS 전용 Xcode/CocoaPods, Android 전용 SDK/NDK 27+·Java 17까지 명시. **필수 선행 설치물의 명시 여부: 문서화는 충실함.**

### 단계 1 — clone + 설치

```bash
git clone <repo-url> && cd rustra-bridge
bun install                 # 워크스페이스 의존성
```

(`CONTRIBUTING.ko.md:26-28`)

- `bun install`은 `prepare` 스크립트(`package.json:82` → lefthook install)로 커밋 훅까지 자동 설치. 이 부분은 마찰 없음.

### 단계 2 — 첫 신호: `bun run test:fast`

```json
"test:fast": "cargo check --workspace -q && tsc -p examples/calculator/tsconfig.json && bun run --cwd packages/cli test"
```

(`package.json:15`, `CONTRIBUTING.ko.md:29`는 "웜 기준 약 15초의 첫 신호(첫 실행은 더 김)"라고 고지)

- **여기서 첫 벽.** `--workspace`는 `Cargo.toml:21`의 `default-members`를 무시하고 전체 멤버를 검사하며, 그중 `examples/tauri-calculator/src-tauri`(`Cargo.toml:9`)는 `Cargo.toml:17-19` 주석이 "macOS 전용 크레이트"라고 명시하는 대상이다. Linux에서는 tauri/wry가 `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` 등(`ci.yml:108`) 없이 컴파일되지 않는다.
- 즉 **저장소 설계자는 `default-members`로 이 문제를 정확히 알고 차단했는데**("bare cargo/clippy/test 가 macOS 전용 크레이트(tauri-calculator)를 빌드하지 않게 한다 — Linux CI 는 물론, Tauri 시스템 라이브러리가 없는 macOS 환경에서도 bare 명령이 green", `Cargo.toml:17-19`), 정작 기여자가 처음 치는 `test:fast`는 `--workspace`라서 같은 보호를 우회해 실패한다.
- Linux 의존성 설치 안내는 `docs/`·CONTRIBUTING 어디에도 없고 `ci.yml`의 `apt-get install` 행(108, 165, 470)에만 존재함을 확인했다(`grep -rn webkit2gtk docs/ CONTRIBUTING* README*` → 워크플로 외 0건).

### 단계 3 — 전체 배터리 (CONTRIBUTING.ko.md:31-34)

```bash
cargo build --workspace     # "느림; --workspace 는 macOS 전용 tauri-calculator 까지 빌드한다"는 주석 있음
cargo test --workspace
bun run test:compat
```

- 문서에 "macOS 전용" 경고 주석은 있지만, Linux 기여자에게 실행 가능한 대안(`cargo build` — default-members)을 알려주지 않는다. 경고만으로는 복구 경로가 없다.
- `test:compat`(`package.json:32`) = `test:ts:node && test:ts:bun && test:adapters && test:runtime` → `test:runtime:tauri`(`package.json:28`)는 `examples/tauri-calculator build`를 실제로 돌린다. **PR 필수 게이트(`CONTRIBUTING.ko.md:122` "test:compat ← 전체 통합 (PR 필수)")조차 Linux에서 시스템 의존성 없이는 통과 불가.**

### 단계 4 — PR 전 로컬 풀배터리: `test:local`

`package.json:16` 원문 그대로 22단계:

```
bun run build → test:release-coherence → lint → format:check → audit:prod
→ test:ts:node → test:ts:bun → test:adapters → cli test → test:complex-codec-bench
→ test:bench-gate → test:api-surface → test:codegen-fresh → test:bindings-fresh
→ test:architecture → test:release-tools → test:registry-consumer
→ test:runtime:node → test:runtime:bun → test:packages → test:onboarding → test:docs
```

빌드 반복 집계 (각 하위 스크립트 정의를 전개해 계산):

| 빌드 종류                               | 실행 정의 위치                                                                                                                                                      |    `test:local` 1회당 횟수    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------: |
| 워크스페이스 TS 빌드(`bun run build`)   | 상위 체인 + `test:packages`(`package.json:19`) 내부                                                                                                                 |            **2회**            |
| `packages/cli` 빌드                     | 워크스페이스 빌드 2회에 포함 + `test:codegen-fresh`/`test:bindings-fresh`/`test:onboarding` 각각 명시(`package.json:25,36,37`)                                      |            **5회**            |
| calculator `tsc -p examples/calculator` | `test:ts:node`(:17), `test:runtime:node`(:21)                                                                                                                       |            **2회**            |
| cargo 빌드                              | `test:ts:bun` debug(:20), `test:runtime:node` release(:21), `test:runtime:bun` release(캐시, :22), **onboarding-gate의 스캐폴드 `cargo build` 2회**                 | **5회 스폰(실질 4회 컴파일)** |
| 스캐폴드 콜드 cargo 빌드                | `scripts/onboarding-gate.mjs:87-97` `ONBOARDING_STEPS`의 `build`(:91) + `rebuild`(:97) 단계, scratch dir는 `mkdtempSync`(:325)라 **매 실행마다 target 캐시 0 상태** |         **2회/실행**          |

추가 관찰: `test:local`에는 `cargo test --workspace`, `clippy`, `cargo fmt`가 없다. 즉 로컬에서 `test:local` green이어도 CI의 `rust` 잡(cargo test/clippy/fmt)·`rust-msrv` 잡(`ci.yml:160-168`, 15개 잡을 `scripts/ci-gate.sh`가 집계)에서 처음 적신다. "로컬에서 뭘 돌리면 CI green인가"에 답하는 단일 명령이 없다.

---

## 3. onboarding-gate가 검증하는 것과 못 하는 것

`scripts/onboarding-gate.mjs`는 설계가 우수한 fail-closed 게이트다.

### 검증하는 것 (사용자 여정)

- `ONBOARDING_STEPS`(:87-98): `init → patch → doctor → build → codegen → demo → codegen-check → mutate → regen → rebuild → verify`
- init 스캐폴드 생성부터 doctor, cargo build, codegen, 데모 실행, `codegen --check` 드리프트 0, 스키마 변형(`mutateScaffoldSources`) 후 재코드젠 재호출까지 **행위 기반으로 매일 CI 검증** — 헤더 주석(:2-19)대로 "산문이 아니라 게이트로 계약"한다.
- 각 단계 `durationMs`를 보고하나(:17-18) "임계 게이팅은 의도적으로 하지 않는다" — 시간이 10분으로 늘어도 green이다.

### 검증하지 못하는 것 (기여자 여정의 사각지대)

1. **저장소 기여자의 첫 빌드 경로는 검증 대상이 아니다.** 게이트는 temp dir에서 발행물 소비자 여정(`bunx @rustra/cli init`)만 재현한다. `bun install → test:fast → test:compat`가 fresh clone에서 돌아가는지는 아무 게이트도 없다. 본 감사의 1·2번 불편이 바로 이 사각지대에서 발생했다.
2. **발행 전 우회(`patch`, :89, :47-76 `injectWorkspacePatch`)** — repo 체크아웃에서는 `.cargo/config.toml` 패치 + `node_modules/@rustra/*` 심링크로 레지스트리를 우회한다(:48-56 주석 명시). 즉 repo CI에서는 **실 레지스트리 버전 해소 흐름을 검증할 수 없다**(의도된 트레이드오프이지만, `^0.8.0` 스캐폴드 요구와 워크스페이스 `0.11.0`의 버전 스큐가 사용자 환경에서 터지는 사례는 게이트가 못 잡는다).
3. **호스트 필수 도구 부재 시나리오** — `doctor` 단계는 "경고는 통과, 필수 fail만 중단"(:10)이라 webkit2gtk 같은 시스템 라이브러리 부재를 대신 잡아주지 않는다.
4. **E2E 시간 임계 없음** — 온보딩이 느려져도 게이트는 조용하다.

---

## 4. doctor.config.json의 역할

- 내용: eslint 플러그인 계열 규칙(`deslop/unused-file`, `deslop/unused-export`, `react-doctor/async-await-in-loop` 등)의 파일별 ignore 오버라이드 모음이다.
- **그러나 레포 내 그 어떤 스크립트·설정도 이 파일을 참조하지 않는다**: `eslint.config.js`에 언급 없음, `package.json`에 `doctor`/react-doctor 스크립트 없음(외부 react-doctor CLI의 자동 발견 설정으로 추정).
- `rustra doctor`(CLI 환경 진단, `docs/development-hurdles.ko.md:105`), 스캐폴드의 `bun run doctor`(getting-started :40-46), RN 예제의 `bun scripts/doctor.mjs`(`examples/react-native-calculator/package.json:19`), 루트 `doctor.config.json` — **"doctor"라는 이름이 서로 무관한 4곳에서 쓰여 신규 기여자의 grep을 오염시킨다.**
- 이는 이미 내부 감사에서 지적된 알려진 이슈다: `docs/research/2026-08-29-20-56-04-architecture-review.md:170`("루트 doctor.config.json은 rustra doctor와 무관한 react-doctor/deslop 설정"), `docs/research/2026-08-29-22-46-49-dx-audit.md:111`.

짜증 지수: **하** (기능 파손은 없지만 첫날 혼란 유발, 제거/이름 변경/주석 한 줄로 해결 가능)

---

## 5. 불편 포인트 전체 목록 (짜증 지수)

### 상

1. **Linux에서 첫 명령·PR 필수 게이트가 모두 Tauri 시스템 의존성으로 차단**
   - 근거: `package.json:15`(`test:fast`의 `cargo check --workspace`), `package.json:28,32`(`test:runtime:tauri`가 `test:compat`/`test:runtime`에 포함), `Cargo.toml:9,17-21`(tauri-calculator는 macOS 전용 멤버라 default-members에서 의도적으로 제외), 시스템 패키지 목록은 `.github/workflows/ci.yml:108,165`에만 존재.
   - 왜 짜증: CONTRIBUTING.ko.md:29-34를 그대로 따라 친 첫 명령이 실패하고, 복구에 필요한 패키지 목록은 워크플로 파일을 뒤져야 나온다.

2. **`test:local`의 22단계 체인과 대량 중복 빌드, 매 실행 콜드 스캐폴드 cargo 빌드**
   - 근거: `package.json:16`(22단계 원문), 전개 집계 — 워크스페이스 빌드 ×2(:16 상위 + :19 `test:packages`), cli 빌드 ×5(:16·:19·:25·:36·:37), calculator tsc ×2(:17·:21), cargo ×5(스캐폴드 2회 포함), `scripts/onboarding-gate.mjs:87-97`(`build`+`rebuild`)+:325(`mkdtempSync` 콜드 캐시).
   - 왜 짜증: PR 전 "한 번만 돌리자"는 명령의 실체가 수십 분+의 중복 컴파일이고, 그중 가장 무거운 콜드 cargo 빌드는 캐시가 전혀 재사용되지 않는다.

### 중

3. **툴체인/런타임 버전 핀·가드 부재**
   - 근거: `rust-toolchain.toml` 부재(저장소 루트 확인), CI는 `dtolnay/rust-toolchain@1.95.0`(`ci.yml:75,100`)/MSRV 잡 `@1.88.0`(`ci.yml:160`), MSRV 근거는 `Cargo.toml:43-44`(`rust-version = "1.88"`)에만 존재. `.nvmrc`/`.node-version` 부재, `node --experimental-strip-types` 사용 스크립트 다수(`package.json:25,36,37,39` 등 — Node ≥22.6 필요)인데 요구 버전이 CONTRIBUTING·getting-started 어디에도 없음(해당 키워드 grep 0건). Bun은 `packageManager: "bun@1.4.0"`(`package.json:5`) 핀이 있으나 로컬 강제 수단 없음(CI만 `oven-sh/setup-bun@v2` `bun-version: 1.4.0`, `ci.yml:199-201`).
   - 왜 짜증: Node 20 사용자는 `test:release-tools`부터 `bad option: --experimental-strip-types`이라는 암호적 에러를 맞는다. rustup 사용자는 로컬 툴체인이 1.88 미만이면 cargo가MSRV 에러를 내긴 하지만, CI(1.95)와 동일 환경을 강제하는 장치가 없어 "로컬 green → CI red" 여지가 항상 남는다.

4. **"CI green을 위해 로컬에서 뭘 돌려야 하는가"의 단일 답 부재**
   - 근거: `test:local`(`package.json:16`)에 `cargo test`/`clippy`/`fmt` 없음. 실제 PR 게이트는 `scripts/ci-gate.sh:33-50`의 15개 잡 집계(`rust`, `rust-msrv`, `napi`, `ts-*`, `rn-*`, `uniffi-*` 등). CONTRIBUTING.ko.md:105는 PR 조건을 `test:compat` 통과로만 명시.
   - 왜 짜증: 로컬 최선 노력(`test:local`)과 CI 요구(15잡)의 간격만큼 "CI에서 처음 적발"이 반복된다.

### 하

5. **`doctor` 이름 4중 사용 충돌** — 위 4절 참고. `doctor.config.json`은 레포 내 참조 0건. 근거: `eslint.config.js`(미참조), `docs/research/2026-08-29-22-46-49-dx-audit.md:111`(이미 지적됨).

6. **문서 내 발행 버전 하드코딩으로 인한 스큐 위험** — `docs/getting-started.ko.md:40`(`@rustra/cli@0.11.3`), `:77`(`@rustra/node@0.10.2` 등). 문서 스스로 "이 표는 발행 또는 이 브랜치의 CI 통과를 증명하지 않는다"(:88 부근)라고 고지하지만, 신규 사용자는 오래된 설치 명령을 그대로 치게 된다. (다만 이는 저장소 기여자보다 라이브러리 소비자 온보딩의 문제다.)

7. **`cargo build --workspace` 경고만 있고 대안 제시 없음** — `CONTRIBUTING.ko.md:30-33`의 주석은 사실을 말하지만 Linux 기여자용 실행 가능한 대안(`bare cargo build` = default-members)을 코드 블록으로 주지 않는다.

---

## 6. 잘 작동하는 것 (유지 권장)

- 전제 조건의 단일 원천 표 + 저장소 전용 사항만 CONTRIBUTING에 덧붙이는 구성(`CONTRIBUTING.ko.md:9-13`, `docs/getting-started.ko.md:20-31`).
- `prepare` 스크립트로 lefthook 자동 설치 + `stage_fixed: true` 포맷 자동 재스테이징(`CONTRIBUTING.ko.md` 릴리즈 절, `lefthook.yml`).
- 사용자 온보딩 여정을 산문이 아닌 fail-closed 게이트로 계약한 `scripts/onboarding-gate.mjs` + 유닛 테스트(`scripts/onboarding-gate.test.ts`, `test:onboarding`으로 CI 결속).
- Rust 없이 시작하는 mock 엔진 제공(`docs/development-hurdles.ko.md:36` `@rustra/testing` `createMockEngine`).
- 웜 `test:fast` ~15초라는 기대치 명시(`CONTRIBUTING.ko.md:29`).

---

## 7. 개선 제안 (우선순위 순)

1. `test:fast`의 `cargo check --workspace` → `cargo check`(default-members)로 변경하거나, Linux 시스템 의존성 설치 블록을 CONTRIBUTING "초기 설정"에 코드로 추가. (`test:compat`의 `test:runtime:tauri`도 플랫폼 분기 또는 명시적 사전조건 안내)
2. `test:local`에서 워크스페이스 빌드·cli 빌드 중복 제거(체인 재구성) + onboarding-gate 스캐폴드 빌드에 공유 target dir(`CARGO_TARGET_DIR`) 주입 검토.
3. `rust-toolchain.toml`(1.95.0 또는 MSRV 별도 정책) 및 `.nvmrc`(22.x) 추가, `engines`/전제 조건 문서에 "Node ≥22.6(`--experimental-strip-types`)" 명기.
4. `test:local`과 `ci-gate` 15잡의 대응표를 CONTRIBUTING에 추가해 "로컬에서 뭘 돌려야 CI green"을 한 표로 답하기.
5. `doctor.config.json` 이름 변경(예: `react-doctor.config.json`) 또는 파일 최상단에 용도 주석 추가.

---

## 부록: 검증에 사용한 명령

- `grep -n` 인용: `package.json` 스크립트, `Cargo.toml` 멤버/MSRV, `scripts/onboarding-gate.mjs` 단계 정의, `.github/workflows/ci.yml` 시스템 패키지
- `grep -rn webkit2gtk` (docs/CONTRIBUTING/README) → 워크플로 외 문서화 0건 확인
- `ls rust-toolchain* .nvmrc .node-version` → 모두 부재 확인
- `grep -rn "doctor.config"` → 레포 내 실참조 0건, 연구 문서의 기지정 이슈 확인
- `test:local` 22단계 전개 및 중복 빌드 집계는 각 하위 스크립트 정의(`package.json:15-37`)를 수동 전개하여 계산
