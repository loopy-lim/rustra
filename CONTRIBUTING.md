# 기여 가이드

rustra에 기여하는 방법을 정리한다.

---

## 개발 환경 설정

### 요구사항

- Rust (edition 2024, resolver 3)
- Node.js 18+
- Bun
- Cargo 워크스페이스 지원

### 초기 설정

```bash
git clone <repo-url> && cd rustra-bridge

# Rust 빌드 확인
# (lynx-tauri-spike 은 macOS + Lynx SDK 가 필요한 전용 스파이크 — 제외.
#  --workspace 는 default-members 를 무시하므로 명시적 exclude 가 필요하다)
cargo build --workspace --exclude rustra-lynx-tauri-spike

# 전체 테스트 실행
cargo test --workspace --exclude rustra-lynx-tauri-spike
npm run test:compat
```

---

## 프로젝트 구조 이해

기여 전에 다음 문서를 읽는 것을 권장한다:

1. [아키텍처 개요](docs/architecture.md) — 전체 구조와 핵심 개념
2. [Crate 및 Package 구조](docs/internal/crate-structure.md) — 각 crate/package의 책임과 의존성
3. [테스트 구조](docs/internal/testing.md) — 테스트 계층, 실행 명령어

---

## 개발 워크플로우

### 1. 브랜치 생성

```
main → feature/짧은-설명
     → fix/짧은-설명
```

### 2. 코드 변경

Rust 코드를 변경하면:

```bash
# Rust 테스트
cargo test --workspace --exclude rustra-lynx-tauri-spike

# 생성된 TS 갱신 (calculator 예시)
cargo run -p rustra-calculator-example

# 전체 호환성 테스트
npm run test:compat
```

TypeScript 패키지를 변경하면:

```bash
# 어댑터 테스트
npm run test:adapters

# 런타임 테스트
npm run test:runtime
```

### 3. 커밋

커밋 메시지는 변경의 **이유**를 중심으로 작성한다:

```
feat: add tuple type support in TS codegen

fix: handle null args in rustra_dispatch

docs: add debugging guide to contributing

refactor: extract command name resolution into shared function
```

### 4. PR 생성

- PR 제목은 70자 이내로 변경을 요약
- PR 본문에 **무엇을** 변경했는지, **왜** 필요한지 설명
- `npm run test:compat`가 통과하는지 확인

---

## 테스트

### 테스트 계층

```
cargo test          ← Rust 단위 테스트 (필수)
    ↓
npm run test:ts:node  ← TS 타입 검증 (필수)
    ↓
npm run test:adapters ← 어댑터 동작 검증 (필수)
    ↓
npm run test:runtime  ← 실제 Rust↔TS 실행 (필수)
    ↓
npm run test:compat   ← 전체 통합 (PR 필수)
```

### Rust 테스트

```bash
cargo test --workspace --exclude rustra-lynx-tauri-spike
```

### TypeScript 테스트

```bash
# 전체
npm run test:compat

# 개별
npm run test:ts:node
npm run test:ts:bun
npm run test:adapters
npm run test:runtime:node
npm run test:runtime:bun
npm run test:runtime:tauri
```

### 테스트 파일 위치

| 파일                                                | 역할                        |
| --------------------------------------------------- | --------------------------- |
| `crates/rustra/tests/public_authoring_api_tests.rs` | Rust 공개 API 테스트 (10개) |
| `examples/calculator/tests/example_contract.rs`     | 종단 간 계약 테스트 (1개)   |
| `examples/calculator/ts/generated-client.test.ts`   | TS 클라이언트 동작 (2개)    |
| `examples/calculator/ts/adapter-compat.test.ts`     | 4개 어댑터 호환성 (6개)     |
| `examples/calculator/ts/runtime-contract.test.ts`   | 런타임 계약 (2개)           |

---

## 코드 규칙

### 불변식

모든 변경은 [호환성 계약](docs/compatibility-contract.md)을 만족해야 한다:

1. **생성된 TS는 host-specific import를 포함하지 않는다**: `node:`, `bun:`, `@tauri-apps`, `react-native`, `expo-modules` 금지
2. **어댑터 패키지는 서로를 import하지 않는다**
3. **어댑터는 host 패키지를 직접 import하지 않는다**: transport는 호출자가 주입
4. **`EngineClient`가 유일한 계약이다**: command helper는 `EngineClient`만 의존

### Rust

- 공개 API는 `prelude` 모듈에서 재export
- `#[command]` 매크로는 시그니처 검증 + trait bound assertion만 수행 (본문은 identity passthrough)
- 에러는 `RustraError`로 통일

### TypeScript

- 어댑터 패키지는 외부 의존성 없이 순수 TypeScript
- `EngineClient` 인터페이스(`invoke<T>`)만 노출
- Tauri만 `rustra_dispatch` 래핑, 나머지는 transport 직접 호출

---

## 디버깅 가이드

### 코드 생성 결과가 이상할 때

1. `schema.json` 확인 — schemars가 생성한 JSON Schema가 의도한 대로인지 검사
2. `types.ts` 확인 — JSON Schema → TS 타입 매핑 규칙은 [codegen 문서](docs/internal/codegen.md) 참조
3. 미지원 타입(`tuple`, `oneOf`, `allOf`, integer enum, 중첩 `$ref`)은 `unknown`으로 폴백됨

### Contract hash 불일치

`contract.ts`의 `GENERATED_CONTRACT_HASH`는 `schema.json`의 SHA-256 해시다. Rust 코드를 변경하고 TS를 재생성하지 않으면 해시가 달라진다:

```bash
# 재생성
cargo run -p rustra-calculator-example

# diff로 확인
git diff generated/contract.ts
```

### command 이름이 예상과 다를 때

- `command_fn()`은 `std::any::type_name`에서 이름을 추출한다. 디버그 빌드에서는 전체 경로가 포함될 수 있음
- 정확한 이름이 필요하면 `#[command(name = "myCommand")]` 사용
- `commands.ts`에서 실제 생성된 이름을 확인

### 어댑터 테스트 실패

```bash
# 특정 어댑터만 실행
npm run test:adapter:tauri
npm run test:adapter:react-native

# 모킹 transport로 로깅
const engine = createNodeEngine({
  invoke(command, args) {
    console.log('invoke:', command, args);
    return mockResponse;
  },
});
```

### Tauri 런타임 디버깅

Tauri 앱이 `rustra_dispatch`에서 에러를 반환할 때:

1. Rust 측: `RustraError`가 `{ code, message }` JSON으로 직렬화됨
2. TS 측: `createTauriEngine`이 이를 `RustraCommandError`로 변환하여 throw
3. 콘솔에서 `e.code`, `e.message` 확인

### React Native 관련

- RN 런타임 테스트는 시뮬레이터/디바이스가 필요하므로 CI에서는 제외됨
- `test:adapter:react-native`는 모킹 transport로 검증 (실제 FFI 아님)
- FFI 문제 시 Swift 모듈에서 `@_silgen_name` 함수명과 Rust `#[unsafe(no_mangle)]` 함수명이 일치하는지 확인

---

## 릴리즈

### 버전 관리

- 현재 `0.1.0` (semver)
- `0.x` 동안은 breaking change가 가능하나, 최소한의 변경으로 유지
- Rust crate과 TS 패키지는 동일 버전을 유지

### 릴리즈 체크리스트

1. `cargo test --workspace --exclude rustra-lynx-tauri-spike` 통과
2. `npm run test:compat` 통과
3. `Cargo.toml` 버전 갱신
4. CHANGELOG 갱신 (있다면)
5. git tag 및 push
