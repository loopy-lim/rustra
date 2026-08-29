# Events 트랙 리포트 (feat/event-surface)

**날짜:** 2026-08-30
**워크트리:** `.claude/worktrees/events` (브랜치 `feat/event-surface`)
**근거:** `docs/plans/2026-08-30-parallel-three-tracks.md` 트랙 3 / DX 감사 §1.2·§5
**커밋:** 599b4fd6 → 5d3a52e8 → 0d67336b → 3e549f4a → 393c4045 (working tree clean, push 없음)

---

## (a) 태스크 상태

| 태스크                         | 상태                                      | 산출물                                                             |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| 3.1 Bun subscribeEvent         | ✅ 완료 (설계 변경 — 아래 SKIP/결정 참조) | `packages/bun/src/bun-events.ts` + 테스트 5건, `index.ts` export   |
| 3.2 Node subscribeEvent        | ✅ 완료                                   | `packages/node/src/node-events.ts` + 테스트 5건, `index.ts` export |
| 3.3 4호스트 시그니처 정합      | ✅ 완료 (타입 프로브로 계약 규칙 확정)    | node/bun/tauri 소속 이벤트 파일에 컴파일 타임 단언                 |
| 3.4 compatibility-matrix 갱신  | ✅ 완료                                   | Node/Bun ❌→✅ + 전달 경로 1줄 주석                                |
| (추가) 적대적 재검증 결함 수정 | ✅ 완료                                   | drainEvents 동기 throw 생존 (393c4045)                             |

### 핵심 설계 결정 (지상진실 대비 변경)

1. **Bun은 "이벤트 버스 폴링"이 아니라 FFI 푸시로 구현** — 조사 결과 Rust FFI 표면에
   `take_pending_events` 드레인 심볼이 존재하지 않음(`nm` 실증: `rustra_ffi_event_sink_register/unregister`만
   존재). 심볼 추가는 crates 침범(Perf 소유)이라 금지 → 대신 기존 푸시 싱크 심볼 +
   Bun `JSCallback`으로 실 dylib E2E 실증(emitDemo 3 이벤트 푸시 수신). FFI 드레인 심볼이
   생기면 `BunEventDrainSource` 폴링 경로가 이미 그 자리를 담당.
2. **Bun `threadsafe: true` JSCallback은 사용 불가** — Bun 1.4.0 실증에서 `cstring`/`ptr`
   인자 마샬링이 깨져 가비지 값을 받음. `threadsafe: false`(JS 스레드 동기 호출 전제)로
   구현하고, 백그라운드 스레드 emit 호스트를 위해 `poll` 폴백 옵션 제공. JSDoc에 계약 명시.
3. **`set_event_sink` 이중 수신 방지 계약 준수** — 푸시 싱크 등록 중엔 버스가 비므로
   폴링과 혼용되지 않음(Rust `package_events.rs` 문서 계약). JSDoc에 명시.

### 3.3에서 확정한 계약 규칙 (타입 프로브로 실증)

- `(payload: unknown) => void` 콜백을 받는 호스트 시그니처는 제네릭 생성 계약
  `<N extends Name>(name, cb: (p: Payloads[N]) => void) => (() => void) | Promise<...>`와
  **양방향 불할당**(TS 5.9 실측).
- `(payload: never) => void`는 모든 페이로드 콜백의 최소 상위집합 → **할당 성공**.
- 따라서 node/bun 구독 콜백을 `never` 페이로드로 선언하고, 3패키지에 생성 계약 동형
  타입 단언을 넣어 계약이 바뀌면 tsc가 깨지게 고정. Tauri/RN의 `unknown`/제네릭 시그니처는
  0.x 호환 오버로드를 유지하며 `tauri-events.ts`의 단언으로 정합 고정(호스트 측 어댑팅 포함).
- **SKIP 판단: 코드젠(CLI) 변경 불필요 확인** — `generateEventsTs`가 생성하는 `SubscribeFn`/
  `onRustraEvent`는 호스트 주입형으로 이미 정합. `packages/cli/**` 무수정이 맞았음.

## (b) 게이트 결과

