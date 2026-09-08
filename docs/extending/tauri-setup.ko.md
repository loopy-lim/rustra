[English](./tauri-setup.md)

# 기존 Tauri 앱에 rustra 얹기

이미 가지고 있는 Tauri v2 앱에 rustra 명령을 넣는 파일별 워크스루다. 변경은 5개
파일이고 앱의 다른 부분은 건드리지 않는다. 정확히 이 구성으로 만든 완전한 동작
앱은 [`examples/tauri-calculator`](../../examples/tauri-calculator/)에 있다.

| #   | 파일                               | 변경                                                     |
| --- | ---------------------------------- | -------------------------------------------------------- |
| 1   | Rust 코어 크레이트 — `src/lib.rs`  | `#[command]` 함수 + package 함수 정의                    |
| 2   | Rust 코어 크레이트 — `rustra.json` | `"tauri": {}` 블록과 codegen generator 키 추가           |
| 3   | `src-tauri/Cargo.toml`             | 코어 크레이트 의존 + `tauri` feature를 켠 `rustra` 의존  |
| 4   | `src-tauri/src/main.rs`            | `tauri_support::register_with_events`로 패키지 등록      |
| 5   | `src-tauri/tauri.conf.json`        | `app.withGlobalTauri: true` 설정                         |
| 6   | 프런트엔드 (예: `src/app.ts`)      | `../generated/tauri.js`에서 import — 엔진 설정 코드 없음 |

## 1. Rust 코어 크레이트: 명령과 패키지

비즈니스 로직을 담는 크레이트에서(여기서는 `rustra-app`, 경로는 레이아웃에 맞게
조정):

```rust
// rustra-app/src/lib.rs
use rustra::prelude::*;

#[bridge_type]
pub struct AddNumbersInput { pub a: i64, pub b: i64 }

#[bridge_type]
pub struct AddNumbersOutput { pub value: i64 }

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

pub fn package() -> Package {
    rustra::build!("dev.rustra.app", add_numbers).done()
}
```

## 2. `rustra.json` — Tauri 호스트 켜기

Rust 크레이트에 `rustra.json`을 만든다(또는 확장한다). `tauri` 블록은 빈
객체다 — Cargo metadata와 표준 Tauri API를 추론한다:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "tauri": {}
}
```

그리고 클라이언트 표면을 생성한다:

```bash
bunx --bun @rustra/cli codegen --config rustra.json
```

`generated/tauri.ts`가 렌더링된다(`types.ts`, `commands.ts`, `contract.ts` 포함).
아직 schema 프로브 바이너리가 없다면 크레이트에
`package().generate_typescript()?.write_schema_to_dir("generated")`를 호출하는
`generate` bin을 추가한다 — [시작하기 §2-4](../getting-started.ko.md) 참고.

## 3. `src-tauri/Cargo.toml` — feature와 의존성

```toml
[dependencies]
rustra = { version = "0.8", features = ["tauri"] }
rustra-app = { path = "../rustra-app" }   # 여러분의 코어 크레이트
```

## 4. `src-tauri/src/main.rs` — 한 줄 등록

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register_with_events(
        rustra_app::package(),
        tauri::Builder::default(),
    );
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

- `register_with_events`가 프로덕션 기본값이다: `register` + 이벤트 푸시 배선
  (`Package::emit` → `rustra://{name}` Tauri 이벤트).
- `register(package, builder)`는 이벤트 배선 없는 변형이다.
- 모든 명령은 단일 `rustra_dispatch` Tauri 커맨드로 멀티플렉싱된다 — Tauri
  쪽에 명령을 나열하지 않는다.

## 5. `src-tauri/tauri.conf.json` — global API 활성화

생성 엔트리가 global Tauri API를 통해 IPC와 이벤트 API를 lazy 감지한다. `app`
안에서 켠다:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "My App",
  "identifier": "dev.rustra.myapp",
  "app": {
    "withGlobalTauri": true
  }
}
```

(이것이
[`examples/tauri-calculator/src-tauri/tauri.conf.json`](../../examples/tauri-calculator/src-tauri/tauri.conf.json)의
실제 모양이다.) global API를 원하지 않는 앱은 대신
`createTauriEngine({ invoke })`를 `configure()`에 넘기면 된다 —
[transport 가이드 §2 Tauri](./transport-guide.ko.md) 참고.

## 6. 프런트엔드 — import 후 호출

어댑터를 한 번 설치하고 생성 엔트리를 import한다:

```bash
bun add @rustra/tauri @rustra/types
```

```ts
// src/app.ts
import { addNumbers, subscribeEvent } from '../rustra-app/generated/tauri.js';

// Rust 측 Package::emit이 타입 있는 푸시 이벤트로 도착한다 (폴링 없음)
const unsubscribe = await subscribeEvent<{ value: number }>('calc.tick', (payload) => {
  console.log('tick', payload.value);
});

const result = await addNumbers({ a: 20, b: 22 }); // 42
```

엔트리가 첫 호출 때 엔진을 lazy 설치한다 — 앱 코드에 `configure()`도 invoke
배관도 없다. 평소처럼 앱을 빌드/실행한다(`tauri dev` / `tauri build`).

## 검증과 트러블슈팅

- `bunx --bun @rustra/cli doctor --config rustra.json` — 툴체인, manifest 배선,
  생성물 최신성을 검사한다.
- 첫 호출 계약 실패(`contract.mismatch`): 생성 TS와 Rust 바이너리가 서로 다른
  스키마로 빌드된 것이다 — codegen을 다시 돌리고 재빌드한다.
- OS capability 권한/CSP와 Tauri ACL은 별도 계층이다:
  [플랫폼 권한 가이드](../platform-permissions.ko.md) 참고.
- 호스트별 capability 차이(이벤트, 채널)는
  [호환성 매트릭스](../compatibility-matrix.ko.md)에 있다.
