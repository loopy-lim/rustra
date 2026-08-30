---
date: 2026-08-29
author: loopy-lim
status: draft
type: optimization
priority: high
---

# 성능 5트랙 최적화 SPEC (perf-five-tracks)

## 문제

2026-08-29 전수 조사 결과, rustra-bridge의 각 호스트 경로에 아직 정량화된 병목이 남아 있다.
복합 스키마 명령은 호출마다 `serde_json::Value` 트리 3회 생성/소모로 로직 앞뒤가 막혀 있고
(2.9µs, 핸들러 자체는 수 ns), Bun generated 경로는 safe-integer 값에도 BigInt 산술을 강제해
raw FFI 대비 4.5x 느리며(2.27µs vs 0.5µs), Node persistent loop는 이중 JSON + 파이프로
N-API 대비 13x 느리고(16.9µs), Tauri는 JSON 4패스 + WebKit 크로싱 위에 측정 타이머
왜곡(50µs 그리드)이 얹혀 실성능조차 알 수 없다(표면 279µs). RN은 패리티 달성 상태이나
cachedProp 2단 해시와 async 이름 기반 진입 등 미세 잔여가 있고 F3/Android 기기 실측이 비어 있다.

## 해결 목표

**현재:**
- Complex 라우트 명령: `complex_decode → from_value → handler → to_value → complex_encode`
  체인으로 Value 트리 3회 왕복 (`crates/rustra/src/command.rs:133-139`). 스키마 인터프리터는
  노드마다 `schema.clone()`(`complex_codec.rs:50`), oneOf마다 variants 클론+정렬
  (`complex_codec.rs:466`). JS 코덱도 동일 구조라 echoGroups 등은 JS+Rust 이중 비용.
- Bun generated: i64 필드가 safe integer임에도 BigInt 산술 5회+ (`rkyv-codecs.ts:279-280,
  87-136`), fields fast route가 raw capability 미노출로 dead code → dispatch 4계층 통과
  (`rkyv-engine.ts:432`), `callerBuffer.slice` 복사 잔여 (`bun/index.ts:234`).
- Node persistent loop: NDJSON + `invoke_json`(Value 경로) + 문자열 연쇄 버퍼링
  (`packages/node/src/index.ts:328-439`, `loop-stdio.rs:31-44`).
- Tauri: 표준 `__TAURI__.core.invoke` + `rustra_dispatch(command: String, args: Value)` 단일
  진입점, 코어의 postcard/raw/buffer 인프라 미배선 (`tauri_support.rs:38-48`). 측정은
  batch 20호출 × 1ms 타이머 → 50µs/call 그리드로 왜곡.
- RN: 동기 경로(raw/caller-buffer/positional) 완결. 잔여는 decode PropNameID 2단 해시
  (전역 map find + weak_ptr lock, 프로퍼티당 2회), async 이름 기반 진입 + 호출당
  make_shared/뮤텍스 3회, F3/Android 기기 실측 공백.

**목표:**
- Complex 코어: 스키마 사전 컴파일(트랙 A)로 매 호출 clone/정렬 제거, 이후 serde 어댑터
  (트랙 B)로 Value 트리 왕복 통째 제거. addNumbers 2.9µs → 1µs 이하 목표.
- Bun generated: safe-integer number fast-path + raw capability 노출 + slice 제거로
  2.27µs → 1µs 내외.
- Node persistent loop: 바이너리 프레이밍(postcard/rkyv V2 into) + Buffer 누적으로
  16.9µs → 3~6µs (프로세스 경계 하한 존중).
- Tauri: 먼저 측정 정합화(Rust `Instant` 타임스탬프 차감, 배치 확대)로 실성능 규명, 이후
  `rustra_dispatch_batch` 와이어 배치로 호출당 IPC 비용 희석.
- RN: cachedProp 정적 테이블화, async byId 진입. F3/Android는 실측만.

## 성공 기준

