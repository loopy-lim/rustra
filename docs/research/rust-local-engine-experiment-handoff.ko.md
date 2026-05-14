# Rust Local Engine 실험 Handoff

상태: 2026-05-13 기준 iOS PoC 실험 완료. 이 문서는 다른 폴더에서 새 패키지/아키텍처 작업을 시작하기 위한 요약본이다.

## 한 줄 결론

RN에서 Rust local engine을 쓸 때 HTTP/fetch local server는 mobile main path로 너무 비싸다. 대신 Tauri처럼 `invoke(command, args)` 하나를 public API로 두고, 내부에서 JSON command, binary attachment, file/resource handle을 선택하는 구조가 가장 실용적이다.

```ts
await engine.invoke('document.search', { query: 'rust', limit: 20 });
await engine.invoke('image.thumbnail', { input: imageBytes, width: 512 });
await engine.invoke('video.probe', { input: { type: 'file', uri } });
```

## 지금까지 만든 경로

| 경로                               | 목적                                                  | 판단                                                          |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| HTTP/fetch JSON-RPC over localhost | Rust engine을 local server처럼 쓰는 형태 확인         | 동작은 하지만 RN iOS에서 sequential 약 60 calls/s로 너무 느림 |
| Native JSON invoke                 | HTTP/TCP/fetch 제거, Swift FFI로 Rust dispatcher 호출 | 가장 실용적인 기본 경로                                       |
| Native Protobuf invoke             | JSON 제거가 tiny-call 성능에 도움이 되는지 확인       | 작은 command에서는 JSON보다 빠르지 않았음                     |
| JSON command + binary payload      | 이미지/문서 같은 bytes를 base64 없이 넘기는지 확인    | 256KB-1MB급 payload에서 현실성 있음                           |
| Tauri-like single invoke wrapper   | public API를 `invoke(command, args)` 하나로 유지      | DX와 성능 모두 가장 균형 좋음                                 |

## 최종 Run 7 핵심 결과

환경:

| 항목      | 값                            |
| --------- | ----------------------------- |
| 날짜      | 2026-05-13                    |
| Simulator | iPhone 17, iOS 26.2           |
| Build     | Debug simulator               |
| RN        | 0.81.5                        |
| Expo      | 54.0.33 / native pods 54.0.34 |
| JS engine | Hermes                        |
| 측정 위치 | iOS RN 앱 내부                |

핵심 수치:

| Metric                          |                        호출 |     p50 |     p95 |     p99 |  총 시간 |     처리량 |
| ------------------------------- | --------------------------: | ------: | ------: | ------: | -------: | ---------: |
| single invoke JSON `addNumbers` |            1,000 sequential |  0.07ms |  0.10ms |  0.14ms |  78.72ms | 12,703.7/s |
| single invoke JSON `addNumbers` | 1,000 burst, concurrency 10 |  0.26ms |  0.31ms |  0.55ms |  27.73ms | 36,057.0/s |
| Protobuf `addNumbers`           |            1,000 sequential |  0.07ms |  0.08ms |  0.10ms |  82.93ms | 12,058.8/s |
| Protobuf `addNumbers`           | 1,000 burst, concurrency 10 |  0.44ms |  0.51ms |  0.73ms |  45.27ms | 22,091.6/s |
| HTTP/fetch `addNumbers`         |            1,000 sequential | 16.66ms | 17.99ms | 19.78ms |   16.67s |     60.0/s |
| binary echo                     |             256KB, 50 calls |  0.21ms |  0.44ms |  0.65ms |  25.68ms |  1,946.8/s |
| binary invert                   |             256KB, 50 calls |  1.99ms |  2.12ms |  2.41ms | 111.37ms |    448.9/s |
| binary checksum                 |               1MB, 20 calls |  3.60ms |  3.88ms |  3.88ms |  83.22ms |    240.3/s |

중요 비교:

```txt
HTTP/fetch 1K addNumbers sequential: 16,665.71ms
single invoke JSON 1K addNumbers sequential: 78.72ms

16,665.71ms / 78.72ms = about 212x faster
```

Protobuf는 작은 command에서는 이득이 없었다.

```txt
JSON wrapper 1K sequential: 78.72ms
Protobuf 1K sequential: 82.93ms

JSON wrapper 1K burst: 27.73ms
Protobuf 1K burst: 45.27ms
```

## 배운 내용

### 1. HTTP/fetch local server는 mobile main path가 아니다

