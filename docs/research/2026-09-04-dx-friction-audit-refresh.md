---
date: 2026-09-04
researcher: claude
git_commit: 3d5eb404
branch: feat/tauri-channel-adapter
repository: loopy-lim/rustra
topic: 'DX 감사 리프레시 — 5영역(CLI/문서/TS 표면/Rust 저작면/E2E 실측) 전수 재검증'
tags: [research, dx, audit-refresh, cli, docs, types, rust-macros, onboarding, e2e]
status: complete
last_updated: 2026-09-04
last_updated_by: claude
---

# 리서치: DX 감사 리프레시 — 5영역 전수 재검증

**날짜**: 2026-09-04
**연구자**: claude (병렬 Explore 에이전트 5개)
**Git Commit**: 3d5eb404 (feat/tauri-channel-adapter)
**기준 리서치**: `docs/research/2026-08-29-22-46-49-dx-audit.md` (2026-08-29 감사)

## 연구 질문

2026-08-29 DX 감사 이후 여러 트랙이 착지했다. 과거 클레임 각각의 현재 판정(해소/여전/소관 이전)과, 과거 감사에 없던 신규 마찰을 5영역(CLI 표면, 문서 정확도, TS 표면, Rust 저작면, 첫성공 E2E 실측)에서 조사한다.

## 요약

**과거 감사의 HIGH 항목은 전 영역에서 대량 해소됐다** — CLI HIGH 6건 전부, 문서 HIGH 6건 대부분, `__RUstra_doc_` 오독 정정, doc→JSDoc 전달 체인, arg-parser 통일 구조 제안 실현. 0.6 T3(T4) 투자가 실측으로 증명됐다.

**신규 마찰은 한 클래스로 수렴한다: "조용한 성공/조용한 실패"** — 사용자를 안심시킨 뒤(성공 출력, doctor PASS, 타입 시그니처) 어긋나는 것들. codegen 성공 뒤 stale 바이너리로 demo 낙하, 받아놓고 무시하는 `InvokeOptions`, 항상 실패하는 스캐폴드 `codegen:check`, 존재하지 않는 `generate` bin을 가르치는 문서, `.command_fn()` 경로의 capability 무음 드랍.

**E2E 실측**: 도구 순수 오버헤더는 이미 훌륭(init 0.08s / doctor 0.23s / codegen 0.19s / demo 0.06s, 스키마 변경→재코드젠→재호출 사이클 <1s). 콜드 외부 개발자 2~4분은 전부 첫 cargo 빌드. **도구 속도가 아니라 실패 경로의 품질이 다음 체감을 결정** — 0.7 "신뢰" 테마와 정확히 일치.

## 신규 마찰 (이번 DX 트랙 대상 — HIGH/MEDIUM)

