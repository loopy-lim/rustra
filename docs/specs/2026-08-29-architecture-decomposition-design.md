# Rustra Architecture Decomposition Design

## 목표

현재 Rustra의 기능 계약을 유지하면서 큰 모듈을 책임별로 분리하고, 분리 상태가
다시 합쳐지거나 호스트별 복제가 재발하면 자동으로 발견할 수 있는 architecture
boundary 검사를 추가한다.

## 범위와 제약

- 현재 체크아웃의 버전 필드는 변경하지 않는다.
- generated wire format, public package entrypoint, `EngineClient`, Rust public
  authoring API는 유지한다.
- `RendererHost`는 0.x 호환성을 위해 삭제하지 않고 deprecated/doc-hidden
  정책으로 표시한다.
- Node/Bun/Tauri JSON engine은 하나의 공용 구현을 사용한다.
- RN은 공용 UTF-8 및 cancel helper를 사용하며 자체 사본을 두지 않는다.
- `rustra dev`와 `rustra generate --watch`는 같은 watcher state machine을
  사용하고 disposer를 반환한다.
- `.changeset`에는 다음 릴리스의 버전 스큐를 기록하되 실제 version bump는
  수행하지 않는다.

## 목표 모듈 경계

### Rust

- `crates/rustra-naming`: proc-macro crate와 core가 공유하는 snake/camel 이름
  변환만 소유한다.
- `crates/rustra/src/codegen/`: schema, TypeScript emit, contract output을
  소유한다.
- `crates/rustra/src/registry.rs`: command registration, id lifecycle, frozen
  registry를 소유한다.
- `crates/rustra/src/command.rs`: command metadata와 handler construction을
  소유한다.
- `crates/rustra/src/package.rs`: `Package`, `PackageBuilder`, public facade를
  소유한다.
- `crates/rustra/src/invoke.rs`: JSON/postcard/rkyv dispatch orchestration을
  소유한다.

### TypeScript

- `packages/types/src/public.ts`: public types and error exports.
- `packages/types/src/errors.ts`: error codes, parsing, normalization.
- `packages/types/src/utf8.ts`: runtime-safe UTF-8 encode/decode.
- `packages/types/src/cancel.ts`: timeout and abort races.
- `packages/types/src/json-engine.ts`: shared JSON transport engine.
- `packages/types/src/live-schema.ts`: live schema parsing/cache surface.
- `packages/types/src/rkyv-engine.ts`: rkyv V2 codec and dispatch engine.
- `packages/types/src/global.ts`: configure, lazy bootstrap, global invoke.
- `packages/types/src/index.ts`: compatibility re-export facade only.

### CLI

- `packages/cli/src/watch.ts`: debounce, queue, dispose, and filesystem event
  filtering.
- `packages/cli/src/index.ts`: command dispatch and public CLI facade only.
- Existing `config.ts`, `cargo.ts`, `hash.ts`, `paths.ts`, `process.ts` remain
  single-purpose helpers.

## Architecture boundary checks

`bun run test:architecture` must fail when any of the following occurs:

1. `packages/types/src/index.ts`, `crates/rustra/src/lib.rs`, or
   `packages/cli/src/index.ts` exceeds its agreed line budget.
2. JSON adapter packages duplicate transport-engine logic instead of calling
   `createJsonEngine`.
3. RN defines private UTF-8 or abort-race implementations.
4. More than one Rust implementation of the shared snake/camel conversion exists.
5. CLI watcher timers or watcher state machines are reintroduced outside
   `watch.ts`.
6. public imports bypass the intended facade or create a forbidden adapter-to-adapter
   dependency.

The check reports the exact file, rule, and remediation so a future contributor can
repair the boundary without reading the entire implementation.

## Compatibility strategy

Extraction is behavior-preserving. Each extraction starts with a failing test or
snapshot of the existing public surface, then moves implementation behind the new
module and keeps the old import path as a re-export. Generated outputs are compared
byte-for-byte, and the Rust/C++/TS wire fixtures remain mandatory gates.

## Validation

- focused tests after every extraction;
- TypeScript build and package tests;
- Rust workspace tests and doctests;
- generated code and C++ codec tests;
- architecture boundary test;
- React Doctor and release/package checks;
- existing Rust and JS performance suites.
