---
'@rustra/cli': minor
'@rustra/types': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
---

feat: bigint postcard fast-path — 와이드 정수 게이트 해제

**와이어 변경 (breaking for stale codecs)**

- `int64`/`uint64` 필드가 complex codec 폴백 대신 postcard fast-path 로 라우팅
  됩니다(A1의 64-bit `_pcEncodeVarint64`/`_pcDecodeVarint64`/`_pcEncodeZigzag64`/
  `_pcDecodeZigzag64` 헬퍼 사용). Rust 엔진 게이트도 동일 판정으로 갱신되어
  양면 와이어가 일치합니다.
- **튜플/와이드 정수 명령의 와이어가 0.4.1 과 다릅니다.** 예: calculator
  `span` — 0.4.1 complex-codec 튜플 와이어는 `count + elements` 였지만 postcard
  튜플은 접두 없는 `elements` 나열입니다. 0.4.1 TS 코덱과 재생성된 Rust(또는
  그 역)를 혼용하면 디코딩이 조용히 깨집니다 — 양쪽을 함께 재생성해야 합니다.
- safe 정수 범위(±2^53) 밖의 값은 `number` 대신 `bigint` 로 복원됩니다.
  TS 타입 표면이 `i64`/`u64` 필드에서 `number` → `number | bigint` 로 넓어집니다.
- 복합 타입도 와이드 정수를 수용: `Vec<u64>`, `Set<i64>`, `HashMap<String, u64>`,
  `Option<i64>` 등이 원소/값 레벨 64-bit 헬퍼로 fast-path 를 사용합니다
  (`vec_i64/vec_u64`, `set_i64/set_u64`, `map_i64/map_u64`,
  `option_zigzag64/option_uvar64` kind 신설).
- C++ 정적 코덱(JSI 네이티브)은 여전히 int64/uint64 를 fast-path 에 넣지
  않습니다 — 해당 필드가 있으면 C++ 광고 집합에서 제외됩니다(트랙 B 후속).
- 경계 와이어 픽스처: calculator `gauge`(u64::MAX), `span`(i64::MIN, 2^53±1),
  신규 `wideAgg`(Vec<u64> + Option<i64> 다원소 10바이트 LEB128) — Rust
  `wire_fixtures.rs` 와 TS `cross-wire.test.ts` 가 동일 hex 를 공유합니다.