| #   | 심각도 | 영역  | 위치                                                                                       | 설명                                                                                                                                                              |
| --- | ------ | ----- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH   | CLI   | `init-template.ts:50-54` vs `cli-codegen.ts:90-95`                                         | 스캐폴드 `codegen:check` 스크립트가 **항상 실패** — init이 심는 generate bin은 `RUSTRA_SCHEMA_OUT`을 무시하는데 `codegen --check`는 tmp 경로 schema.json 요구     |
| 2   | HIGH   | 문서  | `docs/getting-started.md:208,828-832` / `README.md:709`                                    | 문서가 가르치는 `generate` bin이 실제로 존재하지 않음(`--bin generate` 즉시 실패). 프로브 재생성 경로의 실동행 부재                                               |
| 3   | HIGH   | E2E   | codegen/doctor vs demo                                                                     | **stale 런타임 바이너리 함정** — codegen은 프로브만 재빌드, doctor freshness도 프로브 기준 PASS → demo가 `contract.mismatch`로 낙하, "fix: cargo build" 힌트 없음 |
| 4   | HIGH   | E2E   | `cli-init.ts:107-112`                                                                      | init Next steps에 `cargo build` 누락 — CLI 힌트만 따라가면 demo 진입 실패                                                                                         |
| 5   | HIGH   | Rust  | `macro_command.rs:115-129` vs `builder_commands.rs:87-95`                                  | **capability 무음 드랍** — `.command_fn()` 이름추론 등록 경로에서 `#[command(capability=...)]`이 경고 없이 사라지고 deny-by-default 없이 공개 명령화 (보안 관련)  |
| 6   | HIGH   | TS    | `examples/calculator/generated/positional-facade.ts:47-50`                                 | positional facade가 `InvokeOptions`(timeoutMs/signal) 받아놓고 `void options` 무음 무시 — 26곳                                                                    |
| 7   | HIGH   | TS    | `positional-facade.ts:35-45`                                                               | `callPos`/`requireNative` 동기 throw — `Promise<T>` 선언과 달리 rejected Promise가 아니라 `.catch()` 우회하는 uncaught exception                                  |
| 8   | MEDIUM | TS    | `cancel.ts:62-67`, `cancel-by-id.ts:44`, `global-batch.ts:45`, `global-config.ts:66-72,87` | 타임아웃 race가 base `RustraCommandError`만 던짐(`instanceof TimeoutError` 경로별 불일치) + 미구성 엔진 sync throw/rejected promise 이중 동작                     |
| 9   | MEDIUM | CLI   | `cli-main.ts:63-68`, `cargo-metadata.ts:52-57`                                             | 최상위 오타 커맨드 exit 1(exit-2 계약 구멍) + cargo 미설치 시 raw ENOENT 노출(doctor는 rustc 검사하나 codegen 직행엔 설치 힌트 없음)                              |
| 10  | MEDIUM | 문서  | `getting-started.md:541-563`, `README.md:545,147,565`                                      | 마커 밖 샘플 드리프트(contract.ts 해시, 구형 multiline 샘플) + `i64→number` 표 오류(실제 `number\|bigint`) + 버전 표기 3중 갈라짐(`0.4`/`0.5`/`0.6`)              |
| 11  | MEDIUM | TS    | `rkyv-engine-dispatch.ts:29-37` 등                                                         | 디버그 블라인드 스팟 — RN JSI typed fast path/async 왕복/어댑터 수명주기(spawn 실패, 핸드셰이크)는 RUSTRA_DEBUG 켜도 아무것도 안 나옴                             |
| 12  | MEDIUM | React | `useEvent.ts:33`                                                                           | subscribe에 인라인 화살표 넘기면 렌더마다 구독 해지→재구독(푸시 유실 창) — JSDoc 경고 부재                                                                        |
| 13  | MEDIUM | CLI   | `cli-codegen.ts:118-127`, `dev.ts:143-144`, `host-entries.ts:156`                          | `codegen --check` 성공 시 출력 0건 + `rustra dev` 플래그 없이 치면 엉뚱한 힌트 + Windows 백슬래시 경로 오탈                                                       |

## 과거 클레임 판정 요약 (전수 결과)

### CLI (과거 19항목)

- **해소됨**: H1 --help 전부 에러 → `cli-main.ts:26-29` 일원화 / H2 빌드 무음 → `process.ts:13,44-61` 스피너+경과 / H3 무조건 덮어쓰기 → `cli-init.ts:84-88` --force 게이트 / H4 .gitignore·tsconfig 부재 → `init-template.ts:66-67` / H5 config 오타 silent → `config.ts:331-346` did-you-mean / H6 help 누락 → `cli-help.ts:38-43` / M8 schema 오류 무힌트 → `cli-generate-files.ts:64-74` / M11 diff 이중 출력 / M13 exit 미구분 → `cli-usage-error.ts` + `index.ts:43` / M14 $schema 부재 → `rustra.schema.json` + init 삽입 / L19 파서 4중복 → `cli-arg-parser.ts` 단일 파서 + `--flag=value` 균등
- **여전함**: M10 bun 하드코딩(호스트 감지는 개선됨) / M12 --config 기본값 불일치 / L15 validate/clean/new 부재 / L16 TTY 프롬프트 / L17 watch config 미감시 / L18 inspect 한국어
- **부분**: M7 cause (message 흡수로 실질 축소, CLI 최종 출력은 1줄) / M9 --format json (codegen/diff는 schemaVersion:1 통일, generate만 구형)

### TS 표면 (과거 9항목)

