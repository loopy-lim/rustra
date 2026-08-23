# rustra

[![CI](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml/badge.svg)](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rustra/types)](https://www.npmjs.com/package/@rustra/types)
[![crates.io](https://img.shields.io/crates/v/rustra.svg)](https://crates.io/crates/rustra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Rust에서 명령을 한 번 정의하면, Node / Bun / Tauri / React Native 어디서든 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크.

> **English** — Define commands once in Rust, get type-safe TypeScript clients
> for Node, Bun, Tauri, and React Native. Single Rust core, four host surfaces,
> zero-copy binary wire (rkyv V2). Quick start: `cargo add rustra` +
> `bunx @rustra/cli init`. Full docs (Korean) below.

## 작동 방식

```
Rust #[command] 정의 → TypeScript 클라이언트 자동 생성 → 각 플랫폼 어댑터로 실행
```

- Rust 쪽에서 `#[command]`로 함수를 정의
- `generate_typescript()` 호출 시 타입 안전한 TS 클라이언트 코드 생성
- Node, Bun, Tauri, React Native 어댑터가 동일한 `EngineClient` 인터페이스로 라우팅

## 왜 rustra인가 (비교)

단일 Rust 코어를 여러 JS 호스트에 잇는 도구는 각자 다른 지점을 타협한다:

|                               | **rustra**                        | napi-rs           | Nitro Modules | Tauri commands | tauri-specta |
| ----------------------------- | --------------------------------- | ----------------- | ------------- | -------------- | ------------ |
| 단일 Rust 코어 × 멀티 호스트  | ✅ Node/Bun/Tauri/RN              | Node (+ Electron) | RN 중심       | Tauri 전용     | Tauri 전용   |
| 타입 안전 코드젠 (양방향)     | ✅ 커맨드+이벤트                  | 수동 d.ts         | ✅            | ❌ (수동)      | ✅           |
| 바이너리 zero-copy 와이어     | ✅ rkyv V2 (JSON 대비 11.8× 작음) | JSON/Buffer       | JSI 객체      | JSON IPC       | JSON IPC     |
| 계약 게이트 (breaking change) | ✅ `rustra diff` + contract hash  | ❌                | ❌            | ❌             | 부분         |
| 취소/타임아웃/배치 시맨틱     | ✅ 매트릭스로 문서화              | 직접 구현         | 직접 구현     | ❌             | ❌           |

rustra의 선택: **RPC 표면 전체(정의→코드젠→와이어→검증)를 하나의 계약으로
소유**한다. 개별 경로의 마이크로 최적화보다 "한 번 정의하면 어디서든 같은
시맨틱"이 이 프로젝트가 사는 지점이다.

## 로드맵

- [x] 4호스트 어댑터 (Node/Bun/Tauri/RN iOS+Android) — 0.1
- [x] rkyv V2 바이너리 fast-path + 취소/타임아웃/배치 — 0.1~0.2
- [x] 이벤트 계약 코드젠 (`PackageBuilder::event`) — 0.2.x
- [x] persistent 루프 런타임 + Node loop transport — 0.2.x
- [x] 타입 패리티 1단계 — fast path 타입 확장 (2026-08-22): u8–u64 plain
      varint, 동적 맵 `HashMap<String,T>`(원시값), 튜플(무접두), `Vec<u8>`
      bytes(ArrayBuffer 표면), chrono Date(ISO string), Set<unsigned> —
      3면(TS·Rust·C++) 코드젠 + PINNED hex 와이어 게이트. 잔여: bigint TS
      표면(number 유지, 2^53 한계), data enum(oneOf 순서 비결정 → Tier 3 확정)
- [x] 타입 패리티 2단계 — 채널/리소스 (Tauri v2 `ipc::Channel`·`Resource`
      모델, 2026-08-23): 콜백을 직렬화 가능한 채널 핸들(u32, 호출 귀속
      유니캐스트 회신)로, 객체 참조를 Rust-소유 리소스 핸들(`channels.rs`
      `ChannelHost` 테이블, 코드젠 커맨드로 read/write/close)로. wire는
      정수 핸들뿐이라 계약 게이트·양방향 코드젠·멀티호스트 일관성 유지.
      RN JSI `createChannel(cb)`/`dropChannel(h)` 배선 + Rust FFI
      `rustra_ffi_channel_{create,send,drop}` — 시뮬레이터 E2E 검증 완료
- [ ] async 커맨드 핸들러 (워커 풀은 완료, 핸들러 trait 비동기화는 진행 중)
- [ ] Windows 런타임 검증 (CI 확장 단계)
- [ ] 프리빌트 바이너리 배포 (npx 설치 시 cargo 불필요)

## FAQ

**Q. Rust 툴체인이 꼭 필요한가요?**
지금은 네(네이티브 라이브러리를 로컬 빌드). 프리빌트 배포는 로드맵에 있다.
JS만으로 시작하려면 `@rustra/testing`의 mock 엔진으로 UI를 먼저 만들 수 있다.

**Q. JSON 경로도 지원하나요?**
예. rkyv V2는 fast-path일 뿐, 모든 명령은 JSON 폴백으로도 동작한다(Tier 3).
바이너리 이식이 어려운 환경도 계약은 같다.

**Q. 기존 napi-rs/Tauri 앱에 점진적으로 붙일 수 있나요?**
예. 어댑터는 transport만 교체한다 — `createNodeEngine(transport)`에 기존
invoke 함수를 넘기면 그 명령만 rustra 계약으로 들어온다.

**Q. 스키마가 깨지면 어떻게 되나요?**
`rustra diff`가 breaking change를 CI에서 잡고, 계약 해시(contract hash)가
JS/네이티브 조합의 drift를 런타임에 감지한다.

## 설치

### Rust

```toml
[dependencies]
rustra = "0.2"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

### TypeScript 어댑터 (필요한 환경만)

```bash
bun add @rustra/node      # Node.js
bun add @rustra/bun       # Bun
bun add @rustra/tauri     # Tauri
bun add @rustra/react-native  # React Native
bun add @rustra/testing       # Mock 엔진 (테스트)
bun add @rustra/devtools      # 호출 관측성 (개발)
```

## 빠른 예제

```rust
use rustra::prelude::*;

// #[command] 는 단일 Input 구조체를 받고 Result<Output> 를 반환한다.
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }
#[bridge_type]
struct AddNumbersOutput { sum: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}

fn main() -> Result<()> {
    let package = rustra::build!("example.calculator", add_numbers).done();

    // TypeScript 클라이언트 생성 (1단계: types/commands/contract/schema)
    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

바이너리 fast-path(rkyv V2, RN)를 쓰려면 **2단계**가 추가로 필요하다 —
Rust가 만든 `schema.json`을 읽어 TS CLI가 `rkyv-codecs.ts`/`rkyv-registry.ts`를
생성한다(이 파일들이 없으면 fast-path 클라이언트는 import 에러로 부팅 실패):

```bash
bunx @rustra/cli generate --schema ./generated/schema.json --output ./generated
```

두 단계를 한 번에 실행하려면 `bunx @rustra/cli dev`(소스 감시 + dual-path 자동 재생성)
또는 `bunx @rustra/cli init`이 만들어주는 `bun run codegen` 스크립트를 쓴다.

```ts
// TypeScript — 모든 플랫폼에서 동일
import { createNodeEngine, configure } from '@rustra/node';
import { addNumbers } from './generated/commands.js';

const engine = createNodeEngine({ invoke: myTransport });
configure(engine); // 글로벌 invoke 에 엔진 설치 — 생성 함수는 엔진 파라미터 없이 호출
const result = await addNumbers({ a: 20, b: 22 }); // 42
```

## 프로젝트 구조

```txt
crates/
  rustra/          Rust 패키지 authoring API (core)
  rustra-macros/   #[command], #[bridge_type] proc macros, build! 매크로

packages/
  node/            Node adapter
  bun/             Bun adapter
  tauri/           Tauri adapter
  react-native/    React Native adapter
  testing/         Mock 엔진 + 계약 게이트 (createMockEngine)
  devtools/        호출 관측성 래퍼 (createInstrumentedEngine)

examples/
  calculator/              기본 예시 (Rust crate + C FFI + stdio + 생성된 TS)
  crud/                    CRUD 패턴 예시 (create/get/list/update/delete)
  benchmark/               성능 벤치마크 (페이로드 확장, 처리량 측정)
  tauri-calculator/        Tauri 런타임 예시
  react-native-calculator/ React Native 런타임 예시
  calculator-napi/         napi-rs transport 예시 (release transport 벤치마크의 소스)
  streaming/               이벤트 스트리밍 예시 (Package::emit + 폴링 어댑터)
  auth/                    세션/capability 게이트 예시 (deny-by-default)
  reference-app/           @rustra/react 훅 레퍼런스 앱 (useCommand/useMutation/useEvent)
```

## 로컬 저장공간 관리

개발 및 테스트 Cargo 프로필은 incremental 캐시와 의존성 debug info를 저장하지 않는다.

```bash
bun run clean:dry    # deep clean 대상을 삭제하지 않고 크기만 확인
bun run clean:build  # Rust/Xcode/Android/TS 빌드 산출물 제거, 설치 의존성 유지
bun run clean:deep   # build 산출물 + node_modules/Pods/로컬 패키지 캐시 제거
```

정리 명령은 명시된 재생성 가능 경로만 제거한다. `git clean -fdX`는 로컬 모바일
프로젝트나 설정 파일까지 삭제할 수 있으므로 저장공간 정리 용도로 사용하지 않는다.

## Rust: 명령 정의

```rust
use rustra::prelude::*;

// 모든 #[command] 는 단일 Input 구조체(또는 인자 없음)를 받고 Result<O> 를 반환한다.
#[bridge_type]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    sum: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}

// 인자가 없는 명령도 가능하다
#[command]
fn ping() -> Result<String> {
    Ok("pong".to_string())
}

// capability 게이트가 필요한 명령은 속성 하나로 (grant 전까지 deny-by-default)
#[command(capability = "compute:secure")]
fn locked_add(input: AddNumbersInput) -> Result<AddNumbersOutput> { ... }
```

패키지를 빌드하고 TypeScript 코드를 생성:

```rust
fn main() -> Result<()> {
    // build! 매크로로 여러 커맨드를 한 번에 등록
    let package = rustra::build!("example.calculator", add_numbers).done();

    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

## 런타임 명령 레지스트리 (dev / prod)

`Package`는 **debug 빌드**에서 런타임에 명령을 추가/교체/삭제할 수 있다. **release 빌드**에서는
`build()` 시점에 자동으로 동결(freeze)되어 불변이 된다. 동일한 바이너리를 debug/release로 빌드하는
것만으로 dev(가변)/prod(불변) 동작이 결정된다.

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> { /* ... */ }

#[command]
fn double(input: AddNumbersInput) -> Result<AddNumbersOutput> { /* ... */ }

let pkg = rustra::build!("my.pkg", add_numbers).done();

// 아래는 debug 빌드에서만 동작. release 빌드에서는 Err(code: "registry.frozen").
pkg.register_fn(double)?;            // 런타임 등록 (이름 자동 추론 → "double")
pkg.register("triple", double)?;     // 이름 지정 등록
pkg.replace("addNumbers", double)?;  // 핸들러 교체 (command_id 유지)
pkg.unregister("triple")?;           // 제거
pkg.freeze();                        // 명시적 봉인 (debug에서 prod 동작 시뮬레이션)
```

- 동적으로 등록된 명령은 이름 기반 JSON 경로(`engine.invoke('double', ...)`)로 호출된다.
- `command_id`(`u16`)는 단조 증가하며, `unregister` 시 **재사용되지 않는다**(retired).
- `Package`의 `clone`은 동일 레지스트리를 공유한다(`Arc` 기반).
- 제한: `command_id` 공간은 최대 65,534개. 초과 시 `registry.id_exhausted` 에러.

## 호출 취소 (AbortSignal)

JS `invoke(cmd, args, { signal })` 옵션으로 진행 중 호출을 취소한다. 네이티브가
`invokeAsync`/`invokeCancel`을 노출하면 취소가 Rust 체크포인트까지 전파되고(JS 코덱
경로), 그렇지 않으면 JS 프라미스만 즉시 거부하는 얕은 취소로 폴백한다. 에러 코드는
`cancelled`(retryable).

Rust FFI: `rustra_ffi_invoke_cancel(id)` / `rustra_ffi_cancellation_status(id)` —
`invoke_async`는 `invocation_id` out-param으로 호출별 ID를 발급한다.

## OTA 스키마 호환

JS 번들만 갱신되는 배포(구 JS + 신 네이티브)에서 스키마 드리프트를 흡수한다:

- `PackageBuilder::alias_command_id(name, legacy_id)` — 구 JS 코드젠이 구운
  command_id를 신 네이티브가 alias로 수용한다 (rkyv V2 와이어에는 이름이 없다).
- `schema_version(n)` — schema.json의 버전. 코드젠은 `SCHEMA_VERSION`으로 노출.
- 엔진 옵션 `onContractMismatch` — 계약 해시 불일치 시 throw 대신 degraded 모드로
  계속(opt-in). `schemaVersion`/`onSchemaStale` — JS > native 조합(OTA 롤백 등)의
  stale 경고.

## 페이로드 크기 한도

페이로드 상한(기본 1 MiB)을 런타임에 조정한다: `rustra_ffi_set_max_payload(bytes)` /
`rustra_ffi_get_max_payload()`. JS 엔진 옵션 `maxPayloadBytes`는 인코딩 직후 크기를
검사해 네이티브 왕복 전 조기 실패시킨다(tier2/tier3/전파 경로; typed 경로는 네이티브
게이트가 적용된다).

## TypeScript: 생성된 클라이언트

모든 플랫폼에서 동일한 인터페이스:

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

type RustraError = {
  readonly code: string;
  readonly message: string;
};
```

### 타입 매핑

| Rust                 | TypeScript                                    |
| -------------------- | --------------------------------------------- |
| `i64`, `u32`, `f64`  | `number`                                      |
| `String`             | `string`                                      |
| `bool`               | `boolean`                                     |
| `Vec<T>`             | `T[]`                                         |
| `(A, B, C)`          | `[A, B, C]`                                   |
| `HashMap<String, T>` | `Record<string, T>`                           |
| `Option<T>`          | `T \| null` (필드가 optional이면 `?:`도 추가) |
| `enum { A, B }`      | `'A' \| 'B'`                                  |
| 구조체               | `{ field: type; ... }`                        |

각 어댑터가 `EngineClient`를 구현하므로, 생성된 커맨드 헬퍼는 플랫폼에 관계없이 동일하게 동작한다.

## 플랫폼 어댑터

### Tauri

`tauri` feature를 활성화:

```toml
rustra = { version = "0.2", features = ["tauri"] }
```

Rust 측:

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

TypeScript 측:

```ts
import { createTauriEngine } from '@rustra/tauri';
import { configure } from '@rustra/types';

const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
```

### Node / Bun / React Native

각 패키지(`@rustra/node`, `@rustra/bun`, `@rustra/react-native`)에서 `EngineClient` 구현체를 제공한다. 사용 방식은 Tauri와 동일하다.

#### React Native

React Native는 rkyv V2 바이너리 fast-path를 기본으로 사용한다. JSI 네이티브 모듈이 `invokeRkyvV2`를 노출해야 한다.

```ts
import { createFastEngine, configure, getRustraNative } from '@rustra/react-native';
import { rkyvV2Registry } from './generated/rkyv-registry.js';

configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
const result = await addNumbers({ a: 20, b: 22 });
```

네이티브 모듈 설정(iOS JSI / Android C++)은 [React Native 설정 가이드](docs/extending/react-native-setup.md)를 참고.

### 플랫폼 지원 매트릭스

| 플랫폼               | 상태   | 비고                                         |
| -------------------- | ------ | -------------------------------------------- |
| Node / Bun           | Stable | subprocess·N-API·FFI 전 경로 CI 검증         |
| Tauri (macOS/Linux)  | Stable | 폴링 + 이벤트 푸시(`register_with_events`)   |
| React Native iOS     | Stable | JSI Tier 1~3 왕복 실기 검증, Release 빌드 CI |
| React Native Android | Stable | Release APK 빌드 CI (Gradle→Rust 자동 빌드)  |

모든 플랫폼은 `bun run test:compat`·CI 네이티브 빌드 잡이 게이트한다.

## 성능

모든 어댑터에서 `addNumbers({ a: 42, b: 58 })` 호출 기준 (Apple Silicon, release 빌드).

| 어댑터                 | 평균 지연  | 처리량          |
| ---------------------- | ---------- | --------------- |
| Rust (typed)           | 341–347 ns | 2,913,359 ops/s |
| Bun (JS측)             | 189 ns     | ~5.3M ops/s     |
| Node.js (JS측)         | 297–299 ns | ~3.35M ops/s    |
| Swift → Rust FFI       | 1.2 µs     | 853,614 ops/s   |
| Node napi-rs (release) | 1.5 µs     | 654,817 ops/s   |
| Bun FFI (release)      | 2.1 µs     | 471,640+ ops/s  |

> React Native(JSI rkyv V2)는 동일 객체 연산의 Nitro 대비 3회 중앙값
> 1.17–1.24x(add 1.2068x, string 1.2384x, bytes 1.1656x, pair 1.2162x).
> 비교의 범위와 기능 패리티 매트릭스는
> [벤치마크 문서](docs/benchmarks.md) §"Nitro Modules 비교" 참고) —
> 상세 벤치마크, 레이어별 오버헤드 분석, 페이로드 확장성은
> [벤치마크 문서](docs/benchmarks.md) 참고 (2026-08-23 iOS Release 재측정).

> 상세 벤치마크, 레이어별 오버헤드 분석, 페이로드 확장성은 [벤치마크 문서](docs/benchmarks.md)를 참고.

## 에러 처리

Rust:

```rust
// 커맨드에서 발생한 에러
return Err(RustraError::command_not_found("unknownCommand"));

// 잘못된 인자
return Err(RustraError::invalid_args("expected non-empty name"));

// 내부 에러
return Err(RustraError::internal("database connection failed"));

// 커스텀 에러
return Err(RustraError::custom("validation.too_large", "value exceeds limit"));
```

TypeScript:

```ts
try {
  const result = await addNumbers({ a: 1, b: 2 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code, e.message); // "validation.too_large" "value exceeds limit"
  }
}
```

## 개발

```bash
# Rust 워크스페이스 전체 테스트
# (--workspace 는 default-members 를 무시하므로 macOS 전용 tauri-calculator 까지
#  빌드된다. CI 도 동일 명령을 쓴다: .github/workflows/ci.yml)
cargo test --workspace

# CI rust 잡은 ubuntu/macos/windows 3-OS 매트릭스로 돌고, 플랫폼별 cdylib
# (.so/.dylib/.dll) 산출물을 아티팩트로 업로드한다 (.github/workflows/ci.yml).

# calculator 예시 빌드 및 TS 생성
cargo run -p rustra-calculator-example

# CRUD 예시 빌드 및 TS 생성
cargo run -p rustra-crud-example --bin generate

# TypeScript 린트 / 포맷
bun run lint
bun run format:check

# Rust 린트 / 포맷
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

# CLI watch 모드 (schema 변경 시 자동 재생성)
bunx @rustra/cli generate --watch --schema ./generated/schema.json --output ./src/generated

# dev 루프 — Rust 소스 감시 + dual-path codegen 자동 재실행 (hot codegen)
bunx @rustra/cli dev --backend ./backend --app ./app
```

## 문서

전체 문서는 [`docs/`](docs/)에 있다.

| 문서                                                             | 내용                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| [시작하기](docs/getting-started.md)                              | 설치, 첫 패키지 만들기, 어댑터 선택            |
| [아키텍처 개요](docs/architecture.md)                            | 데이터 흐름, EngineClient 계약, transport 분리 |
| [Transport 교체 가이드](docs/extending/transport-guide.md)       | Bun FFI, Node napi-rs 교체                     |
| [React Native 설정 가이드](docs/extending/react-native-setup.md) | iOS JSI 모듈 설정, 사용법, 트러블슈팅          |
| [새 Host 추가 가이드](docs/extending/adding-host.md)             | Electron, Deno 등 새 어댑터 추가               |
| [전체 문서 목록](docs/README.md)                                 | 사용자 / 기여자별 읽기 경로                    |

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.
