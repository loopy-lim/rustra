---
'@rustra/cli': minor
---

feat: C++ Set 직결 — 원시 요소 Set의 네이티브 encode

- `cppComplexNativeSupported` 가 `sequence.uniqueItems` 를 원시 요소
  (string/number/integer/bool, literal/enum 포함)에 한해 허용한다. 객체/배열
  요소 Set 은 IR 정규화 한계로 계속 JS complex 경로를 탄다.
- C++ complex encode: JS Set 을 `instanceof Set` 판별 후 `Array.from(set)` 으로
  이터레이션 순서 보존 복사([...set] 계약 — TS complex-codec.ts 와 동일,
  **정렬/중복제거 없음**)한 뒤 postcard seq 를 쓴다. 배열 입력도 허용한다.
- C++ complex decode: 전역 `Set` 생성자에 `callAsConstructor` 로 요소 배열을
  넘겨 실제 JS `Set` 을 복원한다(new Set(values) 계약 — 중복은 Set 이 정리).
- example: calculator 에 `tagSet`(BTreeSet<i64> 입력 / BTreeSet<String> 출력,
  commandId 26 — register! 맨 뒤) 추가. benchEchoBytes 26→27, benchEchoPair
  27→28, echoGroups 28→29 로 시프트된다. 신규 command 는 반드시 register! 맨
  뒤에 추가해야 기존 id 가 보존된다. builder 체인(.buffer_command_fn/
  .command_fn) 명령은 register! 이후 id 를 할당받으므로 register! 내 추가에도
  시프트된다 — 양쪽 생성물(Rust bin + TS CLI)을 함께 재생성할 것.
- wire fixture: `TAGSET_REQUEST/RESPONSE` PINNED hex (Rust wire_fixtures.rs ↔
  TS cross-wire.test.ts ↔ C++ test-rustra-generated-codecs.cpp 3면 동일).
  와이어 자체는 순서 보존 postcard seq 로 기존과 동일 — BTreeSet 은 정렬 순서로
  직렬화되고 Set 복원 후 순서는 관측되지 않는다.
- test-jsi-shim: Function/global()/instanceOf/getPropertyAsFunction 최소 표면
  추가 — Set 직결 경로를 독립 C++ 테스트에서 검증한다.
