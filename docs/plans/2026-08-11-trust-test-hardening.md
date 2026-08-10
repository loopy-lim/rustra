# 신뢰 테스트 강화 (Trust Test Hardening) — 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** "실제 사용자가 rustra-bridge를 믿고 쓴다"를 테스트가 증명하는 상태로 만든다 — FFI 패닉 격리, Rust↔TS↔C++ 교차 와이어 호환 증명, 어댑터 에지/에러 일관성.

**Architecture:** 단계적 하이브리드. Phase 0(현재 상태 측정·고정) → Phase 1(결함 수정) → Phase 2(교차 호환 fixture 증명) → Phase 3(깊이 강화). 설계 근거는 `docs/plans/2026-08-11-trust-test-hardening-design.md`.

**Tech Stack:** Rust (catch_unwind, debug_assert, extern "C"), TypeScript (vitest/node:test), postcard/rkyv wire format, checked-in hex fixtures.

**실행 원칙:**

- 이 plan은 **Phase 0를 step 수준으로 상세화**한다. Phase 1~3은 task 단위이며, 각 phase 진입 시 같은 방식으로 세분화한다.
- 구현은 별도 브랜치/worktree에서 진행한다 (main 아님).
- 커밋은 lefthook prettier hook 대비 — 커밋 후 `git commit --amend --no-edit`으로 재포맷된 파일을 다시 포함한다 (memory: lefthook-prettier-amend).
- UB/abort를 유발하는 결함(F1/F2/F8)은 "failing 테스트 먼저"가 프로세스를 죽이므로, Phase 1에서 구현과 동시에 테스트를 작성한다(TDD: 테스트-먼저 원칙을 안전하게 적용). 실행 가능한 결함(F3/F4/F5)은 Phase 0에서 현재 동작으로 고정한다.

---

# Phase 0 — 기준선 측정 (Measure)

**목표:** 실행 가능한 결함(F3/F4/F5)과 FFI 음수 경로를 현재 동작으로 고정하고, UB 결함(F1/F2/F8)은 명시적 `#[ignore]`/TODO로 가시화한다. 끝나면 "깨진 것 목록"이 테스트로 존재한다.

## Task 0.1: TS F3 — RN/Lynx sync throw 계약 위반 고정

**Files:**

- Modify: `packages/react-native/src/index.test.ts`
- Modify: `packages/lynx/src/index.test.ts`

**배경:** `createReactNativeEngine`(`packages/react-native/src/index.ts:29-50`)은 async가 아니고 try/catch가 없다. `native.invoke`가 sync throw하면 `engine.invoke().catch(h)`로 못 잡는다.

**Step 1: RN failing 테스트 추가** (`packages/react-native/src/index.test.ts`)

```ts
test('createReactNativeEngine rejects (not sync-throws) when native.invoke throws [F3 baseline]', async () => {
  const engine = createReactNativeEngine({
    invoke() {
      throw new Error('native sync boom');
    },
  });
  // 계약: invoke()는 Promise<T>여야 하므로, 실패는 rejected Promise여야 한다.
  await expect(engine.invoke('cmd', {})).rejects.toThrow('native sync boom');
});
```

**Step 2: 실행 — 현재는 FAIL이어야 함 (sync throw라 .rejects 매처가 못 잡음)**

Run: `cd packages/react-native && pnpm test`
Expected: FAIL (에러가 동기적으로 던져져 `rejects` 매처를 통과 못 함). 이것이 F3의 존재 증명이다.

**Step 3: Lynx 동일 테스트** (`packages/lynx/src/index.test.ts`) — JSON fallback 경로(`createLynxEngine`)에 동일 패턴 적용.

**Step 4: 커밋**

```bash
git add packages/react-native/src/index.test.ts packages/lynx/src/index.test.ts
git commit -m "test(trust): F3 baseline — RN/Lynx sync-throw contract violation"
git commit --amend --no-edit  # lefthook prettier 재포함
```

## Task 0.2: TS F4 — 에러 클래스 불일치 고정

**Files:** `packages/react-native/src/index.test.ts`, `packages/lynx/src/index.test.ts`, `packages/types/src/index.test.ts`

**Step 1: 테스트 추가** — RN이 plain `Error`를 던지는 것(코드 유실)을 고정.

```ts
test('createReactNativeEngine throws plain Error (loses code) [F4 baseline]', async () => {
  const engine = createReactNativeEngine({
    invoke() {
      const buf = new TextEncoder().encode(
        JSON.stringify({ ok: false, error: 'command.not_found: unknown' }),
      );
      return buf.buffer;
    },
  });
  try {
    await engine.invoke('cmd', {});
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RustraCommandError); // F4: 코드 유실 고정
  }
});
```

