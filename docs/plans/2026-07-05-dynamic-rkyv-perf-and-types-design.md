# Dynamic rkyv V2 (Tier 3) + Runtime Registry — 성능 측정 및 타입별 테스트 Design

> 날짜: 2026-07-05
> 목표: 이미 구현된 dynamic import(런타임 `register` → rkyv V2 Tier 3 JSON 경로 + TS fallback)에 대해
> (1) Rust 코어 성능 벤치마크, (2) 다양한 타입 상황별 테스트(happy + edge + error + fuzz + 동시성 stress),
> (3) TS 단위 테스트, (4) RN 데모+빌드 검증을 **모두 완료** 한다.
> 범위: **전체 스택** (Rust + TS + RN). 사용자 확정.
> 접근: criterion 정식 benches + proptest 속성 테스트 + 다중 스레드 동시성 스모크.

---

## 1. 배경 (코드 기반 사실)

- **dynamic import 경로** = 런타임 `register`/`register_fn` → `build_command(force_tier3=true)` →
  `rkyv_v2_handler = None` + `build_tier3_json_decoder()` + Tier 3 응답 인코더.
  `invoke_rkyv_v2` 는 handler 가 `None` 이면 Tier 3 fallback 디스패치 (lib.rs:401).
- **정적 경로** = `PackageBuilder::command` → `force_tier3=false` → postcard fast handler.
- **TS fallback** = `createRkyvV2Engine`: static codec miss → `getLiveSchema` commandId 조회 →
  `encodeTier3Request` → `native.invokeRkyvV2` → `decodeTier3Response` (index.ts:212).

### 도달 가능한 두 wire (핵심)
- **정적(postcard)**: req `[cmd_id: u16 LE @0][postcard(I) @2]`,
  resp `[ok: u8 @0=1][postcard(O) @8]`.
- **동적(Tier 3 JSON)**: req `[cmd_id: u16 LE @0][json utf8 @2]`,
  resp `[ok: u8 @0=1][pad 3B][json_len: u32 LE @4][json @8]`.
- **error**: `[ok: u8 @0=0][pad to @8][err_len: u16 LE @8][err utf8 @10]`.

> 스키마 구동 Tier1/2 바이너리 디코더(`rkyv_v2_decode`)는 정적 명령에선 postcard handler 가
> 항상 우선(discord)하므로 사실상 도달 불가. 본 측정/테스트는 **실제 도달하는 두 경로**에 집중한다.

---

## 2. 섹션별 설계

### 2.1 Rust 벤치마크 (criterion, `crates/rustra/benches/`)

의존성: `criterion` 을 `[dev-dependencies]` + `[[bench]] { harness = false }` 3종.

- **`tier_compare.rs`**: 동일 의미(add/echo)를 (a) 정적 Tier 1 postcard, (b) 정적 Tier 2(String/Vec) postcard,
  (c) 동적 Tier 3 JSON 으로 구성 → `invoke_rkyv_v2` end-to-end p50/p99 비교.
  → "동적 Tier 3 가 정적 Tier 1 대비 몇 배 느린가" 정량화.
- **`dynamic_registry.rs`**: `register()` 1회 비용(스키마 생성 포함), `live_schema()` 조회 비용,
  frozen vs mutable 의 `invoke_rkyv_v2` read 경로 차이.
- **`type_scaling.rs`**: 동적 Tier 3 경로 payload 1/10/100/1000 items 확장성.

### 2.2 Rust 타입별 와이어 테스트 (`crates/rustra/tests/rkyv_v2_wire.rs` 신규)

현재 `crates/rustra` 에서 Tier 1/2 wire = zero coverage 해소. `invoke_rkyv_v2` round-trip 검증:

| 경로 | 타입 |
|------|------|
| 정적 Tier 1 | i64/i32/u16/f64/bool 단일·다중필드, 정렬 |
| 정적 Tier 2 | String, Vec<i64>/Vec<f64>/Vec<u8>/Vec<bool>/Vec<i32> |
| 동적 Tier 3 | HashMap/BTreeMap, tuple, enum-with-data, Option, 중첩 구조체, 위 모든 타입 |

