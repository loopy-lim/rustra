# Transport 교체 가이드

## 1. Transport란?

rustra에서 **transport**는 adapter 내부에서 Rust 코드를 실제로 호출하는 구체적인 수단을 말합니다.

adapter(`createNodeEngine`, `createBunEngine` 등)는 transport를 주입받아 `EngineClient`로 래핑할 뿐, transport 자체는 구현하지 않습니다. 따라서 transport만 교체하면 같은 adapter 코드를 그대로 사용하면서 Rust와 통신하는 방식을 변경할 수 있습니다.

### adapter-transport 분리 구조

```ts
// packages/node/src/index.ts
export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type NodeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

`createNodeEngine`은 `NodeInvokeTransport`를 받아들이고, transport의 `invoke`를 호출하기만 합니다. **어떻게 Rust에 도달하는지**는 전적으로 transport 구현에 달려 있습니다.

---

## 2. 현재 구현 현황

일반 앱은 transport를 직접 조립하지 않는다 — 생성된 호스트 진입점
(`generated/node.ts`, `generated/bun.ts`, `generated/tauri.ts`,
`generated/react-native.ts`)가 transport를 lazy하게 연결한다. 아래 표가 출발점
기준선이고, 이 가이드의 나머지는 **수동 조립** — 커스텀 호스트, 커스텀
transport, 기본 경로 교체 — 용이다.

| Host             | 기본 (생성 엔트리)                                                       | Rust 진입점                                                  | 수동 조립 대안                                                                       |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Node**         | one-shot Cargo binary + stdio, `__rustra_contract` 계약 검사             | `main.rs` → `run_invoke_stdio()`                             | 직접 `spawnSync` stdio, `createNodeLoopTransport`(서버), napi-rs 네이티브 모듈, WASM |
| **Bun**          | cdylib + stable C ABI + Frame (`rustra_ffi_invoke_frame`)                | `lib.rs` → `rustra::native_entry!` + `register_ffi(...)`     | `bun:ffi` 직접 C FFI 호출 (§4, JSON 경로)                                            |
| **Tauri**        | `rustra_dispatch` 멀티플렉스 (프레임워크 내장)                           | `tauri_support::register[_with_events]()` (feature: `tauri`) | 커스텀 invoke 함수를 받는 `createTauriEngine({ invoke })`                            |
| **React Native** | autolinked JSI + Frame (`invokeFrame`), `@rustra/generated-react-native` | `rustra::native_entry!` (`rustra_mobile_init` export)        | 커스텀 JSON transport(`createReactNativeEngine`), TurboModule, Nitro Modules         |

### Node — 수동 subprocess stdio

기본 Node 엔트리는 one-shot stdio 프로토콜(`{command, args}` → `{ok, result}` +
예약된 `__rustra_contract` 프로브)을 말하는 Cargo 바이너리를 spawn한다. 프로세스
transport를 직접 조립한다면 형태는 다음과 같다:

```ts
// 수동 조립 — 예시. 생성 node.ts가 이 일을 대신한다
import { spawnSync } from 'node:child_process';
import { createNodeEngine } from '@rustra/node';

const engine = createNodeEngine({
  invoke(command, args) {
    return invokeCalculatorRuntime(command, args);
  },
});

function invokeCalculatorRuntime(command: string, args: unknown): unknown {
  const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
    input: JSON.stringify({ command, args }),
    encoding: 'utf8',
  });

  if (output.status !== 0) {
    throw new Error(output.stderr || `runtime exited ${output.status}`);
  }

  const response = JSON.parse(output.stdout) as { ok: true; result: unknown };
  return response.result;
}
```

Rust stdio 진입점:

```rust
// examples/calculator/src/main.rs
fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = calculator_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
```

### React Native — C FFI (수동 JSON 경로)

> 예전 개정판에 있던 예제 전용 심볼 `rustra_calculator_invoke`/
> `rustra_calculator_free_string`은 제거되었다(2026-09-03 legacy 정리). 현재
> 표면은 모든 패키지를 서빙하는 **코어 공개 C ABI**(`rustra_ffi_*`)다.

Rust 쪽에서는 패키지를 코어 FFI로 등록하고 zero-config init을 export한다 — 앱별
심볼을 손으로 쓰지 않는다:

```rust
// examples/calculator/src/lib.rs
use rustra::ffi::FfiFormat;
use rustra::prelude::*;

