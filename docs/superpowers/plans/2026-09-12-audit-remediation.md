# 감사 결함 수정 및 릴리스 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: subagent-driven-development. 변경은 회귀 테스트와 함께 진행한다.

**Goal:** 승인된 F01–F24를 수정하고 사용자가 지정한 릴리스 작업을 검증 근거와 함께 완료한다.
**Architecture:** 기존 Package/Engine/adapter 경계를 유지하고 소유권·범위·세대 검사를 해당 경계 내부에 둔다.
**Tech Stack:** Rust, TypeScript, React, Node/Bun, Tauri, Cargo, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-09-12-audit-remediation.md

## Global Constraints

- 기준 HEAD 8b826d75, 현재 전용 feature checkout 사용. 기존 사용자 iOS 생성물과 다른 worktree는 보존한다.
- 구현 에이전트는 한 번에 한 명만 실행한다. 루트는 파일 소유권이 겹치지 않는 작업을 진행한다. 에이전트는 재위임하지 않는다.
- 커밋·push·발행은 루트가 최종 범위와 사용자 의사를 확인한 뒤 처리한다. 구현 에이전트는 커밋하지 않는다.
- 소스 정규식 대신 실제 동작 회귀 테스트를 우선한다. 자원 정리는 멱등이어야 한다.

### Task 1: Bootstrap 소유권과 종료 (F02/F07/F08/F09)

Files: packages/types/src/global-config.ts 및 관련 lazy/registry 파일·테스트; packages/node/src/node-bootstrap.ts, node-process-transport.ts 및 테스트; packages/bun/src/bun-ffi.ts 및 테스트.

- [ ] 등록 토큰/세대에 귀속된 해제 API로 다른 엔진을 보호한다.
- [ ] ready 도중 dispose, 비동기 transport 지연 도착, 계약 조회 reject, reload 중복, dispose 후 재생성의 회귀 테스트를 먼저 실패시킨다.
- [ ] 반환된 엔진/기본 transport도 종료 후 호출을 거부한다. ready 직전 microtask 경합을 검증한다.
- [ ] Node/Bun과 types 관련 테스트 및 빌드 후 변경 범위와 근거를 보고한다.

### Task 2: Rust 경로 일치 및 진단 (F03/F04/F12/F23/F24)

Files: crates/rustra/src/{invoke_frame,state,command_handlers,command_into,channels_host,hot_core*}.rs 및 해당 테스트.

- [ ] raw State, 빈 inner 상태, 단순 응답의 direct/fallback 한도, bytes 채널 진단 회귀 테스트를 먼저 실패시킨다.
- [ ] 최소한의 컨텍스트/크기/계수 수정을 적용한다. hot-core는 안전한 retained-library 계수를 제공한다.
- [ ] 해당 Rust 테스트 및 hot-core feature 검사를 실행한다.

### Task 3: React 범위와 입력 수명 (F01/F06/F10/F11/F24)

Files: packages/react/src 및 tests; React package dev dependencies; docs React hook 설명.

- [ ] 실제 마운트/SSR의 엔진 격리, Set/ArrayBuffer 입력 교체, mutation scope 변경, 늦은 unsubscribe를 회귀 테스트로 추가한다.
- [ ] 엔진별 캐시 및 유한 cache policy, scoped invalidate, 충돌 없는 지원 입력 key를 구현한다.
- [ ] 현재 공개 API와 기본 엔진 사용을 보존하고 정책을 문서화한다. React 테스트·빌드를 검증한다.

### Task 4: Tauri 채널 소유권 (F05)

Files: crates/rustra/src/tauri_channels.rs 및 Tauri command/plugin wiring, 관련 테스트와 문서.

- [ ] WebView 별 채널 수신·drop 권한을 실제 Tauri mock runtime 또는 동등 경계 테스트로 고정한다.
- [ ] JS 호출자 WebView에 송신·종료·파괴 정리를 귀속한다. 신뢰된 host helper는 명확한 정책을 유지한다.
- [ ] Tauri feature 빌드와 테스트를 실행한다.

### Task 5: CLI 감시와 UniFFI 산출물 (F13/F14/F15/F16)

Files: packages/cli/src/{watch,dev,cli-uniffi,cli-codegen}.ts 및 관련 모듈·테스트.

- [ ] rustra.json 재해석, 새 디렉터리, watcher error의 테스트 후 복구 가능한 감시를 구현한다.
- [ ] Cargo lib target 및 compiler-artifact를 기준으로 실제 경로를 선택한다.
- [ ] 빈 임시 경로에 UniFFI를 생성한 후 실제 Swift/Kotlin 파일을 비교하고 성공한 산출물만 교체한다. 별도 check 옵션과 gate를 제공한다.
- [ ] CLI 테스트·예제 codegen 검사를 통과시킨다.

### Task 6: API·퍼징·실행 검증 (F17/F18/F19)

Files: scripts/api-surface.mjs 및 tests/snapshots; .github/workflows/fuzz.yml; package.json test scripts.

- [ ] TS 선언 서명·subpath 및 Rust 공개 타입·trait 변경을 감지하는 fixture 테스트를 추가한다.
- [ ] 세 fuzz target마다 유효한 seed/corpus 경로를 replay와 duration 실행에 함께 사용한다.
- [ ] subprocess 검사는 Node에서 직접 실행하고 오류 진단을 보존한다. 루트 test 전체 실행을 복구한다.

### Task 7: 릴리스 정합과 완료 (F20/F21/F22)

Files: RN example lock; release manifest/changesets; README/docs English/Korean; CI configuration as required.

- [ ] 사용자가 지정한 열린 작업과 현재 브랜치/공개 버전을 대조한다. 이미 발행한 버전은 재사용하지 않는다.
- [ ] frozen 설치를 복구하고 설치 예제·호환 표를 단일 릴리스 버전 자료에서 검증한다.
- [ ] Frame 변경의 coordinated upgrade와 소비자 검사를 제공한다. 전체 fmt/lint/build/test/API/docs/codegen/release gate를 실행한다.
- [ ] 전체 변경 독립 리뷰를 거쳐 지적을 해결한다. 최종 커밋/CI/릴리스 결과와 미수행 검증을 기록한다.
