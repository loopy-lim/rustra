# 성능 트랙 Plan 4 — 동적 명령 (dev) 치환 계약 + Tier 정합화

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev 치환 워크플로우("고치고 replace → JS는 아무 것도 안 해도 됨")를 런타임 계약으로 고정하고(T0), 동적 명령도 postcard fast-path를 지원해 JSON 3왕복을 제거한다(T2). 벤치 오독(6.55x)을 교정한다(T1). release frozen 설계는 유지.

**Architecture:** T0가 계약 기반(선행 필수) → T1은 독립(병렬 가능) → T2는 T0의 generation을 소비. T2의 TS 인터프리터는 live_schema만 있으면 동작하므로 코드젠 변경 없음.

**Tech Stack:** Rust (postcard, serde_json, schemars), TypeScript (@rustra/types 런타임), criterion bench.

**Spec:** `docs/specs/2026-08-29-perf-five-tracks-design.md` (트랙 T 절)

## Global Constraints

- 동적 명령은 dev 전용 — release frozen 차단 유지 (`register`는 release에서 registry.frozen)
- T0 계약은 wire 포맷과 무관 — Tier 3(JSON)만 쓰는 명령에도 동일하게 적용
- 치환 후 스키마 불일치는 시끄럽게 실패 (조용한 오염 금지) — T0 재동기화가 이를 보장
- 기존 Tier 3 JSON-in-binary 경로는 폴백으로 유지
- 동적 명령 벤치는 `--profile dev`로 측정 (기존 관례), 측정 조건을 영수증에 기재

---

## 트랙 T0 — 치환 계약: schema generation

### Task T0-1: `schema_generation` u64 도입 + 증가 지점

