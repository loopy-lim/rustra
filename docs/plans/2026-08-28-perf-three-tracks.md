# 성능 3트랙 구현 계획 — caller-buffer / bigint / C++ complex

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `docs/benchmarks.md` 로드맵의 남은 성능 3항목(F: caller-buffer 잔여, A: bigint postcard fast-path, B: C++ complex 직결 잔여)을 와이어 포맷 무변경으로 완성한다.

**Architecture:** 순차 트랙(F→A→B). 트랙 F는 C3(Rust core)/C1(Bun)/C2(async C++) 3-way 병렬 구현 — 파일이 안 겹치므로 워크트리 분리 서브에이전트로 동시 진행. 각 트랙 끝에 wire round-trip 게이트 + 실측 벤치.

**Tech Stack:** Rust (napi/FFI, postcard, rkyv), TypeScript (codegen, Bun FFI), C++ (JSI, React Native turbo module).

**설계 문서:** `docs/plans/2026-08-28-perf-three-tracks-design.md`

---

## 트랙 F — FFI caller-buffer 잔여 범위

### Task F1: Rust — complex-route into-handler (C3) ⭐

**Files:**
- Modify: `crates/rustra/src/lib.rs:767-802` (into-handler 생성 게이트), `crates/rustra/src/complex_codec.rs` (bounded writer)
- Test: `crates/rustra/tests/` (wire round-trip 게이트 확장)

**Step 1: 실패하는 테스트 작성**

`crates/rustra/tests/`에 complex 커맨드의 into-handler 존재 + DirectResponse::Written 확인 테스트 추가:

```rust
// complex 커맨드가 into-handler를 가져야 한다 (현재 None → Buffered 폴백)
#[test]
fn complex_command_has_into_handler() {
    let pkg = test_package_with_complex_command();
    assert!(pkg.into_handler_for(COMPLEX_CMD_ID).is_some());
}
```

(실제 테스트 시그니처는 기존 `js_codec_supported` 커맨드 테스트를 참조해 동일 패턴으로 작성)

**Step 2: 테스트 실패 확인**

Run: `cargo test -p rustra --test <새테스트파일> 2>&1 | tail -5`
Expected: FAIL (into-handler가 None)

**Step 3: 구현**

1. `complex_codec.rs`에 bounded writer 기반 `encode_into_slice(writer: &mut &mut [u8], ...) -> Result<usize>` 추가 — 0.4.1의 bounded reader/writer 인프라 재사용
2. `lib.rs` into-handler 생성부(:767)에서 complex 커맨드도 핸들러 생성하도록 게이트 확장
3. 오버플로우 시 기존 `Buffered` 폴백 유지

**Step 4: 테스트 통과 확인**

Run: `cargo test -p rustra 2>&1 | tail -10`
Expected: PASS (기존 wire 게이트 포함 전부)

**Step 5: 커밋**

```bash
git add -A && git commit -m "perf(core): complex-route into-handler — DirectResponse::Written 경로"
```

### Task F2: Bun 어댑터 `_into` 바인딩 (C1)

**Files:**
- Modify: `packages/bun/src/index.ts:136-141, 183-200`
- Test: `packages/bun/` 기존 테스트 러너에 rkyv V2 round-trip + `_into` 경로 확인

**Step 1: 실패하는 테스트**

Bun 테스트에 into 경로 검증 추가:

```ts
// into 바인딩이 malloc 없이 응답을 쓰고 상태 코드를 반환하는지
// 기존 rkyv V2 round-trip 테스트를 _into FFI로 재실행하는 형태
```

(기존 `packages/bun/` 테스트 구조 참조해 동일 패턴)

**Step 2: 테스트 실패 확인**

Run: `cd packages/bun && bun test 2>&1 | tail -5`
Expected: FAIL (바인딩 부재)

**Step 3: 구현**

`packages/bun/src/index.ts`에 `rustra_ffi_invoke_rkyv_v2_into` FFI 바인딩 추가:

```ts
const invoke_rkyv_v2_into = new CCallableFunction(
  "pointer",
  "pointer", // command id
  "pointer", // request ptr
  "usize",
  "pointer", // response buffer ptr
  "usize",   // response buffer capacity
  "pointer", // out actual size ptr
  "u64",     // status
);
```

호출부: 512B 스택 버퍼(전역 재사용 `Uint8Array`) → status 확인 → 필요 시 exact-size heap 재시도. `copyOwned`/malloc 경로는 폴백으로 유지.

**Step 4: 테스트 통과 + 벤치**

Run: `cd packages/bun && bun test`
Expected: PASS

Bun bench before/after 실측 (기존 레시피: `toArrayBuffer` zero-copy 뷰 함정 기억).

**Step 5: 커밋**

```bash
git add -A && git commit -m "perf(bun): rkyv V2 caller-buffer 바인딩 — malloc/복사 제거"
```

### Task F3: C++ async `_into` 변형 (C2)

