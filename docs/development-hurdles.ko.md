[English](./development-hurdles.md)

# 개발 허들 줄이기

Rustra는 Rust 명령을 네이티브 코드로 연결하므로 모든 환경 의존성을 없앨 수는
없습니다. 대신 설치 전에 필요한 도구를 확인하고, Rust schema 생성과 TypeScript/C++
생성을 한 명령으로 묶으며, 생성물의 동기화를 CI에서 자동으로 검사할 수 있습니다.

이 문서는 버전을 변경하지 않은 현재 checkout의 동작을 기준으로 합니다. CLI, JS
패키지, Rust crate는 독립적인 버전 범위를 가지므로 실제 호환성은 프로젝트의
lockfile과 생성된 manifest를 함께 확인해야 합니다.

## CLI 실행 — 표준 3형태

| 형태                                                 | 언제                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| `bunx --bun @rustra/cli <cmd>`                       | 권장 일회성 형태 (설치 없음, bunx가 버전 고정) |
| `bun add -d @rustra/cli` + `bunx --bun rustra <cmd>` | 패키지 스크립트로 CLI 명령을 돌리는 프로젝트   |
| `bun i -g @rustra/cli` + `rustra <cmd>`              | 드물게 — 전역 바이너리가 필요한 머신만         |

`rustra init`이 만드는 패키지 스크립트(`bun run doctor`, `bun run codegen`, …)는
디펜던시 형태를 쓰고, CI와 문서 예제는 `bunx` 형태를 쓴다. 모든 명령은
`--config rustra.json`을 명시적으로 받는다.

## Rust 없이 시작하기: mock 엔진

UI가 네이티브 빌드를 기다릴 필요는 없다. `@rustra/testing`의
`createMockEngine`은 실제 `EngineClient`다 — `configure()`로 한 번 설치하면 생성된
커맨드 헬퍼가 그대로 동작하고 Rust 툴체인이 필요 없다:

```bash
bun add @rustra/testing @rustra/types
```

```ts
// src/mock.ts — UI를 만드는 동안 일찍 import한다
import { createMockEngine } from '@rustra/testing';
import { configure } from '@rustra/types';
import { addNumbers } from './generated/commands.js';

const engine = createMockEngine()
  // 문자열 형태 — 아무 커맨드 이름
  .on('addNumbers', ({ a, b }) => ({ value: a + b }))
  // 타입 형태 — 생성 함수에서 이름을 해석, 오타는 바로 실패
  .mock(addNumbers, ({ a, b }) => ({ value: a + b }))
  // 실패 시뮬레이션: {code,message}는 구조화된 RustraCommandError가 된다
  .fail('secureCompute', { code: 'capability.denied', message: 'not granted in mock' });

configure(engine); // 글로벌 invoke에 설치

const result = await addNumbers({ a: 20, b: 22 }); // 42 — Rust 불필요
engine.calls(); // [{ command: 'addNumbers', args: { a: 20, b: 22 } }]
```

mock은 비정상 경로도 커버한다:

- `createMockEngine({ delayMs: 50 })` 또는 `.delay('addNumbers', 50)` — 취소/
  로딩 상태 테스트용 지연(abort된 `signal`은 실제 어댑터와 같은
  `CancelledError` 계약으로 거부된다).
- `.emit('progress.tick', payload)` + `engine.subscribeEvent(name, cb)` —
  이벤트 기반 UI를 구동하고 `.events()`로 발행 이력을 조사한다.
- 테스트 케이스 사이 `.reset()`; `.calls()`가 모든 invoke를 기록해 순서·인자
  단언에 쓸 수 있다.
- 패키지는 계약 게이트(`assertContractCurrent`, `expectContractCurrent`, …)도
  export한다 — `generated/`가 커밋된 schema에서 벗어나면 실패한다.
  `packages/testing/src/contract-gate.ts` 참고.

`configure()` 호출을 지우면 mock이 생성 호스트 엔트리로 바뀐다 — 앱 코드의
다른 부분은 바뀌지 않는다.

