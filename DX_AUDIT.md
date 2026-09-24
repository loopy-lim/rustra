# rustra-bridge DX 감사 최종 보고서

- 작업 ID: `integrate-report` — 4개 분야 감사의 상위 불편 포인트 취합
- 소스: `.loop-dx/audit-onboarding.md`, `.loop-dx/audit-devloop.md`, `.loop-dx/audit-errors.md`, `.loop-dx/audit-consumer.md`
- 대상: rustra-bridge 모노레포 (Rust 코어 + TS 코드젠/어댑터 브릿지 프레임워크)
- 방법: 4개 보고서의 항목을 전수 취합 → 중복 제거(예: `test:fast` Linux 파손은 onboarding·devloop 양쪽에서 지적되어 병합) → Quick win / 중기 / 구조적 3단계 분류. 취합 과정에서 핵심 근거(`package.json`, `Cargo.toml`, `.github/workflows/ci.yml`, 파일 부재 여부)를 원본에서 재검증했고, 보고서 주장과 달라진 부분은 §4에 보정 기록했다.

---

## 1. 요약 — TOP 5 불편 포인트

| #   | 불편 포인트                                                                                               | 근거 파일                                                                                                                                                                                                                                             | 영향받는 사람                        |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | **첫 권장 명령(`test:fast`)과 PR 필수 게이트(`test:compat`)가 Linux에서 Tauri 시스템 의존성으로 차단**    | `package.json` `test:fast`(`cargo check --workspace`), `Cargo.toml` `default-members`(tauri-calculator 의도적 제외 주석), `.github/workflows/ci.yml:108,165,470`(패키지 목록 유일 출처), `CONTRIBUTING.md:108,125`(PR 필수 `test:compat`)             | 기여자 (특히 Linux)                  |
| 2   | **수동 파일 나열 스크립트가 "침묵 속 테스트 누락"을 이미 발생시킴 — 6개 테스트가 어느 러너에서도 미실행** | `package.json` `test:ts:node`(8개 나열 vs `dist-ts` 11개), `packages/cli/package.json` `test`(22개 vs `dist-test` 29개), `package.json` `coverage:ts`(react 3개 테스트 중 1개만 반영)                                                                 | 기여자 + 컨슈머 (테스트 신뢰도)      |
| 3   | **JS 코덱 프레임 디코드 실패가 명령명·에러 코드·오프셋·힌트 없는 "맨몸 Error"로 전파**                    | `packages/types/src/frame-engine-contract.ts:16-27`(`instanceof Error`면 래핑 스킵), `examples/calculator/generated/frame-codecs.ts:35,40,97,139`(plain `Error` throw, 실측 재현: `code: undefined, message: varint out of bounds`)                   | 컨슈머 (`error.code` 분기 코드 전반) |
| 4   | **`test:local` 22단계 체인의 대량 중복 빌드 + 콜드 스캐폴드 cargo 빌드 + `test:types` 누락(패리티 구멍)** | `package.json:16`(22단계, 워크스페이스 빌드 ×2·cli 빌드 ×5·calculator tsc ×2·cargo ×5), `scripts/onboarding-gate.mjs:87-97,325`(`mkdtempSync` 콜드 캐시), `package.json` `test`/`test:packages`와 대조 시 `test:local`에 `test:types` 부재(CI는 실행) | 기여자                               |
| 5   | **`engine.supports` 값이 호환성 매트릭스 본문 셀과 표면상 모순 — 기능 게이트 분기의 신뢰 훼손**           | `docs/compatibility-matrix.md:120-129`(`channels: false`(Node), `events: 'none'`(RN JSON)) vs 동일 문서 `:27-28`(`createNodeChannel` ✅ 등), "1:1 transcription" 선언(`:120-124`)과 충돌                                                              | 컨슈머 (잘못된 기능 분기)            |

이 5개 외에도 4개 보고서에서 총 30여 개 불편 포인트가 도출되었으며, 아래에 중복 제거 후 우선순위별로 정리했다.

---

## 2. Quick win — 소규모 수정, 즉시 착수 권장

### Q1. `test:fast`의 `cargo check --workspace` → Linux 호환으로 수정

