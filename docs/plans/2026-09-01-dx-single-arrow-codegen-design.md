# DX 사이클 설계: 단일 화살 코드젠 + 산출물 가시성 + 온보딩 게이트 (2026-09-01)

> 상태: 사용자 승인 완료 (접근 A + B + C 적층). 구현 계획은 `2026-09-01-dx-single-arrow-codegen.md`에 작성 예정.

## 목표

코드젠 혼란 3종(듀얼 패스 재생성, 소스 오브 트루스 방향, 다중 표면 추적)을 뿌리에서 제거하고,
온보딩/일상 개발 루프/디버깅 진단/산출물 가독성 네 DX 통증을 한 축에서 함께 개선한다.

## 배경 — 듀얼 패스의 현재 실체 (코드 확인 완료)

- **Rust 측** `package.generate_typescript().write_to_dir()` (`crates/rustra/src/package_types.rs`):
  `schema.json`, `types.ts`, `commands.ts`, `contract.ts`를 발행. `RUSTRA_SCHEMA_OUT` 지원.
- **TS 측** `generateFromSchema` (`packages/cli/src/cli-generate-files.ts`):
  같은 `schema.json`에서 `types.ts`/`commands.ts`/`contract.ts`를 재렌더링하고,
  `rkyv-codecs.ts`, `rkyv-registry.ts`, C++ 코덱, 호스트 엔트리(node/bun/tauri/react-native)까지 전부 발행.
- `rustra codegen`(`cli-codegen.ts`)은 이미 cargo run → runGenerate 2단계를 오케스트레이션한다.
  비-check 경로에서 cargo가 쓴 types.ts를 TS 렌더가 덮어쓰므로 최종 바이트는 TS 렌더.
- **산 함정**: `cargo run`(데모)만 돌려도 `generated/types.ts` 등이 Rust 렌더로 덮여써져
  다음 `codegen --check`에서 drift로 fail. "둘 다 순서대로"라는 지식이 문서/머릿속에만 존재.
  crud 예제가 한때 이 부류로 HEAD부터 깨진 전례([[codegen-dual-path-regen]]).

## 핵심 원리

- **schema.json이 유일한 입력, TS CLI가 유일한 렌더러**: Rust bin은 계약 프로브로 축소.
  같은 파일을 두 렌더러가 생산하는 구조 자체를 소멸시킨다.
- **계약은 산문이 아니라 게이트로**: "둘 다 돌려라"는 문서가 아니라, 한 방 커맨드 +
  doctor 스테일 감지 + CI 바이트 게이트로 강제한다.
- **파일이 자기서술한다**: generated 파일 헤더가 출처·재생성 명령·편집 금지를 각인한다.
- **문서는 거짓말하지 않는다**: getting-started 흐름을 CI가 실동작으로 검증한다.

## 설계

### 1. 단일 렌더러 원칙 (접근 A 뼈대)

- Rust `generate_typescript()`의 TS 발행(`types_ts`/`commands_ts`/`contract_ts`)은
  **deprecated 표기** (버전 정책 준수 — 제거 아님). Node 없는 환경 경계는 문서로 정직화.
- Rust bin의 역할은 **계약 프로브**: `schema.json` 발행 (`RUSTRA_SCHEMA_OUT` 경로 유지).
- 예제 generate bin들(auth/streaming/crud `src/bin/generate.rs`, calculator `main.rs`의
  데모 중 `write_to_dir`)은 TS 파일 쓰기를 중단하고 schema.json만 쓴다.
  calculator 데모가 `generated/`를 덮어쓰는 부작용 제거.
- `rustra codegen`은 오케스트레이터로 유지 (구조 변경 최소 — 2단계는 이미 존재).
  `--check`도 양 단계 바이트 검증 유지.
- `rustra generate --schema/--output` 직접 경로는 하위호환으로 유지 (외부 프로젝트용).

### 2. Generated 헤더 각인 (접근 B)

전 생성 TS/C++ 파일 상단에 결정론적 헤더 삽입:

```
// ── rustra generated ────────────────────────────────────────
// Source: schema.json (do not edit — this file is regenerated)
// Regen:  rustra codegen --config rustra.json
// Stage:  types (rust-probe schema → ts renderer)
// ────────────────────────────────────────────────────────────
```

- 대상: types/commands/contract/events, rkyv-codecs/registry, positional-facade,
  C++ hpp/cpp, 호스트 엔트리, RN 스캐폴드 — TS CLI가 쓰는 전 파일.
- 헤더는 바이트 안정적이어야 한다 (매니페스트/스냅샷 게이트와 정합).
  계약 해시 계약(contract.ts의 GENERATED_CONTRACT_HASH, wire 골든 게이트) 불변.
- Stage 표기로 "이 파일이 어디서 왔는지" 다중 표면 추적 혼란 해소.

### 3. 진단 강화 (접근 A)

- **`rustra doctor` 스테일 검사 추가** (읽기 전용 유지):
  - 매니페스트(`.rustra-generated.json`) 부재 → "run rustra codegen"
  - `schemaHash` ≠ 현재 schema.json 해시 → schema 변경 후 재생성 안내
  - `generatorVersion` ≠ CLI 버전 → 재생성 안내
  - 바이트 전수검증은 `codegen --check` 소관 (doctor는 저비용 유지)
- **`rustra codegen --explain`**: 입력→출력 매핑 표 출력.
  `schema.json → types.ts (ts renderer)`, `schema.json → rkyv-codecs.ts` 등
  전 표면의 출처를 한눈에. 다중 표면 추적 혼란의 직접 처방.
- drift 에러 메시지가 수정 명령(`rustra codegen`)을 직접 안내하는지 확인/보강.

### 4. 온보딩 화살 (접근 C)

- `rustra init`이 심는 package.json 스크립트는 단일 커맨드를 가리킨다
  (doctor/codegen/codegen:check/dev/demo — 이미 단일 화살, 템플릿 정합성만 확인).
- **`test:onboarding` CI 게이트 신설**: 임시 디렉토리에서
  `init → doctor → codegen → demo` 전 흐름을 실동행 검증.
  getting-started.md의 "첫 10분"이 문서가 아니라 게이트가 된다.
- getting-started.md에서 Rust bin 직접 codegen 유도 서술을 단일 화살로 정리.

## 테스트 전략

- 헤더: 바이트 안정성 테스트(동일 스키마 2회 렌더 == 동일 바이트), 전 파일 헤더 존재 게이트.
- deprecated: Rust 측 deprecation 어노테이션 + 문서 정합 테스트.
- 예제 bin: schema.json만 쓰는지 음성 테스트(TS 파일 미기록).
- doctor: 스테일 3부류(부재/해시 드리프트/버전 드리프트) 상황 매트릭스.
- explain: 매핑 표 스냅샷 테스트.
- onboarding: 임시 디렉토리 엔드투엔드 게이트 스크립트 + 테스트.
- 회귀: `cargo clippy --all-targets -D warnings`, 전체 bun 테스트, `codegen --check` CI green.

## 범위 밖 (명시적 이월)

- WASM/Web 호스트, Electron 호스트, 프리빌트 바이너리 배포 (기존 별트랙 유지)
- Live TUI/웹 인스펙터 대시보드
- Rust 측 TS 발행의 실제 제거 (deprecated → 별도 minor에서 판단)
- 발행(Version PR #51 머지) — changeset 추가 적립 후 사용자 승인으로만