## 첫 실행 경로

새 프로젝트는 다음 순서로 시작합니다.

```bash
bunx --bun @rustra/cli init my-project
cd my-project
bun install
bun run doctor
bun run codegen
```

`rustra init`은 `rustra.json`과 다음 스크립트를 함께 만듭니다.

```json
{
  "doctor": "rustra doctor --config rustra.json",
  "codegen": "rustra codegen --config rustra.json",
  "codegen:check": "rustra codegen --config rustra.json --check",
  "dev": "rustra dev --config rustra.json"
}
```

## `rustra doctor`

`doctor`는 설치나 파일 변경 없이 현재 호스트를 진단합니다.

```bash
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli doctor --config rustra.json --format json
bunx --bun @rustra/cli doctor --config rustra.json --strict
```

공통으로 Rust MSRV 1.88+, Cargo, Node/Bun, C/C++ 컴파일러, CMake, Cargo manifest와
설정된 Rust target을 확인합니다. React Native를 설정한 경우에만 macOS의
Xcode/CocoaPods와 Android의 Java 17, `ANDROID_NDK_ROOT` 또는 SDK의 NDK
`27.1.12297006`, 기본 Rust Android target을 추가로 확인합니다. Tauri 설정에는
호스트별 native build 도구도 포함됩니다.

각 실패에는 확인한 값과 복사 가능한 다음 조치가 함께 출력됩니다. `--format json`은
CI annotation이나 IDE 연동에 사용할 수 있고, `--strict`는 경고도 실패로 처리합니다.
`doctor`는 자동 설치를 수행하지 않습니다.

## 통합 codegen과 dev 루프

이전의 두 명령 대신 설정이 가리키는 Rust generator를 CLI가 찾아 다음 순서로 실행합니다.

```text
Cargo metadata로 target 선택
  -> cargo run --bin <configured generator>
  -> schema.json
  -> TypeScript/C++/React Native 생성
  -> .rustra-generated.json 기록
```

`rustra.json`에는 workspace에서 모호하지 않도록 Rust manifest, package, binary를
명시할 수 있습니다.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustPackage": "my-app",
    "rustBinary": "generate"
  }
}
```

binary를 생략하면 이름이 `generate`인 binary, 또는 유일한 binary를 사용합니다. 둘
이상 후보가 있으면 자동으로 추측하지 않고 `codegen.rust_binary_ambiguous`와 후보를
출력합니다.

Rust를 수정하면서 계속 생성하려면 다음을 사용합니다.

```bash
bun run dev
```

config 모드의 `dev`는 CLI 설치 위치를 추측하거나 별도 CLI 프로세스를 만들지 않고 같은
프로세스의 `codegen` 오케스트레이터를 호출합니다. Rust `src`, `Cargo.toml`,
`Cargo.lock`, schema를 감시하며, 생성된 schema와 같은 내용의 Linux write 이벤트는
다시 codegen을 예약하지 않습니다. 두 감시 모드는 공통 상태 머신을 사용하므로 실행 중
추가 변경은 하나의 대기 실행으로 합쳐지고 오래 걸리는 Cargo 빌드가 겹치지 않습니다.
기존의 `--backend`/`--app` 감시 모드도 호환성을 위해 유지됩니다.

## 생성물 drift 게이트

일반 생성은 산출물과 `.rustra-generated.json`을 갱신합니다. 생성된 TS/C++/RN 파일을
커밋하는 프로젝트는 다음 명령을 CI에 추가할 수 있습니다.

```bash
bun run codegen:check
```

`generate --check`는 현재 schema로 예상한 모든 파일의 바이트, schema hash, generator
버전을 매니페스트와 비교하고 파일을 쓰지 않습니다. 디스크 내용 변경과 stale manifest를
서로 다른 오류로 보고하며, 누락·변경·예상 밖 파일은 실패로 처리합니다. `codegen --check`는
Rust generator에 `RUSTRA_SCHEMA_OUT` 임시 디렉터리를 전달해 Cargo 단계도 작업 트리를
쓰지 않게 한 뒤 TS/C++/RN 검증을 수행합니다. 생성된 Rust 파일은 내용이 같으면 재작성하지
않습니다.

## 플랫폼별 현실적인 경계

### Rust와 native toolchain

Rustra CLI 자체는 npm/Bun 패키지로 설치할 수 있습니다. 그러나 사용자의 `#[command]`,
schema, staticlib를 포함한 애플리케이션 네이티브 산출물은 앱과 target에 종속되므로
범용 prebuilt binary 하나로 대체할 수 없습니다.