**Step 2: `createRkyvV2Engine` unknown-command 경로** (`packages/types/src/index.test.ts`) — 이미 plain `Error`를 던지는지 단언 강화: 현재 테스트는 `/no codec/.test(msg)`만 검사. `instanceof Error && !(instanceof RustraCommandError)` 단언 추가로 F4-divergence 고정.

**Step 3: 실행** — PASS(현재 동작 고정). Run: `cd packages/types && pnpm test && cd ../react-native && pnpm test`

**Step 4: 커밋** — `test(trust): F4 baseline — error class divergence pinned`

## Task 0.3: TS F5 — contract hash 미검증 고정

**Files:** `packages/types/src/index.test.ts`

**Step 1: 테스트 추가** — 엔진이 hash 불일치를 (현재는) 조용히 통과함을 고정.

```ts
test('createRkyvV2Engine accepts mismatched contract hash silently [F5 baseline]', () => {
  // 현재는 engine이 hash를 전혀 보지 않으므로, 불일치 상태에서도 invoke 가능.
  // createRkyvV2Engine(native, registry) 시그니처에 hash 인자가 없음을 단언.
  const engine = createRkyvV2Engine(makeMockNative(), new Map());
  // F5: hash 검증이 존재하지 않음 — 함수 시그니처 자체에 hash가 없다.
  expect(engine).toBeDefined();
  // Phase 1에서 hash 옵션이 추가되면 이 테스트는 reject를 단언하도록 바뀐다.
});
```

**Step 2: 실행** — PASS. Run: `cd packages/types && pnpm test`

**Step 3: 커밋** — `test(trust): F5 baseline — contract hash not enforced`

## Task 0.4: Rust F1/F2/F8 — UB/abort 결함 가시화 (`#[ignore]`)

**Files:** `crates/rustra/tests/trust_baseline_ffi.rs` (Create)

**배경:** F1(패닉 abort), F2(double-free UB), F8(null deref UB)는 실행 시 프로세스를 죽이므로 일반 `#[test]`로 못 잡는다. 명시적 `#[ignore]` 테스트로 "알고 있는 깨진 것"으로 표시하고, Phase 1에서 구현 후 ignore를 제거한다.

**Step 1: ignore 테스트 작성**

```rust
//! Trust baseline — 현재 깨진 FFI 안전성 결함을 가시화.
//! 각 테스트는 Phase 1에서 구현이 끝나면 #[ignore]를 제거하고 통과해야 한다.

#[test]
#[ignore = "F1: catch_unwind 미구현 — 패닉 시 호스트 abort. Phase 1에서 catch_unwind 추가 후 활성화"]
fn panic_in_handler_returns_clean_error_not_abort() {
    // TODO Phase 1: 패닉 핸들러 등록 → invoke → ok=false + RustraError 단언
}

#[test]
#[ignore = "F2: rustra_ffi_free double-free/wrong-len UB. Phase 1에서 debug_assert 가드 후 활성화"]
fn free_wrong_len_is_detected() {
    // TODO Phase 1
}

#[test]
#[ignore = "F8: rustra_ffi_get_schema가 out_len null 체크 누락. Phase 1에서 null 체크 후 활성화"]
fn get_schema_with_null_out_len_is_safe() {
    // TODO Phase 1
}
```

**Step 2: 실행** — ignore로 스킵됨. Run: `cargo test --test trust_baseline_ffi -- --ignored` (run하지 않고 listing만)
Expected: 3개 ignore 테스트 존재.

**Step 3: 커밋** — `test(trust): F1/F2/F8 baseline — UB defects surfaced as ignored tests`

## Task 0.5: Rust — huge payload / postcard error 경로 고정

**Files:** `crates/rustra/tests/trust_baseline_ffi.rs`

**Step 1: huge payload 테스트** (`MAX_PAYLOAD_BYTES` > 1MiB 거부, ffi.rs:203)

```rust
#[test]
fn huge_payload_rejected() {
    let pkg = /* test_package */;
    pkg.register_ffi();
    let big = vec![b' ', 2 * 1024 * 1024]; // 2MiB, invalid JSON
    let mut out_len = 0usize;
    let ptr = unsafe { rustra_ffi_invoke_json(big.as_ptr(), big.len(), &mut out_len) };
    let resp = /* read buffer, free */;
    assert!(!resp.ok);
    assert!(resp.error.unwrap().contains("size limit"));
}
```