- **해소됨**: RUSTRA_DEBUG(`debug.ts` 와이어 trace+구조화 싱크) / cause 보존(`errors.ts:13-14,100-101`) / Timeout/Cancelled 서브클래스(`errors.ts:26-42`) / bigint inputKey(`input-key.ts:8-14`)
- **readiness 소관(워크트리 착지)**: withRetry / useSuspenseCommand / 계약 게이트 필드 강화+contract hash 게이트
- **readiness 소관(미착지 — Task 7/8 잔여와 일치)**: NDJSON 실패 라인 보존 / 응답 셰이프 경고
- **여전함**: mock 핸들러 반환값 무검증 (`testing/src/index.ts:152-153`)

### Rust 저작면

- **해소됨**: `__RUstra_doc_` "죽은 코드"는 오독으로 정정 완료 — 살아있음(`macro_register.rs:75-84`→`builder_commands.rs:41-49`→JSDoc 체인 실증 `generated/types.ts:110`) / unknown 폴백 경고 양측 착지(`codegen.rs:32-87`, `codegen-warnings.ts:37-54`) / doc→JSDoc 전달 완성
- **여전함**: on_unimplemented over-claim(구현 0건 — 문서 정정은 readiness Task 9a)
- **구현 타당성 평가**: `private.rs:6,9` 두 sealed trait에 속성 2개 추가만(S 규모). 현재 E0277이 `__private` 내부 경로를 노출하는 게 최대 고통 — 직접 해소. 단 readiness 9a(같은 문서 문단 정정)와 순서 조율 필요 → **다음 트랙 큐잉**
- **`#[allow(dead_code)]`**: 구조적 불가피 확인 — 유지 권고

### 문서 정확도 (과거 HIGH 6건 + 게이트)

- **해소됨**: init 퀵스타트 / 모순 예제 / divide 시그니처 / CONTRIBUTING 릴리스 / docs-gate 착지(fail-closed+테스트 27건+CI 연동, 마커 4영역)
- **부분**: 생성 코드 샘플(types.ts/commands.ts는 마커로 byte 검증, contract.ts 해시·단발 샘플은 마커 밖) / 루트 CHANGELOG(0.5까지, 0.6은 readiness 소관)
- **매트릭스**: 현 트리와 일치 (Channels ❌ — 채널 4호스트는 `feat/tauri-channel-adapter-work` 브랜치에 코드+매트릭스 동반 커밋돼 있음)
- **en/ko 쌍**: 사용자 대상 문서 전부 쌍 존재(유일 예외 compatibility-contract ko — readiness 소관). research/plans 내부는 제외 구역

### E2E 실측 (백로그 전수 포함)

- 단계별 실측 표, 스키마 사이클 실측, 네트워크 차단 환경 정직성 메모 포함 (요약 상단)
- doctor가 crates.io 도달성을 검사하지 않음 — 프록시 사용자가 22초 무응답 + cargo 영어 원문을 홀로 해석 (MEDIUM, 이번 트랙 9번과 동일 축)
- **이번 트랙 후보로 유효 재확인된 백로그**: CJS exports 조건 부재(Jest `require()` 소비자 실패) / stringly-typed invoke(CommandName 유니온 0건) / mock 출력 무검증 / dev `--format json` 부재 / vite 플러그인·react 문서 부재 / resolveRef 이동 예약(유일 1급 TODO)
- **무효화 폐기**: `__RUstra_doc_` 정리(오독) / caller-buffer 라벨(구현 완료 — readiness 위생이 문구만 정리) / T0-3·T1·P0-2 관련 주석들(구현 완료 설명 문구)
- **발행 간극**: 대기 changeset 7종은 전부 착지 완료분 — PR #51 머지 순서가 곧 발행 비용 (사용자 게이트)

## 관련 리서치

- `docs/research/2026-08-29-22-46-49-dx-audit.md` — 원전 감사
- `docs/research/2026-09-03-16-00-00-dx-macro-first-assessment.md` — Rust 저작면 전신
- `docs/research/2026-09-03-20-08-17-production-readiness-gap-analysis.md` — readiness 소관 정의
- `docs/plans/2026-09-03-readiness-tracks.md` — readiness 소관 항목의 계획(Task 3~10)