pub fn calculator_package() -> Package {
    let pkg = rustra::build!("examples.calculator", add_numbers /*, … */).done();
    // rustra_ffi_invoke_json / rustra_ffi_invoke_postcard가 이 패키지를 서빙한다
    pkg.register_ffi_with_default(FfiFormat::Json);
    pkg
}

// rustra_mobile_init() export — 호스트가 lazy bootstrap 중 호출한다
rustra::native_entry!(calculator_package);
```

코어 진입점의 JSON-over-bytes 계약:

```text
rustra_ffi_invoke_json(payload: *const u8, payload_len: usize, out_len: *mut usize) -> *mut u8
  요청:  JSON {"command":"...","args":{...}} raw bytes
  응답:  JSON {"ok":bool,"result":...,"error":"..."} raw bytes
  반환 버퍼는 rustra_ffi_free(ptr, len)으로 해제 — 정확한 짝으로
```

Swift는 같은 심볼을 직접 바인딩한다:

```swift
// 손으로 만든 JSI/모듈 브릿징 계층 (커스텀 호스트 전용 — 기본 RN 경로는
// 생성된 @rustra/generated-react-native 패키지다)
@_silgen_name("rustra_mobile_init")
func rustra_mobile_init()

@_silgen_name("rustra_ffi_invoke_json")
func rustra_ffi_invoke_json(
    _ payload: UnsafePointer<UInt8>, _ payloadLen: Int,
    _ outLen: UnsafeMutablePointer<Int>
) -> UnsafeMutablePointer<UInt8>?

@_silgen_name("rustra_ffi_free")
func rustra_ffi_free(_ ptr: UnsafeMutablePointer<UInt8>, _ len: Int)

func invokeRawJSON(_ payload: String) throws -> String {
    rustra_mobile_init() // 멱등 — 첫 호출에 패키지를 등록한다
    let bytes = Array(payload.utf8)
    let outLen = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    defer { outLen.deallocate() }
    guard let raw = rustra_ffi_invoke_json(bytes, bytes.count, outLen) else {
        throw NSError(domain: "rustra", code: 1, userInfo: [NSLocalizedDescriptionKey: "FFI invoke returned null"])
    }
    defer { rustra_ffi_free(raw, outLen.pointee) } // 정확한 ptr/len 짝으로 해제
    return String(decoding: UnsafeBufferPointer(start: raw, count: outLen.pointee), as: UTF8.self)
}
```

같은 cdylib/staticlib의 다른 코어 FFI 심볼: `rustra_ffi_invoke`(기본 포맷
디스패치), `rustra_ffi_invoke_postcard`, `rustra_ffi_invoke_frame`,
`rustra_ffi_get_schema`, `rustra_ffi_contract_hash` — 안정 등급을 포함한 전체
목록은 [Rust API 가이드 — FFI 부록](../rust-api-guide.ko.md)과
[버전 정책](../versioning-policy.ko.md)에 있다.

### Tauri — rustra_dispatch 멀티플렉스 패턴

Tauri transport는 개별 커맨드를 passthrough하는 방식이 아니라, **모든 커맨드를 `rustra_dispatch` 단일 엔드포인트로 멀티플렉싱**하는 방식을 사용한다.

```ts
// packages/tauri/src/index.ts
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      // 모든 커맨드를 rustra_dispatch 하나로 라우팅
      return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
    },
  };
}
```

Rust 쪽에서는 `rustra::tauri_support::register`로 패키지를 Tauri 빌더에 등록한다. 이 함수가 `rustra_dispatch` 커맨드 핸들러와 상태 관리를 자동으로 설정한다.

```rust
// examples/tauri-calculator/src-tauri/src/main.rs
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder.run(tauri::generate_context!()).expect("failed to run tauri calculator app");
}
```

`tauri_support`를 사용하려면 `Cargo.toml`에서 `tauri` feature를 활성화해야 한다:

```toml
rustra = { path = "...", features = ["tauri"] }
```

---

## 3. Transport 교체 절차 (일반화된 3단계)

### Step 1: Rust 쪽에 새 진입점 추가 (필요한 경우만)

코어 FFI에 패키지를 등록한 크레이트(`rustra::native_entry!` + `register_ffi(...)`,
§2 참고)는 이미 코어 C ABI(`rustra_ffi_invoke_json`, `rustra_ffi_free`, …)를
export한다 — FFI 기반 transport로 전환할 때 새 진입점이 필요 없다.

새로운 통신 방식(napi-rs, WASM 등)이 필요하면, `lib.rs`에 해당 진입점을 추가합니다.

```toml
# Cargo.toml에서 crate-type 확인
[lib]
crate-type = ["rlib", "staticlib"]
```

`staticlib`이 포함되어 있으면 `.a` / `.lib` 정적 라이브러리가 빌드되어 C FFI용으로 사용할 수 있습니다.

### Step 2: App에서 transport 구현 변경

adapter의 팩토리 함수에 새로운 transport를 주입합니다. adapter 코드 자체는 수정하지 않습니다.

```ts
// 변경 전: subprocess stdio
const engine = createNodeEngine({
  invoke(command, args) {
    return invokeViaSubprocess(command, args);
  },
});

