# @rustra/bun

Bun 1.4 환경에서 Rustra cdylib를 stable C ABI로 자동 연결하는 어댑터입니다.

## Zero-config 기본 경로

Rust crate에 host-neutral entry를 한 줄 선언하고 `cdylib`을 켭니다.

```rust
rustra::native_entry!(app_package);
```

```toml
[lib]
crate-type = ["rlib", "cdylib"]
```

`rustra.json`에는 `"bun": {}`만 추가합니다. 생성된 파일이 Cargo metadata로 Release,
Debug library 후보를 만들고, 실제 ABI 심볼까지 검사한 뒤 rkyv V2 engine을 lazy
설치합니다.

```ts
import { addNumbers } from './generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });
```

배포 레이아웃이 다르면 `RUSTRA_BUN_LIBRARY=/absolute/path/to/libapp.dylib`를 사용합니다.

## 공개 API

```ts
type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

type BunEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createBunEngine(transport: BunInvokeTransport): BunEngineClient;
```

## 사용 예시

### subprocess 기반

```ts
import { createBunEngine } from '@rustra/bun';
import { spawn } from 'bun';

const engine = createBunEngine({
  async invoke(command, args) {
    const proc = spawn(['cargo', 'run', '-p', 'my-crate', '--', 'invoke']);
    // JSON stdin/stdout으로 통신
    return sendAndReceive(proc, { command, args });
  },
});
```

### bun:ffi 기반

```ts
import { createBunEngine } from '@rustra/bun';
import { dlopen } from 'bun:ffi';

const lib = dlopen('libmy_crate.so', {/* FFI 시그니처 */});

const engine = createBunEngine({
  invoke(command, args) {
    return lib.symbols.invoke(JSON.stringify({ command, args }));
  },
});
```

`createBunEngine(transport)`는 HTTP나 커스텀 FFI가 필요한 예외 경로입니다. 기본
`createBunBootstrap`은 Rust 소유 응답을 JS 소유 `ArrayBuffer`로 복사한 뒤 정확한
pointer/length 쌍으로 해제하며, schema/contract hash도 같은 ABI에서 검증합니다.

2026-08-24 macOS arm64 Release에서 생성된 `addNumbers` API 전체 경로는 평균 2.27µs,
p50 2.21µs, 약 439,961 ops/s였습니다. 이는 adapter 함수만 잰 숫자가 아니라 lazy
bootstrap 이후 codec, FFI, Rust invoke, 응답 소유권 이전을 포함합니다. 재현 코드는
[`bun-performance.ts`](../../examples/calculator/apps/bun-performance.ts)입니다.
