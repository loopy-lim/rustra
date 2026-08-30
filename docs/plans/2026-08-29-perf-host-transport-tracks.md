# 성능 트랙 Plan 2 — Node persistent loop 바이너리화 + Tauri 측정 정합화/배치

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node persistent loop의 이중 JSON(16.9µs)을 바이너리 프레이밍으로 제거하고, Tauri의 측정 왜곡(50µs 그리드)을 정합화한 뒤 실측에 근거해 와이어 배치를 도입한다.

**Architecture:** 트랙 D(Node loop)와 트랙 E(Tauri)는 파일 비중복 → 병렬 가능. D는 신규 프로토콜을 **옵트인**으로 추가(기존 NDJSON 유지 — 호환), E는 측정 분리가 선행이고 배치는 코어의 기존 바이너리/JSON 어댑터를 재사용.

**Tech Stack:** Rust (postcard, serde_json), TypeScript (Node transport, Tauri engine, JSON engine), Bun test, cargo test.

**Spec:** `docs/specs/2026-08-29-perf-five-tracks-design.md`

## Global Constraints

- 기존 NDJSON 프로토콜은 기본 유지 — 바이너리는 프로토콜 협상/옵트인 (구 transport 소비자 무중단)
- Tauri `rustra_dispatch` 기존 시그니처 유지 (신규 엔트리는 추가만)
- 와이어 포맷 무변경 — 코어 핸들러 재사용
- 벤치 영수증에 로드 평균 조건 기재

---

## 트랙 D — Node persistent loop 바이너리화

### Task D1: 루프 런타임 바이너리 모드 (Rust)

**Files:**
- Modify: `examples/calculator/src/bin/loop-stdio.rs` (핸드셰이크 + 바이너리 프레임 위임)
- Test: `crates/rustra/tests/` (코어 레벨 — loop-stdio는 example bin이라 통합 스모크로 검증)

**Steps:**

- [ ] **Step 1: 실패하는 테스트/스모크 작성** — 핸드셰이크 `{"command":"__hello"}` → 응답에 `"binary":true` capability 포함. 이후 binary 프레임 `[len:u32 LE][cmd_id:u16 LE][postcard body]` 요청 → `[len][8B 헤더+rkyv V2 body]` 응답 round-trip을 Node 테스트에서 검증 (Task D3와 짝)
- [ ] **Step 2: 실패 확인** — 현재 `__hello` 미지원 → FAIL
- [ ] **Step 3: 구현** —
  - `__hello` 특수 요청 처리 (기존 `__drainEvents` 선례, `loop-stdio.rs:71+`)
  - stdin을 `BufReader<Stdin>`의 `read_exact` 루프로: 4B len → payload → `package.invoke_rkyv_v2(&payload)` (`crates/rustra/src/invoke.rs:8`) → 응답 4B len + frame. **`invoke_rkyv_v2_into` + 재사용 출력 버퍼**로 응답 복사 1회 절감 (플러시 전까지 유지)
  - 에러는 rkyv V2 에러 프레임으로 정규화 (코어가 이미 반환)
  - 이벤트 폴링(`__drainEvents`)은 JSON 라인과 동일하게 바이너리 모드에서도 유지 (커맨드 id는 frozen registry 조회로 name 해석)
- [ ] **Step 4: 통과** — cargo test + 수동 스모크 (`echo -e ... | cargo run --bin loop-stdio`)
- [ ] **Step 5: 커밋** — `feat(node): loop-stdio 바이너리 프레임 모드 — invoke_rkyv_v2 직결`

### Task D2: `createNodeLoopTransport` 바이너리 모드 (TS)

**Files:**
- Modify: `packages/node/src/index.ts:328-439` (transport), 신규 프레이밍 유틸
- Test: `packages/node/src/index.test.ts`

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — (a) `__hello` 핸드셰이크 후 transport가 바이너리 모드로 전환 (b) 요청 Buffer 조립 `[len][cmd_id][postcard]` (c) 응답 파싱이 **Buffer 누적**(문자열 연쇄 `stdoutBuffer +=` 제거) (d) 기존 NDJSON 프로세스와의 폴백 유지 (capability 없으면 레거시)
- [ ] **Step 2: 실패 확인** — `cd packages/node && bun test` → FAIL
- [ ] **Step 3: 구현** —
  - `writeRequest`: 코덱 encode 결과(`encodeInto` 재사용 버퍼) → length-prefix로 `proc.stdin.write`
  - 응답: `Buffer` 청크 누적 → len 프레임 슬라이스 → codec.decode. pending Map은 유지
  - 커맨드 이름→cmd_id는 엔진의 정적 id 캐시(`ensureStaticIds` 선례) 재사용
  - JSON 엔진과의 인터페이스 유지: transport.invoke는 (command, args)를 받아 내부에서 코덱 선택 — 다만 **JSON engine 상위 계약은 그대로** (`createJsonEngine` 소비자 변화 없음). 코덱은 generated `rkyv-codecs.ts`를 node 앱에서 import하는 형태 (bun-performance.ts 선례)
- [ ] **Step 4: 통과** — `bun test packages/node` + 전체 `bun run test:ts:node`
- [ ] **Step 5: 커밋** — `feat(node): 루프 transport 바이너리 모드 — Buffer 누적 프레이밍`

### Task D3: 성능 앱 전환 + 벤치

**Files:**
- Modify: `examples/calculator/apps/node-performance.ts:24-34` (persistent 루프가 바이너리 모드 사용), 필요 시 `scripts/host-bench.mjs`
- Test: 기존 테스트 전수

