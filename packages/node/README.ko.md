# @rustra/node

Node 환경의 Rustra 런타임을 자동 발견하고 공통 `EngineClient`로 연결하는 어댑터입니다.

## Zero-config 기본 경로

`rustra.json`에 빈 host 블록만 둡니다.

```json
{ "schema": "./generated/schema.json", "output": "./src/generated", "node": {} }
```

코드젠은 Cargo metadata로 기본 binary와 target 디렉터리를 찾고 `generated/node.ts`를
만듭니다. 애플리케이션에는 엔진 생성이나 `configure()`가 남지 않습니다.

```ts
import { addNumbers } from './generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
```

Release 산출물을 먼저 사용하고 Debug로 폴백합니다. transpile/bundle 후에는 현재 작업
디렉터리의 부모에서 동일한 Cargo target을 제한적으로 찾습니다. 배포 레이아웃이 다르면
`RUSTRA_NODE_BINARY=/absolute/path/to/app`만 지정합니다.

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
import { createNodeEngine } from '@rustra/node';
import { spawn } from 'node:child_process';

const engine = createNodeEngine({
  async invoke(command, args) {
    const child = spawn('cargo', ['run', '-p', 'my-crate', '--', 'invoke']);
    // JSON stdin/stdout으로 통신
    return sendAndReceive(child, { command, args });
  },
});
```

### napi-rs 기반

```ts
import { createNodeEngine } from '@rustra/node';
import { invoke as nativeInvoke } from 'my-crate-napi';

const engine = createNodeEngine({
  invoke(command, args) {
    return nativeInvoke(command, args);
  },
});
```

수동 `createNodeEngine`, process/loop transport 주입 API는 다중 런타임과 커스텀
N-API 배포 같은 예외를 위해 그대로 제공됩니다. 기본 생성 진입점은 표준 one-shot
stdio protocol을 사용하므로, N-API 수준 성능이 필요한 배포는 별도 native addon을
선택해야 합니다.

## 성능에 맞는 경로 선택

2026-08-24 macOS arm64 Release의 generated API 실측은 기본 one-shot 평균 2.76ms,
persistent loop 16.86µs, N-API rkyv V2 1.26µs였습니다. 따라서 기본 경로는 CLI와
저빈도 작업에 사용하고, 서버는 `createNodeLoopTransport`, 고빈도 hot path는 N-API
addon을 사용해야 합니다. 세 경로의 실행 가능한 비교는
[`node-performance.ts`](../../examples/calculator/apps/node-performance.ts)에 있습니다.