**Files:**
- Modify: `crates/rustra/src/ffi.rs` (async into FFI 추가), `packages/react-native/native/cpp/RustraJSIBridge.{hpp,cpp}:1153-1209`
- Test: RN 예제 cpp 테스트 확장 또는 rust 테스트

**Step 1: 실패하는 테스트**

Rust 측: `rustra_ffi_invoke_rkyv_v2_async_into`의 완료 콜백이 caller 버퍼에 직접 쓰는지 검증하는 rust 테스트 추가.

**Step 2: 실패 확인**

Run: `cargo test -p rustra 2>&1 | tail -5`
Expected: FAIL

**Step 3: 구현**

1. `ffi.rs`: `rustra_ffi_invoke_rkyv_v2_async_into` — JS ArrayBuffer 포인터를 콜백 클로저가 캡처, 완료 시 Rust가 직접 write. 기존 `alloc_response` 대신 caller buffer 사용. 수명 계약: JS가 콜백까지 버퍼 유지 (기존 `invokeTypedAsync` 프라미스 구조와 동일)
2. `RustraJSIBridge.cpp`: async 콜백에서 `std::vector frame` 복사 제거, in-place decode로 전환

**Step 4: 통과 확인**

Run: `cargo test -p rustra && (RN 예제 cpp 테스트 스크립트)`
Expected: PASS

**Step 5: 커밋**

```bash
git add -A && git commit -m "perf(rn): async 응답 caller-buffer — std::vector 복사 제거"
```

### Task F4: 트랙 F 통합 검증

**Step 1:** `cargo test -p rustra -p rustra-macros && cd packages/types && bun test`
**Step 2:** Bun bench before/after 수치 기록 → `docs/benchmarks.md` 갱신
**Step 3:** PR 생성 (perf/base-complex-codec 기반... 아니면 main 기반) + CI green 확인

---

## 트랙 A — bigint postcard fast-path

### Task A1: 64-bit varint/zigzag 런타임 헬퍼

**Files:**
- Modify: `packages/cli/src/codegen.ts:296-343` (`_pcEncodeVarint` 등 헬퍼 아래에 추가)
- Test: `packages/cli/src/generate.test.ts` (헬퍼 단위 검증)

**Step 1: 실패하는 테스트**

`generate.test.ts`에 헬퍼 검증 추가:

```ts
// 생성된 코드에서 _pcEncodeVarint64(2n**64n - 1n) → 10바이트 LEB128
// _pcDecodeVarint64 역변환 → 2n**64n - 1n
// safe number 입력: number 연산 경로 (출력 동일)
// 2^53+1 입력: bigint 반환 (정밀도 계약)
```

**Step 2: 실패 확인**

Run: `cd packages/cli && bun test src/generate.test.ts 2>&1 | tail -5`
Expected: FAIL (헬퍼 부재)

**Step 3: 구현**

`codegen.ts` 헬퍼 섹션에 추가:

```ts
export const _pcEncodeVarint64 = (v: number | bigint, w: { push(...): void }) => {
  const big = typeof v === "bigint" ? v : BigInt(Math.trunc(v));
  // LEB128 루프 — low 7 bits + continuation
};
export const _pcDecodeVarint64 = (r) => {
  // LEB128 → bigint 누적
  // 반환: Number.isSafeInteger(Number(acc)) ? Number(acc) : acc
};
// zigzag64: (n << 1) ^ (n >> 63) bigint 연산
```

디코드 계약: safe → number, unsafe → bigint (complex-codec.ts:103 선례).

**Step 4: 통과**

Run: `cd packages/cli && bun test src/generate.test.ts`
Expected: PASS

**Step 5: 커밋**

```bash
git add -A && git commit -m "feat(cli): 64-bit varint/zigzag 런타임 헬퍼"
```

### Task A2: 코드젠 게이트 완화 + emit 연결

**Files:**
- Modify: `packages/cli/src/generate.ts:318-356` (classifyPostcardField), `:586-615` (hasWideInteger), `:1551-1554` (commandCodecSupported), `:699-761, :1018-1035` (emit)
- Test: `packages/cli/src/generate.test.ts`
- Fixture: `examples/calculator/generated/` 재생성

**Step 1: 실패하는 테스트**

```ts
// int64/uint64 필드를 가진 스키마가 postcard fast-path codec을 받는지
// (현재: createComplexCodec 폴백 → 기대: _pcEncodeVarint64 사용 codec)
```

**Step 2: 실패 확인**

Run: `cd packages/cli && bun test src/generate.test.ts 2>&1 | tail -5`
Expected: FAIL (complex 폴백이 생성됨)

**Step 3: 구현**

1. `classifyPostcardField`: format int64/uint64 → 새 종류 `'uvar64'`/`'zigzag64'` 반환
2. `hasWideInteger` 게이트 완화 — 와이드 정수가 fast-path 처리 가능함을 반영
3. encode/decode/encodeInto emit에서 와이드 필드 → `_pcEncodeVarint64`/`_pcDecodeVarint64` 사용

**Step 4: 통과**

Run: `cd packages/cli && bun test`
Expected: PASS

**Step 5: generated/ 재생성 + wire fixture**