**Steps:**

- [ ] **Step 1:** node-performance 앱이 새 모드로 persistent 루프 구동 확인 (`__hello` 협상 성공 로그)
- [ ] **Step 2:** 벤치 before/after — `bun run bench:hosts -- --output /tmp/node-loop-bin.json`, 4쌍 중앙값. 목표 16.9µs → 3~6µs (프로세스 경계+파이프 하한 존중, 달성 못 하면 원인 분석 기록)
- [ ] **Step 3:** `docs/benchmarks.md` persistent loop 절 갱신 + receipt 보존
- [ ] **Step 4:** 전체 게이트 (`cargo test`, `bun run test:ts:node`) + 커밋 `perf(node): persistent loop 바이너리 왕복 실측`

---

## 트랙 E — Tauri 측정 정합화 → 와이어 배치

### Task E1: 벤치 측정 정합화 (측정만, 구현 없음)

**Files:**
- Modify: `examples/tauri-calculator/src/benchmark.ts:30-45` (batch 20→1000, Rust 타임스탬프 차감)
- Test: 수동 측정 + receipt

**Steps:**

- [ ] **Step 1:** 측정 개선 설계 — (a) batch 크기 1000으로 확대해 그리드를 1µs/call로 (b) `rustra_dispatch`가 `Instant::now()` 2회(진입/응답 직전)를 응답에 포함 → JS가 RTT에서 네이티브 처리 시간 차감 (c) WebKit 크로싱 비용은 RTT − 네이티브 − JS 측 마샬링으로 잔차 추정
- [ ] **Step 2:** `rustra_dispatch`에 측정 필드 추가는 **측정 전용 뒷문**으로: 신규 커맨드 `rustra_dispatch_profiled` (tauri_support.rs) 또는 벤치 전용 플래그 — 프로덕션 경로 오염 없게
- [ ] **Step 3:** 실측 실행 → receipt (`benchmark-receipts/2026-08-29-tauri-timing.json`) — 네이티브/크로싱/JS 성분 분해표
- [ ] **Step 4:** `docs/benchmarks.md` Tauri 절 갱신 — "279µs" 표에 보정 수치 병기
- [ ] **Step 5: 커밋** — `perf(tauri): IPC 벤치 측정 정합화 — 타이머 그리드 왜곡 제거`

### Task E2: `rustra_dispatch_batch` (진짜 와이어 배치)

**Files:**
- Modify: `crates/rustra/src/tauri_support.rs` (배치 커맨드), `packages/tauri/src/index.ts` (transport 배치), `packages/types/src/json-engine.ts:23-29` (`invokeBatch`가 Tauri transport에서 실제 배치 프레임 사용)
- Test: `crates/rustra` (배치 핸들러 단위), `packages/types` 테스트

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — `rustra_dispatch_batch(state, requests: Vec<BatchRequest>) -> Vec<BatchResponse>` 코어 단위 테스트 (성공/부분 실패/순서 보존). BatchRequest/Response는 기존 JSON 계약 재사용
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현 (Rust)** — `tauri_support.rs`에 배치 커맨드 추가: 요청 배열을 순회해 `package.invoke_json` 호출, 개별 실패는 요청별 에러로 응답 (fail-fast 아님 — 기존 RN invokeBatch의 fail-fast와 차이를 문서화). `generate_handler!`에 등록
- [ ] **Step 4: 구현 (TS)** — Tauri transport에 `invokeBatch` 구현: `{command, args}[]` → 단일 `invoke('rustra_dispatch_batch', {requests})`. `json-engine.ts`의 `invokeBatch`가 transport에 배치 위임 인터페이스 노출 (`transport.invokeBatch?` 옵트인 — 없으면 기존 `Promise.all` 폴백)
- [ ] **Step 5: 게이트** — `cargo test -p rustra` + `bun test packages/types packages/tauri` + Tauri 예제 스모크
- [ ] **Step 6: 벤치 + 커밋** — E1의 정합화된 측정으로 batch before/after (20호출 1 IPC vs 20 IPC) → `docs/benchmarks.md` → `perf(tauri): 와이어 배치 rustra_dispatch_batch`

### Task E3: 커스텀 프로토콜 조사 스파이크 (선택, E2 이후)

**Files:**
- Spike: `crates/rustra/src/tauri_support.rs`에 `register_asynchronous_uri_scheme_protocol("rustra", ...)` 프로토타입 (커밋 전 제거 또는 feature-gate)
- Output: 스파이크 결과를 `docs/benchmarks.md`에 기록

**Steps:**

- [ ] **Step 1:** Tauri v2 `InvokeBody::Raw`로 postcard 바디 수신 + `invoke_rkyv_v2` 위임 프로토타입
- [ ] **Step 2:** WKURLSchemeHandler vs postMessage RTT A/B 측정 (E1 측정 장치 재사용)
- [ ] **Step 3:** 결과 기록 + 채택/보류 판단 — **구현 확정은 별도 스펙으로** (본 플랜 범위 밖)

---

## 병렬 실행 노트

- 트랙 D와 E는 완전히 파일 비중복 → 2-way 병렬 (워크트리 분리 가능)
- D의 `loop-stdio.rs`는 example bin — crates 변경 없음 (트랙 A/B와 무충돌)
- E2의 `tauri_support.rs`는 트랙 B와 무충돌, 단 E1/E2 순차 권장 (측정 장치가 벤치에 필요)
- NDJSON→바이너리 전환은 capability 협상으로 구 transport 무중단 유지 — release 노트에 기재
