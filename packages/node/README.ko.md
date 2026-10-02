# @rustra/node

## 상태를 유지하는 호출과 이벤트

`node: {}` 기본값은 명령마다 새 프로세스를 실행한다. Rust 상태를 호출 사이에
유지하려면 `rustra.json`에 `node: { "persistent": true }`를 설정한다. 생성 엔트리는
한 `serve` 프로세스를 재사용한다. 기존 데몬 플래그가 다르면 `node.args`에 지정한다
(예: `["--serve"]`). 바이너리는 NDJSON 요청 id와 `__rustra_contract`,
`__rustra_capabilities`, `__drainEvents`를 지원해야 한다. 현재 init 스캐폴드에 포함된다.

스키마에 이벤트가 선언되면 생성 Node 엔트리는 persistent 모드를 사용한다.
그 엔트리에서 생성 명령과 `subscribeEvent`를 함께 가져오면 같은 계약 검증된
런타임으로 호출과 구독이 연결된다. 종료 시 `rustra.dispose()`로 프로세스와 구독을
정리한다. `reload()`는 구독을 유지하며 프로세스를 교체한다. 계약/기능 검사 제한은
기본 5초이며 `readinessTimeoutMs`로 조정한다.

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

후보를 수정 시간이 최신인 순서로 계약 검증하고, 호환되는 다음 후보로 폴백합니다.
transpile/bundle 후에는 현재 작업 디렉터리의 부모에서 동일한 Cargo target을 찾습니다. 배포 레이아웃이 다르면
`RUSTRA_NODE_BINARY=/absolute/path/to/app`만 지정합니다.

수동 부트스트랩의 상대 `commandCandidates`와 `binaryName` 탐색은
`spawnOptions.cwd`(문자열 또는 file URL)를 기준으로 하며, 기본값은 `process.cwd()`입니다.
명시적인 경로 없는 `command`는 자식 프로세스의 `PATH`에서 찾습니다.
런타임을 찾지 못하면 오류에 작업 디렉터리와 검사한 후보 경로를 표시합니다.

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
persistent loop 16.86µs, N-API Frame 1.26µs였습니다. 따라서 기본 경로는 CLI와
저빈도 작업에 사용하고, 서버는 `createNodeLoopTransport`, 고빈도 hot path는 N-API
addon을 사용해야 합니다. 세 경로의 실행 가능한 비교는
[`node-performance.ts`](../../examples/calculator/apps/node-performance.ts)에 있습니다.
