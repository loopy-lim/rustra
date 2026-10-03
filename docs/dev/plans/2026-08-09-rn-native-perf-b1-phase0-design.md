# RN → Native 성능 (B1) + DX (Phase 0) Design

> 날짜: 2026-08-09
> 목표: React Native(JS) → Rust native 호출의 **단건 latency / 잦은 호출 jank / 큰 payload / 무거운 연산 블록** 을
> Nitro(~2.1µs) 급으로 끌어내리고, 동적 런타임 명령 레지스트리와 rkyv V2 추상화를 **그대로 보존** 한다.
> 범위: **B1(codegen C++ postcard codec + JSI typed marshal)** + **Phase 0(zero-copy/배치/async 기반)**.
> iOS + Android 양쪽. 단계적 적용(A 먼저 → B).

---

## 1. 배경 (측정된 사실)

- 현재 RN rkyv V2 단건 호출 = **~5.8µs avg**. Nitro 참조 = ~2.1µs.
- 분해: **JS postcard encode ~2.4µs** + **Rust FFI ~0.76µs** + **JS decode ~1.0µs** ≈ 3.8µs (나머지 = JSI/런타임 오버헤드).
- **Rust 코어 연산 자체 = 209ns.** 즉 병목은 Rust가 아니라:
  1. **JS-side codec**(인코딩 2.4µs + 디코딩 1.0µs) — JS Array/TextEncoder/DataView 할당 비용.
  2. **JS 스레드 동기 블록** — 긴 연산이 UI(jank)를 막음.
  3. **이중 memcpy** — 응답: Rust alloc → `std::memcpy` → 새 JS ArrayBuffer → JS codec이 다시 읽음.
- 동적 런타임 레지스트리(`register`/`replace`/`freeze`)는 debug 빌드에서 mutating, release 에선 frozen. **이 경로를 건드리지 않는 것이 핵심 제약.**

### 현재 호출 경로 (변경 전)

```
commands.ts:addNumbers(x)  ──►  invoke('addNumbers', x)   [글로벌]
   └─► createRkyvV2Engine.invoke:
         registry.has(cmd)?
           ├─ 정적: codec.encode(x) [JS postcard] ─► native.invokeRkyvV2(ArrayBuffer)
           │        ─► JSI HostObject ─► rustra_calculator_invoke_rkyv_v2
           │        ─► Rust invoke_rkyv_v2 (typed postcard handler) ─► bytes
           │        ─► codec.decode(bytes) [JS postcard] ─► result
           └─ 동적: getLiveSchema ─► encodeTier3Request(JSON) ─► invokeRkyvV2 ─► decodeTier3Response
```

JS codec(정적 경로)가 단건 latency 의 대부분을 차지한다.

---

## 2. 왜 B1인가 — feasibility verdict (핵심)

"per-command Rust typed FFI(`extern fn add_numbers(a,b)`)" 방식은 **복잡 타입(Vec/Map/중첩)에서 결국 다시 와이어가 필요**하고, 제네릭 엔진 모델·동적 레지스트리와 충돌 → **우리 형태에 안 맞음**.

대신 **B1**: "TS가 아닌 **C++** 로 postcard codec을 codegen 한다."

- 생성된 `rkyv-codecs.ts`는 순수 postcard 로직(varint/zigzag/string/concat 헬퍼 + per-command encode/decode) → **C++ 로 1:1 이식 가능**. 이미 codegen 이 스키마 기반으로 TS codec 을 생성하므로, **C++ emitter 추가만으로 동일 로직을 네이티브로** 내린다.
- **와이어 포맷(rkyv V2 postcard)·Rust FFI(`rustra_*_invoke_rkyv_v2`)·응답 헤더 — 전부 불변.**
- 정적 명령 → C++ postcard fast path(JS codec 3.4µs 제거).
- 동적 명령 → **Tier 3 JSON fallback 그대로**(JS `decodeTier3Response`). 단일 엔진의 2계층 모델 유지.

→ prod(release/frozen) = 모든 명령이 정적 = 전부 C++ codec 보유 = **풀 Nitro급**. dev 동적 명령 = JSON fallback = 오늘과 동일. **추상화/레지스트리/와이어 모두 보존.**

---

## 3. 섹션별 설계

### 3.1 Phase 0 — 기반(저비용, 선적용)

#### P0-1 응답 복사 최소화 ✅ (B1 으로 달성)

- 현재 `createArrayBuffer` = 새 JS ArrayBuffer alloc + `std::memcpy` + Rust 버퍼 즉시 `rustra_ffi_free`.
- **B1 도입 후** JSI 가 C++ codec 으로 디코드하면서 결과를 JSI Object 로 직접 조립하므로, **중간 ArrayBuffer 자체가 사라짐**(정적 경로). 이것이 가장 큰 zero-copy 효과. 요청 방향도 JS 객체 → C++ `Writer` 직접 직렬화로 JS ArrayBuffer/DataView/TextEncoder 왕복 제거.
- 동적(Tier 3)/레거시 경로는 기존 memcpy 유지(YAGNI).

