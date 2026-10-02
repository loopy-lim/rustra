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

type TauriEngineOptions = {
  invoke?: TauriInvoke;
  contractHash?: string;
  contractVerification?: 'strict' | 'warn' | 'off';
};

function createTauriEngine(options?: TauriEngineOptions): EngineClientWithBatch;
```

### hot-core 스왑 이벤트 (실험적)

`subscribeHotSwap`는 예약 채널 `rustra://hot-core/swapped`를 구독한다 — Rust 쪽이
`tauri_support::register_dispatch_with_swap_events`(hot-core dylib 루프)로 등록했을 때만
발생하며, 정적 등록 아래에서는 채널이 침묵한다.

```ts
type HotSwapEvent = { oldContractHash: string; newContractHash: string } | { error: string };

function subscribeHotSwap(
  callback: (event: HotSwapEvent) => void,
  listen?: TauriListen,
  options?: TauriEventOptions,
): Promise<() => void>;
```

성공 페이로드에는 이전과 새 contract hash가 둘 다 실려 있어 캐시 재동기화 신호를 겸할
수 있다: 해시를 비교해 스키마 의존 캐시를 다시 가져올지 정한다. 실패는 버려지지 않고
보고된다. 예약 채널 규칙은
[events-and-channels](../../docs/events-and-channels.ko.md)를 참고한다.

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

기존 Tauri 네이티브 명령이 있는 앱은 프로덕션 등록을
`tauri_support::with_app_commands(builder, tauri::generate_handler![greet])`로
감싸면 두 핸들러가 결합되고 Rustra 예약 엔드포인트, 상태, 이벤트, 채널도
유지됩니다. Tauri의 `.invoke_handler()`는 이전 핸들러를 교체합니다.
[기존 앱 설정 예제](../../docs/extending/tauri-setup.ko.md)를 참고하세요.

실제 WebView IPC 예제와 Release 성능 영수증은
[`tauri-calculator`](../../examples/tauri-calculator/)에 있습니다. 2026-08-24 macOS
arm64 실측은 평균 279.04µs, p50 300µs였으며, Rust 직접 호출 스모크가 아니라 숨은
WKWebView에서 생성된 `addNumbers`를 3,000회 호출한 값입니다.

## 채널 소유권과 수명

JS가 생성하는 Tauri 채널은 발급한 물리 WebView에 귀속된 네이티브
`Channel<InvokeResponseBody>`를 사용한다. `close()`는 네이티브 lease를 해제하고
JS 콜백을 정리하며, 페이지 이동·파괴·앱 종료에서도 소유자의 자원을 정리한다.
`ipc-channel-chunks-v1` handshake는 기존 브로드캐스트 네이티브를 거부하므로
`@rustra/tauri`와 Rust를 함께 갱신하고 다시 빌드해야 한다. 전역 설정에는
`core.Channel`과 Tauri 콜백 정리 API가 필요하다. 전역 API를 쓰지 않으면 `invoke`와
함께 `{ value, dispose() }`를 반환하는 `createIpcChannel(onMessage)` 팩터리를
명시한다. `listen`만 전달해서는 채널을 생성할 수 없다.

원시 조각은 최대 968바이트로 Tauri의 직접 IPC 임계값 1,024바이트보다 작다.
네이티브 메시지 한도는 런타임 페이로드 한도와 16 MiB 중 작은 값이다. 코어의 기본
페이로드 한도는 **1 MiB**이므로, 설정을 바꾸지 않은 네이티브 경로의 실제 한도도
1 MiB다. JS 재조립의 상한은 16 MiB이며 미완성 메시지는 30초 후 만료한다. JSON은 최종 재조립 후 한 번만
해석하여 JSON 문자열도 문자열로 보존하며, 바이너리 콜백에는 `Uint8Array`를 전달한다.
일반 이벤트 구독은 브로드캐스트를 유지한다. 신뢰된 Rust 호스트의
`create_channel_for`/`create_bytes_channel_for` 헬퍼도 명시적으로 앱 전체에 전달한다.
소유권 프로토콜은 Mock IPC와 JS 테스트로 검사했으며, 물리 WebView 종료는 각 대상의
네이티브 GUI 검증이 별도로 필요하다.

Rust `tauri` 기능은 현재 Tauri 2.11.5에 고정돼 있다. 전용 조각 전송은 이 버전의 직접 IPC 전달 상한을 기준으로 검증했다. 의존성을 변경할 때는 네이티브·JS 채널 경계를 검토하고 관련 테스트를 다시 실행해야 한다. 다른 Tauri 버전을 정확히 요구하는 앱은 먼저 이 호환 조건을 해결해야 한다.

Tauri 이벤트 페이로드는 이미 해석된 값이다. `'{"a":1}'`이나 `'"quoted"'`처럼
JSON 모양의 문자열도 그대로 보존한다. 직렬화된 JSON 문자열을 공급하는 사용자
정의 레거시 `listen` 전송만 네 번째 인자를 명시한다:
`subscribeEvent(name, callback, listen, { payloadEncoding: 'serialized-json' })`.
`subscribeTauriEvent`와 `subscribeHotSwap`도 같은 옵션을 지원한다.

Rust 등록 헬퍼는 단건·배치·프로파일 명령의 실행을 Tauri 블로킹 풀로 넘긴다.
오래 걸리는 동기 핸들러와 Rustra의 블로킹 async 실행기가 WebView IPC 스레드를
점유하지 않는다. 와이어 명령 이름·결과 구조·배치 순서와 공개 동기 Rust 헬퍼의
시그니처는 유지한다. 응답성 개선을 검증했으며, 위 과거 지연 측정값과 비교하려면
새 WebView 측정이 필요하다.

생성 Tauri 엔트리는 `GENERATED_CONTRACT_HASH`를 네이티브 `rustra_contract_hash`
엔드포인트로 검증하며 기본 정책은 strict다. `bootstrap.ready()`는 검증 완료를
기다리고, 불일치는 명령 실행 전에 `contract.mismatch`로 실패한다. 구형 등록이나
`contract_hash()`가 없는 사용자 정의 `JsonDispatch`는 `contract.unenforceable`로
실패하므로 Rust 재빌드와 TypeScript 재생성을 함께 수행한다. 의도적 호환·축소 운용은
`contractVerification: 'warn'` 또는 `'off'`로 명시한다. `contractHash`가 없는 수동
엔진은 기존 검증 없는 경로를 유지한다. Hot-core 등록은 선택된 dylib의 생산자 해시를
조회하며, 스왑은 기존 계약 게이트를 따른다.
