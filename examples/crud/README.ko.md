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
import { createItem, rustra } from './generated/node.js';

const { item } = await createItem({ name: 'Widget', value: 42 });
console.log(item.id, item.name, item.value);

rustra.dispose(); // 엔진 서브프로세스 정리
```

전제: `cargo build -p rustra-crud-example` — 엔트리는 `target/release/` 를 먼저,
그다음 `target/debug/` 를 찾는다.

**transport 주의(원샷)**: 생성 Node 엔트리는 invoke 마다 stdio 바이너리를 새로
띄운다 — 호출마다 별도 프로세스에서 실행되므로, 이 예제의 메모리 Rust 스토어는
이 transport 에서 호출 간 유지되지 않는다. 상태를 가진 전체 흐름(create → get →
update → delete)은 Rust 데모(`cargo run -p rustra-crud-example --bin rustra-crud-example`)가 한 프로세스에서
실행하고, [`ts/crud-operations.test.ts`](ts/crud-operations.test.ts) 가 상태를 가진
mock 엔진으로 검증한다. 상시 프로세스는 calculator 의 loop transport
([`node-performance.ts`](../calculator/apps/node-performance.ts)) 를 참고한다.