#### P0-2 invokeBatch ✅ (구현 완료)

- 잦은 단건 호출의 JSI 횡단 비용 상쇄. **단일 JSI 횡단**으로 N 개 정적 명령을 처리.
- C++ JSI: `invokeTypedBatch(names[], args[])` — 루프하며 `encode_by_name → invoke_rkyv_v2 → decode_by_name` → 결과 JS Array 1회 반환. 첫 에러에서 throw(fail-fast).
- 엔진: `createRkyvV2Engine` 가 `invokeBatch(entries)` 제공. **모든 항목이 정적(`hasStaticCodec`)이면** `invokeTypedBatch` 1회 호출, **동적 명령이 섞이면** 항목별 `invoke` 로 자동 폴백(typed/Tier3 분기 유지).
- 글로벌 `invokeBatch<T>(entries)` 헬퍼(`@rustra/types`) 추가 — `invoke` 패턴과 일치.
- codegen 이 `RkyvV2Codec` dispatch 테이블(`encode_by_name`/`decode_by_name`/`has_static_codec`)을 C++ 에 노출하므로 자연스럽게 구현.
- **in-session 검증**: 엔진 라우팅 단위 테스트 3종(단일 배치 / 혼합 폴백 / 미지원 폴백) green. C++ 루프 자체는 동일한 검증된 primitives 재사용 → 디바이스 빌드에서 링크 확인.

#### P0-3 무거운 연산 offload (async) — 설계만 확정

- 현재 rkyv V2 경로는 **동기 JSI**(JS 스레드 블록). 긴 Rust 연산 = jank.
- `invokeAsync(cmd, args): Promise` — 전용 worker 큐(또는 dispatch_async)에서 Rust 호출 후 JS 콜백 큐로 직렬화.
- **설계만 이 문서에 확정**하고, 스레드/런타임 안전성(Runtime 잠금, caller 스레드 제약) 검증이 필요 → 디바이스 검증 항목으로 분리.

> Phase 0 의 실측 정량화(배치/async 효과)는 디바이스에서만 가능. 이 문서는 API/구조를 확정하고, in-session 검증 가능한 부분만 구현한다.

### 3.2 B1 — codegen C++ codec + JSI typed marshal

#### 3.2.1 C++ postcard 코덱 라이브러리 (`rustra-codec.hpp/.cpp`)

- **JSI 의존성 없는** 순수 postcard Reader/Writer. iOS/Android 공통, clang++ 단위 테스트 가능.
- 인터페이스:
  ```cpp
  namespace rustra::codec {
    struct Writer { std::vector<uint8_t> buf; void u8/u32var/zigzag_i64/f64/f32/string/bytes(...); };
    struct Reader { const uint8_t* data; size_t len, pos; uint8_t/u32var/i64(double)/f64/f32/string read(...); };
  }
  ```
- **정수 정확성**: Rust typed postcard handler 는 64-bit varint 를 읽는다. 기존 TS `_pcEncodeVarint` 는 `n >>> 0`(32-bit 절단)이라 큰 i64 에서 손실. **C++ 은 정확한 64-bit zigzag varint** 구현 → JS 안전 정수(≤2^53) 범위에서 Rust 와 바이트-동일(더 정확).

#### 3.2.2 Codegen C++ emitter (`generateRkyvCodecsCpp`)

- `packages/cli/src/generate.ts` 에 추가. 기존 `classifyPostcardField`/`collectPostcardFields`/`generateFieldEncodeExpr`/`generateFieldDecodeExpr` 로직을 **재사용**해 TS → C++ 로 방출만 변경.
- 출력 `rustra-generated-codecs.hpp/.cpp`:
  - per-command `Value encode_<cmd>(Runtime&, const Value& args)` / `Value decode_<cmd>(Runtime&, const uint8_t*, size_t)`.
  - `bool dispatch(name, args, out)` — name→codec 스위치. 미발견 → `false`(JS 가 Tier 3 fallback).
- 필드 순서/알파벳 정렬 케이브(TS emitter 와 동일) 상속.

#### 3.2.3 JSI HostObject `invokeTyped` (`RustraJSIBridge.cpp`)

- 신규 호스트 메서드 `invokeTyped(name, args)`:
  1. `dispatch(name, ...)` → C++ codec 으로 postcard 인코딩(cmd_id + payload).
  2. `rustra_calculator_invoke_rkyv_v2` 호출(또는 제네릭 `rustra_ffi_invoke_postcard` 경로).
  3. C++ codec 으로 응답 디코딩 → **JSI Object 직접 조립**(중간 ArrayBuffer 제거).
  4. 미발겵 명령 → 식별 가능한 sentinel throw → JS 가 Tier 3 fallback.
- 기존 `invokeRkyvV2(ArrayBuffer)` raw 경로는 **유지**(동적 Tier 3 + 레거시 호환).

