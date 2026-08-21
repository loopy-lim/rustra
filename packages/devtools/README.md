# @rustra/devtools

rustra 호출 관측성 엔진 래퍼. 어떤 `EngineClient`든 감싸 호출 수/에러 수/누적
지연을 기록한다.

## 설치

```bash
npm install @rustra/devtools
```

## createInstrumentedEngine

```ts
import { createInstrumentedEngine } from '@rustra/devtools';
import { configure } from '@rustra/types';
import { createNodeEngine } from '@rustra/node';

const engine = createInstrumentedEngine(createNodeEngine({ invoke: myTransport }));
configure(engine);

await addNumbers({ a: 1, b: 2 });
console.table(engine.report().commandStats);
// ┌─────────┬───────┬────────┬─────────┬────────┐
// │ (index) │ count │ errors │ totalMs │ avgMs  │
// ├─────────┼───────┼────────┼─────────┼────────┤
// │ addNum… │ 1     │ 0      │ 3       │ 3      │
// └─────────┴───────┴────────┴─────────┴────────┘
```

`report()`는 `{ totalCalls, commandStats, slowest }`를 반환한다:

- `commandStats` — 명령별 `count`/`errors`/`totalMs`/`avgMs`
- `slowest` — 가장 느렸던 호출 상위 10건 (`{ command, ms }`)

## 동작 계약

- **투명한 래핑** — 관측 삽입이 기능을 제거하지 않는다. `invoke(command, args,
options)`의 options(signal/timeoutMs)를 inner 엔진에 그대로 전달하고,
  inner가 `invokeBatch`를 지원하면 래퍼도 전달한다.
- **타이밍** — `Date.now()` 기반(ms 단위). `performance.now` 글로벌이 없는
  임베디드 JS 런타임을 고려한 선택이다.

## 관련 문서

- [호환성 매트릭스](https://github.com/loopy-lim/rustra/blob/main/docs/compatibility-matrix.md)
- [메인 README](https://github.com/loopy-lim/rustra#readme)
