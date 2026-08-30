---
date: 2026-08-30
author: claude (DX track agent)
branch: feat/dx-hardening
worktree: .claude/worktrees/dx
base: main @ 8f0a04fd
status: complete
---

# DX 트랙 리포트 (feat/dx-hardening)

계획: `docs/plans/2026-08-30-parallel-three-tracks.md` 트랙 1 (Task 1.1~1.6).
근거: `thoughts/shared/research/2026-08-29_22-46-49_dx-audit.md`.

## 0. 계획 대비 현실 — 선(先)착지 분석

감사 커밋(1dec518c) 이후 e339e01f + 69a5a2ae(모듈 분리 리팩터링)에서 트랙 1의
상당 부분이 이미 착지해 있었다. 리포트라인 참조(comments)가 전부 리팩터링
이전 라인을 가리킨다(예: "codegen.rs:138" → 현재 codegen_types.rs). 각 태스크의
**실제 잔여 갭**만 구현했다.

## (a) 태스크별 상태

| 태스크              | 상태                                       | 내용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 arg-parser 통일 | **완료** (잔여분)                          | 파서 헬퍼 자체는 기존 착지돼 있었음. 잔여 갭 구현: 미지 플래그 Levenshtein "Did you mean --X?" 제안 + 매치 없으면 옵션 전집 나열 + `Run "rustra <cmd> --help"` 안내, usage 오류 **exit 2**(기존 전부 1), `init`이 수동 필터링으로 파서를 우회하던 것을 `parseCliArgs`로 통일(오타 `--forcee` → `Did you mean --force?`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 1.2 CLI 인체공학    | **완료** (잔여분)                          | config 오타키 closest 제안(대소문자 무시, 기존 loud-fail 위에 제안 추가), codegen cargo 빌드 스피너(프레임 회전 + 1초 경과 틱 + 완료 시 총 소요 `done in N.Ns`). init 차단+`--force`, 스캐폴드 .gitignore/tsconfig, help `dev --config` 문서화는 **기존 착지 확인** → SKIP (구현 이미 존재)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1.3 errors.ts       | **완료** (잔여분)                          | cause 옵션+normalize cause/stack 보존은 기존 착지돼 있었음. 잔여 갭: `TimeoutError`/`CancelledError` 서브클래스(코드 매핑 `transport.timeout`/`cancelled` + retryable:true 유지), 구조화 `{code,message}` 경로에서 서브클래스 승격                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.4 RUSTRA_DEBUG    | **완료** (잔여분)                          | debug.ts+rkyv/postcard/json 훅은 기존 착지. 잔여 갭: 계약의 `shouldDumpWire()`(순수 env 파싱) + `dumpWire(direction, bytes)`(hex+stderr, 미설정 시 완전 무음) 신설 및 rkyv-engine-dispatch 4곳 훅(허용 범위인 호출부 추가만)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1.5 문서 HIGH 6건   | **완료** (잔여분)                          | README init 예제는 이미 실동작 형태(스모크로 실증 — 아래 게이트). rust-api-guide :424-432 divide 예제는 이미 유효(`RustraError::custom` 서명+단일 구조체 계약 준수 — 이전 커밋에서 해소 확인). 잔여 갭 수정: 가이드 생성코드 샘플을 실물(`createGeneratedFields2`/`invokeGenerated`/`number \| bigint`)로 현세대화, getting-started types/commands 샘플 현세대화 + `divide` TS 예제의 "Tauri 어댑터가 RustraCommandError 제공" 오술 교정(전 어댑터 @rustra/types 정규화 + Timeout/Cancelled/cause 신규 API 반영) + dev 스크립트 이중정의 해소(`rustra dev --config`로 통일) + init 스모크 절차에 `cargo build` 보강 + `--force` 문서화, CONTRIBUTING 릴리스 섹션을 lefthook(pre-commit 3종 + amend 필수 관례)+changesets(Version Packages PR 흐름) 현행 프로세스로 재작성, CHANGELOG 0.3→0.5 요약 추가(0.4 와이어 lockstep, 0.5 bigint postcard fast-path breaking 포함) |
| 1.6 Rust 저작면     | **완료** (1.6a) + **SKIP** (1.6b CLI 연결) | (a) unknown 폴백 경고 수집기 — 아래 상세. (b) `__RUstra_doc_` JSDoc 전달은 **기존 착지 확인**(`command_doc` → `command.description` → schema description → TS JSDoc, 검증 테스트 `command_doc_comments_flow_to_schema_and_typescript_jsdoc` green). SKIP: 수집기 → GeneratedPackage → CLI 출력 연결은 package_types.rs/package_codegen.rs 수정이 필요해 경계 밖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 1.6 unknown 폴백 경고 상세

- 감사 지점 "codegen.rs:138,169,174"는 리팩터링 후 `codegen_types.rs`의 폴백 5곳으로
  이동 — include 패밀리(codegen.rs+codegen_types.rs+codegen_objects.rs+codegen_names.rs)를
  코드젠 단일 단위로 간주하고 수정 (코디네이터 확인 지시대로).
- 설계: 스레드 로컬 수집기(`CODEGEN_WARNINGS`/`CODEGEN_COMMAND`) + `record_unknown_fallback(schema)`
  가 모든 폴백 지점에서 타입 컨텍스트(type/format 발췌)를 기록. 출력 자체(`"unknown"`)
  은 불변 — 기존 생성물 byte-exact 보존(전체 cargo 게이트 green으로 실증).
- **SKIP — 수집기 사용법 (경계 밖 연결용)**:

```rust
// package_codegen.rs 계열(경계 밖)에서 연결할 때:
use crate::codegen::{clear_codegen_warnings, set_codegen_command_context, take_codegen_warnings};

// generate_types_ts / generate_commands_ts 진입에서:
clear_codegen_warnings();
for (name, command) in state.commands.iter() {
    set_codegen_command_context(name);          // 폴백 경고에 명령명 첨부
    // ... 기존 생성 루프 ...
}
let warnings = take_codegen_warnings();          // Vec<CodegenWarning { context, command }>
// → GeneratedPackage에 warnings 필드 추가(serde 미노출, pub Vec<String> 포맷 권장:
//   "command '<name>': unmapped schema type '<context>' fell back to 'unknown'")
//   후 CLI(clicodegen/generate)가 stderr로 출력.
```

## (b) 완료 게이트 실출력 요약

전부 최종 커밋(42cc79c2) 시점, dx 워크트리에서 실행.

1. **`bun test packages/cli packages/types`**: `249 pass / 0 fail` (12 files, 1.66s)
2. **`cargo test -p rustra -p rustra-macros`**: `test result: ok` 16/16 세트
   (신규 codegen 3종 포함 93 lib tests 등), `FAILED`/`failed>0` 0건.
   `cargo fmt --check` 통과.
3. **`bun run test:ts:node`**: `# tests 61 / # pass 58 / # fail 0` (3 skipped —
   기존 조건부 스킵; Tauri 런타임 등 환경 조건)
4. **CLI 스모크** (로컬 빌드 dist):
   - `rustra doctor --format json` → `{"schemaVersion":1,"checks":[...]}]` exit 0
   - `rustra codegen --help` → usage+options 출력, exit 0
   - `rustra init init-gate` 2회 → 1회째 생성 exit 0, 2회째
     `Error: Refusing to overwrite existing files ... Re-run with --force` **exit 1**,
     `--force` → 재생성 exit 0
   - 오타 플래그: `rustra codegen --configg x` →
     `Error: Unknown codegen option: --configg. Did you mean --config? Run "rustra codegen --help".` **exit 2**
5. **문서 명령 실실행** (`/tmp/rustra-smoke/smoke-app`):
   - `rustra init` → 9파일 스캐폴드(Cargo.toml, src/{lib,main,bin/generate}.rs,
     src/index.ts, package.json, rustra.json, .gitignore, tsconfig.json)
   - `bun install` → 3 packages, `bun run codegen` → Rust schema 생성
     (스피너+경과: `[rustra] ⠸ ... still running (4s)` → `✓ done in 6.7s`)
     - generated/ + src/generated/ 생성
   - `cargo build` → `bun run demo` → `hello from TypeScript` (echo 왕복 성공)
   - `codegen --format json` → `{"command":"codegen",...,"files":[...unchanged...]}` (멱등 확인)
   - `codegen --check`: 워크스페이스 예제(examples/calculator)에서 **exit 0**.
     단, init 스캐폴드(외부 프로젝트)에서는 실패 — 원인 규명 아래 (d)-3.

## (c) 변경 파일 + 커밋 (9 commits, main..HEAD)

| 커밋       | 내용                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `5dd21bf4` | feat(cli): 통합 arg-parser — 미지 플래그 Did-you-mean 제안 + usage 오류 exit 2 + init 파서 통일 |
| `4ecd12bc` | feat(cli): config 오타 closest 제안 + codegen 빌드 스피너(경과/총 시간)                         |
| `411616a9` | feat(types): 에러 cause 보존 + Timeout/Cancelled 서브클래스                                     |
| `0b110e5e` | feat(types): RUSTRA_DEBUG=wire 와이어 덤프 — dumpWire hex+stderr + postcard/rkyv 경로 훅        |
| `2a17a5fa` | fix(cli): 스피너 렌더의 options 가드 — tsc 빌드 오류 수정                                       |
| `dc9b02fb` | docs: 실행 실패 예제 교정 + CHANGELOG 0.3→0.5 요약 + 릴리즈 프로세스 현행화                     |
| `05ae3355` | feat(codegen): unknown 폴백 경고 수집 — 타입 컨텍스트+명령명 thread-local 수집기                |
| `52b445a4` | test(cli,types): init 차단/--force·arg-parser 분리형 플래그·string 경로 비승격 경계 보강        |
| `42cc79c2` | chore(codegen): 경고 수집기 dead_code 의도 명시 — 소비 계약 문서화                              |

파일(20, +778/−55): `packages/cli/src/{cli-arg-parser,cli-init,config,index,process}.ts`

- 신규 테스트 3(cli-arg-parser/cli-init/process), `packages/cli/src/generate.test.ts`,
  `packages/types/src/{errors,debug,rkyv-engine-dispatch}.ts` + 신규 debug.test.ts +
  index.test.ts, `crates/rustra/src/{codegen,codegen_types}.rs`, `README.md`(커밋 대상
  검증만 — 최종 변경 없음), `CONTRIBUTING.md`, `CHANGELOG.md`,
  `docs/{getting-started,rust-api-guide}.md`, 이 리포트(미커밋).

## (d) SKIP — 경계 밖 발견 (메인 세션 참고)

1. **codegen 경고 → CLI 출력 연결**: `GeneratedPackage`에 warnings 필드 추가 +
   `package_codegen.rs`/`package_types_gen.rs` 연결 필요 — DX 경계 밖.
   사용법은 (a) 1.6 상세의 rust 스니펫. 수집기와 테스트는 착지돼 있어 연결만
   남았다.
2. **npm 발행 `@rustra/cli@0.5.0` dist가 한 세대 이전**: 발행물은 `cli-main.ts`
   리팩터링 이전 단일 파일 빌드라 `rustra codegen`/`doctor` 서브커맨드가
   `Unknown command`로 실패한다. README/문서의 `bunx --bun @rustra/cli ...`는
   **다음 발행 후에야 실동작**한다(현재 로컬 빌드로 실증). → 메인 세션의
   changeset/발행 흐름에서 자연 해소 예상, 발행 전 dist 재확인 권장.
3. **init 스캐폴드의 `codegen --check` 실패 (외부 프로젝트)**: 스캐폴드가
   crates.io `rustra ^0.4.0`에 의존하는데, **발행된 0.4.0 crate의
   `write_to_dir`는 `RUSTRA_SCHEMA_OUT` 우회를 지원하지 않는다**(워크트리
   crate의 package_types.rs에는 구현돼 있음 — crates 경계 밖이라 미발행 상태).
   `cli-codegen.ts`의 check 모드 에러 메시지는 이 계약을 전제한다. → 다음
   crates.io 발행(rustra minor)에 포함되면 해소. 발행 전까지 문서의
   `codegen:check`는 워크스페이스/패치된 crate에서만 유효.
4. **docs/rust-api-guide.md 생성코드 샘플의 commandId/hard-coded hash**:
   가이드의 계약 해시 예시 값은 실물과 다른 고정 문자열 — 현세대화 시 예시를
   "값은 예시" 취급으로 문구화하는 편이 안전해 본문은 현세대 코드 형태만 맞췄다.
   hash 값 자동 갱신 게이트는 별도 과제.
5. **감사 MEDIUM 항목 미처리** (계획 범위 밖): `--format json` codegen/generate
   부분 지원, doctor 기본 config 경로와 codegen 필수 `--config` 불일치,
   bun 하드코딩, `generate --watch` config 미감시 등 — 감사 테이블 참조.

## (e) 테스트 채움도 자체 점검

| 변경분             | 실패/경계 테스트                                                                                                                                                   | 평가                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| arg-parser 제안    | 미지 플래그+제안 3종(제안 있/없/인접), `--flag=value`, 분리형 `--flag value`, `-h`, boolean 값 거부, 값 누락, positional 거부/허용 — **신규 8종**                  | 충분                                                                            |
| init 차단/--force  | 2회째 차단+메시지, --force 재생성+유효성, 오타 플래그 미흡수, 디렉터리 0/2개 거부, --help 무생성, 무관 파일 비차단 — **신규 5종** (이전엔 runInit 직접 테스트 0종) | 충분                                                                            |
| config 오타 제안   | 기존 loud-fail 테스트 + 제안 매칭 신규 1종                                                                                                                         | 충분 (거리>2 미제안 분기는 closestKey 내부 분기로 제안-없음 케이스가 간접 커버) |
| 스피너             | 경과 틱+총 시간, 즉 종료 커맨드에서 still-running 없음 — 신규 2종                                                                                                  | 충분                                                                            |
| errors 서브클래스  | 구조화 경로 승격 2종+일반 코드 비승격, 생성자 코드 매핑/cause/name, string 경로 비승격(평탄화 계약 고정) — 신규 3종 + 기존 cause/stack 보존 1종                    | 충분                                                                            |
| debug env/dumpWire | `1/true/verbose` 수용, `wire/0/미설정` 거부, stderr hex 덤프, 미설정 무음 — 신규 4종                                                                               | 충분                                                                            |
| codegen 수집기     | 폴백 경고 기록(context+command), 알려진 타입 무경고, 중첩 배열 내부 컨텍스트 — 신규 3종                                                                            | 충분 (수집기 단위; 연결은 SKIP)                                                 |

## 아웃스탠딩

- lefthook prettier 재스테이징 없음 관례대로 전 커밋 `--amend --no-edit` 수행 완료.
- push/changeset 금지 준수 — 머지와 changeset은 메인 세션.
- 워크트리 밖 수정 없음 (crates는 codegen.rs include 패밀리 2파일만).