#### 3.2.4 엔진 연결 (`packages/types/src/index.ts` `createRkyvV2Engine`)

- 정적 경로 변경: `registry.has(cmd)` → `native.invokeTyped?.(cmd, args)`(존재 시). 결과를 그대로 resolve.
- `invokeTyped` 미지원/미발겵 → 기존 `codec.encode/invokeRkyvV2/decode`(TS) 또는 Tier 3 fallback.
- **TS codec/registry 파일은 유지**(Node/Bun/Tauri 어댑터 사용 + RN 의 폴백).

### 3.3 와이어 호환성 & 정확성

- 요청: `[cmd_id: u16 LE @0][postcard(Input) @2]` — 불변.
- 응답(정적, typed handler): `[ok:1 @0][pad 7B][postcard(Output) @8]`.
- 에러: `[ok:0 @0][pad to @8][err_len: u16 LE @8][err @10]`.
- C++ codec 출력은 Rust `postcard` crate 과 **바이트-동일**이어야 함 → 단위 테스트로 검증(known-value vector).

---

## 4. 제외 (YAGNI)

- per-command Rust typed FFI(B2) — 제네릭 모델 충돌.
- Old-Arch 진짜 zero-copy(ArrayBuffer-with-destructor) — B1 이 이미 중간 버퍼를 제거해 충분; 추가 복잡도 불필요.
- C++ 에서 동적 명령 JSON 처리 — JS Tier 3 fallback 유지로 C++ JSON 디펜던시 회피.
- `loom` 정합성, Phase 0 정량 벤치(디바이스 전용).

---

## 5. 완료 기준

### in-session 검증(이 세션에서 green)

- [x] C++ postcard 라이브러리 단위 테스트(clang++) — varint/zigzag/f64/string round-trip + Rust 와 바이트-동일 known-value. (`test-rustra-codec.cpp`)
- [x] `generateRkyvCodecsCpp` emitter + `generate.test.ts` 구조 검증; `npm run build`(cli) + 기존 코드젠 테스트 16/16 green.
- [x] 생성된 C++ 코덱 round-trip 테스트(clang++ + 최소 JSI shim) — encode 바이트가 Rust 와 동일 + decode 값 보존 + `rustraRegistryDemo` 구조체 필드순서 검증. (`test-rustra-generated-codecs.cpp`)
- [x] codegen 재실행으로 calculator/crud 예제 generated 파일 갱신. **필드 순서 버그 수정** 적용(schemars + serde_json `preserve_order` → 스키마가 구조체 선언 순서 = postcard 와이어 순서).
- [x] `cargo test --workspace` green + TS types(14)/cli(16) 테스트 green.
- [x] JSI `invokeTyped` + `invokeTypedBatch`(P0-2) + 엔진 연결 코드 작성(컴파일은 디바이스 빌드에서).
- [x] 엔진 `invokeBatch` 라우팅 단위 테스트 3종(단일 배치 / 동적 혼합 폴백 / 미지원 폴백) green.

### 디바이스/사용자 로컬 검증(체크리스트 `2026-08-10-rn-b1-verification.md`)

- [ ] iOS sim 빌드(`build-rust-ios.sh` + `expo run:ios`) — C++ codec 링크 확인.
- [ ] addNumbers/multiply/sumList/createItem(processItem) 단건 호출 결과 일치.
- [ ] 동적 명령(ping/average/greetDyn) Tier 3 fallback 정상.
- [ ] 단건 latency 측정 — 기존 5.8µs 대비 감소(목표 Nitro급).
- [ ] invokeBatch(async) jank 관찰 — P0-2/P0-3 효과 정량.
- [ ] Android(NDK) 빌드 — C++ codec 동일 동작.

---

## 6. 파일 맵 (변경/추가)

| 경로                                                            | 변화                                           |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `crates/rustra-jsi/rustra-codec.hpp/.cpp`(신규, RN 모듈 ios 하) | 순수 postcard Reader/Writer (JSI 무의존)       |
| `crates/.../rustra-generated-codecs.hpp/.cpp`(codegen 출력)     | per-command C++ codec + dispatch               |
| `packages/cli/src/generate.ts`                                  | `generateRkyvCodecsCpp()` 추가                 |
| `packages/cli/src/index.ts`                                     | emit `rustra-generated-codecs.{hpp,cpp}`       |
| `packages/cli/src/generate.test.ts`                             | C++ 출력 구조 검증                             |
| `examples/.../RustraJSIBridge.{hpp,cpp}`                        | `invokeTyped` + C++ codec 호출                 |
| `examples/.../src/index.ts` (RN 모듈)                           | `invokeTyped?` 타입 추가                       |
| `packages/types/src/index.ts`                                   | `createRkyvV2Engine` 정적 경로 → `invokeTyped` |
| `examples/calculator/generated/*`                               | codegen 재실행                                 |
| `docs/plans/2026-08-10-rn-b1-verification.md`                   | 디바이스 검증 체크리스트                       |
