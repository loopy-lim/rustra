# Calculator 예시

별도의 Rust crate가 `rustra`를 사용하는 완전한 예시입니다. 애플리케이션 작성자가 실제로 사용하는 방식을 보여줍니다.

## 실행

```bash
cargo run -p rustra-calculator-example
```

## 예시가 보여주는 것

1. **타입 정의** — `AddNumbersInput`, `AddNumbersOutput`을 `Serialize + Deserialize + JsonSchema`로 정의
2. **커맨드 등록** — `#[command]`로 핸들러 함수를 표시하고 `Package::builder(...).command_fn(...)`로 등록
3. **로컬 invoke** — `package.invoke("addNumbers", ...)`로 타입 안전한 호출
4. **TypeScript 생성** — `package.generate_typescript()` → `generated.write_to_dir(...)`로 파일 출력
5. **FFI 엔트리포인트** — `rustra_calculator_invoke` / `rustra_calculator_free_string` C ABI 제공
6. **stdio 브릿지** — `cargo run -p rustra-calculator-example -- invoke`로 stdin/stdout JSON 통신

## 생성되는 파일

`examples/calculator/generated/` 디렉토리에 다음 파일이 생성됩니다:

- `schema.json` — 패키지 스키마
- `types.ts` — TypeScript 타입 정의
- `commands.ts` — 커맨드 헬퍼 함수
- `contract.ts` — 계약 해시

## 생성된 커맨드 헬퍼

```ts
import { invoke } from '@rustra/types';

export function addNumbers(input: AddNumbersInput): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input);
}
```

글로벌 엔진은 `configure()`로 한 번 설정하면 이후 `addNumbers({ a: 42, b: 58 })`처럼
engine 파라미터 없이 호출할 수 있습니다 (Tauri-like 글로벌 invoke 패턴).

## 호환성 테스트

Node와 Bun에서 생성된 TypeScript 클라이언트를 검증합니다:

```bash
npm run test:compat
```
