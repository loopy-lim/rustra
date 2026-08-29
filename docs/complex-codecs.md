# Complex binary codecs

Rustra는 명령마다 wire route를 선택한다.

| Route          | 대상                                                                  | RN 경로                                                                 |
| -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| postcard       | primitive, Vec/Set/tuple, primitive map, string enum 등 검증된 subset | C++ JSI 또는 JS codec                                                   |
| complex binary | recursive struct, struct-valued map, data enum, 조합형 Option         | native-safe schema는 C++ JSI, 나머지는 JS codec → `invokeRkyvV2` → Rust |
| Tier 3 JSON    | 두 binary codec이 모두 지원하지 않는 schema 또는 runtime 등록 명령    | JSON-in-binary                                                          |

Complex request는 `[command_id: u16 LE][body]`, success response는 기존 8-byte
header 뒤에 complex body가 이어진다. Struct field는 schema declaration 순서로
기록한다. Map key는 UTF-8 byte 순으로 정렬하고, enum variant는 이름/판별 tag에서
얻은 deterministic key로 정렬한다. 따라서 `oneOf` 배열의 순서가 Rust와 generated
TypeScript 사이에서 달라도 wire index가 바뀌지 않는다.
안정적인 이름/태그/title을 얻을 수 없는 모호한 `oneOf`는 complex route에
등록하지 않고 Tier 3 JSON으로 보낸다. 익명 variant는 스키마에
`x-rustra-variant-order: ["key-for-first", "key-for-second"]`를 명시할 수
있다. 실제 wire index는 이 stable key를 UTF-8 byte 순으로 정렬해 계산한다.

기본 limits는 depth 32, payload 1 MiB, collection/string length 100,000이다.
잘린 frame, 중복 map key, 잘못된 variant, trailing byte는 성공 결과가 아니라
`command.invalid_args`/`invoke.malformed`로 처리된다.

CLI의 공용 Codec IR이 TS/C++ 생성기의 recursive ref, struct field, map, option,
tuple, enum 판정을 공유한다. RN C++는 현재 `Set`과 `int64/uint64` 명령을
정적 광고하지 않는다. Set은 JSI 호환성, 64-bit 정수는 BigInt 표면을 보장하기
위해 JS complex codec으로 간다. 복합 정수는 `number | bigint`를 받고
`int8..uint64` 범위를 검증한다. 측정은 다음 명령으로 machine-readable JSON
receipt를 만든다.

```bash
bun run bench:complex
```

이 receipt는 JS encode/decode 비용만 측정하며 Rust/C++ dispatch나 물리 디바이스
실행을 증명하지 않는다. C++ complex 생성 소스 검사는 route/구조 검증까지이고,
실제 플랫폼 실행 receipt는 별도다. 현재 예제의 Android release APK는
`TB710FU` 실기기에서 complex command, channel, resource, benchmark까지
검증되었고, iOS는 `iphoneos` generic Debug 링크와 iPhone 17 Simulator의
Release embedded-bundle runtime까지 검증되었다. Simulator 로그에서
codec/complex command, channel/resource, JSI 및 benchmark 경로가 확인되었다.
