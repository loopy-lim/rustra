# rustra

[![CI](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml/badge.svg)](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rustra/types)](https://www.npmjs.com/package/@rustra/types)
[![crates.io](https://img.shields.io/crates/v/rustra.svg)](https://crates.io/crates/rustra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Rust에서 명령을 한 번 정의하면, Node / Bun / Tauri / React Native 어디서든 동작하는 TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크.

> **English** — Define commands once in Rust, get type-safe TypeScript clients
> for Node, Bun, Tauri, and React Native. Single Rust core, four host surfaces,
> compact caller-buffer optimized binary wire (rkyv V2). Quick start: `cargo add rustra` +
> `bunx --bun @rustra/cli init my-project`. Full docs (Korean) below.

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
| compact 바이너리 와이어       | ✅ rkyv V2 (JSON 대비 11.8× 작음) | JSON/Buffer       | JSI 객체      | JSON IPC       | JSON IPC     |
| 계약 게이트 (breaking change) | ✅ `rustra diff` + contract hash  | ❌                | ❌            | ❌             | 부분         |
| 취소/타임아웃/배치 시맨틱     | ✅ 매트릭스로 문서화              | 직접 구현         | 직접 구현     | ❌             | ❌           |

rustra의 선택: **RPC 표면 전체(정의→코드젠→와이어→검증)를 하나의 계약으로
소유**한다. 명령 호출과 계약 검증은 호스트 간 공통으로 유지하고, 취소·이벤트·채널
같은 capability 차이는 [호환성 매트릭스](docs/compatibility-matrix.md)에 명시한다.

## 로드맵

- [x] 4호스트 어댑터 (Node/Bun/Tauri/RN iOS+Android) — 0.1
- [x] rkyv V2 바이너리 fast-path + 취소/타임아웃/배치 — 0.1~0.2
- [x] 이벤트 계약 코드젠 (`PackageBuilder::event`) — 0.2.x
- [x] persistent 루프 런타임 + Node loop transport — 0.2.x
- [x] 타입 패리티 1단계 — fast path 타입 확장 (2026-08-22): u8–u64 plain
      varint, 동적 맵 `HashMap<String,T>`(원시값), 튜플(무접두), `Vec<u8>`
      bytes(ArrayBuffer 표면), chrono Date(ISO string), Set<unsigned> —
      3면(TS·Rust·C++) 코드젠 + PINNED hex 와이어 게이트.
- [x] 타입 패리티 3단계 — schema-driven complex binary route (2026-08-27):
      recursive struct, struct-valued map, data enum, nested Option/Set —
      공용 Codec IR, TS/Rust golden wire + bounds, native-safe C++ complex
      marshalling. 원시 요소 Set과 int64/uint64의 `number | bigint` 경계도
      native-safe subset에서 직접 처리하며, 객체 요소 Set 등 나머지는 JS
      complex codec으로 안전하게 폴백한다.
- [x] 타입 패리티 2단계 — 채널/리소스 (Tauri v2 `ipc::Channel`·`Resource`
      모델, 2026-08-23): 콜백을 직렬화 가능한 채널 핸들(u32, 호출 귀속
      유니캐스트 회신)로, 객체 참조를 Rust-소유 리소스 핸들(`channels.rs`
      `ChannelHost` 테이블, 코드젠 커맨드로 read/write/close)로. wire는
      정수 핸들뿐이라 계약 게이트와 양방향 코드젠은 공통이고, 호스트별
      channel adapter 지원 범위는 [호환성 매트릭스](docs/compatibility-matrix.md)에
      따른다. RN JSI `createChannel(cb)`/`dropChannel(h)` 배선 + Rust FFI
      `rustra_ffi_channel_{create,send,drop}` — Android arm64 실기기 E2E 검증
      완료; iOS generic device build와 iPhone 17 Simulator Release runtime
      완료, physical-device runtime은 별도 증거
- [x] async 커맨드 핸들러 — `#[command] async fn`, waker 기반 실행기,
      bounded FFI 워커 풀/백프레셔/취소 게이트
- [x] Windows 코어 런타임 검증 — CI의 Windows MSVC 테스트 + release DLL 산출
- [x] 개발 허들 완화 — `rustra doctor`, 설정 기반 `rustra codegen`, `rustra dev`,
      생성물 drift 게이트 (`rustra generate --check`)
- [ ] 범용 prebuilt 애플리케이션 네이티브 바이너리 — 앱별 Rust 코드와 target에
      종속되므로 CI artifact/cache 방식으로 대체 권장

안정화 트랙: 버전 관리, 호환성 보장, 폐기 절차는
[버전 정책](docs/versioning-policy.md)에 정의되어 있다.

## FAQ

**Q. Rust 툴체인이 꼭 필요한가요?**
앱별 네이티브 라이브러리는 Rust와 플랫폼 toolchain으로 빌드해야 한다.
CLI와 공용 adapter는 Bun/npm으로 설치할 수 있지만, 사용자의 command와 staticlib를
포함한 앱별 네이티브 산출물은 Rust와 플랫폼 toolchain으로 빌드해야 한다. 팀에서는
CI가 commit/target별 native artifact를 만들어 개발자가 재사용할 수 있다. Rust 없이
UI를 먼저 만들려면 `@rustra/testing`의 mock 엔진을 사용한다. 상세한 진단과 설치
범위는 [개발 허들 가이드](docs/development-hurdles.md)를 참고한다.

**Q. JSON 경로도 지원하나요?**
예. postcard fast-path가 다루지 않는 복잡 schema는 schema-driven complex binary로
처리하고, 두 binary route가 모두 지원하지 않는 명령은 JSON 폴백(Tier 3)으로
간다. 바이너리 이식이 어려운 환경도 계약은 같다.

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
rustra = "0.4"
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

    // TypeScript 클라이언트 생성 — rustra codegen이 schema와 TS/C++를 함께 처리한다.
    package.generate_typescript()?.write_to_dir("generated")?;
    Ok(())
}
```

바이너리 fast-path(rkyv V2, RN)를 쓰려면 CLI codegen도 실행한다. `rustra.json`에
Rust generator를 지정하면 schema 생성부터 `rkyv-codecs.ts`/`rkyv-registry.ts`까지
한 번에 처리한다:

```bash
bunx --bun @rustra/cli codegen --config rustra.json
```

기존 schema만 다시 렌더링해야 하는 경우에는 `generate --config`를 직접 사용할 수
있다. Rust 수정까지 감시하려면 `bunx --bun @rustra/cli dev --config rustra.json`,
CI 동기화 검사는 `bunx --bun @rustra/cli generate --config rustra.json --check`를
사용한다.

### React Native: Expo와 bare RN 공통 설정

React Native는 앱 네이티브 프로젝트를 직접 수정하지 않는다. Rust crate에 정적
라이브러리 출력과 mobile entry를 선언하고, 앱의 `rustra.json`에 `reactNative`를
켜면 생성기가 충돌 격리된 로컬 패키지를 만든다.

```toml
[lib]
crate-type = ["rlib", "staticlib"]
```

```rust
rustra::native_entry!(my_package);
```

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

```bash
bun add @rustra/react-native @rustra/types
bun add -d @rustra/cli
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli codegen --config rustra.json
bun install
```

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 20, b: 22 });
```

첫 호출이 JSI 설치, contract 검증, fast engine 설정을 한 번만 수행한다. 생성된
`@rustra/generated-react-native` 패키지가 iOS Podspec과 Android Gradle/CMake를
소유하므로 Expo development build와 bare React Native 모두 표준 autolinking을
사용한다. Expo Go는 네이티브 JSI 모듈을 로드할 수 없다. Cargo workspace가
모호한 경우에만 `reactNative.rustManifest`를 app crate의 `Cargo.toml`로 지정한다.

Node, Bun, Tauri도 같은 생성 진입점 규칙을 쓴다. 필요한 host를 빈 객체로 켜면 Cargo
metadata와 표준 host API를 추론한다.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "node": {},
  "bun": {},
  "tauri": {}
}
```

```ts
import { addNumbers } from './generated/node.js'; // Bun은 bun.js, Tauri는 tauri.js

const result = await addNumbers({ a: 20, b: 22 });
```

수동 `configure()`는 다중 런타임, custom N-API, global Tauri 비활성화처럼 자동
추론을 의도적으로 벗어나는 경우에만 사용한다.

## 실사용 예시

생성된 host 진입점이 연결을 소유하므로 제품 코드에는 transport 설정이 남지 않는다.
아래 코드는 모두 같은 Rust `addNumbers` 명령을 호출한다.

### Node 배치 작업

```ts
import { addNumbers, rustra } from './generated/node.js';

try {
  const [a, b] = process.argv.slice(2).map(Number);
  const { value } = await addNumbers({ a, b });
  console.log(value);
} finally {
  rustra.dispose();
}
```

기본 생성 경로는 설치가 단순한 one-shot 프로세스라 저빈도 CLI와 배치에 적합하다.
요청이 계속 들어오는 서버에서는 `createNodeLoopTransport`를, 마이크로초 단위 호출이
필요하면 N-API rkyv V2를 선택한다. 실제 코드는
[`node-app.ts`](examples/calculator/apps/node-app.ts), 성능별 선택은
[`node-performance.ts`](examples/calculator/apps/node-performance.ts)에 있다.

### Bun HTTP 서비스

```ts
import { addNumbers, rustra } from './generated/bun.js';

const server = Bun.serve({
  async fetch(request) {
    const input = (await request.json()) as { a: number; b: number };
    return Response.json(await addNumbers(input));
  },
});
process.on('SIGTERM', () => {
  rustra.dispose();
  server.stop();
});
```

이 경로는 생성된 stable C ABI와 rkyv V2 codec을 바로 사용한다. 별도 `dlopen`, pointer
해제, contract 검증 코드는 앱에 필요 없다. 실행 가능한 최소 예제는
[`bun-ffi-app.ts`](examples/calculator/apps/bun-ffi-app.ts)다.

### Tauri 화면과 이벤트

```ts
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent<{ value: number }>('calc.tick', ({ value }) => renderTick(value));
button.addEventListener('click', async () => {
  const { value } = await addNumbers({ a: 20, b: 22 });
  output.value = String(value);
});
```

`withGlobalTauri`와 Rust 측 `register_with_events` 이후에는 프런트엔드 설정이 없다.
[`tauri-calculator`](examples/tauri-calculator/)는 실제 WebView IPC 빌드, 실행, 성능
영수증까지 포함한다.

### Expo development build와 bare React Native

```tsx
import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import { addNumbers } from './generated/react-native';

export function Calculator() {
  const [value, setValue] = useState<number>();
  return (
    <View>
      <Button
        title="Run Rust"
        onPress={() => void addNumbers({ a: 20, b: 22 }).then((result) => setValue(result.value))}
      />
      <Text>{value ?? 'Ready'}</Text>
    </View>
  );
}
```

Expo API를 사용하지 않는 동일한 autolink 패키지이므로 앱 코드는 두 환경에서 같다.
전체 화면 예제는 [`Expo App.tsx`](examples/react-native-calculator/App.tsx)와
[`bare RN App.tsx`](examples/react-native-bare-calculator/App.tsx)를 참고한다. Expo Go는
네이티브 JSI 코드를 포함하지 못하므로 지원하지 않는다.

0.3.1에서 올리는 경우에는 npm과 Rust 버전을 함께 맞춰야 한다. 호스트별 수동
경계와 before/after는 [0.3에서 0.4로 마이그레이션](docs/migrations/0.3-to-0.4.md)을
따른다. Rust crate 가 0.5 라인이라면
[0.5에서 0.6으로 마이그레이션](docs/migrations/0.5-to-0.6.md)을 따른다.

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
  react/           React hooks (Provider/useCommand/useMutation/useEvent)
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
rustra = { version = "0.4", features = ["tauri"] }
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
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
```

Tauri 설정의 `app.withGlobalTauri`를 켜면 생성 진입점이 IPC와 event API를 lazy
감지한다. 기존 `createTauriEngine({ invoke })`는 global API를 쓰지 않는 앱의
escape hatch다.

### Node / Bun / React Native

Node는 Cargo binary, Bun은 stable C ABI cdylib, React Native는 autolinked JSI를
각각 생성 진입점에서 lazy 연결한다. 배포 레이아웃만 다른 경우 Node는
`RUSTRA_NODE_BINARY`, Bun은 `RUSTRA_BUN_LIBRARY`로 경로를 덮어쓴다.

#### React Native

React Native는 rkyv V2 바이너리 fast-path를 기본으로 사용한다. JSI 네이티브 모듈이
`invokeRkyvV2`를 노출해야 한다. 입력과 출력이 각각 하나의 필수 `Vec<u8>` 필드인
명령은 명시적 Rust 등록 시 `Uint8Array`/`ArrayBuffer` 전용 네이티브 경로도 사용할
수 있다. complex schema 명령은 JS codec registry를 통해 같은 `invokeRkyvV2`로
전달되며, C++ 직접 마샬링은 별도 성능 확장이다.

```ts
import { addNumbers } from './generated/react-native.js';

const result = await addNumbers({ a: 20, b: 22 });
```

네이티브 모듈 설정(iOS JSI / Android C++)은 [React Native 설정 가이드](docs/extending/react-native-setup.md)를 참고.

### 플랫폼 지원 매트릭스

| 플랫폼               | 현재 증거 수준             | 비고                                                               |
| -------------------- | -------------------------- | ------------------------------------------------------------------ |
| Node / Bun           | Runtime verified           | subprocess·N-API·Bun FFI 로컬 runtime + 어댑터 CI                  |
| Tauri (macOS)        | WebView runtime verified   | Release WebView `rustra_dispatch` 정확성·성능 영수증               |
| Tauri (Linux)        | Build + smoke verified     | 실제 WebView 사용자 흐름은 별도 E2E 필요                           |
| React Native iOS     | Simulator runtime verified | Release build·설치·launch·reload·Nitro 비교; 실기기 증거는 별도    |
| React Native Android | Release runtime verified   | `TB710FU` arm64 실기기와 arm64/x86_64 `.so` 확인; 다른 기기는 별도 |

`bun run test:compat`는 JS 계약과 지원되는 로컬 runtime을 검증하고, CI 네이티브
잡은 빌드·링크를 검증한다. 이 둘을 실제 기기 설치·화면 렌더 증거와 동일시하지 않는다.

## 성능

`addNumbers({ a: 20, b: 22 })`를 생성된 API 또는 문서화된 고성능 경로로 호출한
end-to-end Release 실측이다. 2026-08-24 Apple Silicon에서 정확성을 먼저 확인하고
warm-up 뒤 3회 반복했다.

| 실제 사용자 경로                | 평균 지연 |       p50 |        처리량 | 권장 용도        |
| ------------------------------- | --------: | --------: | ------------: | ---------------- |
| Node 생성 one-shot              |   2.76 ms |   2.76 ms |     363 ops/s | CLI, 저빈도 배치 |
| Node persistent loop            |  16.86 µs |  16.67 µs |  59,301 ops/s | 일반 서버        |
| Node N-API rkyv V2 escape hatch |   1.26 µs |   1.17 µs | 793,185 ops/s | 고빈도 hot path  |
| Bun 생성 FFI rkyv V2            |   2.27 µs |   2.21 µs | 439,961 ops/s | 서비스, CLI      |
| Tauri 생성 WebView IPC          | 279.04 µs | 300.00 µs |   3,584 ops/s | 데스크톱 UI 명령 |
| RN 생성 JSI, iOS Simulator      |         — |   2.71 µs |             — | 모바일 hot path  |

평균과 처리량은 OS 스케줄링 꼬리값을 줄인 양끝 5% trimmed mean이다. Tauri는
WKWebView 타이머 정밀도 때문에 20호출 배치의 호출당 값을 사용했다. RN 행은
최종 Release receipt의 Rustra add p50이며, 다른 행과 다른 iOS Simulator 환경이다.
bare RN과 Android는 동일한 생성 bridge를 빌드하지만 별도 런타임 성능 영수증이 없어
숫자를 추정하지 않았다. 전체 호스트는 `bun run bench:hosts`, RN은 아래 receipt 명령으로
재현한다.

> 2026-08-24 iPhone 17 Simulator Release 측정에서 일반 객체 연산은 Nitro 대비
> 3회 중앙값 add 1.0418x, string 1.0281x, pair 1.0535x였고 64B byte는
> 0.9543x였다. 전용 byte 경로는 64 KiB 0.9338x, exact 1 MiB-wire
> 1.0129x였다. 각 실행은 paired 95% CI가 포함된 JSON receipt로 자동 추출했다.
> 이는 시뮬레이터 영수증이며
> iOS/Android 실기기 성능 주장이 아니다.
> 비교의 범위, 기능 패리티, 레이어별 오버헤드와 페이로드 확장성은
> [벤치마크 문서](docs/benchmarks.md)를 참고한다.

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
cargo run -p rustra-calculator-example --bin rustra-calculator-example

# CRUD 예시 빌드 및 TS 생성
cargo run -p rustra-crud-example --bin generate

# TypeScript 린트 / 포맷
bun run lint
bun run format:check

# Rust 린트 / 포맷
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

# 개발 환경 진단
bunx --bun @rustra/cli doctor --config rustra.json

# Rust schema + TS/C++/RN을 한 번에 생성
bunx --bun @rustra/cli codegen --config rustra.json

# generated 파일 동기화 CI 게이트 (TS/C++/RN은 쓰지 않음)
bunx --bun @rustra/cli generate --config rustra.json --check

# Rust 소스 감시 + 통합 codegen 자동 재실행
bunx --bun @rustra/cli dev --config rustra.json
```

## 문서

전체 문서는 [`docs/`](docs/)에 있다.

| 문서                                                             | 내용                                           |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| [시작하기](docs/getting-started.md)                              | 설치, 첫 패키지 만들기, 어댑터 선택            |
| [아키텍처 개요](docs/architecture.md)                            | 데이터 흐름, EngineClient 계약, transport 분리 |
| [Transport 교체 가이드](docs/extending/transport-guide.md)       | Bun FFI, Node napi-rs 교체                     |
| [React Native 설정 가이드](docs/extending/react-native-setup.md) | iOS JSI 모듈 설정, 사용법, 트러블슈팅          |
| [개발 허들 가이드](docs/development-hurdles.md)                  | doctor, 통합 codegen, drift, native 경계       |
| [새 Host 추가 가이드](docs/extending/adding-host.md)             | Electron, Deno 등 새 어댑터 추가               |
| [전체 문서 목록](docs/README.md)                                 | 사용자 / 기여자별 읽기 경로                    |

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.
