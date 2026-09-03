# 호환성 계약

`rustra`가 생성하는 TypeScript는 host 중립을 유지해야 한다. 생성 파일은 이
형태에만 의존할 수 있다:

```ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

이 계약이 다음을 위한 안정 브릿지다:

- Node: 어댑터가 프로세스, N-API, 또는 다른 Node transport를 통해 로컬 Rust를 호출한다.
- Bun: 어댑터가 Bun FFI, 서브프로세스, 또는 다른 Bun transport를 통해 로컬 Rust를 호출한다.
- Tauri: 어댑터가 `EngineClient.invoke`를 `window.__TAURI__.core.invoke` 또는 플러그인 invoke로 매핑한다.
- React Native: 생성 진입점이 `EngineClient.invoke`를 autolink된 Rustra JSI 모듈로 매핑한다.

생성된 커맨드 헬퍼는 `node:`, `bun:`, `@tauri-apps`, `react-native`, `expo` 같은
host 전용 API를 import하거나 언급해서는 안 된다.

현재 검증:

```bash
cargo test --workspace
bun run test:compat
```

`bun run test:compat`에는 두 부류의 검사가 포함된다:

- 어댑터 계약 검사: 생성된 커맨드가 host 패키지를 import하지 않고 주입된 Tauri 및 React Native transport를 호출한다.
- 런타임 검사: Node와 Bun이 Rust 계산기 바이너리를 실행하고, Tauri 예제는 실제 앱을 빌드한 뒤 WebView JavaScript가 `window.__TAURI__.core.invoke`로 Rust 커맨드를 호출할 수 있을 만큼 실행한다. Tauri 커맨드 핸들러는 별도의 수작업 계산기 경로가 아니라 공유 `rustra` 계산기 패키지를 `Package::invoke`로 호출한다.
- React Native 검사: Expo fixture는 iOS와 Android에서 생성 모듈을 빌드하고, Expo 없는 RN 0.81 fixture는 양쪽 autolinking 플랫폼을 타입체크·검증한다. 디바이스 실측은 빌드/링크 증명과 별도로 관리한다.

React Native는 런타임 게이트를 통과했다: 네이티브 JSI 모듈이 존재하고, 실제
디바이스 호출이 검증되었으며, CI가 Release 앱을 빌드한다. 측정된 fast-path
수치는 `docs/benchmarks.md`를 참고한다.

## 안정 어댑터 경계

각 어댑터 패키지는 의도적으로 작은 안정 범위를 갖는다.

| 패키지                 | 안정 범위                                                  | 이 레이어의 범위 밖                      |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `@rustra/node`         | Node 쪽 async transport를 `EngineClient`로 변환            | N-API vs 서브프로세스 vs HTTP 선택       |
| `@rustra/bun`          | Bun 쪽 async transport를 `EngineClient`로 변환             | Bun FFI vs 서브프로세스 vs HTTP 선택     |
| `@rustra/tauri`        | Tauri `invoke(command, args)` 함수를 `EngineClient`로 변환 | Tauri 플러그인 등록, ACL/capability 생성 |
| `@rustra/react-native` | 생성 JSI 부트스트랩과 저수준 `EngineClient` 어댑터         | 앱 전용 커맨드 정의와 벤치마크 비교기    |

불변식은 모든 host에서 동일하다:

```ts
generatedCommand(engine, input)
  -> engine.invoke(commandName, input)
  -> host transport(commandName, input)
```

어댑터는 서로를 import해서는 안 된다. Tauri와 React Native 어댑터는 자신의 host
패키지를 직접 import해서는 안 된다 — 호출부가 host transport를 주입한다. 이렇게
유지하면 생성 클라이언트 코드의 재사용성이 보존되고, 네이티브/런타임 선택이
커맨드 계약 밖에 머문다.

## 동일 코드 요구사항

host 예제는 동일한 커맨드 표면을 사용해야 한다:

- 동일한 Rust 커맨드 패키지가 커맨드 등록과 디스패치를 소유한다.
- 동일한 생성 TypeScript 커맨드 헬퍼를 host 앱 코드가 import한다.
- host별 JavaScript 차이는 어느 어댑터가 `EngineClient`를 만드는지뿐이다.
- host별 네이티브/런타임 차이는 그 어댑터 transport가 Rust에 도달하는 방식뿐이다.

계산기 예제에서 공유 경로는 `addNumbers({ a, b })`다. 생성 플랫폼 진입점이 lazy
엔진 설치를 소유하며, 수동 `configure(engine)`은 명시적 오버라이드일 뿐이다.
Node, Bun, Tauri는 생성 헬퍼나 `rustra` 패키지 디스패치를 우회하는 앱 로컬
계산기 로직을 별도로 두어서는 안 된다.

React Native는 두 fixture 모두에서 동일한 JavaScript 경로를 따르며,
`@rustra/generated-react-native`(공유 C++ JSI 브릿지 + 생성 postcard 코덱)로
디스패치한다.

## 런타임 수용 게이트

host를 "실제로 동작한다"고 부르기 전의 협상 불가능한 게이트다:

| Host         | 통과 조건                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node         | Node 앱이 생성 TypeScript 헬퍼를 호출하고, 헬퍼가 `@rustra/node`를 호출하고, 어댑터가 기대한 JSON 결과를 반환하는 Rust 프로세스를 호출한다.                                        |
| Bun          | Bun 앱이 생성 TypeScript 헬퍼를 호출하고, 헬퍼가 `@rustra/bun`을 호출하고, 어댑터가 기대한 JSON 결과를 반환하는 Rust 프로세스를 호출한다.                                          |
| Tauri        | Tauri 앱이 빌드·실행되고, WebView JavaScript가 `@rustra/tauri`를 통해 생성 `addNumbers` 헬퍼를 호출하며, Rust 커맨드 핸들러가 공유 `rustra` 패키지를 `Package::invoke`로 호출한다. |
| React Native | React Native 앱이 시뮬레이터/디바이스에서 실행되고, JavaScript가 생성 TypeScript 헬퍼를 호출하고, 네이티브 모듈이 Rust 코드를 호출하며, UI 또는 프로브가 Rust 결과를 관측한다.     |

host가 통과 조건에 도달하기 전까지 문서와 스크립트는 이를 어댑터 또는 번들
검사라고 불러야 하며, 런타임 통과라고 부르면 안 된다.
