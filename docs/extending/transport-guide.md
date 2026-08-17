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

| Host             | 현재 Transport                                 | Rust 진입점                                    | 대안                            |
| ---------------- | ---------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| **Node**         | subprocess stdio (`spawnSync`)                 | `main.rs` → `run_invoke_stdio()`               | napi-rs 네이티브 모듈, WASM     |
| **Bun**          | subprocess stdio (`spawnSync`)                 | `main.rs` → `run_invoke_stdio()`               | `bun:ffi` (C FFI 직접 호출)     |
| **Tauri**        | `rustra_dispatch` 멀티플렉스 (프레임워크 내장) | `tauri_support::register()` (feature: `tauri`) | 없음                            |
| **React Native** | C FFI (`extern "C"`)                           | `lib.rs` → `rustra_calculator_invoke`          | TurboModule, Nitro Modules, JSI |

### Node / Bun — subprocess stdio

```ts
// examples/calculator/apps/node-app.ts
import { spawnSync } from 'node:child_process';
import { createNodeEngine } from '../../../packages/node/src/index.js';

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

### React Native — C FFI

Swift에서 Rust C FFI 함수를 직접 호출합니다:

```swift
// examples/react-native-calculator/modules/rustra-calculator/ios/RustraCalculatorModule.swift
@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

public class RustraCalculatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")
    AsyncFunction("invokeRaw") { (payload: String) -> String in
      return payload.withCString { pointer in
        decodeRustString(rustra_calculator_invoke(pointer))
      }
    }
  }
}
```

Rust C FFI 진입점:

```rust
// examples/calculator/src/lib.rs
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }
    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() { ... };
    let request = match serde_json::from_str::<Value>(payload) { ... };
    let command = request.get("command").and_then(Value::as_str)...;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    match calculator_package().invoke_json(command, args) {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}
```

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

이미 C FFI 진입점(`rustra_*_invoke`, `rustra_*_free_string`)이 존재하면, FFI 기반 transport로 전환할 때 새 진입점이 필요 없습니다.

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
npm run test:compat

# 특정 런타임 테스트
npm run test:runtime:node
npm run test:runtime:bun
```

테스트는 `configure(engine)` 후 `addNumbers({ a: 20, b: 22 })`의 결과가 `42`인지 확인하는 방식으로, transport가 바뀌어도 동일한 결과를 반환하는지 검증합니다.

---

## 4. 예시: Bun FFI로 교체

Bun은 `bun:ffi`로 `.dylib` / `.so`를 직접 로드할 수 있습니다. Rust C FFI 진입점이 이미 존재하므로, Rust 쪽 변경 없이 transport만 교체할 수 있습니다.

### Rust 준비

`examples/calculator/Cargo.toml`에 `cdylib`을 추가합니다 (`staticlib`은 RN iOS용으로 유지):

```toml
[lib]
crate-type = ["rlib", "cdylib", "staticlib"]
```

빌드:

```bash
cargo build -p rustra-calculator-example
```

`target/debug/librustra_calculator_example.dylib` (macOS) 또는 `.so` (Linux)가 생성됩니다.

### Bun FFI transport 구현

**주의**: `FFIType.cstring`을 리턴 타입으로 사용하면 메모리 누수가 발생합니다. Rust의 `CString::into_raw()`로 할당된 메모리는 반드시 `CString::from_raw()`로 해제해야 합니다. Bun의 `FFIType.cstring`은 C 문자열을 읽어 JS 문자열로 복사만 할 뿐 원본 메모리를 해제하지 않습니다. 따라서 `FFIType.ptr`로 포인터를 받은 뒤 수동으로 문자열을 읽고 `free_string`을 호출해야 합니다.

```ts
import { dlopen, FFIType, suffix } from 'bun:ffi';
import { createBunEngine } from '../../../packages/bun/src/index.js';
import { addNumbers } from '../generated/commands.js';
import { configure } from '@rustra/types';

const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_calculator_invoke: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,       // FFIType.cstring이 아님 — 수동 메모리 관리 필요
  },
  rustra_calculator_free_string: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = JSON.stringify({ command, args });
    const rawPtr = lib.symbols.rustra_calculator_invoke(payload);
    const rawResponse = new CString(rawPtr);
    lib.symbols.rustra_calculator_free_string(rawPtr);  // Rust가 CString::from_raw로 해제

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

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`bun FFI result: ${result.value}`); // 42
```

### 기존 Bun app과의 비교

```ts
// 기존: subprocess stdio (프로세스 스폰 오버헤드 있음)
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});

// 교체 후: 직접 FFI 호출 (프로세스 경계 없음, 더 빠름)
const rawResponse = lib.symbols.rustra_calculator_invoke(payload);
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
// crates/calculator-napi/src/lib.rs
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
import { createNodeEngine } from '../../../packages/node/src/index.js';

// napi-rs로 빌드한 네이티브 모듈 로드
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

- **빠른 프로토타이핑**: subprocess stdio로 시작
- **프로덕션 (Node)**: napi-rs 또는 C FFI
- **프로덕션 (Bun)**: `bun:ffi`
- **프로덕션 (React Native)**: C FFI (현재 방식)
- **프로덕션 (Tauri)**: `rustra_dispatch` 멀티플렉스 패턴 (`tauri_support::register`)
