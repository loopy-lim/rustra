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
  commandId 29) 추가. 신규 command 는 기존 id 를 보존하기 위해 등록 순서 맨
  뒤에 추가해야 한다 — register! 튜플은 `.command_fn` 체인만 생성하므로
  builder 체인(.buffer_command_fn/.command_fn) 명령보다 **앞에** 올 수 없고,
  체인 끝에 `.command_fn` 으로 붙인다(초기 구현이 register! 튜플에 넣어
  benchEchoBytes/Pair/echoGroups id 를 시프트한 것을 수정 — generated id 는
  원래 값 25/26/27 유지). 양쪽 생성물(Rust bin + TS CLI)을 함께 재생성할 것.
- wire fixture: `TAGSET_REQUEST/RESPONSE` PINNED hex (Rust wire_fixtures.rs ↔
  TS cross-wire.test.ts ↔ C++ test-rustra-generated-codecs.cpp 3면 동일).
  와이어 자체는 순서 보존 postcard seq 로 기존과 동일 — BTreeSet 은 정렬 순서로
  직렬화되고 Set 복원 후 순서는 관측되지 않는다.
- test-jsi-shim: Function/global()/instanceOf/getPropertyAsFunction 최소 표면
  추가 — Set 직결 경로를 독립 C++ 테스트에서 검증한다.