- [ ] 와이어 포맷 무변경: 모든 트랙에서 PINNED hex fixture(3면: `wire_fixtures.rs` ↔
      `cross-wire.test.ts` ↔ C++ codec test) byte-exact 유지
- [ ] Complex 코어: complex 라우트 명령 core dispatch 기준 측정 개선 (addNumbers
      2.9µs → 1µs 이하, 트랙 B 완료 기준) + 기존 wire round-trip 게이트 전부 통과
- [ ] Bun generated: `bun run bench:hosts` 측정 개선 (2.27µs → 1µs 내외) + encode/encodeInto
      바이트 동일성 게이트 유지
- [ ] Node persistent loop: host-bench 측정 개선 + 기존 NDJSON 호환 폴백 또는 버전 협상 유지
- [ ] Tauri: 측정 리포트에 타이머 왜곡 보정된 실성능 수치가 영수증으로 기록됨
- [ ] 전체 테스트 게이트 green: `cargo test`, `bun run test:ts:node`, C++ codec tests
- [ ] 트랙 T: replace 후 JS 재호출이 재동기화 없이 성공 (generation 계약 테스트) +
      동적 명령 postcard 경로 실측 (교정된 tier_compare 기준)

## 범위 제한

- 와이어 포맷 변경 금지 — 모든 최적화는 바이트 동일성 하에서 이뤄진다
- N-API/JSI/Bun FFI 등 이미 하한에 도달한 transport 자체는 건드리지 않는다
- Node one-shot CLI 경로(2.76ms)는 저빈도 용도로 설계된 것 — 대상 아님
- Tauri 커스텀 프로토콜+fetch raw body는 본 스펙에서 측정만 정의 (구현 여부는 실측 후 별도 결정)
- RN sync 전용 API 경계(Promise 제거 표면)는 설계 결정이 필요해 본 스펙에서 제외
- 동적 명령의 release 지원은 하지 않는다 — dev 전용(release frozen) 설계 유지
- Tier 3 JSON-in-binary 자체는 유지된다 (미지원 스키마 map/data-enum 동적 명령의 폴백)
- HybridView(UI 네이티브 뷰)는 계속 범위 밖
- 벤치 측정은 로드 평균 조건을 영수증에 기재 (비리프리 환경 함정 — 세션 조건 필수)

## 트랙 T — 동적 명령 (dev) 치환 계약 + Tier 정합화

동적 명령(runtime register)은 dev 전용(release는 frozen) 설계를 유지한다. 현재 dev 치환
워크플로우(replace 후 JS 재호출)의 안전성은 JSON wire가 self-describing이라는 성질에
의존할 뿐 런타임 계약이 없다 — `schema_version`은 빌드 시점 고정값이고 치환 시 증가하는
generation이 없다. 이를 명시적 계약으로 고정한 뒤, 동적 명령도 스키마가 binary 지원
형태면 postcard fast-path를 옵트인해 JSON 3왕복(3.97µs)을 제거한다.

- **T0 치환 계약 (wire 무관)**: `schema_generation: u64`가 register/replace/unregister마다
  증가하고 live_schema + 저비용 FFI로 노출된다. TS 엔진은 동적 명령 코덱/경로 캐시에
  generation을 묶어 저장하고 호출 전 일치를 확인, 불일치 시 live_schema 재조회 + 캐시
  재구축 후 진행한다. 미등록/스키마 불일치는 기존대로 시끄럽게 실패한다(not_found /
  decode 에러) — "고치고 replace하면 JS는 아무 것도 안 해도 된다"가 런타임 보장이 된다.
- **T1 벤치 교정**: 기존 tier_compare는 서로 다른 연산(add/greet/echo) + debug 빌드라
  6.55x가 wire 차이로 오독된다. 같은 연산·같은 빌드 조건으로 재측정해 격차 실측을 교정한다.
