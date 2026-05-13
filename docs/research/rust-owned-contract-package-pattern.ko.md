# Rust-owned Contract Package Pattern

상태: 다음 폴더에서 구현할 패키지 구조 제안. 이 문서는 RN만을 위한 native module이 아니라, Rust local engine을 RN, Node, Tauri/Electron 등 여러 host에 이식하기 위한 contract/codegen 패턴을 정의한다.

## 목표

TypeScript가 API를 먼저 정하고 각 native 구현체가 따라가는 구조를 피한다. Rust가 command/type/error/resource contract의 source of truth가 되고, 사용하는 쪽은 generated SDK를 받는다.

```txt
Rust source
  -> schema/registry export
  -> generated TypeScript types
  -> generated TypeScript command client
  -> host adapters: RN, Node, Tauri, Electron
```

## 핵심 원칙

| 원칙 | 설명 |
| --- | --- |
| Rust owns contract | command name, input, output, error, attachment metadata는 Rust에서 정의 |
| one public invoke | 사용자는 `invoke(command, args)` 또는 generated command function만 사용 |
| host adapter is dumb | RN/Node/Tauri adapter는 transport만 담당 |
| generated SDK is host-agnostic | generated command client는 RN/Node를 몰라야 함 |
| binary/file/resource are data plane | JSON은 control plane, 큰 데이터는 attachment/file/resource |
| batching first | micro-call 최적화보다 coarse command와 batch 설계 우선 |

## Package Boundary

```txt
crates/
  engine-core/
  engine-contract/
  engine-codegen/
  engine-rn/
  engine-node/

packages/
  client/
  react-native/
  node/

generated/
  types.ts
  commands.ts
  schema.json
```

### `engine-core`

순수 Rust domain logic이다. RN, Node, Tauri를 모른다.

책임:

| 책임 | 예시 |
| --- | --- |
| command implementation | `document_search`, `media_probe`, `state_increment` |
| state/storage ownership | in-memory state, SQLite, file index |
| domain validation | command-level validation |
| binary/file 처리 | bytes transform, file read/write |

금지:

```txt
Expo, Swift, N-API, Tauri type import
host-specific path normalization
JS-specific error shape 직접 생성
```

### `engine-contract`

host와 core 사이의 stable protocol이다.

책임:

| 책임 | 예시 |
| --- | --- |
| command registry | command name -> handler metadata |
| envelope | request/response/error format |
| attachment model | bytes/file/resource input/output |
| schema export | JSON Schema, contract hash |
| versioning | engine version, contract version |

추천 envelope:

```rust
pub struct EngineRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
    pub attachments: Vec<AttachmentMeta>,
}

pub struct EngineResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<EngineError>,
    pub attachments: Vec<AttachmentMeta>,
}
```

초기 PoC에서는 attachment 1개만 지원해도 된다. 단, contract는 N개로 확장 가능하게 설계한다.

### `engine-codegen`

Rust contract에서 host SDK를 만든다.

초기 생성물:

| 생성물 | 역할 |
| --- | --- |
| `schema.json` | command/type schema snapshot |
| `types.ts` | Rust input/output type의 TS 변환 |
| `commands.ts` | typed command helper |
| `contract.ts` | contract version/hash |

생성 예:

```ts
export function documentSearch(engine: EngineClient, input: DocumentSearchInput) {
  return engine.invoke<DocumentSearchOutput>("document.search", input);
}
```

중요: generated command는 `EngineClient` interface만 의존한다.

```ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

### `packages/client`

host-agnostic TypeScript runtime이다.

책임:

| 책임 | 예시 |
| --- | --- |
| `createEngine(adapter)` | adapter를 받아 공통 client 생성 |
| attachment detection | `Uint8Array`, file/resource marker 감지 |
| request envelope 생성 | id, method, params, attachments |
| response decode | JSON result, bytes result, error throw |
| contract check | version/hash mismatch 감지 |

형태:

```ts
export type EngineAdapter = {
  invokeJson(payload: string): Promise<string>;
  invokeBinary?(payload: string, bytes: Uint8Array): Promise<Uint8Array>;
  status?(): Promise<EngineStatus>;
};

