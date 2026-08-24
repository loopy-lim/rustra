# @rustra/tauri

Tauri의 global IPC를 lazy 감지해 공통 `EngineClient`로 연결하는 어댑터입니다.

## Zero-config 기본 경로

Tauri 설정에서 global API를 켜고 Rust package를 한 줄 등록합니다.

```json
{ "app": { "withGlobalTauri": true } }
```

```rust
let builder = rustra::tauri_support::register_with_events(app_package(), tauri::Builder::default());
```

`rustra.json`에는 `"tauri": {}`만 추가합니다. 생성된 진입점이 invoke와 event API를
lazy 감지하므로 프런트엔드는 바로 명령과 구독 함수를 import합니다.

```ts
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
```

## 공개 API

```ts
type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

type TauriEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient;
```

## 사용 예시

```ts
import { createTauriEngine } from '@rustra/tauri';
import { invoke } from '@tauri-apps/api/core';

const engine = createTauriEngine({ invoke });
```

내부적으로 Tauri의 `rustra_dispatch` 커맨드로 라우팅합니다:

```ts
engine.invoke('addNumbers', { a: 2, b: 3 });
// → options.invoke("rustra_dispatch", { command: "addNumbers", args: { a: 2, b: 3 } })
```

이 패키지는 `@tauri-apps/api`를 강제로 설치하지 않아 기존 Tauri 버전과 충돌하지
않습니다. `withGlobalTauri`를 쓰지 않는 앱은 기존 `createTauriEngine({ invoke })`를
명시적 escape hatch로 사용할 수 있습니다.

Rust 측에서 `tauri` feature를 활성화하고 `tauri_support::register()`로 패키지를 등록해야 합니다:

```rust
use rustra::tauri_support::register;

let builder = register(my_package, tauri::Builder::default());
```

`register()`가 등록하는 `rustra_dispatch` 엔드포인트를 통해 이 어댑터가 동작합니다.

실제 WebView IPC 예제와 Release 성능 영수증은
[`tauri-calculator`](../../examples/tauri-calculator/)에 있습니다. 2026-08-24 macOS
arm64 실측은 평균 279.04µs, p50 300µs였으며, Rust 직접 호출 스모크가 아니라 숨은
WKWebView에서 생성된 `addNumbers`를 3,000회 호출한 값입니다.
