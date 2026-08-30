# Tauri Calculator 예시

rustra 패키지를 Tauri 2 데스크톱 애플리케이션에 통합하는 예시입니다.

## 개요

Rust 측 한 줄 등록과 생성된 TypeScript 진입점만으로 Tauri IPC와 event push를
연결합니다. 프런트엔드에는 engine 생성이나 `configure()`가 없습니다.

## 실행

```bash
# 프로덕션 빌드
bun run build

# 프론트엔드만 빌드
bun run build:frontend

# 런타임 스모크 테스트
bun run smoke

# 실제 숨은 WebView에서 generated API 3,000회 측정
bun run bench
```

## 예시가 보여주는 것

1. **Tauri 연동** — `tauri_support::register(package, builder)`로 커맨드 자동 등록
2. **Zero config 프런트엔드** — `generated/tauri.ts`가 global invoke/event를 lazy 감지
3. **실제 화면 코드** — 명령 결과의 `result.value`를 DOM에 반영하고 event를 구독
4. **WebView 성능 영수증** — 실제 `rustra_dispatch` IPC를 warm-up 뒤 3회 반복

## 핵심 파일

| 파일                    | 설명                                          |
| ----------------------- | --------------------------------------------- |
| `src-tauri/src/main.rs` | Tauri 빌더에 rustra 패키지 등록 + 프로브 모드 |
| `src-tauri/Cargo.toml`  | `rustra` crate `tauri` feature 활성화         |
| `src/app.ts`            | generated command와 event를 사용하는 화면     |
| `runtime-smoke.mjs`     | 자동화 런타임 스모크 테스트                   |
| `src/benchmark.ts`      | 실제 WebView IPC 정확성·지연 측정             |
| `benchmark.mjs`         | 숨은 앱 실행 + 로컬 영수증 수집               |

## Rust 측 설정

```rust
use rustra::tauri_support;
use rustra_calculator_example::calculator_package;

let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

## TypeScript 측 사용

```ts
import { addNumbers, subscribeEvent } from '../calculator/generated/tauri.js';

await subscribeEvent('calc.tick', console.log);
const { value } = await addNumbers({ a: 20, b: 22 });
document.querySelector('output').value = String(value);
```

Tauri 설정은 `app.withGlobalTauri: true`, `rustra.json`은 `"tauri": {}`를 사용합니다.
global API를 의도적으로 끈 기존 앱만 `createTauriEngine({ invoke })`를 escape hatch로
사용합니다.

## 현재 실측

2026-08-24 macOS arm64 Release에서 generated WebView IPC는 평균 279.04µs, p50
300µs, 약 3,584 ops/s였습니다. WKWebView 타이머가 약 1ms 단위라 20회 배치의
호출당 값으로 percentile을 계산합니다. 이는 Tauri UI IPC 비용을 포함하므로 Rust
직접 호출이나 Node/Bun 네이티브 ABI 수치와 같은 경계가 아닙니다.

## 사전 요구사항

- Rust 툴체인
- Tauri CLI 2.0+ (`bun add -g @tauri-apps/cli`)
- `rustra-calculator-example` 패키지 (같은 워크스페이스 내)