export function createEngine(adapter: EngineAdapter): EngineClient {
  // hidden routing
}
```

### `packages/react-native`

Expo Module 또는 RN native module adapter다.

책임:

| 책임 | 예시 |
| --- | --- |
| Swift/Kotlin FFI binding | Rust static/dynamic lib 호출 |
| `invokeJson` 구현 | string -> string |
| `invokeBinary` 구현 | string + bytes -> bytes |
| lifecycle | start/status/stop |
| platform packaging | podspec, Gradle, autolinking |

public API:

```ts
export function createEngine() {
  return createCoreEngine(reactNativeAdapter());
}
```

### `packages/node`

Node adapter다. `napi-rs`를 우선 고려한다.

책임:

| 책임 | 예시 |
| --- | --- |
| N-API binding | Rust engine call |
| `invokeJson` 구현 | string -> string |
| `invokeBinary` 구현 | Buffer/Uint8Array -> Buffer |
| Node packaging | prebuild, platform binary |
| Node benchmark | same generated client로 측정 |

public API:

```ts
export function createEngine() {
  return createCoreEngine(nodeAdapter());
}
```

## Command Definition Pattern

초기에는 macro 없이 명시 registry로 시작해도 된다. macro는 중복이 실제로 아프기 시작한 뒤 도입한다.

### Option A: 명시 registry 우선

```rust
pub fn register_commands(registry: &mut CommandRegistry) {
    registry.command::<DocumentSearchInput, DocumentSearchOutput>(
        "document.search",
        document_search,
    );
}
```

장점:

| 장점 | 설명 |
| --- | --- |
| 디버깅 쉬움 | macro expansion을 볼 필요 없음 |
| 초기 구현 빠름 | codegen 난이도 낮음 |
| 명시적 | command 목록이 잘 보임 |

단점:

| 단점 | 설명 |
| --- | --- |
| boilerplate | command가 많아지면 반복 |
| name drift 가능 | 함수명과 command name이 분리됨 |

### Option B: attribute macro

```rust
#[engine_command(name = "document.search")]
pub async fn document_search(input: DocumentSearchInput) -> EngineResult<DocumentSearchOutput> {
    // implementation
}
```

장점:

| 장점 | 설명 |
| --- | --- |
| command 선언 밀도 높음 | 함수 옆에 contract가 붙음 |
| codegen 자동화 쉬움 | registry/schema 추출 자동화 |
| drift 감소 | type/function/name 묶임 |

단점:

| 단점 | 설명 |
| --- | --- |
| macro 유지비 | proc macro가 별도 복잡도 |
| 에러 메시지 | 초기에 디버깅이 불편할 수 있음 |

추천: 새 폴더의 첫 버전은 Option A로 시작하고, command가 10개 이상이 되면 Option B를 도입한다.

## Type Export Strategy

추천 Rust derive:

```rust
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct DocumentSearchInput {
    pub query: String,
    pub limit: u32,
}
```

후보 도구:

| 도구 | 용도 | 판단 |
| --- | --- | --- |
| `serde` | runtime JSON serialize/deserialize | 필수 |
| `schemars` | JSON Schema export | 우선 후보 |
| `ts-rs` | Rust type -> TS 생성 | 후보, command registry와 함께 검토 |
| custom generator | command client까지 통합 생성 | 장기적으로 필요 |

초기 추천은 `schemars`로 schema를 안정적으로 뽑고, TS client generator는 작게 직접 만든다. 이유는 command helper까지 생성하려면 결국 command registry metadata가 필요하기 때문이다.

## Data Plane Contract

JSON은 control plane이다.

```ts
await engine.invoke("image.thumbnail", {
  width: 512,
  input: imageBytes,
});
```

wrapper가 내부 envelope로 바꾼다.

```json
{
  "id": "image.thumbnail-...",
  "method": "image.thumbnail",
  "params": {
    "width": 512,
    "input": {
      "type": "bytes",
      "attachmentIndex": 0,
      "length": 262144
    }
  }
}
```

파일은 bytes로 복사하지 않는다.

```ts
await engine.invoke("video.probe", {
  input: { type: "file", uri: "file:///..." },
});
```

resource handle은 장기 작업이나 cache에 쓴다.

```ts
const resource = await engine.invoke<{ id: string }>("model.load", {
  uri: "file:///model.bin",
});

