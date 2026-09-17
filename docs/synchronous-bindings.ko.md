[English](./synchronous-bindings.md) | 한국어

# 동기 명령 바인딩

`bindSync<I, O>(command)`는 일반적인 동기 함수를 반환한다. 바인딩하기 전에 엔진을 구성하고 초기화를 완료한다.

```ts
import { bindSync } from '@rustra/types';
import { rustra } from './generated/react-native.js';
import type { AddNumbersInput, AddNumbersOutput } from './generated/types.js';

await rustra.ready();
const add = bindSync<AddNumbersInput, AddNumbersOutput>('addNumbers');
const result = add({ a: 20, b: 22 });
```

기존 생성 명령 함수는 계속 Promise를 반환하며 취소·타임아웃 옵션을 유지한다. 동기 바인딩은 입력만 받으며 명령 오류를 동기적으로 던진다.

최초 지원 호스트는 원자적 네이티브 바인딩 팩토리를 갖춘 React Native JSI다. 생성된 정적 네이티브 codec, 컴파일된 네이티브 codec·JS·Rust 코어 간 정확한 계약 일치, 동결된 네이티브 레지스트리가 필요하다. Release 패키지는 자동으로 동결되며, 명시적으로 동결한 개발 패키지도 사용할 수 있다. 비동기 transport, 네이티브 지원 누락, 이전 메타데이터, 실행 종류가 명시되지 않은 명령, async 명령은 `sync.unavailable` 오류를 던진다. 생성된 명령 목록에 없는 이름은 `command.not_found` 오류를 던진다. 호출자가 동기 실행 자격을 강제로 선언하는 옵션은 없다. 타입 매개변수는 컴파일 시점의 타입을 제공하며 네이티브 계약 검증을 대신하지 않는다.

Rust의 `register!`와 `build!`는 `async fn` 래퍼를 포함해 원래 `#[command]` 함수의 실행 종류를 보존한다. 기존 `.command(...)`, `.command_fn(...)`, 버퍼 등록은 producer가 `.command_execution(name, CommandExecution::Sync)` 또는 `Async`를 제공하지 않으면 실행 종류가 unknown으로 남는다. producer의 실제 동작을 선언해야 하며, async 매크로 어댑터는 반드시 Async를 유지해야 한다. 이 메타데이터는 생성 계약 해시를 변경하므로 TS와 네이티브 산출물을 함께 다시 생성한다. 명령 ID, 요청·응답 바이트, FFI 함수 시그니처는 바뀌지 않는다.

바인딩은 전역 엔진 교체와 dispose를 감지한다. 각 네이티브 호출은 하나의 불변 코어 테이블을 캡처한다. hot-core 교체는 다음 호출 전에 다시 검증하며, 이미 진행 중인 호출은 인코딩, 디스패치, 응답 버퍼 초과 처리, 소유 버퍼 해제까지 캡처한 테이블을 유지한다. 계약이 변경됐거나 레지스트리가 동결되지 않았거나 명령이 동기 실행이 아니면 핸들러 실행 전에 거부한다. JS 메타데이터를 변경된 Rust 코어에 맞추더라도 오래된 컴파일 codec 검증을 우회할 수 없으므로 네이티브 codec도 다시 빌드해야 한다. 컴파일된 codec 식별 정보가 없는 이전 생성 C++는 기존 API의 컴파일과 Promise 동작을 유지하지만, 새 바인딩은 검증 조건을 충족하지 못하므로 거부된다. 동결된 레지스트리는 하나의 코어 안에서 스키마 세대가 바뀔 수 없고 Rust FFI 등록은 최초 등록이 유지된다. 따라서 네이티브 코어 식별 정보가 별도의 JS→네이티브 세대 조회 없이 호출마다 수명을 보호한다.

네이티브 페이로드 한도와 호출별 새 출력의 소유권은 유지된다. 기존 typed 경로와 마찬가지로 `FrameEngineOptions.maxPayloadBytes`는 JS codec의 사전 검사 옵션이며, 엔진별 네이티브 한도를 추가하는 옵션이 아니다. 초기 바인딩 지원에는 네이티브 정적 codec이 필요하며 JS codec 폴백은 사용하지 않는다.

벤치마크 영수증은 `sync-public`, `sync-internal-diagnostic`, `async-public`을 구분한다. 공개 동기 API의 성능은 전체 검증을 포함한 바인딩을 측정해야 하며, 네이티브 진단용 측정값은 공개 API의 결과가 아니다.