- **증상**: 저장소 설계자는 `default-members`로 macOS 전용 tauri-calculator를 bare cargo 대상에서 정확히 뺐는데(`Cargo.toml:17-19` 주석), 정작 기여자가 처음 치는 `test:fast`는 `--workspace`라 그 보호를 우회해 Linux에서 `libwebkit2gtk-4.1-dev` 등 부재로 실패한다. 필요한 패키지 목록은 `ci.yml:108,165,470`에만 존재하고 docs·CONTRIBUTING에는 0건.
- **근거**: `package.json` `test:fast`, `Cargo.toml` `default-members` 주석, `.github/workflows/ci.yml:108,165,470`
- **영향받는 사람**: 기여자 (Linux, 시스템 의존성 없는 macOS 포함)
- **해결책**: `cargo check --workspace --exclude rustra-tauri-calculator-example`(또는 default-members 존중 형태)로 한 줄 수정 + CONTRIBUTING 초기 설정에 Linux 의존성 설치 블록 추가.
- _한계: Linux 파손은 Cargo.toml 주석·CI 매트릭스로부터의 추론이며 러너 재현 미실측(감사 보고서 본인 명시)._

### Q2. `test:local`에 `test:types` 편입 (패리티 구멍 제거, 한 줄)

- **증상**: "로컬 전체 배터리" `test:local`에 엔진 코어 계약 테스트인 `test:types`(packages/types 유닛 10파일)가 없다. CI(`ci.yml` ts-tests)는 명시 실행하므로 로컬 green → CI red가 가능.
- **근거**: `package.json` `test`/`test:local`/`test:packages` 정의 대조, `test:types` 정의(`package.json`)
- **영향받는 사람**: 기여자
- **해결책**: `test:local` 체인에 `test:types` 한 단계 추가.

### Q3. cargo 실패 직후 스피너 "✓ done" 오표기 수정

- **증상**: `child.on('exit')`에서 코드 판정 전에 `✓ … done in Xs`를 출력한 뒤 reject — 컴파일 실패 직후 성공 체크마크가 CI 로그에서 "빌드 됐는데 다른 게 죽었다"로 오독됨(가짜 cargo exit 101로 실측 재현됨).
- **근거**: `packages/cli/src/process.ts:69-79`
- **영향받는 사람**: 기여자 + CI 로그 독자
- **해결책**: `code === 0`일 때만 ✓ 출력, 그 외엔 `✗ … failed in Xs`.

### Q4. `Generated drift` 9종 중 7종에 재생성 힌트 부착

- **증상**: `(invalid manifest)`, `(schema changed)`, `(generator changed)` 등 7종 변형에 "다음 행동" 힌트가 없다. 1차 소비자는 CI인데 `Run rustra codegen --config rustra.json` 한 줄 유무가 복구 시간을 좌우. 같은 저장소 doctor의 `fix:` 라인 관례와 불일치.
- **근거**: `packages/cli/src/manifest.ts:49-106`, 대비 관례 `packages/cli/src/doctor-format.ts:30-35`
- **영향받는 사람**: 기여자 (CI에서 drift 적발 시)
- **해결책**: 9종 전부에 공통 접미 힌트 상수 1줄 부착.

### Q5. 툴체인/런타임 버전 핀 파일 추가 + Node ≥22.6 요구 문서화

- **증상**: `rust-toolchain.toml`·`.nvmrc`·`.node-version` 모두 부재(취합 시 재확인). CI는 1.95.0, MSRV는 1.88(`Cargo.toml` `rust-version = "1.88"`), `node --experimental-strip-types` 스크립트 다수는 Node ≥22.6 필요한데 미문서·무가드 — Node 20 사용자는 `bad option: --experimental-strip-types`이라는 암호적 에러를 맞음.
- **근거**: `rust-toolchain.toml`/`.nvmrc`/`.node-version` 부재, `.github/workflows/ci.yml:75,100,160`, `package.json` `test:codegen-fresh`/`test:onboarding`/`test:docs`/`test:release-tools`
- **영향받는 사람**: 기여자 (첫 빌드)
- **해결책**: `rust-toolchain.toml` + `.nvmrc`(22.x) 추가, 전제 조건 문서에 "Node ≥22.6" 명기.

### Q6. `doctor.config.json` 이름 충돌 해소

