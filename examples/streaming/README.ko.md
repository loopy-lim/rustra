# Streaming 예시 — Rust → JS 이벤트 푸시

`Package::emit()`으로 발행한 이벤트를 JS가 소비하는 패턴을 보여주는 예시.
장기 실행 커맨드가 진행률을 스트리밍하고, 호스트 어댑터는
(`@rustra/node` `subscribeEvent`) 구독으로 이벤트를 받아 플랫폼 푸시 채널로
전달한다 — 이 데몬은 라인 JSON 프로토콜(구 런타임)이라 푸시 핸드셰이크
(`events:"push"`)가 없고, 따라서 폴링 폴백 경로로 흐른다.

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
bun examples/streaming/apps/node-app.ts
```

출력 예:

```
[streaming] transport ready — mode=ndjson pushCapable=false (폴링 폴백 경로)
[streaming] startJob(job-1, 5 steps)
[streaming] tick  1/5 ▓░░░░
...
[streaming] done: 5 steps
[streaming] PASS — 5/5 ticks received via subscribeEvent
```

## API

```rust
// Rust — 이벤트 계약 선언 (builder 체인)
rustra::build!("examples.streaming", start_job, job_status)
    .event::<JobProgress>("progress.tick")
    .event::<JobDone>("job.done")
    .done()

// 커맨드 핸들러에서 선언된 타입으로 이벤트 발행
package.emit("progress.tick", JobProgress { job_id, step, total });
```

```ts
// 호스트 어댑터 — 이벤트 버스 폴링 (플랫폼 푸시 채널로 전달)
const events = package.eventBus().takePendingEvents();
// → [{ name: "progress.tick", payload: "{\"jobId\":\"job-1\",\"step\":1,\"total\":5}", seq: 0 }]
```

이벤트 버스는 고정 용량(기본 1024, drop-oldest) — 호스트가 느려도 Rust 호출을
블록하지 않는다. seq는 단조 증가하므로 수신측 순서 검증에 사용한다.

## 다른 플랫폼 적용

- **Tauri**: 폴링 타이머 → `app.emit()`
- **RN**: 폴링 → `DeviceEventEmitter`

Node 데모의 `--serve` 라인 데몬은 `__drainEvents` 폴링 명령에 `events` 필드
(`{"ok":true,"events":[...]}`)로 답한다 — calculator loop-stdio 참조 런타임과
같은 계약이며, `@rustra/node` 폴링 폴백이 읽는 필드다. 푸시 모드(0xfffd
프레임) 런타임은 `examples/calculator/src/loop_stdio.rs` 참고.
