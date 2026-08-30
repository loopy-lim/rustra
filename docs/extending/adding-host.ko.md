# 새 Host Adapter 추가 가이드

## 1. 최소 요구사항

새 host adapter를 추가하려면 단 하나의 인터페이스만 구현하면 됩니다.

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

이것이 rustra가 TypeScript 쪽에서 요구하는 전부입니다. 생성된 명령 함수(`addNumbers` 등)는 모두 `@rustra/types`의 글로벌 `invoke`를 거치며, 이것이 `configure(engine)`로 설치한 `EngineClient`를 사용합니다:

```ts
// examples/calculator/generated/commands.ts
export function addNumbers(input: AddNumbersInput): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input);
}
```

---

## 2. 새 Adapter 만들기

### 디렉토리 구조

```
packages/<host>/src/index.ts    ← adapter 팩토리 함수
packages/<host>/README.md       ← 사용법 문서
```

기존 adapter들은 모두 동일한 패턴을 따릅니다:

```
packages/node/src/index.ts
packages/bun/src/index.ts
packages/react-native/src/index.ts
packages/tauri/src/index.ts
```

### 팩토리 함수 작성

모든 adapter는 "transport를 주입받아 `EngineClient`를 반환"하는 팩토리 함수를 노출합니다. 기존 패턴을 그대로 따르면 됩니다.

#### 기본 패턴 (Node/Bun 스타일)

