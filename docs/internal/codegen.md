# TypeScript 코드 생성 파이프라인

프로젝트 기여자를 위한 내부 문서. `Package::generate_typescript()`의 전체 흐름, schema 추출, TS 타입 매핑 규칙, 생성 결과물을 설명한다.

---

## 전체 흐름

```
Package::generate_typescript()
  │
  ├─ 1. self.schema()           → JSON Value (packageId + commands 배열)
  ├─ 2. contract_hash()         → schema.json 문자열 → SHA256 hex
  ├─ 3. self.generate_types_ts() → types.ts 문자열
  ├─ 4. self.generate_commands_ts() → commands.ts 문자열
  │
  └─ GeneratedPackage { schema_json, types_ts, commands_ts, contract_hash }
       │
       └─ write_to_dir() → schema.json, types.ts, commands.ts, contract.ts
```

---

## 1. Schema 추출

### schema_value\<T\>()

`command()` / `command_fn()`으로 command가 등록될 때 호출된다. `schemars`의 `schema_for!()` 매크로를 사용한다.

```rust
fn schema_value<T: JsonSchema>() -> (Value, Value) {
    let schema = schema_for!(T);
    let root = serde_json::to_value(schema.schema).expect("schema serializes");
    let defs = serde_json::to_value(schema.definitions).expect("definitions serialize");
    (root, defs)
}
```

- 첫 번째 반환값: 타입 T의 JSON Schema (object)
- 두 번째 반환값: `$defs`에 해당하는 definitions 객체 (enum 등 공유 타입 포함)
- 여러 command의 definitions는 `PackageBuilder::command()`에서 병합된다 (BTreeMap merge)
- 병합된 definitions는 `generate_types_ts()`에서 `$defs` 블록으로 출력되어 `ts_type_from_schema`의 `$ref` 해석에 사용됨

### short_type_name\<T\>()

`std::any::type_name::<T>()`에서 마지막 `::` 이후 세그먼트를 추출한다.

예: `calculator::AddNumbersInput` → `AddNumbersInput`

---

## 2. TS 타입 매핑 규칙

`ts_type_from_schema(schema: &Value, definitions: &Value)`이 JSON Schema의 `"type"` 필드를 기준으로 TypeScript 타입 문자열을 생성한다. 두 번째 인자 `definitions`는 `$ref` 해석에 사용된다.

### 매핑 테이블

| JSON Schema type | TypeScript 타입 | 비고 |
|---|---|---|
| `"$ref": "#/definitions/X"` | `X` (참조된 타입 이름) | `resolve_ref()`로 이름 추출 |
| `"anyOf": [...]` | `A \| B \| ...` | 각 스키마에 재귀 호출 후 union 생성 |
| `"object"` | `{ field: type; ... }` | `ts_object_from_schema()` 호출 |
| `"integer"` | `number` | |
| `"number"` | `number` | |
| `"string"` + `"enum"` | `'A' \| 'B'` | string enum 값을 문자열 리터럴 union으로 변환 |
| `"string"` | `string` | enum이 없으면 일반 string |
| `"boolean"` | `boolean` | |
| `"array"` | `type[]` | `items`에서 재귀 호출, 없으면 `unknown[]` |
| `"null"` | `null` | |
| `["string", "null"]` 등 | `string \| null` | type 배열을 union으로 변환 |
| 그 외 | `unknown` | |

### `$ref` 해석 (`resolve_ref`)

```
"#/definitions/MyType" → "MyType"
"#/$defs/MyType"       → "MyType"
```

`$ref`를 만나면 definitions 맵에서 실제 스키마를 찾지 않고 타입 이름만 추출하여 반환한다. 해당 타입은 `generate_types_ts()`에서 `$defs` 블록을 별도로 순회하며 이미 출력되어 있어야 한다.

### Object 매핑 상세 (`ts_object_from_schema`)

```
JSON Schema:
{
  "type": "object",
  "properties": { "a": { "type": "integer" }, "b": { "type": "integer" } },
  "required": ["a", "b"]
}

↓

TypeScript:
{
  a: number;
  b: number;
}
```

- `required` 배열에 없는 프로퍼티는 `?` (optional)로 표시
- `properties`가 없으면 `Record<string, unknown>` 폴백

---

## 3. Command 이름 변환

### command_fn 경로 (자동 추출)

