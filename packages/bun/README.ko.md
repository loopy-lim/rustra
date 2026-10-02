# @rustra/bun

## 선택된 런타임의 이벤트

이벤트가 있는 생성 엔트리는 명령과 같은 계약 검증된 라이브러리를 사용하는
`subscribeEvent`를 내보낸다. 직접 만든 부트스트랩도 `rustra.subscribeEvent`를 제공한다.
초기화된 런타임에서는 구독 호출 중 네이티브 싱크를 설치하므로 바로 다음 명령의
첫 이벤트를 받을 수 있다. `dispose()`는 구독을 정리하고 `reload()`는 다시 연결한다.

기본 네이티브 콜백은 JS 스레드에서 발생하는 동기 FFI 명령의 emit에 쓴다.
Rust 백그라운드 스레드에서 emit한다면 `createBunEventSubscription`에 `poll` 소스를
주입해야 한다.

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
Debug library 후보를 만들고, 실제 ABI 심볼까지 검사한 뒤 Frame engine을 lazy
설치합니다.

```ts
import { addNumbers } from './generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });
```

배포 레이아웃이 다르면 `RUSTRA_BUN_LIBRARY=/absolute/path/to/libapp.dylib`를 사용합니다.

FFI 엔진과 부트스트랩은 Bun 런타임이 필요합니다. Node에서 실행하면
`transport.unavailable` 오류가 `bun`으로 실행하거나 `@rustra/node`를 사용하도록 안내합니다.
패키지 import와 `createBunEngine(transport)`는 Node에서도 사용할 수 있습니다.

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