| 게이트                                               | 결과                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bun test packages/node packages/bun packages/tauri` | ✅ 86 pass / 0 fail / 12 skip (skip은 실 dylib·노드 러너 필요 분 — 기존 관례)              |
| `bun run test:ts:node`                               | ✅ 60 pass / 0 fail / 1 skip                                                               |
| compatibility-matrix ↔ 실제 export 대조              | ✅ `node.subscribeEvent` / `bun.createBunEventBridge` / `tauri.subscribeEvent` 런타임 확인 |
| 커밋 후 `--amend` (prettier 재스테이징)              | ✅ 전 커밋 적용, working tree clean                                                        |

베이스라인 주의: 게이트 실행엔 `bun install` + `packages/types` 빌드 + `cargo build
-p rustra-calculator-example`(debug/release)이 선행되어야 함(신규 워크트리 기준). dylib 없이는
bun FFI 관련 기존 테스트 3건이 baseline fail이다(본 트랙 결함 아님).

## (c) 4호스트 이벤트 전달 경로 표

| 호스트       | API                                                                          | 전달 경로            | 메커니즘                                                                                                                        | 지연                               |
| ------------ | ---------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Tauri        | `subscribeEvent(name, cb[, listen])` → `Promise<unsubscribe>`                | **push**             | Rust `tauri_support`가 `Package::emit`을 `app.emit("rustra://{sanitized}")`로 전달, JS `listen` 구독                            | 실시간                             |
| RN (rkyv V2) | `subscribeEvent(name, cb)` → `unsubscribe`                                   | **push**             | C++ JSI 호스트가 `rustra_ffi_event_sink_register` C 콜백으로 받아 CallInvoker로 JS 큐잉                                         | 실시간(마샬링 후)                  |
| Bun (신규)   | `createBunEventBridge({ library }).subscribeEvent(name, cb)` → `unsubscribe` | **push** (폴백 poll) | Bun `JSCallback`(비threadsafe) + `rustra_ffi_event_sink_register`. 백그라운드 스레드 emit 호스트는 `poll: { drainEvents }` 옵션 | 실시간 / 폴백 폴링 간격 기본 100ms |
| Node (신규)  | `subscribeEvent(transport, name, cb)` → `unsubscribe`                        | **poll**             | `transport.drainEvents()`(`__drainEvents` 특수 명령) setTimeout 백오프 폴링. `RUSTRA_NODE_EVENT_POLL_MS`(기본 100ms)            | 폴링 간격 이하                     |

공통 계약: `(name, callback) => unsubscribe`, 구독자 0이면 폴링/싱크 해제,
다수 구독자 한 루프 공유, 리스너 예외 격리, 비 JSON 페이로드는 원본 문자열 전달.
Rust `set_event_sink` 설치 시 버스 우회(푸시+폴링 이중 수신 방지) — node 폴링과
Bun 푸시를 동시에 쓰지 않아야 한다.

## (d) SKIP 사유

| 항목                                                          | 사유                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Bun 이벤트 버스 폴링(FFI `take_pending_events`)               | FFI 심볼이 Rust에 없음 — 추가는 `crates/**` 침범(Perf 소유). 대안인 FFI 푸시를 실증 후 채택. 심볼 추가는 별도 이슈 권장 |
| `packages/cli/**` 수정                                        | 코드젠(`generateEventsTs`)이 이미 정합 계약 생성 — 무수정이 정답(태스크 지시 조건 충족)                                 |
| `node-loop.ts` / tauri `index.ts` dispatch / `rkyv-engine.ts` | Perf 트랙 소유 — 수정 0건. Node는 `drainEvents()` **호출만** 사용                                                       |
| RN 시그니처의 unknown 콜백 계약 재정의                        | RN 파일이 본 트랙 소유 목록에 없음. `never`-콜백 규칙과의 정합은 `onRustraEvent` 어댑팅으로 해결 가능 — 후속 이슈 권장  |
| changeset / push                                              | 태스크 금지 준수                                                                                                        |

## 머지 노트 (메인 세션용)

- Perf 머지 후 rebase 전제(계획서대로). 본 브랜치는 `packages/node/src/index.ts`,
  `packages/bun/src/index.ts`에 export 1~5줄 추가 + 신규 파일 4개라 충돌 면적 최소.
- Bun FFI 이벤트 심볼 부재는 `crates/rustra`에 `rustra_ffi_take_pending_events` 추가로
  해소 가능 — 별도 이슈로 남김(Perf 머지 후 재조정 권장).
