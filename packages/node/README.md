# @rustra/node

Node 환경의 비동기 transport를 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다.

## 공개 API

```ts
type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

type NodeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient;
```

## 사용 예시

### subprocess 기반

```ts
import { createNodeEngine } from "@rustra/node";
import { spawn } from "node:child_process";

const engine = createNodeEngine({
  async invoke(command, args) {
    const child = spawn("cargo", ["run", "-p", "my-crate", "--", "invoke"]);
    // JSON stdin/stdout으로 통신
    return sendAndReceive(child, { command, args });
  },
});
```

### napi-rs 기반

```ts
import { createNodeEngine } from "@rustra/node";
import { invoke as nativeInvoke } from "my-crate-napi";

const engine = createNodeEngine({
  invoke(command, args) {
    return nativeInvoke(command, args);
  },
});
```

## 주의사항

이 패키지는 N-API, subprocess, HTTP 등 특정 transport를 선택하지 않습니다. transport 결정은 사용자가 외부에서 주입합니다.
