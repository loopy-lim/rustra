# @rustra/tauri

Tauri의 `invoke` 함수를 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다.

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
import { createTauriEngine } from "@rustra/tauri";
import { invoke } from "@tauri-apps/api/core";

const engine = createTauriEngine({ invoke });
```

내부적으로 Tauri의 `rustra_dispatch` 커맨드로 라우팅합니다:

```ts
engine.invoke("addNumbers", { a: 2, b: 3 });
// → options.invoke("rustra_dispatch", { command: "addNumbers", args: { a: 2, b: 3 } })
```

## 주의사항

이 패키지는 `@tauri-apps/api`를 직접 import하지 않습니다. 호출자가 `invoke` 함수를 주입하므로, 생성된 커맨드 헬퍼는 Tauri에 종속되지 않습니다.

Rust 측에서 `tauri` feature를 활성화하고 `tauri_support::register()`로 패키지를 등록해야 합니다:

```rust
use rustra::tauri_support::register;

let builder = register(my_package, tauri::Builder::default());
```

`register()`가 등록하는 `rustra_dispatch` 엔드포인트를 통해 이 어댑터가 동작합니다.