- **증상**: "doctor"라는 이름이 서로 무관한 4곳(`rustra doctor` CLI, 스캐폴드 `bun run doctor`, `scripts/doctor.mjs`, 루트 `doctor.config.json`)에서 쓰여 신규 기여자의 grep을 오염시킴. `doctor.config.json`은 레포 내 실참조 0건(재확인).
- **근거**: `doctor.config.json`, `eslint.config.js`(미참조), `docs/research/2026-08-29-22-46-49-dx-audit.md:111`(기지정 이슈)
- **영향받는 사람**: 기여자 (첫날 혼란)
- **해결책**: `react-doctor.config.json` 등으로 이름 변경 또는 파일 최상단 용도 주석 추가.

### Q7. CONTRIBUTING PR 체크리스트에 `docs/gate-map.md` 연결

- **증상**: "로컬에서 뭘 돌려야 CI green인가"의 단일 지도가 `docs/gate-map.md`에 이미 존재(잡별 로컬 등가물 표 포함)하는데, CONTRIBUTING의 PR 체크리스트는 `test:compat` 통과만 요구하고 gate-map을 링크하지 않음(grep 재확인: CONTRIBUTING·README에 gate-map 언급 0건).
- **근거**: `docs/gate-map.md`(2026-09-20 검증), `docs/README.md:68`(링크는 docs 인덱스에만 존재), `CONTRIBUTING.md:108,125,330`
- **영향받는 사람**: 기여자
- **해결책**: CONTRIBUTING PR 절에 gate-map 링크 + "전체는 `test:local`, Rust 게이트는 `cargo fmt/clippy/test`" 한 줄 안내 추가.

### Q8. `engine.supports` 테이블에 engine-level 한정 각주 추가

- **증상**: `supports`는 엔진 팩토리 기준인데 매트릭스 행은 어댑터/transport 기준이라, Node 컨슈머가 `engine.supports?.channels === false`를 보고 채널을 포기하면 실제로는 `createNodeChannel`이 동작하는 잘못된 분기를 함. 문서 스스로의 "1:1 transcription" 주장과도 충돌.
- **근거**: `docs/compatibility-matrix.md:120-129` vs `:27-28`
- **영향받는 사람**: 컨슈머
- **해결책**: `supports` 테이블에 "engine-level 한정, transport-level API는 본문 행 참조" 각주 명시(문서 수정만으로 즉시 가능).

---

## 3. 중기 — 설계·조정이 필요한 개선

### M1. `test:local` 체인 재구성 (셋업 1회 → 검증 전부) + 스캐폴드 빌드 캐시

- **증상**: 22단계 체인 1회 실행 시 워크스페이스 TS 빌드 ×2, cli 빌드 ×5, calculator tsc ×2, release cargo 빌드 ×2 중복. 가장 무거운 onboarding-gate 스캐폴드 cargo 빌드 2회는 `mkdtempSync` temp dir라 매 실행 콜드. CI는 2026-09-20에 "각 검증 정확히 1회" 원칙으로 우산 중복을 제거했지만 로컬 우산은 방치됨.
- **근거**: `package.json:16`(test:local), `package.json:19,25,36,37`(하위 스크립트), `scripts/onboarding-gate.mjs:87-97,325`, `.github/workflows/ci.yml` 주석(우산 분할 이력)
- **영향받는 사람**: 기여자 (PR 전 배터리 소요 수십 분)
- **해결책**: "셋업 1회(build·cargo 빌드) → 검증 전부" 2단계로 재작성, onboarding-gate에 공유 `CARGO_TARGET_DIR` 주입 검토.
- _한계: `test:local` 전체 벽시계 미실측 — 착수 전 실측 권장(감사 보고서 본인 명시)._

### M2. 수동 테스트 나열 → glob 전환 또는 일치 게이트 (TOP 5 #2)

- **증상**: `test:ts:node`는 calculator 8개만 나열해 `devices`/`loose-invoke`/`typed-errors`가 node에서 미실행(bun glob은 11개 전부 — 비대칭), `packages/cli test`는 `generate-sync`/`generate-bound-context`/`generate-postcard-map` 3개가 어느 러너에서도 미실행, `coverage:ts`는 react 3개 테스트 중 1개만 반영해 수치 왜곡. 새 테스트 추가 시 스크립트 수정 필요성을 알 길이 없고 누락돼도 경고 없음.
- **근거**: `package.json` `test:ts:node` vs `dist-ts/examples/calculator/ts/`(11개), `packages/cli/package.json` `test` vs `dist-test/`(29개), `packages/react/package.json` `test`
- **영향받는 사람**: 기여자 + 컨슈머 (검증 신뢰도)
- **해결책**: crud 선례처럼 glob으로 교체하거나, "tsconfig emit 산물 vs 스크립트 나열" 일치 게이트 추가(`ci-gate.test.ts` 선례).
- _주의: 미실행 3개 CLI 테스트가 의도적 제외일 가능성은 배제 불가 — 히스토리 확인 후 진행._

