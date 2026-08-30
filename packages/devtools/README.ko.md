# @rustra/devtools

rustra 호출 관측성 엔진 래퍼. 어떤 `EngineClient`든 감싸 호출 수/에러 수/누적
지연을 기록한다.

## 설치

```bash
bun add @rustra/devtools
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

`report()`는 `{ totalCalls, commandStats, batchStats, slowest }`를 반환한다:

- `commandStats` — 명령별 `count`/`errors`/`totalMs`/`avgMs`
- `batchStats` — batch 횟수/엔트리 수/실패 수/총·평균 지연. 단일 batch 실패의
  원인을 특정 명령으로 추측하지 않는다.
- `slowest` — 가장 느렸던 호출 상위 10건 (`{ command, ms }`)

## 동작 계약

- **투명한 래핑** — 관측 삽입이 기능을 제거하지 않는다. `invoke(command, args,
options)`의 options(signal/timeoutMs)를 inner 엔진에 그대로 전달하고,
  inner가 `invokeById`/`invokeBatch`를 지원하면 래퍼도 전달한다.
- **타이밍** — 단조 고해상도 `performance.now()`를 우선하고, 해당 글로벌이
  없는 임베디드 JS 런타임에서만 `Date.now()`로 폴백한다.
- **메모리 상한** — 호출 이력 전체를 보관하지 않고 가장 느린 10건만 유지한다.

## 관련 문서

- [호환성 매트릭스](https://github.com/loopy-lim/rustra/blob/main/docs/compatibility-matrix.md)
- [메인 README](https://github.com/loopy-lim/rustra#readme)