- Node/Bun만 사용하면 Rust, C/C++ linker와 Node/Bun이 필요합니다.
- Tauri는 해당 호스트의 Rust와 C/C++ 도구가 필요합니다.
- React Native는 iOS에서 Xcode/CocoaPods, Android에서 SDK/NDK 27+와 Java 17이
  필요하며 Expo Go가 아니라 development build를 사용합니다.

팀에서는 모든 개발자가 매번 native archive를 다시 만들게 하지 말고, CI가 각 플랫폼과
아키텍처별 archive를 빌드해 캐시 또는 내부 artifact로 제공하는 방식을 권장합니다.
그 artifact는 같은 Rust commit, schema hash, target에만 사용할 수 있는 앱별 결과물이며
Rustra가 제공하는 범용 runtime prebuilt가 아닙니다.

### Expo Go

Rustra의 RN adapter는 C++ JSI와 Rust FFI를 포함하므로 Expo Go에 사후 로드할 수
없습니다. Expo 앱은 development build를 한 번 만든 뒤 실행합니다.

```bash
bunx --bun expo prebuild
bunx --bun expo run:ios
# 또는
bunx --bun expo run:android
```

### Rust 타입 경계

브리지 파라미터와 반환값은 `#[bridge_type]` 및 Serde/Schemars로 표현할 수 있는 owned
데이터여야 합니다. 참조자, `dyn Trait`, 클로저를 직접 넘길 수 없다는 제한은 제거할
수 없지만, 문서와 schema validation으로 경계를 codegen 단계에서 드러내야 합니다.
채널/리소스 기능이 필요한 경우에는 callback 자체 대신 소유된 핸들 계약을 사용합니다.

### 성능 계층

평탄한 원시 타입, 고정 tuple, 단순 구조체는 postcard/rkyv fast path를 사용합니다.
중첩 구조체, 구조체 값 map, data enum 등은 schema-driven complex codec으로 처리하고,
지원하지 않는 형태는 Tier 3 JSON fallback으로 내려갑니다. 따라서 성능 주장은 타입별
경로를 구분해야 하며, 복합 payload는 실제 schema로 벤치마크해야 합니다.

### 런타임 registry와 unsafe

동적 command registry의 command ID는 u16 공간이며 최대 65,534개이고, retired ID는
재사용하지 않습니다. Release에서는 registry가 frozen되므로 런타임 plugin 주입을
기본 확장점으로 삼지 않습니다.

제로 카피 FFI의 unsafe Rust/C++ 경계는 남아 있습니다. 애플리케이션 사용자는 생성된
모듈과 adapter API를 사용하고, bridge 내부를 수정하는 기여자는 Miri, sanitizer,
fuzzing과 native build를 함께 통과시켜야 합니다.

## 외부 레퍼런스가 적은 문제

0.x API의 변경 가능성은 남아 있으므로, CI에서 `doctor`, `codegen:check`, `rustra diff`
를 함께 실행하고 CLI/Rust/adapter 버전을 각각 lock합니다. 문제를 재현할 때는 다음
정보를 함께 남기면 소스 코드까지 내려가지 않고도 진단할 수 있습니다.

```bash
bunx --bun @rustra/cli doctor --config rustra.json --format json > rustra-doctor.json
bun run codegen:check
bunx --bun @rustra/cli diff --old generated/schema.v1.json --new generated/schema.json
```