### M3. tier2 디코드 실패 에러 정규화 (TOP 5 #3)

- **증상**: 생성 코덱의 plain `Error`가 `instanceof Error` 분기로 래핑 없이 통과 — `error.code`가 `undefined`가 되어 디코드 버그와 핸들러 실패를 구분 불가, 명령명·오프셋·와이어 단서 부재, `RUSTRA_DEBUG=1` 존재를 에러가 안내하지 않음. 같은 계층의 JSON 경로(`invalid json: {detail}`)·inspector(`at byte 42`)는 위치 정보를 주는 데 tier2만 낙후.
- **근거**: `packages/types/src/frame-engine-contract.ts:16-27`, `examples/calculator/generated/frame-codecs.ts`, 대비 `packages/types/src/json-wire.ts:80`, `packages/types/src/inspector.ts:141-152`
- **영향받는 사람**: 컨슈머
- **해결책**: `tier2Outcome`이 command 이름을 받도록 서명 확장, `RustraCommandError('invoke.malformed', "decode failed for 'addNumbers' at offset N: … — set RUSTRA_DEBUG=1")`로 정규화.

### M4. pre-push 훅 도입 + eslint 범위 확대

- **증상**: pre-commit은 포맷/lint 자동수정뿐이고 컴파일·테스트 검증 전무, pre-push 훅 없음 → `test:fast`조차 push 전 강제되지 않아 CI 실패 피드백이 푸시 후 수 분 지연. eslint도 `packages/*/src/**` 한정이라 `scripts/*.ts`·`examples/**/*.ts`는 로컬·CI 어디서도 미적용.
- **근거**: `lefthook.yml`(전체 17줄, pre-commit만), `package.json` `lint`, `.github/workflows/ci.yml` ts-checks Lint 스텝
- **영향받는 사람**: 기여자
- **해결책**: pre-push 훅에 `test:fast` 부착 + eslint 범위를 scripts/examples로 확대.

### M5. 브라우징 가능한 API 레퍼런스 제공

- **증상**: `typedoc.json`과 `docs:api` 스크립트가 존재하지만 출력 `docs/api/`가 `.gitignore:52`에 있어 커밋·호스팅되지 않음. "EngineClient 계약이 정확히 뭐지?"를 문서만으로 닫으려면 `docs/architecture.md` → 소스(`packages/types/src/public.ts`)로 내려가야 함.
- **근거**: `typedoc.json`, `package.json:69`, `.gitignore:52`, `docs/README.md`(API 레퍼런스 링크 부재)
- **영향받는 사람**: 컨슈머
- **해결책**: typedoc 출력을 CI에서 생성·호스팅(GitHub Pages 등)하고 docs 인덱스에 링크.

### M6. crud 예제 완결 — "엔진 없이" 끝나는 두 번째 예제

- **증상**: crud README 스니펫이 `const engine = /* EngineClient */` 플레이스홀더로 끝나고, `rustra.json`에 호스트 키가 없어 호스트 엔트리가 생성되지 않으며, 스니펫 호출 형태가 실제 생성 함수 시그니처와도 불일치. 첫 성공 경로가 calculator에만 존재해 두 번째 예제에서 사용자가 부트스트랩을 스스로 조립하게 됨.
- **근거**: `examples/crud/README.md:47-53`, `examples/crud/rustra.json`, `examples/crud/generated/commands.ts:14-16`, 대비 완결 사례 `examples/calculator/apps/node-app.ts`
- **영향받는 사람**: 컨슈머
- **해결책**: crud `rustra.json`에 호스트 키 추가 + README 스니펫을 실제 생성 시그니처에 맞는 완결 코드로 교체.

### M7. shallow cancellation 경고를 생성 표면으로 노출

