# Tauri Calculator 예시

rustra 패키지를 Tauri 2 데스크톱 애플리케이션에 통합하는 예시입니다.

## 개요

`rustra::tauri_support::register`를 사용하여 rustra 패키지를 Tauri 빌더에 등록합니다. 프론트엔드에서 `@rustra/tauri` 어댑터의 `createTauriEngine`으로 Tauri IPC를 통해 커맨드를 실행합니다.

## 실행

```bash
# 프로덕션 빌드
npm run build

# 프론트엔드만 빌드
npm run build:frontend

# 런타임 스모크 테스트
npm run smoke
```

## 예시가 보여주는 것

1. **Tauri 연동** — `tauri_support::register(package, builder)`로 커맨드 자동 등록
2. **런타임 스모크 테스트** — `RUSTRA_TAURI_PROBE_FILE` 환경변수를 사용해 앱 실행 없이 커맨드 검증
3. **프론트엔드 사용** — `createTauriEngine({ invoke: window.__TAURI__.core.invoke })`로 엔진 생성

## 핵심 파일

| 파일 | 설명 |
|------|------|
| `src-tauri/src/main.rs` | Tauri 빌더에 rustra 패키지 등록 + 프로브 모드 |
| `src-tauri/Cargo.toml` | `rustra` crate `tauri` feature 활성화 |
| `src/app.ts` | 프론트엔드에서 `createTauriEngine` 사용 |
| `runtime-smoke.mjs` | 자동화 런타임 스모크 테스트 |

## Rust 측 설정

```rust
use rustra::tauri_support;
use rustra_calculator_example::calculator_package;

let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

## TypeScript 측 설정

```ts
import { createTauriEngine } from '@rustra/tauri';

const engine = createTauriEngine({
  invoke: window.__TAURI__.core.invoke,
});
```

## 사전 요구사항

- Rust 툴체인
- Tauri CLI 2.0+ (`npm install -g @tauri-apps/cli`)
- `rustra-calculator-example` 패키지 (같은 워크스페이스 내)