- **T2 동적 명령 postcard 옵트인**: register 시 스키마가 js postcard 코덱 지원 형태면
  `force_tier3=false`로 binary 핸들러 활성화 (기존 `js_codec_supported` 게이트 재사용).
  TS 측은 live_schema 기반 스키마→postcard 코덱 인터프리터가 필요하다 (기존 코덱은
  타입 기반 코드젠 산물). T0의 generation 계약이 스테일 코덱의 조용한 오염을 차단한다.
  치환으로 스키마가 바뀐 직후 첫 호출은 T0 재동기화를 거치므로 잘못된 코덱으로 호출되지 않는다.

## 참고 자료

### 조사 근거 (2026-08-29 전수 조사)
- Complex 코어: `crates/rustra/src/command.rs:96-258` (핸들러 생성 3분기),
  `crates/rustra/src/complex_codec.rs:29-51` (resolved_schema clone), `:466-490` (variants
  클론+정렬), `:1021-1063` (encode/encode_into/decode 진입). JS 미러:
  `packages/types/src/complex-codec.ts:133-150, 330-400, 556+`
- Bun: `examples/calculator/generated/rkyv-codecs.ts:268-308` (i64 BigInt 코덱),
  `packages/types/src/rkyv-engine.ts:379-480` (라우트 resolve — raw 미노출 시 undefined),
  `packages/bun/src/index.ts:182-235` (`_into` + slice)
- Node loop: `examples/calculator/apps/node-performance.ts:24-34` (측정),
  `examples/calculator/src/bin/loop-stdio.rs:31-44` (`invoke_json` 위임),
  `packages/node/src/index.ts:328-439` (transport)
- Tauri: `crates/rustra/src/tauri_support.rs:38-60`, `packages/tauri/src/index.ts:78-116`,
  `examples/tauri-calculator/src/benchmark.ts:30-45` (측정 방식),
  `docs/benchmark-receipts/2026-08-24-host-matrix.json`
- RN: `packages/react-native/native/cpp/RustraJSIBridge.cpp:203-257` (typedInvokeTail),
  `:909-1015` (byId/Pos), `:1115-1275` (async), 생성 코덱
  `examples/react-native-calculator/modules/rustra-jsi/generated/rustra-generated-codecs.cpp:44-56`
  (cachedProp)

### 벤치/측정
- 현 수치: `docs/benchmarks.md` (2026-08-24 host matrix, 2026-08-28 caller-buffer 실측,
  Track B 실측)
- 실행: `bun run bench:hosts -- --output /tmp/rustra-host-matrix.json`,
  `cargo bench -p rustra`, `bun scripts/transport-bench.mjs`
- 이전 성능 트랙 설계: `docs/plans/2026-08-28-perf-three-tracks-design.md`

### 트랙 T 근거
- register 강제 tier3: `crates/rustra/src/registry.rs:118` (`force_tier3=true`),
  게이트 구조: `crates/rustra/src/command.rs:86-97` (`js_codec_supported` 재사용 가능)
- 치환 불변식: commandId 재사용(`registry.rs:96-104`), live_schema 캐시 무효화
  (`registry.rs:122,162,191`), 테스트 `runtime_registry_tests.rs:247-283`
- `schema_version`은 빌드 시점 고정(`package.rs:51`, builder:231) — 치환 시 증가하는
  generation 부재가 T0의 존재 이유
- preserve_order 피처로 스키마 properties 순서 = struct 선언 순서 (`Cargo.toml:47-48`)
- 격차 오독 근거: `docs/benchmarks.md` "Rust Criterion debug Tier 3 기준선" 절
  (서로 다른 연산 + debug 빌드 주의 문구 이미 존재)

### 검증 게이트
- PINNED hex: `crates/rustra/tests/wire_fixtures.rs` ↔ `packages/types` cross-wire.test.ts ↔
  C++ `test-rustra-generated-codecs.cpp`
- generated/ 재생성은 Rust bin + TS CLI 이중 경로, generated/는 prettier 제외