- **증상**: `options.signal`이 실제 중단이 아니라 "JS 프라미스만 거부, Rust 실행 계속"(shallow)이라는 사실과 "retryable: true ≠ 재실행 안전" 경고가 매트릭스 산문과 코어 주석에만 존재 — 생성 `commands.ts`의 `InvokeOptions` 툴팁에는 없어 비멱등 명령 무단 재시도 사고의 온상.
- **근거**: `docs/compatibility-matrix.md:23,39`, `packages/types/src/public.ts:92-95`, 생성물 `examples/calculator/generated/commands.ts`(경고 부재)
- **영향받는 사람**: 컨슈머
- **해결책**: 코드젠 템플릿이 생성 `InvokeOptions` JSDoc에 취소 의미론 경고를 삽입하도록 수정.

### M8. devtools 실패 프레임 포렌식 지원

- **증상**: `DevtoolsLog`에 프레임 바이트/길이/오프셋 필드가 없어 디코드 실패(M3)를 보조할 와이어 단서가 로그에 남지 않음 — 프로세스 종료 후 재현 불가, `RUSTRA_DEBUG` 수작업 재실행으로 떠넘겨짐. 성능(타임라인)은 성숙, 장애 포렌식은 공백.
- **근거**: `packages/devtools/src/devtools-types.ts:24-36`, `packages/devtools/src/timeline-report.ts:59-70`, `packages/devtools/src/index.ts:7-9`
- **영향받는 사람**: 컨슈머 + 기여자
- **해결책**: `frameBytesHex`(절단 256B)·`frameByteLength` 선택 필드를 실패 로그 한정 additive 확장.

### M9. 어댑터별 부트스트랩 옵션 정합화

- **증상**: 4개 생성 호스트 엔트리의 옵션명·계약 검증 기본값이 제각각(node: `contractVerification: 'strict'` / bun: `schemaVersion` 포함 / tauri: 인자 없음 / RN: `contractVerification` 없음) — "내 플랫폼에서 contract mismatch가 strict인가"를 판단하려면 어댑터별 소스를 열어봐야 함.
- **근거**: `examples/calculator/generated/node.ts:19-27`, `bun.ts:16-29`, `tauri.ts:15-16`, `react-native.ts:9-16`
- **영향받는 사람**: 컨슈머
- **해결책**: `contractVerification` 등 핵심 옵션명·기본값을 어댑터 간 통일(하위 호환 alias 유지).

### M10. `test:adapters`/`test:runtime:tauri`의 로컬 사전조건 문서화 + 게이트화

- **증상**: PR 필수인 `test:compat` 체인의 `test:runtime:tauri`가 Tauri 시스템 의존성을 요구한다는 사실이 CI 주석에만 존재. 또한 `test:fast`·`test:local` 어느 것도 CI 어디에서도 실행되지 않아 스크립트 자체의 드리프트(M2의 누적 원인)가 무검증.
- **근거**: `package.json` `test:compat`/`test:runtime:tauri`, `.github/workflows/ci.yml` ts-tests 주석, `.github/workflows/` 전체에서 `test:fast`/`test:local` 미참조
- **영향받는 사람**: 기여자
- **해결책**: CONTRIBUTING에 사전조건 명시 + CI(ts-checks 선두)에서 `test:fast` 스모크 실행으로 게이트화.

---

## 4. 구조적 — 코드젠·계약·네이밍 체계 변경

### S1. 코드젠 타입 명명 정화 + 호출 규약 혼재 해소

- **증상**: Rust 내부 타입명이 TS 표면으로 누출(`export type String = string`, `Tuple_of_String`, `Tuple_of_int32_and_int32` 등)되고, 같은 generated 파일 안에 struct 기반(`addNumbers({a,b})`)과 positional(`add(a,b)`) 호출 규약이 혼재 — 소비자가 명령마다 스타일을 외워야 함.
- **근거**: `examples/calculator/generated/types.ts:49,51,185,187,255,303,305`, `commands.ts:12-15`, `docs/function-registration.md:73-74`(`arg0, arg1` 한계 문서화)
- **영향받는 사람**: 컨슈머
- **해결책**: positional 명령에 타입 별칭 정화(`[string]` 인라인, 예약어 회피)를 코드젠에 적용 + 규약 혼재 시 생성 헤더 경고 주석.
- _하위 호환 영향이 커서 major 릴리스 사이클 과제._

### S2. 우산 스크립트 3종(`test`/`test:local`/`test:compat`)의 역할 재정의

