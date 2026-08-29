# 성능 트랙 Plan 1 — Complex 코어 (A: 스키마 사전컴파일 → B: serde 어댑터) + Bun BigInt fast-path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조사 결과 1·2순위 병목을 와이어 무변경으로 제거한다 — (1) complex 코어의 매 호출 schema clone/정렬, (2) complex 코어의 `serde_json::Value` 3회 왕복, (3) Bun generated 경로의 safe-integer BigInt 강제.

**Architecture:** 트랙 A→B 순차 (A의 컴파일된 스키마 표현이 B의 serde 어댑터 재료). Bun 트랙은 코어와 파일 비중복이라 병렬 가능. 모든 단계 끝에 PINNED hex byte-exact 게이트.

**Tech Stack:** Rust (postcard, serde, rkyv), TypeScript (Bun FFI, 코드젠 템플릿), Bun test, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-29-perf-five-tracks-design.md`

## Global Constraints

- 와이어 포맷 무변경 — PINNED hex fixture 3면(`wire_fixtures.rs` ↔ `cross-wire.test.ts` ↔ C++ codec test) byte-exact 유지
- `DirectResponse`/into-handler 계약(비멱등 커맨드 재실행 금지) 유지
- 코드젠 이중 경로(Rust bin + TS CLI)로 generated/ 재생성, generated/는 prettier 제외
- lefthook pre-commit이 prettier 포맷 → 커밋 후 amend
- 벤치 수치는 로드 평균 조건을 영수증에 기재

---

## 트랙 A — Complex 코어 스키마 사전컴파일

### Task A1: 컴파일된 스키마 노드 타입 설계 + failing test

**Files:**
- Create: `crates/rustra/src/complex_schema_ir.rs`
- Test: `crates/rustra/src/complex_into_tests.rs` (기존 파일에 추가) 또는 신규 IR 테스트 모듈

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성** — `ResolvedNode` IR 빌드 함수 검증:

```rust
// $ref → 인라인 전개, allOf 단일 → 평탄화, option(type/anyOf 2택+null) →
// OptionKind 변형, oneOf → 변형 정렬 완료(basic key 순) 상태로 컴파일됨을 검증
#[test]
fn compiles_refs_options_and_sorted_variants() { /* ... */ }
```

- [ ] **Step 2: 테스트 실패 확인** — `cargo test -p rustra complex_schema_ir 2>&1 | tail -5` → FAIL (모듈 부재)
- [ ] **Step 3: IR 구현** — 노드 종류: Scalar(format별)/String/Bool/Null/Seq{Box<ResolvedNode>}/Option{Box}/Struct{Vec<(String, ResolvedNode)>, required set}/Enum/Const/DataEnum{sorted variants}/Map. `$ref`는 빌드 시 전개(재귀는 `Arc`+depth 한도로). `variants()`의 클론+정렬을 빌드로 이동 — key는 컴파일 시점 1회 결정
- [ ] **Step 4: 통과 확인** — `cargo test -p rustra`
- [ ] **Step 5: 커밋** — `feat(core): complex 스키마 IR 사전컴파일`

### Task A2: encode/decode를 IR 순회로 전환

**Files:**
- Modify: `crates/rustra/src/complex_codec.rs` (encode_node/decode_node → IR 매칭), `crates/rustra/src/command.rs` (Command에 컴파일된 IR 보관)
- Test: 기존 complex codec 테스트 전수

**Steps:**

- [ ] **Step 1: 실패 테스트** — 기존 complex round-trip 테스트(`complex_into_tests.rs`, `command.rs` tests, wire fixtures)를 그대로 게이트로 쓴다. IR 전환 후에도 동일 바이트임을 명시하는 테스트 1개 추가 (같은 페이로드 → 구현 전후 동일 hex — fixture로 충분)
- [ ] **Step 2: 구현** — `complex_encode`/`complex_decode`/`complex_encode_into`가 `&Value` 스키마 대신 `&ComplexSchemaIr`을 받는 오버로드로 전환. 기존 `&Value` 시그니처는 IR 빌드→호출 래퍼로 유지(외부 호환). 매 호출 `resolved_schema`/`option_inner`/`variants` 호출 소멸
- [ ] **Step 3: Command 연결** — `build_command`에서 input/output IR을 1회 컴파일해 `rkyv_v2_handler`/`rkyv_v2_into_handler` 클로저가 Arc로 캡처
- [ ] **Step 4: 전체 게이트** — `cargo test -p rustra` + wire fixture byte-exact
- [ ] **Step 5: 벤치 + 커밋** — `cargo bench -p rustra` (complex 라우트 벤치 있으면 실행, 없으면 트랙 B 끝에 일괄) → `perf(core): complex 스키마 IR 순회 — 매 호출 clone/정렬 제거`

### Task A3: JS complex-codec 미러 (스키마 resolve 캐시)

**Files:**
- Modify: `packages/types/src/complex-codec.ts` (resolvedSchema/optionInner/variants → codec 생성 시 1회 컴파일)
- Test: `packages/types/src/complex-codec.test.ts`, cross-wire 게이트

**Steps:**

- [ ] **Step 1: 실패 테스트** — 동일 codec 재호출 시 resolve가 재수행되지 않음을 검증(스파이 또는 성능 계약 대신 "encode→decode→encode 동일 바이트 + variants 정렬 불변식" 테스트로 대체 가능)
- [ ] **Step 2: 구현** — `createComplexCodec`에서 input/output 스키마를 1회 컴파일한 클로저 트리로 encode/decodeNode 전환 (Rust IR과 동일 전략, JS는 객체 트리 캐시)
- [ ] **Step 3: 게이트** — `bun test packages/types` + cross-wire byte-exact
- [ ] **Step 4: 커밋** — `perf(types): JS complex codec 스키마 사전컴파일`

---

## 트랙 B — Complex 코어 serde 어댑터 (Value 왕복 제거)

**선행: 트랙 A 머지** (IR이 어댑터의 wire-encoding 엔진으로 재사용됨)

### Task B1: serde Serializer 구현 (complex 바이너리 → I 타입)

**Files:**
- Create: `crates/rustra/src/complex_serde.rs`
- Test: `crates/rustra/tests/complex_serde_roundtrip.rs`

**Steps:**

- [ ] **Step 1: 실패 테스트** — `complex_reader::from_bytes::<AddNumbersInput>(bytes, ir)`가 `complex_decode`+`from_value` 결과와 동일한 `I`를 만든다는 프로퍼티 테스트 (기존 fixture 타입 전수)
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: Deserializer 구현** — IR 노드별 `deserialize_*` 매핑 (Scalar→visitor visit_*, Option→visit_none/visit_some, Seq→visit_seq, Struct→visit_map, DataEnum→variant 인덱스→visit_enum). 와이어는 IR 순회와 동일 바이트
- [ ] **Step 4: 통과** — round-trip + 기존 게이트
- [ ] **Step 5: 커밋** — `feat(core): complex 바이너리 serde Deserializer`

### Task B2: serde Serializer 구현 (O 타입 → complex 바이너리)

**Files:**
- Modify: `crates/rustra/src/complex_serde.rs`
- Test: `crates/rustra/tests/complex_serde_roundtrip.rs`

**Steps:**

- [ ] **Step 1: 실패 테스트** — `complex_writer::to_bytes::<O>(&output, ir)`가 `to_value`+`complex_encode` 결과와 byte-exact
- [ ] **Step 2: Serializer 구현** — IR 노드별 `serialize_*` 매핑, bounded writer 재사용 (into 경로 포함)
- [ ] **Step 3: 게이트** — round-trip byte-exact + wire fixtures
- [ ] **Step 4: 커밋** — `feat(core): complex 바이너리 serde Serializer`

### Task B3: 핸들러 체인 전환

**Files:**
- Modify: `crates/rustra/src/command.rs:125-258` (complex 분기 2곳)
- Test: 기존 전체 게이트

**Steps:**

- [ ] **Step 1: 실패 테스트** — complex 라우트 명령이 Value 없이 처리됨을 검증 (기존 테스트가 이미 wire로 검증하므로, 여기선 성능 회귀 게이트로 criterion or iter 벤치 추가)
- [ ] **Step 2: 구현** — `complex_decode+from_value` → `complex_serde::from_bytes::<I>` / `to_value+complex_encode` → `complex_serde::to_bytes::<O>`. into-handler도 `complex_encode_into` → serde bounded writer로 전환. Value 트리 3회 왕복 소멸
- [ ] **Step 3: 전체 게이트** — `cargo test -p rustra -p rustra-macros` + wire fixtures + `bun run test:ts:node` (JS codec과의 cross-wire)
- [ ] **Step 4: 벤치** — core dispatch addNumbers/echoGroups before/after (트랙 A 직후 동일 측정과 비교) → `docs/benchmarks.md` 갱신
- [ ] **Step 5: 커밋** — `perf(core): complex 라우트 serde 직결 — Value 트리 왕복 제거`

---

## 트랙 C — Bun BigInt fast-path (트랙 A/B와 병렬 가능)

### Task C1: safe-integer number zigzag64 fast path (실패 테스트)

**Files:**
- Modify: `packages/cli/src/codegen-postcard-wide.ts:46-91` (`_pcEncodeZigzag64`/`_pcDecodeZigzag64`)
- Test: `packages/cli/src/generate.test.ts` + cross-wire

**Steps:**

- [ ] **Step 1: 실패 테스트** — 생성된 코드에서 safe integer 입력이 number 산술 경로를 타는지 검증:
```ts
// _pcEncodeZigzag64(20) → number 경로 (BigInt alloc 0)
// _pcEncodeZigzag64(-1) → number 경로 (zigzag → 1, varint 1바이트)
// _pcDecodeZigzag64(<1바이트 varint>) → number 반환
// 경계: 2^53-1 / -2^53 → number 경로, 2^53+1 / -(2^53+1) → bigint 경로
// 출력 동일성: number 경로와 BigInt 경로의 바이트 동일 (기존 게이트 패턴)
```
- [ ] **Step 2: 실패 확인** — `cd packages/cli && bun test src/generate.test.ts` → FAIL
- [ ] **Step 3: 구현** — encode: `typeof v === 'number' && Number.isSafeInteger(v)`면 number zigzag `(v << 1) ^ (v >> 31)` **주의: 32비트 시프트 한계** — safe 53비트 전체는 `v * 2` + 부호 분기로 처리(또는 32비트 내에서만 시프트). decode: 첫 바이트 유무와 최대 7바이트 누적으로 safe 판정 후 number zigzag 역변환, unsafe면 기존 BigInt 이월 경로 (기존 `_pcDecodeVarint64`의 7바이트 number 누적 패턴 재사용)
- [ ] **Step 4: 게이트** — `bun test packages/cli` + generated 재생성 + cross-wire byte-exact (`u64::MAX`/`i64::MIN`/2^53 경계 fixture 유지)
- [ ] **Step 5: 커밋** — `perf(cli): zigzag64 safe-integer number fast path`

### Task C2: encodeInto 인라인 경로에도 적용

**Files:**
- Modify: `packages/cli/src/generate-postcard-encode-into.ts:35`, `packages/cli/src/generate-postcard-encode-fields.ts:18,94`, `packages/cli/src/generate-postcard-encoding-support.ts:17,23` (emit 템플릿)
- Test: `packages/cli/src/generate.test.ts`

**Steps:**

- [ ] **Step 1: 실패 테스트** — encodeInto emit이 safe number에 BigInt 없이 기록하는지 스냅샷/동일성 테스트
- [ ] **Step 2: 구현** — emit 템플릿에서 `_x = BigInt(expr)` 대신 헬퍼 호출(헬퍼가 number/BigInt 이중 경로)로 통일 — 인라인 복붙 템플릿 제거가 유지보수성도 개선
- [ ] **Step 3: 게이트** — 코드젠 재생성 + 전체 테스트 + wire 게이트
- [ ] **Step 4: 커밋** — `perf(cli): encodeInto 와이드 정수 경로 헬퍼 통일`

### Task C3: Bun 어댑터 잔여 — slice 제거 + raw capability

**Files:**
- Modify: `packages/bun/src/index.ts:182-235` (slice 제거), raw capability 노출
- Test: `packages/bun/` 테스트 + transport-bench

**Steps:**

- [ ] **Step 1: 실패 테스트** — `_into` 응답이 복사 없이 재사용 ArrayBuffer 뷰로 반환되는지(또는 소유 계약 문서화) 검증
- [ ] **Step 2: 구현** — (a) 길이 우선 조회 FF I(`_into`가 out_len을 이미 반환) → 정확한 크기 재사용 ArrayBuffer + subarray 반환. **주의: 소유 계약** — large-buffer 경로(`:218` 주석)의 소유 이전과 섞이지 않게. (b) `invokeTypedRaw` FFI 바인딩 노출로 Bun 네이티브 capability에 CODEC_RAW 추가 → fields fast route活了 (`rkyv-engine.ts:432`의 조건 충족)
- [ ] **Step 3: 게이트 + 벤치** — `bun test`, `bun scripts/transport-bench.mjs`, `bun run bench:hosts` before/after → `docs/benchmarks.md` 갱신
- [ ] **Step 4: 커밋** — `perf(bun): 응답 slice 제거 + raw capability 노출`

### Task C4: 트랙 C 통합 검증

- [ ] **Step 1:** `cargo test && bun run test:ts:node` (전체)
- [ ] **Step 2:** host-matrix 재측정 → receipt + `docs/benchmarks.md` 갱신
- [ ] **Step 3:** PR + CI green

---

## 병렬 실행 노트

- 트랙 A→B는 순차 필수 (B가 A의 IR 재사용). 트랙 C는 A와 파일 비중복 → 병렬 가능
- 트랙 B는 `complex_serde.rs` 신규라 `tauri_support.rs`와 무충돌, 다만 `command.rs`는 트랙 A(A2)와 B(B3)가 순차 점유
- JS 측(complex-codec.ts, rkyv-codecs.ts)은 서로 다른 트랙이므로 커밋 단위 분리
- generated/ 재생성 잊지 말 것 (코드젠 이중 경로)
