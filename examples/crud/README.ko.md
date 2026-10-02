# CRUD 예제

rustra-bridge를 사용한 전체 CRUD(Create, Read, Update, Delete) 패턴 예제입니다.

## 명령어

| 명령어       | 입력                    | 출력          |
| ------------ | ----------------------- | ------------- |
| `createItem` | `{ name, value }`       | `{ item }`    |
| `getItem`    | `{ id }`                | `{ item }`    |
| `listItems`  | `{ minValue? }`         | `{ items }`   |
| `updateItem` | `{ id, name?, value? }` | `{ item }`    |
| `deleteItem` | `{ id }`                | `{ deleted }` |

## 빌드

```sh
cargo build -p rustra-crud-example
```

## TypeScript 코드 생성

```sh
bun run --cwd examples/crud codegen   # Rust 스키마 프로브 + TS 렌더링 + 호스트 엔트리 한 번에
# 또는 이 디렉터리에서: bun run codegen
```

`examples/crud/generated/`에 생성됨:

- `schema.json` — 모든 명령어의 JSON Schema (Rust 프로브가 발행)
- `types.ts` — TypeScript 타입 정의 (`rustra codegen` 이 렌더링)
- `commands.ts` — 타입 안전 명령어 헬퍼 함수
- `contract.ts` — 호환성 검사용 contract hash
- `node.ts` — 생성된 Node 호스트 엔트리(부트스트랩 + 엔진 셋업), `rustra.json` 의 `node` 키로 켠다

## 테스트

```sh
bunx tsc -p examples/crud/tsconfig.json
node --test dist-ts/examples/crud/ts/crud-operations.test.js
```

## TypeScript에서 사용

`rustra.json` 의 `node` 호스트가 `node.ts` 를 생성한다. 이 엔트리가 엔진을
부트스트랩하고(strict 계약 검증, release/debug 바이너리 후보 해상) lazy 하게
설치하므로, 생성 명령은 엔진 파라미터 없이 입력 객체 하나만 받는다 —
calculator 예제와 동일한 형태다:

```ts
import { createItem, getItem, rustra } from './generated/node.js';

const { item } = await createItem({ name: 'Widget', value: 42 });
console.log(item.id, item.name, item.value);
console.log((await getItem({ id: item.id })).item);

rustra.dispose(); // 엔진 서브프로세스 정리
```

전제: `cargo build -p rustra-crud-example` — 엔트리는 `target/release/` 를 먼저,
그다음 `target/debug/` 를 찾는다.

이 예제의 `node.persistent: true` 설정은 명령마다 같은 Rust 프로세스를 사용한다.
따라서 `create → get → update → delete` 동안 메모리 스토어가 유지된다.
바이너리는 NDJSON `serve` 프로토콜을 구현한다. 서버 플래그가 다르면
`node.args`로 지정한다. 앱을 종료할 때 `rustra.dispose()`로 프로세스를 정리한다.
이 옵션이 없고 이벤트도 없는 스키마는 기존 원샷 `invoke` 프로토콜을 사용한다.

저장소 루트에서 `bun run test:runtime:crud`로 실제 생성 Node 소비자를 실행한다.