- **증상**: 세 우산의 범위가 서로 다르고(`test`는 types 포함·adapters 제외, `test:local`은 types 제외·adapters 포함, `test:compat`는 통합만), CONTRIBUTING은 PR 조건으로 `test:compat`를 요구하는데 그 체인은 Linux를 차단하는 `test:runtime:tauri`를 포함한다. "중간 밀도" 레벨(test:fast ≈15초와 test:local 수십 분 사이)도 부재.
- **근거**: `package.json` 우산 3종 정의, `CONTRIBUTING.md:108,125`, `docs/gate-map.md`의 CI 16잡 매핑
- **영향받는 사람**: 기여자
- **해결책**: "빠른 신호 / 패키지 유닛 / 전체 통합" 3계층으로 우산을 재정의하고 PR 필수 게이트를 Linux-safe 조합으로 교체.

### S3. 스크립트 네이밍 체계 정리 (총 68개)

- **증상**: 완전 중복 스크립트 2쌍(`test:runtime:bun` ≡ `test:runtime:bun-ffi`, `bench` ≡ `bench:bun`), 러널 이름 박힌 분열(`test:ts:node`/`test:ts:bun` — 드리프트 실증이 M2), "adapter/runtime/app" 접두어만으로 용도 추측 불가, 우산 미편입 스트리밍/auth/reference 스크립트, 동사 불일치(`fmt:rust` vs `format`).
- **근거**: `package.json` 해당 정의들, `.github/workflows/ci.yml`의 구분 설명 주석
- **영향받는 사람**: 기여자
- **해결책**: 정본 지정·제거(alias 유지 가능) + 접두어 규약 문서화, `docs/gate-map.md`와 정합 유지.

### S4. 소비 API 저작 모델 이원화 해소

- **증상**: 매크로 경로(명령당 입/출력 래퍼 구조체 2개 + `#[bridge_type]`)와 `PackageBuilder::function` 경로가 기능 분화돼(RN 스칼라 숏컷 미지원, async/상태 주입은 매크로 전용) "내 명령은 어느 쪽으로 쓰지" 결정이 문서 두 곳을 오가게 함. crud 예제는 5개 명령에 구조체 10개.
- **근거**: `examples/crud/src/lib.rs:5-46`, `docs/function-registration.md:18-31,77,92-95`
- **영향받는 사람**: 컨슈머 (패키지 저작자)
- **해결책**: 두 저작 모델의 기능 지원 매트릭스를 한 표로 문서화하고, 장기적으로 래퍼 보일러플레이트를 코드젠/매크로로 흡수.

---

## 5. 취합 과정에서의 교차 검증 결과 (보정 사항)

1. **`test:local` 문서화 주장 보정**: audit-devloop은 "`test:local`이 CONTRIBUTING·README·docs 어디에도 언급 없음(grep 0건)"이라 했으나, 재검증 결과 `docs/gate-map.md`(2026-09-20 검증, 22단계 전문 + CI 잡별 로컬 등가물 표)에 문서화되어 있고 `docs/README.md:68`에서 링크된다. 다만 CONTRIBUTING·README에는 여전히 언급이 없어(Q7), 발견 가능성 문제는 CONTRIBUTING 미링크로 축소되어 성립한다.
2. **CI 잡 수**: audit-onboarding은 "15개 잡"이라 했으나 `docs/gate-map.md` 기준 2026-09-20 분할 이후 16개 잡(`gate` 집계 포함)이다.
3. **감사 보고서들이 스스로 밝힌 미검증 한계 (근처 신뢰도 참고)**:
   - audit-devloop: `test:fast` Linux 파손은 추론이며 Linux 러너 재현 미실측
   - audit-onboarding: `test:fast` 웜 ~15초는 CONTRIBUTING 기재값 인용, 본 환경 재측정 아님
   - audit-errors: 심각도에 사용 빈도 추정 포함(예: cargo metadata 검사가 codegen 진입로에 있어 2.5의 실노출 빈도는 낮음)
   - audit-consumer: docs의 ko-en 줄 수 차이는 CJK 렌더링 특성으로 판단했으나 본문 전체 대조는 아님

---

## 6. 잘 작동하는 것 (유지 권장 — 4개 보고서 공통 확인)