HTTP/fetch는 RN iOS에서 sequential 약 60 calls/s로 묶였다. p50도 대부분 16.6ms 근처라 frame cadence에 강하게 묶이는 모습이었다.

이 경로는 다음 용도에는 괜찮다.

| 용도                          | 판단            |
| ----------------------------- | --------------- |
| desktop/debug reuse           | 가능            |
| 개발 중 curl/debug endpoint   | 가능            |
| mobile high-frequency command | 부적합          |
| coarse background command     | 제한적으로 가능 |

### 2. Native invoke가 핵심 전환점이다

HTTP/TCP/fetch를 제거하고 Expo Module/Swift FFI로 Rust를 직접 호출하니 1,000 sequential tiny calls가 16.67s에서 78.72ms로 줄었다.

이 결과는 “Rust local engine을 mobile에 넣을 수 있는가”에 대한 가장 중요한 근거다. 서버 모양의 command dispatcher는 유지하되, transport만 in-process로 바꾸면 된다.

### 3. Public API를 나누면 DX가 망가진다

아래처럼 public lane을 나누면 호출부가 transport 정책을 알아야 한다.

```ts
invokeJson('document.search', params);
invokeBinary('image.resize', params, bytes);
invokeHandle('video.probe', uri);
```

대신 public API는 하나여야 한다.

```ts
invoke(command, args);
```

내부에서만 `Uint8Array`, file URI, resource handle을 감지해서 transport를 선택한다.

### 4. Protobuf는 지금 단계의 답이 아니다

Protobuf 자체가 나쁜 것은 아니다. 하지만 이번 PoC의 tiny command에서는 JS manual codec, `Uint8Array`, Swift `Data`, Rust prost 비용이 JSON보다 낫지 않았다.

Protobuf를 다시 볼 조건:

| 조건                                       | 이유                                      |
| ------------------------------------------ | ----------------------------------------- |
| generated codec이 생김                     | manual JS codec 비용 제거                 |
| payload가 크고 schema 안정성이 중요함      | JSON보다 binary schema가 유리해질 수 있음 |
| cross-language strict contract가 더 중요함 | DX보다 protocol stability 우선            |

현재 다음 단계에는 JSON Schema 기반 Rust-owned codegen이 더 맞다.

### 5. Binary는 JSON에 넣지 말고 attachment로 분리한다

이미지/문서/압축 blob은 `Uint8Array` attachment로 실험할 만하다. 256KB echo p50 0.21ms, 1MB checksum p50 3.60ms였다.

하지만 영상 원본처럼 수십 MB급 데이터는 RN boundary를 bytes로 넘기면 안 된다. file URI나 resource handle을 넘기고 Rust가 직접 읽고 쓰는 쪽이 맞다.

### 6. 성능의 핵심은 “더 빠른 micro-call”보다 “coarse command 설계”다

Nitro/Craby는 tiny native method hot path에서 압도적으로 빠르다. 이 PoC는 그 방향으로 이기려는 구조가 아니다.

이 구조의 목표:

```txt
RN UI
  -> invoke("domain.command", args)
  -> Rust owns state/work/batch
  -> small JSON/bytes/file result
```

고빈도 logical operation은 아래처럼 합친다.

```ts
await engine.invoke('document.applyOps', {
  ops: [
    { type: 'insert', blockId: 'a', text: 'hello' },
    { type: 'update', blockId: 'b', text: 'world' },
  ],
});
```

## 새 폴더에서 가져가야 할 목표 구조

목표는 RN native module이 아니라 Rust-owned generated contract runtime이다.

```txt
Rust owns:
  command names
  params types
  result types
  error model
  attachment/file/resource contract

Generated per host:
  TypeScript types
  TypeScript command client
  React Native adapter package
  Node adapter package
  optional Tauri/Electron adapter
```

추천 repo/package 구조:

```txt
crates/
  engine-core/
    commands/
    types/
    state/

  engine-contract/
    command registry
    schema export
    envelope/error/attachment model

  engine-codegen/
    Rust contract -> TS types/client

  engine-rn/
    iOS/Android FFI adapter

  engine-node/
    napi-rs adapter

packages/
  client/
    createEngine(adapter)
    invoke protocol

  react-native/
    Expo Module adapter

  node/
    Node adapter

generated/
  types.ts
  commands.ts
```

## Rust-owned contract 예시

Rust가 원본이다.