// 변경 후: 새로운 transport
const engine = createNodeEngine({
  invoke(command, args) {
    return invokeViaNewTransport(command, args);
  },
});
```

### Step 3: 기존 테스트로 회귀 검증

```bash
# 모든 adapter 호환성 테스트 실행
bun run test:compat

# 특정 런타임 테스트
bun run test:runtime:node
bun run test:runtime:bun
```

테스트는 `configure(engine)` 후 `addNumbers({ a: 20, b: 22 })`의 결과가 `42`인지 확인하는 방식으로, transport가 바뀌어도 동일한 결과를 반환하는지 검증합니다.

---

## 4. 예시: Bun FFI로 교체

Bun은 `bun:ffi`로 `.dylib` / `.so`를 직접 로드할 수 있다. **기본 생성 `bun.ts`
엔트리**가 Frame 심볼로 이미 이 일을 한다. 아래 JSON 경로는 커스텀 호스트용
수동 조립 변형으로, 같은 코어 C ABI(`rustra_ffi_invoke_json`)를 쓴다.

### Rust 준비

크레이트의 `Cargo.toml`에 `cdylib`을 추가합니다 (`staticlib`은 RN iOS용으로 유지):

```toml
[lib]
crate-type = ["rlib", "cdylib", "staticlib"]
```

`lib.rs`에서 코어 FFI용 패키지를 등록한다(전체 스니펫은 §2 React Native 참고) —
`rustra::native_entry!(my_package)`와
`pkg.register_ffi_with_default(FfiFormat::Json)`. 빌드:

```bash
cargo build -p rustra-calculator-example
```

`target/debug/librustra_calculator_example.dylib` (macOS) 또는 `.so` (Linux)가 생성됩니다.

### Bun FFI transport 구현

요청/응답은 C 문자열이 아니라 raw bytes(`Buffer`/`ArrayBuffer`)다 — 반환값에
Bun의 `FFIType.cstring`을 쓰면 안 된다. `FFIType.ptr`로 포인터를 받아 복사한 뒤
정확한 짝으로 `rustra_ffi_free(ptr, len)`을 호출해 해제한다:

```ts
import { dlopen, FFIType, suffix, toArrayBuffer } from 'bun:ffi';
import { createBunEngine } from '@rustra/bun';
import { configure } from '@rustra/types';
import { addNumbers } from '../generated/commands.js';

const outLength = new BigUint64Array(1); // usize out-param
const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_mobile_init: { args: [], returns: FFIType.void },
  rustra_ffi_invoke_json: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr], // payload, payload_len, out_len
    returns: FFIType.ptr, // FFIType.cstring이 아님 — 수동 메모리 관리 필요
  },
  rustra_ffi_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
});
lib.symbols.rustra_mobile_init(); // 멱등 패키지 등록

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = Buffer.from(JSON.stringify({ command, args }), 'utf8');
    outLength[0] = 0n;
    const rawPtr = lib.symbols.rustra_ffi_invoke_json(payload, BigInt(payload.length), outLength);
    const len = Number(outLength[0]);
    let responseText: string;
    try {
      // Rust 할당을 해제하기 전에 JS 소유 메모리로 복사한다
      responseText = new TextDecoder().decode(toArrayBuffer(rawPtr, 0, len));
    } finally {
      lib.symbols.rustra_ffi_free(rawPtr, BigInt(len));
    }

    const response = JSON.parse(responseText) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'Rust invoke failed');
    }

    return response.result;
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`bun FFI result: ${result.value}`); // 42
```

릴리스용 변형(계약 검증까지 포함, 수동 dlopen이 전혀 없는 Frame
caller-buffer 경로)은 생성 `bun.ts` 엔트리다 —
[`bun-ffi-app.ts`](../../examples/calculator/apps/bun-ffi-app.ts) 참고.

### subprocess stdio transport와의 비교

```ts
// subprocess stdio (호출마다 프로세스 스폰 오버헤드)
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});