- 에러 처리 성숙도: 설정 부재 시 `rustra init` 힌트, 오타 suggestion, cargo 부재 시 rustup 안내, contract hash mismatch의 원인+수순+후보 전수 보고, `rustra doctor`의 `fix:` 라인 관례, NDJSON 파싱 실패 라인 링 버퍼 보존, FFI 패닉 정규화, fuzz 타깃 3종.
- 문서 구조: 전제 조건의 단일 원천 표(getting-started) + CONTRIBUTING의 저장소 전용 사항만 보강, ko/en 쌍 동시 커밋 관례, `docs/gate-map.md`의 게이트 단일 지도.
- 게이트 문화: `scripts/onboarding-gate.mjs`의 fail-closed 행위 기반 사용자 여정 검증 + 유닛 테스트, lefthook `prepare` 자동 설치 + `stage_fixed`, CI의 "각 검증 정확히 1회" 원칙과 무음 green 방지(`skipped` 실패 처리).
- 타입/에러 인체공학: `RustraCommandError` 단일 `instanceof` 분기, 명령별 타입 가드 생성, `#[command(error(...))]` 계약.

---

## 7. 권장 착수 순서

1. **Quick win 일괄 (Q1–Q8)**: 특히 Q1(한 줄로 Linux 첫 경로 복구)·Q2(한 줄 패리티 제거)·Q3·Q4(로그 신뢰 회복)는 공수 대비 효과 최대.
2. **M2**: 테스트 누락은 이미 발생한 손실이므로 glob/게이트 전환을 우선 착수(단, 의도적 제외 여부 히스토리 확인 선행).
3. **M1 + M10**: `test:local` 재구성 착수 전 벽시계 실측, CI의 "1회 원칙" 이식.
4. **M3 + M8**: 디코드 실패 진단 경험 세트로 함께 개선.
5. **중기 문서/API 항목(M4–M7, M9)**과 **구조적 항목(S1–S4)**은 다음 minor/major 릴리스 사이클에 분산 배치.

---

## 8. 해결 상태 (실행 완료 업데이트)

모든 항목(Q1–Q8, M1–M10, S1–S4)이 아래와 같이 반영됐다. 상태 근거는 실제 커밋된 파일 기준.

### 상태 요약표