- **edge**: 빈 Vec/String, 유니코드·이모지, null, 큰 payload(10K items), f64 특수값.
- **error**: 잘린 payload(<2B/<8B), 알 수 없는 command_id, malformed JSON, frozen 후 mutation,
  unregister 후 invoke, replace 누락, id 소진.

### 2.3 Rust fuzz + 동시성 (`tests/rkyv_v2_fuzz.rs`, `tests/rkyv_v2_concurrency.rs`)

- **proptest**: Tier 1 임의 i64/f64/bool 조합 round-trip 보존; Tier 2 임의 길이 String/Vec round-trip;
  동적 Tier 3 임의 JSON Value → echo → 의미 보존.
- **동시성**: `std::thread` N write(register/unregister) + M read(invoke_rkyv_v2/live_schema) 혼합 →
  패닉/교착/레이스 없음(실제 스레드 스모크; `loom` 은 범위 외). debug/release 양쪽 통과.

### 2.4 TS 단위 테스트 (`packages/types`, vitest 도입)

`packages/types` 에 현재 테스트 러너 없음 → `vitest` devDep 추가 + `vitest.config.ts`.

- `createRkyvV2Engine` Tier 3 fallback (mock native): static miss → getSchema → invokeRkyvV2 흐름.
- Tier 3 response 디코드(성공/에러 wire), 다양한 결과 타입.
- `getLiveSchema`: schema JSON → Map 변환, `getSchema` 누락 시 가드.
- error: live schema 에 없는 명령, schemaCache 무효화.

### 2.5 RN 데모 + 빌드 (`examples/react-native-calculator`)

- `DynamicRegistryApp.tsx` 확장: string/vec/map/중첩 타입 동적 명령 등록 → 단일 rkyvV2 엔진 호출 →
  결과 + live schema commandId/types 화면 표시.
- 빌드 파이프라인: `modules/rustra-jsi/ios/build-rust-ios.sh` (RUSTRA_PROFILE=debug) → `npx expo run:ios`.
- **검증 체크리스트**(`docs/plans/2026-07-05-rn-verification-checklist.md`): 단계별 예상 결과 + 스크린샷 가이드.

### 2.6 문서

- `docs/benchmarks.md`: 벤치 실행 후 "Dynamic commands (Tier 3)" 섹션 + Tier 비교표 추가.
- `docs/plans/2026-07-04-dynamic-rkyv-path.md` · `runtime-command-registry.md`: done criteria 체크.
- `docs/architecture.md`: dynamic path 테스트/벤치 참조 서브섹션.

---

## 3. 제외 (YAGNI)

- TS postcard runtime encoder, live schema push, `loom` 정합성 테스트, criterion 의 custom 플러그인.

---

## 4. 완료 기준

- [x] `cargo bench -p rustra --profile dev` 3종(tier_compare/dynamic_registry/type_scaling) 정상 동작 + 수치 기록. → `docs/benchmarks.md` "동적 명령 (Tier 3)" 섹션.
- [x] `cargo test -p rustra`(wire 27 / fuzz 5 / concurrency 3) 전부 pass. `cargo test --release -p rustra` 도 pass(정적 10종). `cargo clippy -- -D warnings` / `cargo fmt --check` clean.
- [x] TS Tier 3 fallback 단위 테스트 pass — `packages/types/src/index.test.ts` (8 tests, `npm run test:types`, node:test 기반으로 vitest 대신 저장소 표준 채택).
- [x] RN 데모 코드(`DynamicRegistryApp.tsx` 4종 타입) + 빌드 스크립트(`build-rust-ios.sh`) + 검증 체크리스트(`docs/plans/2026-07-05-rn-verification-checklist.md`) 작성(실행은 사용자 로컬).
- [x] `docs/benchmarks.md` 동적/Tier 3 수치 추가, 양쪽(2026-07-04) design done criteria 체크, `docs/architecture.md` 서브섹션 추가.