**Files:**
- Modify: `crates/rustra/src/package.rs:37-52` (RegistryState 필드 추가), `crates/rustra/src/registry.rs:89-192` (register/replace/unregister에서 증가)
- Test: `crates/rustra/src/runtime_registry_tests.rs` (기존 파일 확장)

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
#[test]
#[cfg(debug_assertions)]
fn schema_generation_advances_on_register_replace_unregister() {
    let pkg = empty_pkg();
    let g0 = pkg.schema_generation();
    pkg.register("echo", echo).unwrap();
    let g1 = pkg.schema_generation();
    assert!(g1 > g0);
    pkg.replace("echo", c1).unwrap();
    assert!(pkg.schema_generation() > g1);
    pkg.unregister("echo").unwrap();
    assert!(pkg.schema_generation() > g1);
    // 스키마 불변 동작(register 중복 이름 = id 재사용, 실질 무변화)은
    // 증가해도 무해 — 계약은 "증가 방향 보존"만 요구.
}
```

- [ ] **Step 2: 실패 확인** — `cargo test -p rustra schema_generation 2>&1 | tail -5` → FAIL (함수 부재)
- [ ] **Step 3: 구현** — `RegistryState`에 `schema_generation: u64` 추가(초기 0). register/replace/unregister의 기존 `live_schema_cache = None` 지점(`registry.rs:122,162,191`)에서 함께 증가. frozen 전환(build) 시에는 증가 불요(정적 명령은 generation 무관)
- [ ] **Step 4: 통과 확인** — `cargo test -p rustra` 전체
- [ ] **Step 5: 커밋** — `feat(core): schema generation — 치환 동기화 계약 기반`

### Task T0-2: live_schema에 generation 포함 + 저비용 FFI

**Files:**
- Modify: `crates/rustra/src/package_codegen.rs:4-31` (live_schema 응답에 `"schemaGeneration"` 필드), `crates/rustra/src/ffi.rs` (기존 `rustra_ffi_get_schema` 옆 `rustra_ffi_schema_generation` 신규 — u64 반환, 잠금 최소화)
- Test: `crates/rustra/tests/` (FFI round-trip), `packages/node/src/index.test.ts` (FFI 노출)

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — (a) live_schema JSON에 `schemaGeneration` 포함 (b) FFI 호출이 현재 generation 반환. 기존 `live_schema_cache_tracks_replace_and_unregister` 테스트에 generation 단조 증가 assertion 추가
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `live_schema()` 캐시 값에 generation을 함께 스냅샷(캐시된 schema 객체에 필드가 이미 있으므로 자동 일관). FFI는 read lock 1회 + u64 복사 — 호출 비용 수십 ns
- [ ] **Step 4: 통과** — `cargo test -p rustra` + 노드 FFI 스모크
- [ ] **Step 5: 커밋** — `feat(core): live_schema/FFI에 schema generation 노출`

### Task T0-3: TS 엔진 generation 게이트 + 재동기화

**Files:**
- Modify: `packages/types/src/rkyv-engine.ts` (동적 명령 Tier 3 라우팅부 `:341-361` 주변), `packages/types/src/live-schema.ts` (generation 필드)
- Test: `packages/types/src/index.test.ts` (동적 Tier 3 fallback 테스트 확장)

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — (a) 엔진이 live_schema 조회 시 generation을 캐시 (b) 동적 명령 호출 전(또는 N회 주기) `rustra_ffi_schema_generation` 비교 — FFI 미노출 호스트는 스킵(현상 유지) (c) 불일치 시 live_schema 재조회 → 미등록 명령은 `command.not_found`로 시끄럽게 실패 (d) 스키마 동일하면 캐시 유지
- [ ] **Step 2: 실패 확인** — `bun test packages/types` → FAIL
- [ ] **Step 3: 구현** — Tier 3 동적 명령 진입점 앞에 generation 체크 삽입 (매 호출 u32/u64 FFI 읽기 1회 — dev 전용 경로라 오버헤드 허용). 불일치 시: live_schema 재조회 → 동적 명령 id/스키마 캐시 재구축 → 재진행. **호출 중 재동기화는 1회만** (재귀 방지)
- [ ] **Step 4: 통과** — `bun test packages/types` + `bun run test:ts:node`
- [ ] **Step 5: 커밋** — `feat(types): 치환 재동기화 — generation 게이트로 스테일 캐시 차단`

### Task T0-4: E2E 워크플로우 검증

**Steps:**

- [ ] **Step 1:** 노드/디버그 예제에서 register → invoke → replace(스키마 변경) → invoke 순서 시뮬레이션 — JS가 중간 동기화 없이 성공하는지, 미등록 명령이 not_found로 실패하는지 확인
- [ ] **Step 2:** RN DynamicRegistryApp(`examples/react-native-calculator/DynamicRegistryApp.tsx`) 스모크 — JSI FFI가 generation 노출 여부에 따라 기능 저하 없음 확인
- [ ] **Step 3: 커밋** — `test(e2e): dev 치환 워크플로우 generation 재동기화 검증`

---

## 트랙 T1 — tier_compare 벤치 교정 (T0와 병렬 가능)

### Task T1-1: 동일 연산 3-wire 벤치로 재작성

**Files:**
- Modify: `crates/rustra/benches/tier_compare.rs`, `crates/rustra/benches/common.rs`
- Output: `docs/benchmarks.md` Tier 절 갱신

**Steps:**

- [ ] **Step 1: 벤치 설계** — 동일 의미 연산(echo: `{"v":7}`)을 3가지 wire로: (a) 정적 postcard (b) 동적 Tier 3 JSON (c) T2 완료 후 동적 postcard. 기존 add/greet/echo 혼합 구성을 교체 — 연산 효과를 통제해 wire 차이만 남김
- [ ] **Step 2: 구현** — echo 타입을 빌더 명령으로도 등록(정적 postcard), 동일 타입을 register로도 등록. common.rs에 echo용 postcard/tier3 요청·응답 헬퍼 추가
- [ ] **Step 3: 측정** — `cargo bench -p rustra --bench tier_compare --profile dev` + 필요 시 release 정적 비교선 병기 (동적은 dev-only이므로 절대 수치 비교 주석 필수)
- [ ] **Step 4: 문서화** — `docs/benchmarks.md` "동적 명령" 절에 "연산 통제 비교" 표 추가, 기존 6.55x 표에 오독 주의 강화
- [ ] **Step 5: 커밋** — `bench(core): tier_compare 연산 통제 재작성 — wire 순수 비교`

---

## 트랙 T2 — 동적 명령 postcard fast-path (T0 머지 후)

### Task T2-1: register 게이트 완화 (Rust)

**Files:**
- Modify: `crates/rustra/src/registry.rs:118` (`force_tier3=true` → 게이트 판정), `crates/rustra/src/command.rs` (필요 시 force_tier3와 is_tier3 분기 정리)
- Test: `crates/rustra/src/runtime_registry_tests.rs`, `crates/rustra/tests/rkyv_v2_wire.rs`

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — postcard 지원 스키마(정수/String 등)로 register한 명령이 binary 핸들러를 갖는지, 미지원 스키마(map 필드 등)는 Tier 3 유지하는지:

```rust
#[test]
#[cfg(debug_assertions)]
fn dynamic_postcard_supported_command_gets_binary_handler() {
    let pkg = empty_pkg();
    pkg.register("echo", echo).unwrap(); // {v: i64} — js postcard 지원 형태
    // postcard 요청으로 invoke 성공 + tier3 JSON 요청은 지원 형태면 실패(또는 문서화된 정책)
}
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `register`/`register_fn`/`replace`에서 `force_tier3=false`로 `build_command` 호출 — `build_command` 내부의 기존 `js_codec_supported`/`complex_codec_supported`/`is_tier3` 게이트(`command.rs:86-97`)가 알아서 Tier를 결정. **와이어 정책 결정**: 미지원 스키마는 기존대로 Tier 3 (복합 폴백 유지). frozen 정적 명령의 wire는 전혀 변경 없음 (별도 게이트 — 기존 wire fixture 전수 재확인)
- [ ] **Step 4: 전체 게이트** — `cargo test -p rustra` (wire/fuzz/concurrency 포함)
- [ ] **Step 5: 커밋** — `feat(core): 동적 명령 postcard fast-path — 지원 스키마 binary 핸들러`