```ts
// packages/<host>/src/index.ts

export type MyHostInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type MyHostEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createMyHostEngine(transport: MyHostInvokeTransport): MyHostEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

#### 프레임워크 내장 패턴 (Tauri 스타일)

프레임워크가 자체적인 invoke 체계를 가진 경우, 어댑터에서 명령을 래핑할 수 있습니다:

```ts
// packages/tauri/src/index.ts (참고용)
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      // Tauri는 rustra_dispatch라는 단일 커맨드로 라우팅
      return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
    },
  };
}
```

#### 네이티브 모듈 패턴 (React Native 스타일)

네이티브 모듈을 직접 주입받는 패턴입니다:

```ts
// packages/react-native/src/index.ts (참고용)
export type ReactNativeRustraModule = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export function createReactNativeEngine(
  nativeModule: ReactNativeRustraModule,
): ReactNativeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await nativeModule.invoke(command, args)) as T;
    },
  };
}
```

---

## 3. Rust 진입점 선택 기준

Rust 쪽에서 TypeScript와 통신하는 방식은 다음 네 가지 중에서 선택합니다.

### C FFI (`extern "C"`) — 범용, 높은 성능

**적합한 경우:** React Native, Bun(`bun:ffi`), 임베디드, C/C++ 프로젝트와의 통합

**장점:**

- 언어 바인딩이 자유로움 (Swift, Kotlin, C, Python 등)
- 함수 호출 수준의 성능
- 메모리 직접 관리로 오버헤드 최소

**구현:**

```rust
// lib.rs
use std::ffi::{CStr, CString, c_char};
use serde_json::{Value, json};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_mypackage_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }

    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() {
        Ok(s) => s,
        Err(e) => return json_string(json!({ "ok": false, "error": format!("not UTF-8: {e}") })),
    };

    let request: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(e) => return json_string(json!({ "ok": false, "error": format!("invalid json: {e}") })),
    };

    let command = request.get("command").and_then(Value::as_str)
        .ok_or_else(|| "missing command").unwrap(); // 실제로는 적절히 처리
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));

    match my_package().invoke_json(command, args) {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_mypackage_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

fn json_string(value: Value) -> *mut c_char {
    let text = serde_json::to_string(&value)
        .unwrap_or_else(|e| format!(r#"{{"ok":false,"error":"json encode failed: {e}"}}"#));
    CString::new(text).expect("no interior null").into_raw()
}
```

Cargo.toml에서 `cdylib` 또는 `staticlib`을 지정:

```toml
[lib]
crate-type = ["rlib", "cdylib"]   # 동적 라이브러리 (Bun FFI, Python 등)
# 또는
crate-type = ["rlib", "staticlib"] # 정적 라이브러리 (iOS, Android 등)
```

### stdio (subprocess) — 범용, 구현이 간단

**적합한 경우:** Node.js, Bun, CLI 도구, 빠른 프로토타이핑

**장점:**

- 구현이 매우 간단
- 프로세스 격리로 안전성 보장
- 언어 독립적 (stdin/stdout만 사용)

**단점:**

- 매 호출 시 프로세스 스폰 오버헤드
- 프로세스 유지 불가 (stateless)

**구현:**

```rust
// main.rs
fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = my_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
```

TypeScript 쪽:

```ts
import { spawnSync } from 'node:child_process';

function invokeRuntime(command: string, args: unknown): unknown {
  const output = spawnSync('./target/debug/my-package', ['invoke'], {
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

### napi-rs — Node.js 고성능

**적합한 경우:** Node.js 전용 프로덕션 환경

**장점:**

- Node.js 네이티브 애드온으로서 최고 성능
- 타입 안전한 Rust ↔ JavaScript 변환
- 비동기 지원 (`Promise` 자동 생성)

**구현:**

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn rustra_invoke(command: String, args: Option<String>) -> Result<String> {
    let args_value = match args {
        Some(ref a) => serde_json::from_str(a)?,
        None => serde_json::json!({}),
    };
    let result = my_package().invoke_json(&command, args_value)?;
    Ok(serde_json::to_string(&serde_json::json!({ "ok": true, "result": result }))?)
}
```

### 프레임워크 내장 — Tauri

**적합한 경우:** Tauri 애플리케이션

Tauri는 자체 `invoke` 체계를 가지므로, `rustra::tauri_support::register`로 패키지를 등록하기만 하면 됩니다. 이 함수는 `rustra_dispatch`라는 단일 커맨드 핸들러를 Tauri 빌더에 등록하고, 모든 rustra 커맨드를 이 엔드포인트로 멀티플렉싱합니다:

```rust
// src-tauri/src/main.rs
let builder = rustra::tauri_support::register(my_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

> **참고:** `tauri_support`를 사용하려면 `Cargo.toml`에서 `tauri` feature를 활성화해야 합니다.
>
> ```toml
> rustra = { path = "...", features = ["tauri"] }
> ```

이 패턴은 다른 프레임워크와의 통합에서도 참고할 수 있습니다. 프레임워크가 단일 엔드포인트 기반의 명령 라우팅을 지원한다면, 비슷한 방식으로 멀티플렉스 adapter를 구현할 수 있습니다.

### 선택 결정 트리

```
새로운 host를 추가하시나요?
│
├─ Node.js 전용인가요?
│   ├─ 최고 성능이 필요한가요? → napi-rs
│   └─ 빠른 구현이 우선인가요? → subprocess stdio
│
├─ Bun 전용인가요?
│   ├─ 최고 성능이 필요한가요? → bun:ffi (C FFI)
│   └─ 빠른 구현이 우선인가요? → subprocess stdio
│
├─ React Native인가요?
│   └─ C FFI → Expo Modules Core로 래핑
│
├─ Tauri인가요?
│   └─ 프레임워크 내장 invoke
│
├─ 다른 네이티브 환경인가요? (iOS, Android, 임베디드)
│   └─ C FFI → 각 플랫폼의 FFI 메커니즘으로 래핑
│
└─ 범용 / 언어 독립적인가요?
    └─ subprocess stdio
```

---

## 4. 테스트 추가 방법

### 런타임 앱 작성

`examples/calculator/apps/` 아래에 새 host용 앱을 추가합니다.

```ts
// examples/calculator/apps/<host>-app.ts
import { addNumbers } from '../generated/commands.js';
import { createMyHostEngine } from '../../../packages/myhost/src/index.js';
import { configure } from '@rustra/types';

// transport 구현
const engine = createMyHostEngine({
  invoke(command: string, args?: unknown) {
    // 실제 transport 구현
    return invokeViaMyTransport(command, args);
  },
});

// 테스트
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`<host> runtime result: ${result.value}`);
```

### Adapter 테스트 작성 (모킹)

실제 Rust 바이너리 없이 adapter 로직만 검증하는 테스트입니다. 기존 `tauri-app.ts`와 `react-native-app.ts`가 이 패턴을 사용합니다:

```ts
// examples/calculator/apps/<host>-app.ts (모킹 버전)
import { addNumbers } from '../generated/commands.js';
import { createMyHostEngine } from '../../../packages/myhost/src/index.js';
import { configure } from '@rustra/types';

const calls: Array<{ command: string; args: unknown }> = [];

const engine = createMyHostEngine({
  async invoke(command: string, args?: unknown) {
    calls.push({ command, args });
    return { value: 42 }; // 모킹된 응답
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

if (JSON.stringify(calls) !== JSON.stringify([{ command: 'addNumbers', args: { a: 20, b: 22 } }])) {
  throw new Error(`unexpected calls: ${JSON.stringify(calls)}`);
}

console.log(`<host> adapter test passed`);
```

### package.json에 Bun script 추가

```json
{
  "scripts": {
    "test:adapter:myhost": "bun examples/calculator/apps/myhost-app.ts",
    "test:runtime:myhost": "cargo build -p rustra-calculator-example && bun examples/calculator/apps/myhost-app.ts"
  }
}
```

기존 스크립트 패턴을 참고:

```json
{
  "scripts": {
    "test:adapter:tauri": "bun examples/calculator/apps/tauri-app.ts",
    "test:adapter:react-native": "bun examples/calculator/apps/react-native-app.ts",
    "test:adapters": "bun run test:adapter:tauri && bun run test:adapter:react-native && bun run test:adapter:myhost",
    "test:runtime": "bun run test:runtime:node && bun run test:runtime:bun && bun run test:runtime:myhost",
    "test:compat": "bun run test:ts:node && bun run test:ts:bun && bun run test:adapters && bun run test:runtime"
  }
}
```

### 전체 테스트 실행

```bash
# 전체 호환성 테스트
bun run test:compat

# 개별 테스트
bun run test:adapter:myhost       # adapter 모킹 테스트
bun run test:runtime:myhost       # 실제 Rust 런타임 테스트
```

---

## 5. 실제 추가 예시: Electron adapter

Electron용 adapter를 추가하는 전체 과정을 보여줍니다.

### Step 1: 패키지 생성

```
packages/electron/src/index.ts
```

### Step 2: Adapter 작성

```ts
// packages/electron/src/index.ts
export type ElectronInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type ElectronEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createElectronEngine(transport: ElectronInvokeTransport): ElectronEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

### Step 3: Rust 진입점 선택

Electron은 Node.js 기반이므로 subprocess stdio로 시작:

```ts
// examples/calculator/apps/electron-app.ts
import { spawnSync } from 'node:child_process';
import { addNumbers } from '../generated/commands.js';
import { createElectronEngine } from '../../../packages/electron/src/index.js';
import { configure } from '@rustra/types';

const engine = createElectronEngine({
  invoke(command, args) {
    const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
      input: JSON.stringify({ command, args }),
      encoding: 'utf8',
    });

    if (output.status !== 0) {
      throw new Error(output.stderr || `runtime exited ${output.status}`);
    }

    const response = JSON.parse(output.stdout) as { ok: true; result: unknown };
    return response.result;
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`electron runtime result: ${result.value}`);
```

### Step 4: 테스트 스크립트 추가

```json
{
  "test:adapter:electron": "bun examples/calculator/apps/electron-app.ts",
  "test:runtime:electron": "cargo build -p rustra-calculator-example && bun examples/calculator/apps/electron-app.ts"
}
```

### Step 5: 나중에 napi-rs로 전환 (선택)

프로덕션에서 성능이 필요하면, napi-rs로 transport만 교체합니다:

```ts
const engine = createElectronEngine({
  invoke(command, args) {
    const native = require('./my-package.node');
    const rawResponse = native.rustra_invoke(command, JSON.stringify(args));
    const response = JSON.parse(rawResponse);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
});
```

adapter 코드(`packages/electron/src/index.ts`)는 변경하지 않습니다. transport만 교체합니다.
