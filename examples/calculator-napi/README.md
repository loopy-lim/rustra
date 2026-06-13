# Calculator napi-rs 예시

rustra 패키지를 Node.js 네이티브 애드온(napi-rs)으로 래핑하는 예시입니다.

## 개요

`rustra-calculator-example` 패키지의 커맨드를 napi-rs를 통해 Node.js에서 직접 호출할 수 있는 네이티브 애드온으로 만듭니다. JSON 직렬화를 통해 Rust ↔ Node.js 통신이 이루어집니다.

## 실행

```bash
# 디버그 빌드
npm run build:debug

# 릴리스 빌드
npm run build
```

## 예시가 보여주는 것

1. **napi-rs 래핑** — `rustra_calculator_example::calculator_package().invoke_json()`을 napi 함수로 노출
2. **JSON 기반 통신** — 커맨드 이름과 JSON 문자열을 받아 결과를 JSON 문자열로 반환
3. **크로스 플랫폼 빌드** — napi-rs를 통해 macOS, Linux, Windows에서 `.node` 바이너리 생성

## 핵심 파일

| 파일 | 설명 |
|------|------|
| `src/lib.rs` | `#[napi]` 속성으로 `rustra_invoke` 함수를 노출 |
| `build.rs` | napi-rs 빌드 설정 |
| `Cargo.toml` | `cdylib` 크레이트 타입, napi 의존성 |

## 생성된 함수

```ts
const { rustraInvoke } = require('./calculator-napi.darwin-arm64.node');

const result = rustraInvoke('addNumbers', JSON.stringify({ a: 20, b: 22 }));
// '{"ok":true,"result":{"value":42}}'
```

## 사전 요구사항

- Rust 툴체인
- `@napi-rs/cli` (npm 스크립트로 자동 설치됨)
- `rustra-calculator-example` 패키지 (같은 워크스페이스 내)
