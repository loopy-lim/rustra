[English](./compatibility-contract.md)

# 호환성 계약 (Compatibility Contract)

`rustra` 가 생성하는 TypeScript 는 호스트 중립을 유지해야 한다. 생성 파일은
아래 형태에만 의존할 수 있다:

```ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

이 계약이 다음을 잇는 안정적인 다리이다:

- Node: 어댑터가 프로세스, N-API, 또는 다른 Node transport 로 로컬 Rust 를 호출한다.
- Bun: 어댑터가 Bun FFI, 서브프로세스, 또는 다른 Bun transport 로 로컬 Rust 를 호출한다.
- Tauri: 어댑터가 `EngineClient.invoke` 를 `window.__TAURI__.core.invoke` 나 플러그인 invoke 로 연결한다.
- React Native: 생성 진입점이 `EngineClient.invoke` 를 autolink 된 Rustra JSI 모듈로 연결한다.

생성된 커맨드 헬퍼는 `node:`, `bun:`, `@tauri-apps`, `react-native`, `expo` 같은
호스트 전용 API 를 import 하거나 언급해서는 안 된다.

현재 검증:

```bash
cargo test --workspace
bun run test:compat
```

`bun run test:compat` 에는 두 부류의 검사가 있다:

- 어댑터 계약 검사: 생성 커맨드가 호스트 패키지를 import 하지 않고 주입된 Tauri,
  React Native transport 를 호출하는지.
- 런타임 검사: Node 와 Bun 은 Rust 계산기 바이너리를 실행하고, Tauri 예제는 실제
  앱을 빌드한 뒤 WebView JavaScript 가 `window.__TAURI__.core.invoke` 로 Rust
  커맨드를 호출할 만큼 실행한다. Tauri 커맨드 핸들러는 별도의 수제 계산기 경로가
  아니라 공용 `rustra` 계산기 패키지를 `Package::invoke` 로 호출한다.
- React Native 검사: Expo 픽스처는 iOS/Android 에서 생성 모듈을 빌드하고,
  Expo 없는 RN 0.81 픽스처는 typecheck + 양 플랫폼 autolinking 을 검증한다.
  실기기 측정은 빌드/링크 증명과 분리해 관리한다.

React Native 는 런타임 게이트를 통과했다: 네이티브 JSI 모듈이 존재하고, 실기기
호출이 검증되었으며, CI 가 Release 앱을 빌드한다. 측정된 fast-path 수치는
`docs/benchmarks.ko.md` 를 본다.

## 안정적인 어댑터 경계

각 어댑터 패키지는 의도적으로 좁은 안정 범위를 가진다.

| 패키지                 | 안정 범위                                                   | 이 레이어의 범위 밖                      |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `@rustra/node`         | Node 쪽 비동기 transport 를 `EngineClient` 로 변환          | N-API vs 서브프로세스 vs HTTP 선택       |
| `@rustra/bun`          | Bun 쪽 비동기 transport 를 `EngineClient` 로 변환           | Bun FFI vs 서브프로세스 vs HTTP 선택     |
| `@rustra/tauri`        | Tauri `invoke(command, args)` 함수를 `EngineClient` 로 변환 | Tauri 플러그인 등록, ACL/capability 생성 |
| `@rustra/react-native` | 생성 JSI bootstrap 과 저수준 `EngineClient` 어댑터          | 앱 고유 커맨드 정의와 벤치마크 비교기    |

불변식은 모든 호스트에서 동일하다:

```ts
generatedCommand(engine, input)
  -> engine.invoke(commandName, input)
  -> host transport(commandName, input)
```

어댑터는 서로를 import 해서는 안 된다. Tauri 와 React Native 어댑터는 호스트
패키지를 직접 import 하지 않는다 — 호출자가 호스트 transport 를 주입한다. 덕분에
생성 클라이언트 코드가 재사용 가능하고, 네이티브/런타임 선택이 커맨드 계약 바깥에
머문다.

## 동일 코드 요구사항

호스트 예제는 같은 커맨드 표면을 사용해야 한다:

- 같은 Rust 커맨드 패키지가 등록과 디스패치를 소유한다.
- 같은 생성 TypeScript 커맨드 헬퍼를 호스트 앱 코드가 import 한다.
- 호스트별 JavaScript 차이는 어떤 어댑터가 `EngineClient` 를 만드는지뿐이다.
- 호스트별 네이티브/런타임 차이는 그 어댑터 transport 가 Rust 에 어떻게 도달하는지뿐이다.

계산기 예제에서 공용 경로는 `addNumbers({ a, b })` 이다. 생성 플랫폼 진입점이
지연 엔진 설치를 소유하고, 수동 `configure(engine)` 은 명시적 오버라이드일 뿐이다.
Node, Bun, Tauri 는 생성 헬퍼나 `rustra` 패키지 디스패치를 우회하는 앱 로컬
계산기 로직을 별도로 두어서는 안 된다.

React Native 는 두 픽스처에서 같은 JavaScript 경로를 따른다 —
`@rustra/generated-react-native`(공용 C++ JSI 브리지 + 생성 postcard 코덱)로
디스패치한다.

## 런타임 승인 게이트

호스트를 "실제로 동작한다"고 부르기 전의 협상 불가능한 게이트:

| 호스트       | 통과 조건                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node         | Node 앱이 생성 TypeScript 헬퍼를 호출하고, 헬퍼가 `@rustra/node` 를 호출하며, 어댑터가 Rust 프로세스를 호출해 기대한 JSON 결과를 반환한다.                                       |
| Bun          | Bun 앱이 생성 TypeScript 헬퍼를 호출하고, 헬퍼가 `@rustra/bun` 을 호출하며, 어댑터가 Rust 프로세스를 호출해 기대한 JSON 결과를 반환한다.                                         |
| Tauri        | Tauri 앱이 빌드·실행되고, WebView JavaScript 가 `@rustra/tauri` 로 생성 `addNumbers` 헬퍼를 호출하며, Rust 커맨드 핸들러가 공용 `rustra` 패키지를 `Package::invoke` 로 호출한다. |
| React Native | React Native 앱이 시뮬레이터/실기기에서 실행되고, JavaScript 가 생성 TypeScript 헬퍼를 호출하며, 네이티브 모듈이 Rust 코드를 호출하고, UI 나 프로브가 Rust 결과를 관측한다.      |

호스트가 통과 조건에 도달하기 전까지 문서와 스크립트는 이를 런타임 통과가 아니라
어댑터/번들 검사로 불러야 한다.
