# Calculator 예시

별도의 Rust crate가 `rustra`를 사용하는 완전한 예시입니다. 애플리케이션 작성자가 실제로 사용하는 방식을 보여줍니다.

## 생성과 실행

```bash
bun run --cwd examples/calculator codegen
bun run test:runtime:node
bun run test:runtime:bun
```

Node 예제는 생성된 binary 후보를 lazy 발견하고, Bun 예제는 생성된 cdylib 후보와
stable ABI를 lazy 연결한다. 둘 다 애플리케이션 코드에 `configure()`, 프로세스 생성,
`dlopen` 또는 pointer 수명 관리가 없다.

```ts
import { addNumbers, rustra } from '../generated/node.js'; // Bun은 bun.js

const { value } = await addNumbers({ a: 20, b: 22 });
console.log(value);
rustra.dispose();
```

실행 파일은 [`apps/node-app.ts`](apps/node-app.ts)와
[`apps/bun-ffi-app.ts`](apps/bun-ffi-app.ts)에 있다.

## 예시가 보여주는 것

1. **타입 정의** — `AddNumbersInput`, `AddNumbersOutput`을 `Serialize + Deserialize + JsonSchema`로 정의
2. **커맨드 등록** — `#[command]`로 핸들러 함수를 표시하고 `Package::builder(...).command_fn(...)`로 등록
3. **로컬 invoke** — `package.invoke("addNumbers", ...)`로 타입 안전한 호출
4. **TypeScript 생성** — 계약 프로브(`src/bin/generate.rs`)가 `schema.json`만 발행하면 `rustra codegen`이 TS/C++ 표면을 렌더링
5. **Host 생성 진입점** — `node.ts`, `bun.ts`, `tauri.ts`, `react-native.ts`
6. **네이티브 진입점** — `native_entry!` 한 줄로 stable C ABI와 RN staticlib 공유
7. **고성능 선택지** — Node persistent loop/N-API와 Bun FFI rkyv V2 실측

## 생성되는 파일

`examples/calculator/generated/` 디렉토리에 다음 파일이 생성됩니다:

- `schema.json` — 패키지 스키마 (`generate` bin이 발행)
- `types.ts` — TypeScript 타입 정의
- `commands.ts` — 커맨드 헬퍼 함수
- `contract.ts` — 계약 해시
- `rkyv-codecs.ts`, `rkyv-registry.ts` — rkyv V2 바이너리 fast-path 코덱
- `node.ts`, `bun.ts`, `tauri.ts`, `react-native.ts` — host별 zero-config bootstrap

`positional` 옵션을 켜면(React Native 예시가 그렇다) 추가로 `positional-facade.ts`가
생성된다. `.rustra-generated.json`은 스키마 해시와 파일별 해시를 기록해 CI의
`codegen:check`이 1바이트 드리프트도 감지한다.

## 생성된 커맨드 헬퍼

```ts
import { addNumbers } from '../generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
console.log(result.value); // 42
```

이 코드는 `createGeneratedFields2` 기반으로 생성된 helper와 Node host entry를
사용합니다. 생성된 host 파일이 lazy engine을 한 번 설치하므로 helper는 engine
파라미터 없이 호출합니다. Bun은 같은 방식으로 `../generated/bun.js`를 import하며,
수동 `configure()`는 custom transport를 주입할 때만 필요합니다.

## 실사용 성능 확인

```bash
bun run bench:hosts
```

[`apps/node-performance.ts`](apps/node-performance.ts)는 Node 기본 one-shot,
persistent loop, N-API rkyv V2를 각각 재고,
[`apps/bun-performance.ts`](apps/bun-performance.ts)는 생성된 Bun FFI 경로를 잽니다.
기본 Node 경로는 단순 배포를 위한 CLI/저빈도 경로입니다. 서버 hot path에서 매 호출
프로세스를 시작하지 않도록 loop 또는 N-API를 명시적으로 선택해야 합니다.

## 호환성 테스트

Node와 Bun에서 생성된 TypeScript 클라이언트를 검증합니다:

```bash
bun run test:compat
```
