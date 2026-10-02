[English](./tauri-setup.md)

# 기존 Tauri 앱에 rustra 얹기

이미 가지고 있는 Tauri v2 앱에 rustra 명령을 넣는 파일별 워크스루다. 정확히 이 구성으로 만든 완전한 동작
앱은 [`examples/tauri-calculator`](../../examples/tauri-calculator/)에 있다.

## 기존 앱을 한 명령으로 준비하기

프런트엔드 루트의 `rustra.json`에 `"tauri": {}`를 켜고 CLI 0.12.0으로 실행한다.
Rust 코어와 Tauri 호스트는 Rustra 0.12.0 이상을 함께 사용해야 한다.

```bash
bunx --bun @rustra/cli@0.12.0 setup --config rustra.json
```

setup은 클라이언트 생성, 의존성 설치, 선택된 Rust 코어 빌드,
`app.withGlobalTauri` 설정과 `src-tauri/src/rustra_setup.rs` 생성을 수행한다.
코어 라이브러리와 인자 없는 공개 `Package` 팩토리를 자동으로 찾는다. 기존 네이티브
Rust 소스와 Cargo 의존성은 보존한다. setup이 출력한 누락 의존성만 추가한 뒤 기존 builder를 등록한다.

```rust
mod rustra_setup;
// 기존 플러그인과 managed state를 연결한 builder를 그대로 전달한다.
let builder = rustra_setup::register(builder);
```

기존 Tauri 명령이 있으면 `register` 대신 `.invoke_handler(...)` 자리를
`rustra_setup::with_app_commands(builder, tauri::generate_handler![greet, open_document])`로
바꾼다. 마지막 핸들러 설치로 유지한다. 생성된 `tauri.js`에서 명령을 import하고 Tauri 앱을 다시 빌드한다.

재실행은 같은 파일을 바꾸지 않으며 수정된 어댑터는 덮어쓰지 않는다. 패키지 팩토리가
여러 개면 추측하지 않고 명시적 선택을 요구한다. 실패하면 오류를 해결한 뒤 출력된
setup 명령으로 재시도한다. 준비 완료와 네이티브 앱 빌드·WebView 런타임 검증은
별도이며 registry 발행 여부도 별도로 확인한다.

| #   | 파일                              | 변경                                                     |
| --- | --------------------------------- | -------------------------------------------------------- |
| 1   | Rust 코어 크레이트 — `src/lib.rs` | `#[command]` 함수 + package 함수 정의                    |
| 2   | 프런트엔드 루트 — `rustra.json`   | `"tauri": {}` 블록과 codegen generator 키 추가           |
| 3   | `src-tauri/Cargo.toml`            | 코어 크레이트 의존 + `tauri` feature를 켠 `rustra` 의존  |
| 4   | `src-tauri/src/main.rs`           | `tauri_support::register_with_events`로 패키지 등록      |
| 5   | `src-tauri/tauri.conf.json`       | `app.withGlobalTauri: true` 설정                         |
| 6   | 프런트엔드 (예: `src/app.ts`)     | `../generated/tauri.js`에서 import — 엔진 설정 코드 없음 |

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

프런트엔드 루트에서 `package.json`·`src-tauri/` 옆에 `rustra.json`을 만들거나
확장한다. `codegen.rustManifest`는 Rust 코어 크레이트를 가리킨다. 이 예시의 코어는
`rustra-app/`이며 생성 클라이언트는 프런트엔드 `generated/`에 둔다. 빈 `tauri`
블록은 표준 Tauri API를 추론한다:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./rustra-app/Cargo.toml",
    "rustBinary": "generate"
  },
  "tauri": {}
}
```

그리고 클라이언트 표면을 생성한다:

```bash
bunx --bun @rustra/cli@0.12.0 codegen --config rustra.json
```

`generated/tauri.ts`가 렌더링된다(`types.ts`, `commands.ts`, `contract.ts` 포함).
아직 schema 프로브 바이너리가 없다면 크레이트에
`package().generate_typescript()?.write_schema_to_dir("generated")`를 호출하는
`generate` bin을 추가한다 — [시작하기 §2-4](../getting-started.ko.md) 참고.

생성 엔트리는 예상 계약 해시를 전달하고 네이티브 시작 검증을 strict로 수행한다.
현재 Rust 등록은 `rustra_contract_hash`를 제공하므로 Rust와 생성 TypeScript를 함께
갱신한다. 설치한 Rustra와 CLI는 위 릴리스 버전에 맞춘다. 검증을 제공할
수 없는 구형·사용자 정의 호스트는 `contractVerification: 'warn'` 또는 `'off'`를
명시해야 한다.

## 3. `src-tauri/Cargo.toml` — feature와 의존성

```toml
[dependencies]
rustra = { version = "0.12.0", features = ["tauri"] }
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

