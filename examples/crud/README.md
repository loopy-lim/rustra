# CRUD 예제

rustra-bridge를 사용한 전체 CRUD(Create, Read, Update, Delete) 패턴 예제입니다.

## 명령어

| 명령어 | 입력 | 출력 |
|--------|------|------|
| `createItem` | `{ name, value }` | `{ item }` |
| `getItem` | `{ id }` | `{ item }` |
| `listItems` | `{ minValue? }` | `{ items }` |
| `updateItem` | `{ id, name?, value? }` | `{ item }` |
| `deleteItem` | `{ id }` | `{ deleted }` |

## 빌드

```sh
cargo build -p rustra-crud-example
```

## TypeScript 코드 생성

```sh
cargo run -p rustra-crud-example --bin generate
```

`examples/crud/generated/`에 생성됨:
- `schema.json` — 모든 명령어의 JSON Schema
- `types.ts` — TypeScript 타입 정의
- `commands.ts` — 타입 안전 명령어 헬퍼 함수
- `contract.ts` — 호환성 검사용 contract hash

## 테스트

```sh
npx tsc -p examples/crud/tsconfig.json
node --test dist-ts/examples/crud/ts/crud-operations.test.js
```

## TypeScript에서 사용

```typescript
import { createItem, getItem, listItems } from './generated/commands.js';

const engine = /* EngineClient */;
const { item } = await createItem(engine, { name: 'Widget', value: 42 });
const result = await getItem(engine, { id: item.id });
```