```
함수 정의: fn add_numbers(input: ...) -> Result<...>
                          ↓
type_name::<F>() → "calculator::add_numbers::{{closure}}" 등
                          ↓
short_type_name() → 마지막 세그먼트 추출
                          ↓
trim_end_matches("_command") → "_command" 접미사 제거
                          ↓
snake_to_lower_camel() → "addNumbers"
```

### command 경로 (명시적 이름)

```rust
.command("addNumbers", add_numbers)
```

사용자가 직접 command 이름을 지정한다. 이름 변환 없이 그대로 사용.

### TS 함수명 생성 (`command_function_name`)

command 이름을 TypeScript 함수명으로 변환한다. 구분자(`_`, `-`, `.` 등) 다음 글자를 대문자로 만드는 camelCase 변환이다. 결과가 빈 문자열이면 `"command"`로 폴백.

예: `"addNumbers"` → `"addNumbers"` (이미 camelCase면 변경 없음)

---

## 4. Contract Hash

```rust
fn contract_hash(input: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_ref());
    hex::encode(hasher.finalize())
}
```

- 입력: `schema_json` 문자열 (pretty-printed JSON)
- 출력: SHA256 hex 문자열
- 용도: `contract.ts`에 `GENERATED_CONTRACT_HASH` 상수로 저장. 런타임에 호스트-클라이언트 간 계약 일치를 확인하는 데 사용.

---

## 5. 생성 결과물

`GeneratedPackage`가 생성하는 4개 파일:

### schema.json

```json
{
  "packageId": "example.calculator",
  "commands": [
    {
      "name": "addNumbers",
      "inputType": "AddNumbersInput",
      "outputType": "AddNumbersOutput",
      "inputSchema": { ... },
      "outputSchema": { ... }
    }
  ]
}
```

### types.ts

```typescript
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export type RustraError = {
  readonly code: string;
  readonly message: string;
};

// $defs에 정의된 공유 타입 (enum 등)
export type Status = 'Active' | 'Inactive';

export type AddNumbersInput = {
  a: number;
  b: number;
};

export type AddNumbersOutput = {
  value: number;
};
```

`generate_types_ts()`는 다음 순서로 출력한다:

1. `EngineClient` 타입 정의
2. `RustraError` 타입 정의 (`readonly code: string; readonly message: string`)
3. `$defs`에 정의된 공유 타입 (enum, 재사용 구조체 등). 모든 command의 definitions를 병합한 뒤 emit
4. 각 command의 input/output 타입. 이미 출력된 타입은 중복 emit하지 않음 (`BTreeSet`으로 추적)

### commands.ts

```typescript
import type { AddNumbersInput, AddNumbersOutput, EngineClient, RustraError } from './types.js';

export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
}
```

- `EngineClient`와 `RustraError`를 항상 import에 포함
- 모든 타입을 alphabetical로 import
- 각 command당 하나의 함수

### contract.ts

```typescript
export const GENERATED_CONTRACT_HASH = '<sha256-hex>';
```

---

## 6. 현재 제한사항

JSON Schema → TypeScript 변환에서 다음 타입은 **`unknown`** 으로 폴백된다.

| 미지원 타입 | 이유 |
|---|---|
| `tuple` | `"type": "array"` + `prefixItems` 미처리 |
| `oneOf` | `anyOf`만 처리, `oneOf`는 미처리 |
| `allOf` | 교차 타입(intersection) 미처리 |
| integer enum | string enum만 리터럴 union으로 변환, integer enum은 미처리 |
| 중첩 `$ref` (다단계) | 1단계 `$ref` 해석만 지원. definitions 내부에 또 `$ref`가 있는 경우 재귀 resolve하지 않음 |

### 이미 지원되는 타입 (이전에는 미지원)

| 타입 | 지원 방식 |
|---|---|
| `$ref` | `#/definitions/X`, `#/$defs/X` → 타입 이름 추출 |
| `anyOf` | 각 스키마에 재귀 호출 후 `A \| B` union 생성 |
| string `enum` | `'Value1' \| 'Value2'` 문자열 리터럴 union |
| `null` | `null` 타입 |
| type 배열 union | `["string", "null"]` → `string \| null` |
| optional 필드 | `required`에 없으면 `?` + `\| null` (schemars가 `anyOf`로 표현) |