**Step 2: postcard error-leg 테스트** (현재 happy path만)

**Step 3: 실행** — PASS. Run: `cargo test --test trust_baseline_ffi huge_payload`

**Step 4: 커밋** — `test(trust): FFI negative paths pinned (huge payload, postcard error)`

## Task 0.6: Phase 0 검증 게이트

Run: `cargo test --workspace && pnpm -r test`
Expected: TS F3 테스트만 FAIL(그것이 F3의 증명). 나머지 PASS 또는 ignore. F3 failing 테스트는 Phase 1에서 통과로 전환.

---

# Phase 1 — 결함 수정 (Fix) — task 단위 (진입 시 세분화)

> 각 task는 "Phase 0 baseline 테스트를 통과/활성화하는 구현"이다. P0 → P2 순.

## Task 1.1 [P0-F1]: FFI 패닉 격리 — catch_unwind

- `crates/rustra/src/ffi.rs`: `dispatch_json`을 `std::panic::catch_unwind`로 감싸 패닉을 `FfiResponse { ok:false, error:"internal: panic ..." }`로 변환. `AssertUnwindSafe` 주의.
- `crates/rustra/src/ffi.rs`: postcard path(`dispatch_postcard`/`rustra_ffi_invoke_postcard`)에도 동일 적용.
- `examples/calculator/src/lib.rs`: `extern "C"` 본문 내 `.expect()` 7곳(577,764,821,877,949,1003,1045)을 `match`/`?` 기반 에러 반환으로 교체.
- `crates/rustra/src/lib.rs`: `Package::invoke_json`(387-402) 핸들러 실행부도 catch_unwind 적용 검토(core 계층 방어).
- Task 0.4의 F1 ignore 테스트에서 `#[ignore]` 제거 → 패닉 핸들러 등록 후 clean error 단언.
- **검증:** `cargo test panic_in_handler` 통과. 별도 프로세스(`Command::new`)로 "abort 안 함" 증명.
- 커밋: `fix(ffi): isolate handler panics via catch_unwind (F1)`

## Task 1.2 [P0-F3]: RN/Lynx async 래핑 + try/catch

- `packages/react-native/src/index.ts:34`: `invoke<T>`를 `async`로 변경, 본문을 `try/catch`로 감싸 모든 실패(JSON.stringify/invoke/JSON.parse/!ok)를 `Promise.reject(new RustraCommandError(...))`로 정규화.
- `packages/lynx/src/index.ts:84`: JSON fallback `createLynxEngine` 동일 적용.
- Task 0.1 baseline 테스트가 통과로 전환 (sync throw → rejected promise).
- **검증:** `cd packages/react-native && pnpm test && cd ../lynx && pnpm test` — F3 테스트 녹색.
- 커밋: `fix(rn,lynx): wrap invoke in async try/catch — honor Promise<T> (F3)`

## Task 1.3 [P1-F4]: 에러 클래스 통일

- `packages/react-native/src/index.ts` / `packages/lynx/src/index.ts`: error 응답에서 code/message를 파싱해 `RustraCommandError(code, message)` throw (Node/Bun/Tauri와 일치).
- `packages/types/src/index.ts:381`: unknown-command reject를 `RustraCommandError('command.not_found', ...)`로 변경.
- 에러 응답 형식 합의 — 현재 RN/Lynx는 `error: string`(전체). code/message 분리 포맷 또는 문자열 파싱 규칙 정의 (Node는 `{code,message}` 객체; RN 네이티브도 동일 포맷으로).
- Task 0.2 baseline 테스트를 "RustraCommandError + code 보존" 단언으로 전환.
- 커밋: `fix(adapters): unify error class to RustraCommandError across adapters (F4)`

## Task 1.4 [P1-F2]: rustra_ffi_free 가드

- `crates/rustra/src/ffi.rs:263`: `debug_assert!`로 double-free/wrong-len 탐지(간단한 할당-추적 또는 최소한 len 일치 검증). `# Safety` 문서 강화.
- Task 0.4의 F2 ignore 제거 → wrong-len 케이스 단언.
- 커밋: `fix(ffi): guard rustra_ffi_free against double-free/wrong-len (F2)`

## Task 1.5 [P1-F5]: contract hash 런타임 검증

