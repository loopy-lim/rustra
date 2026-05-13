# @rustra/bun

Bun 환경의 비동기 transport를 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다.

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
import { createBunEngine } from "@rustra/bun";
import { spawn } from "bun";

const engine = createBunEngine({
  async invoke(command, args) {
    const proc = spawn(["cargo", "run", "-p", "my-crate", "--", "invoke"]);
    // JSON stdin/stdout으로 통신
    return sendAndReceive(proc, { command, args });
  },
});
```

### bun:ffi 기반

```ts
import { createBunEngine } from "@rustra/bun";
import { dlopen } from "bun:ffi";

const lib = dlopen("libmy_crate.so", { /* FFI 시그니처 */ });

const engine = createBunEngine({
  invoke(command, args) {
    return lib.symbols.invoke(JSON.stringify({ command, args }));
  },
});
```

## 주의사항

이 패키지는 Bun FFI, subprocess, HTTP 등 특정 transport를 선택하지 않습니다. transport 결정은 사용자가 외부에서 주입합니다.
