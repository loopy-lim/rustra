# 성능 3트랙 설계 — caller-buffer 잔여 / bigint fast-path / C++ complex 직결

- 날짜: 2026-08-28
- 상태: 승인됨 (사용자 승인, 방식 A 순차 트랙)
- 선행 조사: 트랙별 코드 상태 조사 (2026-08-28, file:line 근거 포함)

## 배경

`docs/benchmarks.md` 로드맵에 남은 성능 항목은 3가지다:

1. **FFI caller-buffer 잔여** — tier-1 동기 경로는 5e4a9f01에서 완료. 잔여: Bun 어댑터, async 응답, complex-route core into-handler.
2. **bigint TS 표면** — postcard fast-path가 number 한정(2^53). Rust 와이어는 이미 풀 64-bit라 JS 경계만 문제.
3. **C++ complex direct marshalling 잔여** — 0.4.1(64adbdf9)에서 네이티브-safe complex는 C++ 직결 완료. 잔여: Set(uniqueItems)과 int64/uint64 두 제외.

실행 순서는 의존성 기준: C(복사 체인) → A(bigint, 게이트 완화) → B(C++ 확장). A와 B는 와이어 포맷 변경이 전혀 없다.

## 트랙 C — FFI caller-buffer 잔여 범위

### C1. Bun 어댑터 `_into` 바인딩

- 위치: `packages/bun/src/index.ts:136-141, 194-200`
- 현재: malloc 반환 `rustra_ffi_invoke_rkyv_v2` → `toArrayBuffer` 뷰 → owned 복사 → free.
- 변경: `rustra_ffi_invoke_rkyv_v2_into` 바인딩 추가. C++ `typedInvokeTail`의 probe→512B 스택→heap 재시도 패턴 미러링.
- 주의: Bun `toArrayBuffer`는 zero-copy 뷰라 소유 이전 불가(기록된 함정) — caller-buffer가 정답.
- 결과: Bun rkyv V2 경로 malloc/free 0회, JS 복사 0회.

### C2. Async 응답 `_into` 변형

- 위치: `packages/react-native/native/cpp/RustraJSIBridge.cpp:1153-1209`
- 현재: async 콜백이 malloc 버퍼 → `std::vector` 복사 → free (2중 복사).
- 변경: `rustra_ffi_invoke_rkyv_v2_async_into` 추가. JS ArrayBuffer 포인터를 콜백 클로저가 캡처, Rust가 완료 시 직접 write, C++는 in-place decode. 수명 계약은 기존 `invokeTypedAsync` 프라미스 구조와 동일.

### C3. Complex-route core into-handler ⭐

- 위치: `crates/rustra/src/lib.rs:767` 게이트(js_codec_supported 한정), `:1610-1612` Buffered 폴백.
- 변경: bounded writer 기반 `encode_into_slice` 추가 → complex 커맨드도 into-handler 생성.
- 효과: C++ 네이티브 경로가 caller-buffer 상속. 트랙 B 엔드게임의 전제.

### 범위 밖

- `rustra_ffi_invoke_json_into`(ffi.rs:619) 데드코드 — 외부 커스텀 호스트용 FFI 표면이므로 유지.

### 검증

- Bun bench before/after, wire round-trip 게이트, rust 테스트 전체.

## 트랙 A — bigint postcard fast-path

와이어 포맷 변경 없음. Rust는 이미 풀 64-bit LEB128/zigzag(`crates/rustra/src/lib.rs:711-736`). 타입 선언은 이미 `number | bigint`(codegen.ts:78). 런타임만 따라잡는다.

### A1. 64-bit 런타임 헬퍼

- 위치: `packages/cli/src/codegen.ts:296-343`
- `_pcEncodeVarint64` / `_pcDecodeVarint64` / zigzag64 변형 추가. 입력이 safe number면 number 연산, bigint/2^53 초과면 BigInt 연산.
- 디코드 계약(complex-codec.ts:103 선례): safe 범위면 number, 넘으면 bigint 반환.

### A2. 코드젠 게이트 해제

- 위치: `packages/cli/src/generate.ts:586-615`(`hasWideInteger`), `:1551-1554`(`commandCodecSupported`), `classifyPostcardField` `:318-356`, encode/decode emit `:699-761, :1018-1035`
- `classifyPostcardField`에 `uvar64`/`zigzag64` 종류 추가(format int64/uint64).
- `hasWideInteger` 게이트 완화 → 와이드 정수 커맨드가 postcard fast-path 진입.
- 와이드 필드 emit이 64-bit 헬퍼 사용.

### A3. C++ 게이트 유지 (트랙 B로 이관)

- `cppComplexNativeSupported`의 int64/uint64 제외(`generate.ts:2619`) 유지 — Hermes JSI BigInt 전달 방식 검증이 필요해 B1 스파이크로 넘김.
- RN에서 와이드 정수 커맨드: JS postcard codec(고속) → `invokeRkyvV2`. 기존 JS complex IR 해석기보다 가볍고 정밀도 손실 없음.

### 검증

- wire fixture에 `u64::MAX`, `i64::MIN`, 2^53 경계 추가 → TS↔Rust round-trip.
- 정밀도 계약 테스트: 2^53+1 → bigint 반환.
- 코드젠 스냅샷 갱신 + 전체 테스트.

## 트랙 B — C++ complex 직결 잔여 범위

### B1. C++ 64-bit + JSI BigInt 스파이크 ⭐

- 장벽: `rustra_u64/i64` 헬퍼(`generate.ts:2953-2973`)의 2^53 하드 가드(JSError).
- 먼저 Hermes에서 `BigInt` 전역/`BigInt.asIntN` 사용 가능 여부 스파이크. JSI 호스트 경계의 bigint 전달 방식 검증.
- 가능: decode가 number(safe)/BigInt(unsafe) 반환하도록 C++ 확장 → int64/uint64 제외 해소.
- 불가: 현재 계약(number 한정) 명시적 문서화 유지 — 트랙 A가 이미 정밀도 문제 해결.

### B2. C++ Set 직결

- `cppComplexNativeSupported`의 `sequence.uniqueItems` 제외 해소.
- encode 시 C++에서 정렬(`compareCodecKeys` 와이어 순서 계약) + 중복 제거.
- 지원 범위: 문자열/숫자 요소 집합만 (객체 요소 Set은 IR 정규화 한계).

### 범위 밖

- 비-IR 스키마 → 지원 안 함 유지(dev-time 명확 거부).
- generic `invokeRkyvV2` 경로는 Tier 3 동적 커맨드용으로만 잔존.

### 검증

- Set/와이드 정수 커맨드의 C++ 스위치 진입 코드젠 스냅샷.
- wire fixture + PINNED hex 게이트로 TS↔C++↔Rust 3면 동일성.
- 벤치: JS codec 폴백 vs C++ 직결 실측.

## 실행 그림

```
1단계  트랙 C — C3(Rust core) ∥ C1(Bun) ∥ C2(async C++)   [3-way 병렬, 와이어 무변경]
2단계  트랙 A — bigint postcard (TS/Rust/코드젠)          [와이어 무변경, 게이트 완화]
3단계  트랙 B — B1(Hermes BigInt 스파이크) → B2(Set 직결)   [스파이크 결과로 분기]
```

- 각 단계 끝: 실측 벤치 + wire round-trip 게이트 + PR.
- 파일이 안 겹치는 작업은 워크트리 분리 병렬 서브에이전트로 진행.
- 트랙 간 접점: C3→B(complex into-handler 상속), A→B1(bigint 계약) — 순차 진행으로 충돌 없음.