// 직접 FFI 호출 (프로세스 경계 없음, 더 빠름)
const rawPtr = lib.symbols.rustra_ffi_invoke_json(payload, BigInt(payload.length), outLength);
```

장점:

- **프로세스 스폰 오버헤드 제거**: 매 호출마다 프로세스를 생성하지 않음
- **낮은 레이턴시**: 함수 호출 수준의 성능
- **메모리 공유**: 프로세스 간 직렬화/역직렬화 불필요

---

## 5. 예시: Node napi-rs로 교체

[napi-rs](https://napi.rs/)를 사용하면 Rust 함수를 Node.js 네이티브 애드온(`.node` 파일)으로 노출할 수 있습니다.

### Rust 구현

```rust
// examples/calculator-napi/src/lib.rs — 일반 JSON 패턴
// (실제 예제는 현재 Frame 버퍼 경로를 바인딩한다 — 해당 README 참고)
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustra_calculator_example::calculator_package;
use serde_json::json;

#[napi]
pub fn rustra_invoke(command: String, args: Option<String>) -> Result<String> {
    let args_value = match args {
        Some(ref a) => serde_json::from_str(a).map_err(|e| {
            Error::from_reason(format!("invalid args JSON: {e}"))
        })?,
        None => json!({}),
    };

    let result = calculator_package()
        .invoke_json(&command, args_value)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    serde_json::to_string(&json!({ "ok": true, "result": result }))
        .map_err(|e| Error::from_reason(format!("json encode failed: {e}")))
}
```

빌드:

```bash
cargo build --release
# 또는 napi-rs CLI 사용
napi build --platform --release
```

### Node transport 구현

```ts
import { createNodeEngine } from '@rustra/node';

// napi-rs로 빌드한 네이티브 모듈 로드 (examples/calculator-napi)
const native = require('./calculator-napi.node');

const engine = createNodeEngine({
  async invoke(command: string, args?: unknown): Promise<unknown> {
    const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
    const rawResponse = native.rustra_invoke(command, argsJson);

    const response = JSON.parse(rawResponse) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'Rust invoke failed');
    }

    return response.result;
  },
});

// 동일한 방식으로 사용
import { addNumbers } from '../generated/commands.js';
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`napi-rs result: ${result.value}`); // 42
```

### 기존 Node app과의 비교

```ts
// 기존: subprocess stdio
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});
const response = JSON.parse(output.stdout);

// 교체 후: 네이티브 모듈 직접 호출
const rawResponse = native.rustra_invoke(command, argsJson);
```

장점:

- **성능**: subprocess 오버헤드 없이 직접 함수 호출
- **타입 안전성**: napi-rs가 Rust ↔ JavaScript 타입 변환을 처리
- **비동기 지원**: napi-rs의 `#[napi]`는 자동으로 `Promise` 기반 비동기 함수를 생성 가능

---

## 6. 정리: Transport 선택 기준

| 기준              | subprocess stdio     | C FFI                | napi-rs   | 프레임워크 내장        |
| ----------------- | -------------------- | -------------------- | --------- | ---------------------- |
| **구현 난이도**   | 낮음                 | 중간                 | 중간      | 낮음 (프레임워크 제공) |
| **성능**          | 낮음 (프로세스 스폰) | 높음                 | 높음      | 높음                   |
| **호환성**        | 범용                 | 언어 바인딩 필요     | Node 전용 | 해당 프레임워크 전용   |
| **디버깅**        | 쉬움 (격리됨)        | 어려움 (메모리 관리) | 중간      | 중간                   |
| **프로세스 격리** | 있음                 | 없음                 | 없음      | 없음                   |

**권장사항:**

- **빠른 프로토타이핑**: 생성 엔트리로 시작 (Node는 one-shot stdio, Bun은 cdylib FFI)
- **프로덕션 (Node)**: 생성 엔트리; 핫 경로는 napi-rs 또는 C FFI
- **프로덕션 (Bun)**: 생성 `bun.ts` FFI 엔트리
- **프로덕션 (React Native)**: autolinked JSI 엔트리 (기본); 코어 `rustra_ffi_*` C ABI는 커스텀 네이티브 호스트 전용
- **프로덕션 (Tauri)**: `rustra_dispatch` 멀티플렉스 패턴 (`tauri_support::register`)