기존 앱에 자체 Tauri 네이티브 명령도 있다면 Rustra 등록과 핸들러를 결합한다:

```rust
let builder = tauri_support::with_app_commands(
    tauri_support::register_with_events(rustra_app::package(), tauri::Builder::default()),
    tauri::generate_handler![greet, open_document],
);
```

`greet`와 `open_document`는 앱에 이미 있는 `#[tauri::command]` 함수다.
Tauri의 `.invoke_handler()`는 이전 핸들러를 교체하므로 `with_app_commands`를
마지막 핸들러 설치로 사용한다. 등록된 Rustra 생산자, 이벤트, 채널은 유지되고
프로덕션 Rustra 엔드포인트 여섯 개가 앱 명령보다 우선한다. 프로파일링
엔드포인트는 노출하지 않는다. `register`와 `register_dispatch` 뒤에도 사용할
수 있다.

시작 중 `rustra_contract_hash`가 없다는 오류는 이제 네이티브 등록과 핸들러
교체 원인을 안내한다. 대응하는 Rustra 버전으로 등록한 뒤 호스트를 다시 빌드하고,
앱 자체 네이티브 명령이 있으면 결합 헬퍼를 사용한다.

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
bun add @rustra/tauri@0.10.0 @rustra/types@0.12.1
```

```ts
// src/app.ts
import { addNumbers, subscribeEvent } from '../generated/tauri.js';

// Rust 측 Package::emit이 타입 있는 푸시 이벤트로 도착한다 (폴링 없음)
const unsubscribe = await subscribeEvent<{ value: number }>('calc.tick', (payload) => {
  console.log('tick', payload.value);
});

const result = await addNumbers({ a: 20, b: 22 }); // 42
```

엔트리가 첫 호출 때 엔진을 lazy 설치한다 — 앱 코드에 `configure()`도 invoke
배관도 없다. 평소처럼 앱을 빌드/실행한다(`tauri dev` / `tauri build`).

## 7. 모바일(iOS/Android) — lib/bin 분리

데스크톱 전용 앱은 6까지면 충분하다. Tauri 2 모바일은 앱 본체를 플랫폼 셸(Xcode
프로젝트/Gradle 프로젝트)이 로드하는 **라이브러리 타깃**으로 빌드한다 — bin 전용
레이아웃이면 `no library targets found` 로 실패한다.
[tauri-calculator 예제](../../examples/tauri-calculator/)가 기준 레이아웃이다:

1. `src-tauri/Cargo.toml` 이 라이브러리 타깃을 선언한다 — iOS 용 `staticlib`,
   Android 용 `cdylib`, 데스크톱 bin 과 테스트가 링크를 유지하도록 `rlib`:

   ```toml
   [lib]
   name = "rustra_tauri_calculator_lib"
   crate-type = ["staticlib", "cdylib", "rlib"]
   ```

2. 앱 본체(`register_with_events` 호출과 그 주변 전체)를 라이브러리의 공유
   엔트리로 옮기고 Tauri 모바일 엔트리 attribute 를 붙인다 —
   `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()`.
3. `src-tauri/src/main.rs` 는 `run()` 만 호출하는 얇은 데스크톱 래퍼가 된다.
   모바일은 모바일 엔트리 포인트를 통해 같은 `run()` 으로 부팅한다.
4. `bunx tauri ios init` / `bunx tauri android init` 으로 플랫폼 셸을
   스캐폴딩하고(`src-tauri/gen/` 아래 생성), `tauri ios build` /
   `tauri android build` 로 빌드한다.

rustra 쪽은 모바일에서 추가 작업이 없다 — 같은
`tauri_support::register_with_events` 등록이 공유 엔트리 안에서 실행된다.
(`rustra::native_entry!` 는 **React Native** 경로의 `rustra_mobile_init`
계약이다. Tauri 모바일 앱은 쓰지 않는다.)

## 검증과 트러블슈팅

- `bunx --bun @rustra/cli doctor --config rustra.json` — 툴체인, manifest 배선,
  생성물 최신성을 검사한다.
- 첫 호출 계약 실패(`contract.mismatch`): 생성 TS와 Rust 바이너리가 서로 다른
  스키마로 빌드된 것이다 — codegen을 다시 돌리고 재빌드한다.
- OS capability 권한/CSP와 Tauri ACL은 별도 계층이다:
  [플랫폼 권한 가이드](../platform-permissions.ko.md) 참고.
- 호스트별 capability 차이(이벤트, 채널)는
  [호환성 매트릭스](../compatibility-matrix.ko.md)에 있다.