```bash
# 코드젠 이중 경로 (메모리 참고: Rust bin + TS CLI 둘 다)
cargo run -p rustra --bin ... # 또는 프로젝트 코드젠 커맨드
bun run codegen  # 실제 커맨드 확인 후 사용
```

wire fixture에 `u64::MAX`, `i64::MIN`, 2^53 경계 케이스 추가:
- `examples/calculator/tests/wire_fixtures.rs` + TS 측 cross-wire 테스트
- `u64::MAX` → TS `18446744073709551615n` round-trip
- 2^53+1 → bigint 반환 확인

**Step 6: 전체 테스트 + 커밋**

Run: `cargo test && bun run test:ts:node` (실제 스크립트명 확인)
Expected: PASS

```bash
git add -A && git commit -m "feat(cli): bigint postcard fast-path — 와이드 정수 게이트 해제"
```

---

## 트랙 B — C++ complex 직결 잔여

### Task B1: Hermes BigInt 스파이크

**Files:**
- Create: `packages/react-native/native/cpp/` 스파이크 검증 (임시, 커밋 전 정리)
- Output: 스파이크 결과를 설계 문서에 기록

**Step 1: Hermes BigInt 가용성 확인**

RN 예제 앱 빌드 or 기존 문서/의존성에서 Hermes 버전 확인 → `BigInt` 전역, `BigInt.asIntN` 지원 여부.

방법 (빠른 순):
1. Hermes 소스/릴리스 노트 확인 (rn 브랜치)
2. 기기/시뮬레이터에서 `typeof BigInt` 런타임 체크 (기존 RN 예제 앱에 임시 체크 코드)

**Step 2: JSI 경계 전달 방식 결정**

- `jsi::Value`에 bigint 타입이 없음 → 전달 방법: (a) BigInt 전역 함수 호출로 변환, (b) 문자열 경유, (c) 지원 불가 결론
- (a)가 가능하면: decode 시 C++가 `BigInt(value)` 호출로 bigint JSI Value 생성

**Step 3: 결과 기록 + 분기**

- 가능 → B1-구현으로 (int64/uint64 C++ decode 확장)
- 불가 → `cppComplexNativeSupported` 게이트 유지, 계약을 `docs/benchmarks.md`에 명시 문서화, 트랙 B는 B2만

### Task B2: C++ Set 직결

**Files:**
- Modify: `packages/cli/src/generate.ts:2613-2652` (cppComplexNativeSupported), C++ encode/decode emit (Set 처리), `packages/cli/src/codec-ir.ts` (필요 시)
- Test: `packages/cli/src/generate.test.ts`, C++ 예제 스위치 스냅샷

**Step 1: 실패하는 테스트**

```ts
// uniqueItems sequence가 cppComplexNativeSupported를 통과하는지
// C++ encode emit이 정렬+중복제거 코드를 내는지
```

**Step 2: 실패 확인**

Run: `cd packages/cli && bun test src/generate.test.ts 2>&1 | tail -5`
Expected: FAIL (현재 uniqueItems → false)

**Step of Step 3: 구현**

1. `cppComplexNativeSupported`: `sequence.uniqueItems` → 원시 요소(string/number/integer/bool)인 경우 true
2. C++ encode emit: 요소 수집 → `compareCodecKeys` 순서 정렬 → 중복 제거 → postcard seq write
3. C++ decode emit: seq 읽기 → JS `Array`로 반환 (Set 복원은 JS 래퍼가 담당 — 기존 complex codec 래퍼 계약 확인)

**Step 4: 통과 + 스냅샷**

Run: `cd packages/cli && bun test && (코드젠 재생성)`
Expected: PASS, C++ 스위치에 Set 커맨드 포함

**Step 5: 커밋**

```bash
git add -A && git commit -m "feat(cli): C++ Set 직결 — 원시 요소 Set의 네이티브 encode"
```

### Task B3: PINNED hex 3면 게이트 + 벤치

**Step 1:** Set/와이드 정수 커맨드 wire fixture → TS↔C++↔Rust 동일 hex 확인
**Step 2:** JS codec 폴백 vs C++ 직결 벤치 실측 → `docs/benchmarks.md` 갱신
**Step 3:** PR + CI green

---

## 병렬 실행 노트

- 트랙 F의 F1(Rust core)/F2(Bun)/F3(async C++)는 파일 비중복 → 워크트리 분리 3-way 병렬 가능
- F2는 F1의 FFI 시그니처만 필요 (이미 존재), F3는 새 FFI 필요 → F1과 ffi.rs 충돌 가능 → F3는 F1 머지 후 시작
- A는 F1 머지 후 (같은 lib.rs 영역 아님 — 사실 독립, 병렬 가능하나 안전하게 순차)
- B1 스파이크는 A와 병렬 가능 (조사만, 코드 변경 없음)
- generated/ 재생성은 Rust bin + TS CLI 이중 경로 (메모리 참고), generated/는 prettier 제외
- lefthook pre-commit이 prettier 포맷 → 커밋 후 amend 필수 (메모리 참고)