```rust
#[engine_command(name = "document.search")]
pub async fn document_search(input: DocumentSearchInput) -> EngineResult<DocumentSearchOutput> {
    // implementation
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct DocumentSearchInput {
    pub query: String,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct DocumentSearchOutput {
    pub items: Vec<DocumentItem>,
}
```

생성되는 TS:

```ts
export type DocumentSearchInput = {
  query: string;
  limit: number;
};

export type DocumentSearchOutput = {
  items: DocumentItem[];
};

export function documentSearch(engine: EngineClient, input: DocumentSearchInput) {
  return engine.invoke<DocumentSearchOutput>('document.search', input);
}
```

RN과 Node는 같은 generated client를 쓴다.

```ts
import { createEngine } from '@local-engine/react-native';
import { documentSearch } from './generated/commands';

const engine = createEngine();
await documentSearch(engine, { query: 'rust', limit: 20 });
```

```ts
import { createEngine } from '@local-engine/node';
import { documentSearch } from './generated/commands';

const engine = createEngine();
await documentSearch(engine, { query: 'rust', limit: 20 });
```

## 반드시 조심할 것

### Public API를 transport별로 나누지 않는다

사용자가 `invokeBinary`를 직접 고르게 만들면 이 실험의 장점이 사라진다. transport 선택은 wrapper/adapter 내부 정책이어야 한다.

### Rust core가 RN을 알면 안 된다

`engine-core`는 RN, Swift, Node, Tauri를 몰라야 한다. host adapter만 boundary를 안다.

```txt
good:
engine-core <- engine-contract <- host adapter

bad:
engine-core imports react-native/expo concepts
```

### generated SDK와 runtime adapter를 분리한다

generated `commands.ts`는 `engine.invoke()`만 알아야 한다. RN/Node/Tauri 구현체를 import하면 이식성이 깨진다.

### file/resource handle을 초기에 설계한다

처음부터 bytes만 설계하면 영상/대형 파일에서 다시 구조를 바꿔야 한다.

최소 contract:

```ts
type EngineInput = Uint8Array | { type: 'file'; uri: string } | { type: 'resource'; id: string };
```

### error model을 먼저 고정한다

host별로 error shape가 달라지면 generated client가 지저분해진다.

추천:

```ts
type EngineError = {
  code: string;
  message: string;
  details?: unknown;
  recoverable?: boolean;
};
```

### command versioning을 넣는다

generated client와 Rust binary 버전이 어긋날 수 있다. 최소한 contract version/hash를 start/status에서 확인해야 한다.

```ts
await engine.status();
// { engineVersion, contractVersion, contractHash }
```

### benchmark는 반드시 앱 내부에서 한다

desktop `curl`은 Rust endpoint가 응답하는지만 보여준다. RN, Hermes, Expo Module, Swift, simulator scheduling 비용을 포함하지 않는다.

## 다음 작업 순서

1. 새 repo/folder에서 `engine-core`, `engine-contract`, `packages/client`부터 만든다.
2. command registry와 envelope/error/attachment 타입을 Rust에서 정의한다.
3. `schemars` 또는 유사 JSON Schema export를 붙인다.
4. TS generator로 `generated/types.ts`, `generated/commands.ts`를 만든다.
5. RN adapter는 현재 PoC의 `RustEngineClient`/Expo Module 구조를 가져간다.
6. Node adapter는 `napi-rs`로 같은 `invoke(command, args)`를 구현한다.
7. 같은 generated client로 RN benchmark와 Node benchmark를 나란히 돌린다.
8. Release build와 실제 iPhone에서 다시 측정한다.

## 참고 문서

| 문서                                                  | 내용                                |
| ----------------------------------------------------- | ----------------------------------- |
| `docs/ios-local-engine-benchmark-notes.md`            | Run 1-7 전체 벤치 기록              |
| `docs/tauri-like-single-invoke-architecture.ko.md`    | single `invoke(command, args)` 구조 |
| `docs/json-command-binary-payload-architecture.ko.md` | binary attachment 설계              |
| `docs/rn-rust-native-bridge-comparison.ko.md`         | Craby/Nitro 공개 수치와 비교        |
| `docs/rust-owned-contract-package-pattern.ko.md`      | 새 패키지화/생성 구조 설계          |

## 최종 판단

새 프로젝트의 기본 전략은 다음이다.

```txt
Rust contract is source of truth.
Generated clients provide DX.
Host adapters only implement invoke transport.
Public execution API stays invoke(command, args).
Binary and file/resource paths are hidden behind args.
Coarse commands beat fine-grained bridge calls.
```
