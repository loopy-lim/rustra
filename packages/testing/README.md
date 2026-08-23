# @rustra/testing

Rust 백엔드 없이 생성된 TypeScript 클라이언트를 구동하는 mock 엔진과 계약
게이트를 제공한다. 컴포넌트/훅 테스트에서 네이티브 모듈 없이 rustra 명령을
검증할 수 있다.

## 설치

```bash
bun add -d @rustra/testing
```

## createMockEngine

```ts
import { createMockEngine } from '@rustra/testing';
import { configure } from '@rustra/types';
import { addNumbers } from './generated/commands.js';

const engine = createMockEngine()
  .on('addNumbers', ({ a, b }) => ({ value: a + b }))
  .on('greet', ({ name }) => ({ message: `hello ${name}` }));

configure(engine);
const result = await addNumbers({ a: 20, b: 22 }); // { value: 42 }
```

`.mock()`은 생성된 명령 함수를 직접 전달해 타입 안전하게 등록한다
(minify 환경에서도 안전하다 — 코드젠이 심은 `commandId`를 읽는다):

```ts
const engine = createMockEngine().mock(addNumbers, ({ a, b }) => ({ value: a + b }));
```

### 기능

- **호출 기록** — `engine.calls()`가 `{ command, args, options }` 배열을 반환한다.
  `options.signal`/`options.timeoutMs`까지 기록되어 "signal로 호출했는지" 검증이
  가능하다. `engine.reset()`으로 케이스 간 기록을 비운다.
- **취소 정책 미러** — pre-aborted signal을 넘기면 실제 어댑터와 동일하게
  `cancelled`(retryable)로 거부한다.
- **invokeBatch** — 항목별 `invoke` 라우팅으로 배치를 처리한다(각 항목의 옵션
  정책이 그대로 적용된다).
- **에러 정규화** — 핸들러가 `{code, message}` 형태를 throw하면
  `RustraCommandError`로 변환한다.

## 계약 게이트 (contract gate)

`schema.json`의 명령 목록과 클라이언트가 노출하는 명령 목록의 드리프트를
검출한다. CI에서 `rustra diff`(스키마 버전 간 breaking change)와 짝을 이룬다.

```ts
import { expectContractCurrent } from '@rustra/testing';
import schemaJson from './generated/schema.json' with { type: 'json' };
import * as commands from './generated/commands.js';

test('client matches schema.json', () => {
  // 드리프트가 있으면 사람이 읽는 메시지와 함께 throw, 정합이면 통과.
  expectContractCurrent(schemaJson, Object.keys(commands));
});
```

순수 함수 형태(`assertContractCurrent`)는 결과 객체
(`{missingInClient, missingInSchema}`)를 반환해 커스텀 검증에 쓸 수 있다.

## 관련 문서

- [호환성 매트릭스](https://github.com/loopy-lim/rustra/blob/main/docs/compatibility-matrix.md)
- [메인 README](https://github.com/loopy-lim/rustra#readme)