- `packages/types/src/index.ts`: `createRkyvV2Engine` 옵션에 `contractHash?: string` 추가 (opt-in, 기본 미검증 = 하위 호환). 엔진이 native의 hash(getSchema 메타데이터 또는 별도 FFI)와 비교해 불일치 시 reject.
- Rust 측: `rustra_ffi_get_schema` 응답 또는 별도 `rustra_ffi_contract_hash()`로 hash 노출.
- Task 0.3 baseline 테스트를 "hash 옵션 전달 시 불일치 reject"로 전환.
- 커밋: `feat(contract): opt-in runtime contract-hash enforcement (F5)`

## Task 1.6 [P2-F8]: get_schema null 체크

- `crates/rustra/src/ffi.rs:280`: `out_len.is_null()` 체크 추가(형제 172/200/234와 일치) → null 시 null ptr 반환.
- Task 0.4의 F8 ignore 제거.
- 커밋: `fix(ffi): null-check out_len in rustra_ffi_get_schema (F8)`

## Task 1.7: Phase 1 검증 게이트

- `cargo test --workspace && pnpm -r test` 전체 녹색.
- ignore 테스트 0개(F1/F2/F8 모두 활성화).
- F3/F4/F5 baseline 테스트가 새 단언으로 통과.

---

# Phase 2 — 교차 호환 증명 (Prove) — task 단위 (진입 시 세분화)

## Task 2.1: Rust fixture emit 도구

- Rust 예제/테스트 보조: calculator의 각 command(addNumbers, greet, sumList 등) encode 결과(성공 postcard Tier1/2, Tier3 JSON, 에러 프레임)를 **hex 문자열**로 출력하는 harness. `crates/rustra/examples/emit_wire_fixtures.rs` 또는 `#[test]` `--nocapture`.
- 출력 대상 타입: 원시/enum-with-data/Option/String/Vec/중첩/에러.

## Task 2.2: TS checked-in fixture + snapshot 일관성

- `packages/types/test-fixtures/wire.json` (또는 generated에 checked-in): emit된 hex 상수.
- TS 테스트: hex → bytes → **실제 generated codec**(`addNumbersCodec` 등) decode → 값 일치 단언. stub codec 금지.

## Task 2.3: 역방향(TS encode → Rust decode)

- TS codec `encode()` 결과를 Rust `invoke_rkyv_v2`가 수락함을 증명. hex를 TS에서 생성 → Rust 테스트가 같은 hex(from test-fixture)를 decode.

## Task 2.4: Rust snapshot 테스트 (드리프트 감지)

- Rust 테스트: "현재 encode 결과 == checked-in hex" — encode가 바뀌면 CI 실패 → fixture 의도적 갱신 필요.

## Task 2.5: C++ JSI codec 교차 검증

- 같은 fixture hex를 generated C++ codec(`generate.ts:506` postcard)이 round-trip 함을 증명. C++ 유닛테스트 또는 RN JSI 통합 테스트.

## Task 2.6: 에러 프레임 + 잘린/unknown-id 교차

- Rust 에러 프레임 → TS RustraCommandError(code,message). 잘린/unknown-id/malformed → 양쪽 동일 거동.

## Task 2.7: Phase 2 게이트

- Rust↔TS↔C++ 교차 round-trip 녹색. snapshot 일관성 녹색.

---

# Phase 3 — 깊이 강화 (Harden) — task 단위 (진입 시 세분화)

## Task 3.1: proptest 확장 (i64 전체 범위 2^53/2^32 초과, 유니코드, 중첩)

## Task 3.2: FFI 동시성 (`extern "C"` 다중 스레드 + OnceLock global Package)

## Task 3.3: TS 동시 invoke 순서/재진입 + invokeBatch 에러 전파

## Task 3.4: large/zero-len/malformed payload (양쪽)

## Task 3.5: F7 필드 순서 자동 검증 (비-알파벳순 struct 드리프트 감지 테스트)

## Task 3.6: Phase 3 게이트 — 전체 스위트 + proptest 통과

---

# 완료 기준 (전체)

1. F1: 패닉 핸들러가 호스트 abort 없이 clean `RustraError` 반환 (별도 프로세스 증명).
2. F2/F8: FFI 메모리/포인터 결함이 가드 + 테스트로 보호.
3. F3/F4: 모든 어댑터가 `Promise<T>` + `RustraCommandError(code,message)` 계약 준수.
4. F5: opt-in contract hash 검증 동작.
5. F6: checked-in fixture 기반 Rust↔TS↔C++ 교차 round-trip 녹색 + snapshot 드리프트 감지.
6. F7: 필드 순서 드리프트 감지 테스트 존재.
7. Phase 3: proptest/동시성/large/malformed 녹색.