| 항목 | 상태    | 근거 (파일/스크립트)                                                                                                                                                                                                                                                                                                               |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1   | ✅ 완료 | `package.json` `test:fast` → `cargo check --workspace --exclude rustra-tauri-calculator`                                                                                                                                                                                                                                           |
| Q2   | ✅ 완료 | `test:local` 체인에 `test:types` 편입 확인                                                                                                                                                                                                                                                                                         |
| Q3   | ✅ 완료 | `packages/cli/src/process.ts` — exit 코드 판정 후 `✓ done`/`✗ failed` 분기                                                                                                                                                                                                                                                         |
| Q4   | ✅ 완료 | `packages/cli/src/manifest.ts` — `REGENERATE_HINT` 상수로 9종 drift 전체에 재생성 힌트                                                                                                                                                                                                                                             |
| Q5   | ✅ 완료 | `rust-toolchain.toml`(1.95.0), `.nvmrc`, `.node-version` 신설, README/CONTRIBUTING에 Node ≥ 22.6 명기                                                                                                                                                                                                                              |
| Q6   | ✅ 완료 | `doctor.config.json` 삭제 → `doctor.config.ts` 로 용도 명확화                                                                                                                                                                                                                                                                      |
| Q7   | ✅ 완료 | CONTRIBUTING(.md/.ko.md)에 `docs/gate-map.md` 링크 3건 추가                                                                                                                                                                                                                                                                        |
| Q8   | ✅ 완료 | `docs/compatibility-matrix.md`(en/ko) — `engine.supports` engine-level 한정 각주                                                                                                                                                                                                                                                   |
| M1   | ✅ 완료 | `test:local` 재구성 — 선두 `bun run build` 1회 후 `*:check` 변형(codegen-fresh/bindings-fresh/packages/onboarding)로 중복 빌드 제거                                                                                                                                                                                                |
| M2   | ✅ 완료 | `test:ts:node` glob 전환(8→11개 복구: devices·loose-invoke·typed-errors), cli `test` bun 세그먼트에 generate-sync·generate-bound-context·generate-postcard-map 편입(bun:test 전용임이 원인 규명됨 — node --test 제외는 의도적), `coverage:ts`에 react 3개 테스트 전부 반영, `scripts/check-test-list-parity.mjs` + 테스트 7건 신설 |
| M3   | ✅ 완료 | `packages/types/src/frame-engine-contract.ts` — 디코드 실패 정규화(명령명·오프셋·`RUSTRA_DEBUG=1` 힌트), `frame-engine-contract.test.ts` 신설                                                                                                                                                                                      |
| M4   | ✅ 완료 | `lefthook.yml` pre-push 훅 추가, `eslint.config.js` 범위 scripts/examples 확대                                                                                                                                                                                                                                                     |
| M5   | ✅ 완료 | `docs/README.md` — API Reference (TypeDoc) 섹션 및 인덱스 링크                                                                                                                                                                                                                                                                     |
| M6   | ✅ 완료 | `examples/crud/rustra.json` 호스트 키 추가 → `generated/node.ts` 생성 확인, README 완결 코드 교체(en/ko)                                                                                                                                                                                                                           |
| M7   | ✅ 완료 | 코드젠 템플릿 — 생성 `commands.ts`에 얕은 취소(shallow cancellation)·retryable 경고 JSDoc 삽입                                                                                                                                                                                                                                     |
| M8   | ✅ 완료 | `packages/devtools` — `timeline-report.ts` 등 프레임 포렌식 필드 additive 확장 + 테스트                                                                                                                                                                                                                                            |
| M9   | ✅ 완료 | 4개 호스트 엔트리(node/bun/tauri/react-native) 옵션 정합화, 전 예제 generated 재생성                                                                                                                                                                                                                                               |
| M10  | ✅ 완료 | CONTRIBUTING에 tauri 시스템 의존성 사전조건 명시, CI ts-checks 선두 `test:fast` 스모크                                                                                                                                                                                                                                             |
| S1   | ✅ 완료 | `crates/rustra/src/codegen_names.rs` 등 — 타입명 정화(예약어/내장명 회피), 하위 호환 alias 유지, 전 예제 generated 갱신                                                                                                                                                                                                            |
| S2   | ✅ 완료 | 우산 3계층 재정의(test/test:local/test:compat), PR 필수 게이트 Linux-safe 교체, `docs/gate-map.md` 갱신                                                                                                                                                                                                                            |
| S3   | ✅ 완료 | 중복 2쌍 제거(`test:runtime:bun-ffi`, `bench:bun` 소멸 확인), 스크립트 정리                                                                                                                                                                                                                                                        |
| S4   | ✅ 완료 | `docs/function-registration.md`(en/ko) — 두 저작 모델 기능 지원 매트릭스 표                                                                                                                                                                                                                                                        |

### 최종 검증 결과 (2026-09-24)

- `bun run build` / `lint`(0 errors) / `format:check` ✅
- `test:fast` / `test:types`(297) / `test:ts:node`(77, +8 복구) / `test:ts:bun`(74) ✅
- packages/cli `test`(45, +8 복구) / `test:release-tools`(86, 패리티 게이트 포함) ✅
- `test:api-surface` / `test:architecture` / `test:codegen-fresh` / `test:bindings-fresh` ✅
- `test:onboarding`(전 여정 green) / `test:docs`(ko/en 78쌍 정합) ✅
- `scripts/check-test-list-parity.mjs` — 이밋 산물 vs 스크립트 나열 일치 OK ✅

### 후속 관찰 항목 상태 (2026-09-24 2차 업데이트)

1. **onboarding-gate 콜드 cargo 캐시** — ✅ 완료. `RUSTRA_ONBOARDING_CARGO_TARGET_DIR` 옵트인 환경변수 추가(`scripts/onboarding-gate.mjs`). 미설정 시 기존 콜드 캐시(fresh scaffold) 의미론 유지, `test:onboarding:check`은 `target/onboarding-shared` 공유 타깃으로 웜 실행. 유닛 테스트 21건 통과.
2. **M9/S1 마이그레이션 노트** — ✅ 완료. `.changeset/m9-host-options-s1-type-name-sanitization.md` 작성(`@rustra/cli` minor). 기본값은 어댑터 런타임 의미론상 변화 없음, 생성 엔트리 명시화와 deprecated alias 유지 범위·마이그레이션 절차 문서화.
3. **`test:fast` Linux 실측** — ⏳ CI push 후 확인 대상. `.github/workflows/ci.yml`의 Umbrella smoke (test:fast) 스텝이 `runs-on: ubuntu-latest` 잡에 속해 푸시 시 자동 검증됨(로컬 Linux 재현 불가 환경).
