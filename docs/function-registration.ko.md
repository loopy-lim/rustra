[English](./function-registration.md) | 한국어

# 일반 Rust 함수 등록

미발행 기능입니다. 현재 개발 소스에서 사용할 수 있으며, 클라이언트를 생성하고
실행할 때 Rust·CLI·런타임 패키지를 같은 변경이 반영된 버전으로 맞춰야 합니다.

`PackageBuilder::function`은 인자 0~12개를 받는 안전한 동기 Rust 함수나 클로저를
등록합니다. Rustra 매크로, 입력·출력 래퍼 구조체, `Result` 반환을 요구하지 않습니다.

```rust
use rustra::{Package, RustraError};

fn add(a: i32, b: i32) -> i32 { a + b }
fn reset() {}

enum ReadError { Missing }
fn read(id: u32) -> Result<String, ReadError> {
    if id == 7 { Ok("hello".into()) } else { Err(ReadError::Missing) }
}

let package = Package::builder("app.functions")
    .function("add", add)
    .function("reset", reset)
    .try_function("read", read, |_| RustraError::custom("read.missing", "not found"))
    .build();

assert_eq!(package.invoke_json("add", serde_json::json!([2, 3])).unwrap(), serde_json::json!(5));
```

기존 방식대로 코드 생성과 호스트 설정을 마치면, 생성된 함수를 바로 호출합니다.

```ts
import { add, reset, read } from './generated/commands.js';

const total: number = await add(2, 3);
await reset(); // Promise<void>
const message: string = await read(7, { timeoutMs: 1000 });
```

## 인자와 반환값

- 인자 타입은 `DeserializeOwned + JsonSchema + 'static`, 반환 타입은
  `Serialize + JsonSchema + 'static`이어야 합니다. 사용자 정의 구조체는 Serde와
  Schemars의 derive를 사용할 수 있습니다. 핸들러와 오류 변환 클로저에는
  `Send + Sync + 'static`이 필요합니다.
- 숫자·문자열·튜플·구조체·지원하는 컬렉션은 원래 반환 형태를 유지합니다.
  `fn reset() {}`는 반환 타입을 적지 않아도 되며 TypeScript에서는 `undefined`가
  됩니다. `Option<T>`는 `T | null`로 표현됩니다.
- 생성되는 인자 이름은 `arg0`, `arg1` 등입니다. Rust의 `Fn` 트레잇에서는 원본
  인자 이름을 읽을 수 없습니다. 각 인자의 타입은 유지되며, 선택적인
  `InvokeOptions`는 항상 마지막에 옵니다.
- 튜플 하나를 받는 함수는 TypeScript에서도 튜플 하나를 받습니다.
  `fn pair(value: (i32, String))`는 `pair(arg0, options?)`,
  `fn pair(a: i32, b: String)`는 `pair(arg0, arg1, options?)`로 생성됩니다.
- 하위 JSON API에서는 인자를 순서대로 배열에 넣습니다. 인자가 없으면 `null`,
  unit 타입의 인자는 해당 위치에 `null`을 전달합니다.
- 등록 이름은 명시합니다. 기존 `.command`, `.command_fn`, `#[command]`, 메타데이터
  빌더 API도 사용할 수 있습니다. 비동기 함수와 자동 상태 주입은 기존 command
  매크로를 사용합니다.

## 실패할 수 있는 함수

`try_function(name, handler, map_error)`로 등록하면 `Result<T, E>`의 오류를
TypeScript promise의 rejection으로 전달합니다. 도메인 오류 `E`에 직렬화나
문자열 변환을 구현할 필요는 없습니다. 변환 함수에서 공개할 `RustraError` 코드와
메시지를 정합니다. TypeScript에서는 안정적인 오류 코드를 기준으로 처리합니다.

`function`은 `Result`를 자동으로 풀지 않습니다. 직렬화 가능한 `Result`는 일반
데이터로 반환합니다. 등록 방식을 명시하면 타입 추론의 모호함을 피할 수 있습니다.

## 바이너리 실행

지원하는 인자 튜플과 반환값은 타입을 유지한 채 바이너리 코덱으로 처리합니다.
고정 길이 튜플은 길이 접두사 없이 값을 순서대로 기록합니다. 스칼라 튜플에는
커서 기반 인코더와 요청 버퍼 재사용을 적용합니다. Rust의 스칼라 함수가 호출자가
준 버퍼에 성공 응답을 기록할 때는 JSON 트리 변환과 응답 힙 할당을 생략합니다.

전체 앱에서 할당이 없다는 의미는 아닙니다. 소유하는 문자열·컬렉션은 할당할 수
있고, JavaScript에서 정확한 크기의 요청 버퍼를 복사할 수 있습니다. 응답 버퍼가
작으면 별도 응답을 할당합니다. 미지원 스키마는 기존 complex 또는 JSON 경로를
유지합니다.

React Native에서는 네이티브 정적 코덱이 해당 최상위 형태를 지원하지 않으면 생성된
JavaScript 바이너리 코덱을 사용합니다. 새 함수 명령에는 네이티브 스칼라
raw/positional 단축 경로를 연결하지 않습니다. Rust 마이크로벤치마크만으로
React Native의 속도나 실기기 실행을 검증했다고 볼 수 없습니다.

## 검증

```sh
bun run test:functions
cargo test -p rustra --test function_allocations
cargo bench -p rustra --bench function_dispatch
```

통합 테스트는 실제 Rust fixture에서 클라이언트를 생성하고, 양쪽 공개 생성기의
타입을 검사한 뒤 요청을 Rust 프로세스로 보냅니다. 정적·라이브 스키마 호출,
네이티브 capability 폴백, 오류, 반환값 없음, 비유한 숫자, 작은 응답 버퍼를
검증합니다.
