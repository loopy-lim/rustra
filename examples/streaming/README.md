# Streaming 예시 — Rust → JS 이벤트 푸시

`Package::emit()`으로 발행한 이벤트를 JS가 소비하는 패턴을 보여주는 예시.
장기 실행 커맨드가 진행률을 스트리밍하고, 호스트 어댑터가 이벤트 버스를
폴링해 플랫폼 푸시 채널로 전달한다.

## 구조

```
streaming/
├── src/lib.rs             startJob(백그라운드 스레드 emit) + jobStatus
├── src/bin/invoke.rs      stdio 라인 데몬(--serve) — __drainEvents 폴링 명령
├── apps/node-app.ts       Node end-to-end 데모 (진행률 바 출력)
├── tests/streaming_flow.rs  통합 테스트 (tick 수/seq 단조성/payload 타입)
└── ts/streaming.test.ts   유닛 테스트 (mock 엔진 + generated 검증)
```

## 실행 (end-to-end)

```bash
cargo build -p rustra-streaming-example
npx tsc -p examples/streaming/tsconfig.json
node dist-ts/examples/streaming/apps/node-app.js
```

출력 예:

```
[streaming] startJob(job-1, 5 steps)
[streaming] tick  1/5 (seq=0) ▓░░░░
...
[streaming] done: 5 steps
[streaming] PASS — 5/5 ticks received, seq 0..5
```

## API

```rust
// Rust — 커맨드 핸들러에서 이벤트 발행
package.emit("progress.tick", serde_json::json!({ "value": 42 }));
```

```ts
// 호스트 어댑터 — 이벤트 버스 폴링 (플랫폼 푸시 채널로 전달)
const events = package.eventBus().takePendingEvents();
// → [{ name: "progress.tick", payload: "{\"value\":42}", seq: 0 }]
```

이벤트 버스는 고정 용량(기본 1024, drop-oldest) — 호스트가 느려도 Rust 호출을
블록하지 않는다. seq는 단조 증가하므로 수신측 순서 검증에 사용한다.

## 다른 플랫폼 적용

- **Lynx**: BTS `post_task_to_runtime` + `__rustraDeliver` (스파이크 검증 패턴,
  `docs/plans/2026-08-10-rustra-lynx-runtime-design.md` §이벤트 푸시)
- **Tauri**: 폴링 타이머 → `app.emit()`
- **RN**: 폴링 → `DeviceEventEmitter`

Node 데모의 `--serve` 라인 데몬 + `__drainEvents` 폴링이 이 역할의 참고 구현이다.