### Task T2-2: TS 스키마→postcard 코덱 인터프리터

**Files:**
- Create: `packages/types/src/schema-postcard-codec.ts` (live_schema의 input/outputSchema → RkyvV2Codec)
- Test: `packages/types/src/index.test.ts` (인터프리터 단위 + cross-wire)

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — live_schema 스키마로 생성한 인터프리터 코덱이 generated 코드젠 코덱과 **바이트 동일** (동일 타입의 generated codec fixture와 hex 비교 — PINNED 게이트 패턴 재사용)
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 스키마 노드별 postcard encode/decode 클로저 트리 생성 (정수 포맷별 zigzag/uvar, String, Vec, Option, bool, f32/f64). 생성된 코덱의 `_pcEncode*`/`_pcDecode*` 헬퍼 재사용 — 중복 구현 금지. 지원 불가 노드는 null 반환 → 엔진이 Tier 3 폴백
- [ ] **Step 4: cross-wire 게이트** — TS 인터프리터 ↔ Rust postcard 핸들러 round-trip (동적 명령 실제 왕복 테스트)
- [ ] **Step 5: 커밋** — `feat(types): 스키마→postcard 코덱 인터프리터 — 동적 명령 binary 지원`

### Task T2-3: 엔진 통합 — 동적 명령 라우팅 갱신

**Files:**
- Modify: `packages/types/src/rkyv-engine.ts:341-361` (동적 명령 Tier 3 전용 경로 → 인터프리터 코덱 우선)
- Test: `packages/types/src/index.test.ts`

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — T0-3의 generation 게이트와 결합: 동적 명령이 (a) 인터프리터 코덱 가능하면 binary (b) 불가하면 Tier 3 (c) generation 불일치면 재동기화 후 재판정
- [ ] **Step 2: 구현** — live_schema 재구축 시점에 동적 명령별 코덱을 인터프리터로 생성/갱신. `debugWire` 로그에 경로(tier) 표기 유지
- [ ] **Step 3: 게이트** — `bun test packages/types` + node 통합 테스트 + `DynamicRegistryApp` 스모크 (4종 타입 중 지원 형태는 binary, Map/Nested는 Tier 3 유지 확인)
- [ ] **Step 4: 커밋** — `feat(types): 동적 명령 postcard 라우팅 — generation 연동`

### Task T2-4: 실측 + 문서

**Steps:**

- [ ] **Step 1:** T1의 교정된 벤치에 "동적 postcard" 라인 추가 — `cargo bench -p rustra --bench tier_compare --profile dev`
- [ ] **Step 2:** 목표 확인: 동적 echo가 정적 echo 대비 근접(2x 이내) — 미달 시 성분 분석 기록
- [ ] **Step 3:** `docs/benchmarks.md` 동적 명령 절 전면 갱신 (교정 표 + fast-path 표) + `docs/architecture.md:420-427`의 Tier 3 설명 갱신
- [ ] **Step 4:** 전체 게이트 (`cargo test`, `bun run test:ts:node`) + 커밋 `perf(core): 동적 명령 postcard 실측 — dev 루프 Tier 1 근접`

---

## 병렬 실행 노트

- T0 → T2 순차 필수 (T2가 T0의 generation 소비). T1은 T0와 병렬 가능
- T0-1/T0-2는 코어, T0-3은 TS — 파일 비충돌이나 계약 의존이라 순차 권장
- T2-1(registry.rs)은 트랙 A/B(complex 코어)와 `command.rs` 공유 → 트랙 A/B 머지 후 착수 권장
- T2-2 인터프리터는 코드젠(`packages/cli`) 비의존 — generated 재생성 불필요
- 동적 명령 wire 변경은 OTA/정적 계약에 영향 없음 — 그러나 wire fixture 전수는 매 태스크 재확인