await engine.invoke("model.run", {
  model: { type: "resource", id: resource.id },
  input,
});
```

## Error Model

host별 error가 다르면 generated SDK가 깨진다. Rust contract에서 error shape를 고정한다.

```rust
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub recoverable: bool,
}
```

TS:

```ts
export class EngineCommandError extends Error {
  code: string;
  details?: unknown;
  recoverable: boolean;
}
```

권장 code:

| Code | 의미 |
| --- | --- |
| `command.not_found` | command registry에 없음 |
| `command.invalid_args` | params deserialize 실패 |
| `engine.not_started` | lifecycle 문제 |
| `attachment.missing` | bytes/file/resource 입력 없음 |
| `resource.not_found` | resource id 만료/없음 |
| `internal` | 알 수 없는 Rust 내부 오류 |

## Versioning

contract drift를 막기 위해 engine status에 아래 필드를 포함한다.

```ts
type EngineStatus = {
  engineVersion: string;
  contractVersion: string;
  contractHash: string;
  host: "react-native" | "node" | "tauri";
};
```

client startup에서 generated contract hash와 runtime hash를 비교한다.

```ts
await engine.assertCompatibleContract(GENERATED_CONTRACT_HASH);
```

## Benchmark Contract

새 repo에서도 같은 benchmark를 유지한다.

공통 benchmark:

| Benchmark | 목적 |
| --- | --- |
| `bench.addNumbers` 1K sequential | boundary overhead |
| `bench.addNumbers` 1K burst c10 | Promise/concurrency behavior |
| `bench.addNumbersLoop` 100K | Rust-owned coarse work |
| `binary.echo` 256KB | bytes pass-through |
| `binary.checksum` 1MB | media-probe-like input |
| `document.applyOps` batch | real app style batch |
| `file.probe` with file URI | large asset path |

Host별로 같은 generated command client를 사용해야 한다.

```txt
RN benchmark:
generated commands -> @local-engine/react-native

Node benchmark:
generated commands -> @local-engine/node
```

## Migration From This PoC

현재 PoC에서 가져갈 것:

| 파일/개념 | 새 위치 |
| --- | --- |
| `RustEngineClient.ts`의 single invoke wrapper | `packages/client` |
| `invokeBinary(commandJson, bytes)` 아이디어 | adapter interface |
| Rust `dispatch_rpc` command match | `engine-core` command registry |
| Rust binary dispatcher | `engine-contract` attachment model + command handler |
| benchmark UI/metrics | `benchmarks/react-native` |
| JSONL collector | `benchmarks/tools` |

현재 PoC에서 버릴 것:

| 항목 | 이유 |
| --- | --- |
| localhost HTTP as main mobile path | 너무 느림 |
| public `invokeBinary` 노출 | DX 손상 |
| Protobuf-first design | 이번 실험에서 tiny-call 이득 없음 |
| command를 TS에서 먼저 정의 | Rust-owned contract 목표와 반대 |
| RN-specific type in core | Node/Tauri 이식성 손상 |

## Implementation Order

1. `engine-contract`에 envelope/error/attachment/status 타입을 만든다.
2. `engine-core`에 `CommandRegistry`와 3개 benchmark command를 만든다.
3. `engine-codegen`에 schema export와 TS command generator를 만든다.
4. `packages/client`에 host-agnostic `createEngine(adapter)`를 만든다.
5. `packages/node`를 `napi-rs`로 먼저 붙인다.
6. Node에서 generated client benchmark를 돌린다.
7. `packages/react-native`에 현재 Expo Module adapter를 옮긴다.
8. iOS에서 Run 7과 같은 benchmark를 재실행한다.
9. file/resource handle command를 추가한다.
10. Release build와 physical device에서 다시 측정한다.

## Decision Checklist

새 구현 중 판단이 흔들릴 때 이 체크리스트를 본다.

| 질문 | 맞는 답 |
| --- | --- |
| 이 타입의 원본은 어디인가? | Rust |
| 사용자가 transport를 골라야 하는가? | 아니오 |
| generated command가 RN을 import하는가? | 아니오 |
| core가 Node/RN/Tauri를 아는가? | 아니오 |
| 큰 파일을 bytes로 넘기는가? | 아니오, file/resource handle |
| 고빈도 loop가 JS에서 native를 반복 호출하는가? | 아니오, batch/coarse command |
| benchmark가 desktop curl인가? | 아니오, host 내부 측정 |

## Open Questions

| 질문 | 초기 답 |
| --- | --- |
| macro를 바로 쓸까? | 아니오, 명시 registry 먼저 |
| Protobuf를 버릴까? | 버리지는 말고 후순위로 둔다 |
| Node adapter를 먼저 할까 RN adapter를 먼저 할까? | package pattern 검증은 Node가 더 빠르다 |
| RN은 Expo Module을 계속 쓸까? | 현재 성능상 충분하다 |
| JSI hot path가 필요한가? | 지금은 아니다. profiling 후 극소수 command에만 검토 |

