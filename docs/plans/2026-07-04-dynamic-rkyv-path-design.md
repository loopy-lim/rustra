# Dynamic Commands on rkyv V2 (Tier 3) + Live Schema — Design

> 날짜: 2026-07-04
> 목표: 동적(런타임 등록) 명령을 정적 명령과 **동일한 rkyvV2 엔진 하나**로 호출 가능하게 하고, **live schema 조회**로 TS가 동적 명령의 id/타입을 알 수 있게 한다.
> 범위: dev(DX) 개선. **prod 성능에는 영향 없음** (release는 frozen → 동적 명령이 없고, 정적 명령은 기존 fast-path 유지).
> 접근: **Approach A** — 동적 명령은 **Tier 3(JSON-in-binary)** 강제. TS는 postcard 인코더 없이 `JSON.stringify`만으로 호출.

---

## 1. 배경 및 제약

이미 구현된 동적 레지스트리(`register`/`replace`/`unregister`, dev mutable / release frozen) 위에서:
- 동적 명령은 현재 **JSON 엔진**으로만 호출 가능 (별도 디스패치 경로).
- rkyvV2 fast-path는 빌드 타임 codegen된 per-command codec(`rkyvV2Registry`)이 필요 → 동적 명령(런타임 등록)은 codec이 없어 fast-path 불가.

**dev/prod 모델 (사용자 확정):**
- production 명령은 **빌드 타임**에 등록 (`command_fn`/`register!`). dev/release **동일 코드**, 둘 다 fast (Tier 1/2). 코드 이동 불필요.
- 동적 `register` (런타임) = **dev 전용 실험 도구** (hot-swap, 임시 명령, A-B). release에선 frozen로 자동 차단.
- 따라서 "동적 명령을 fast-path로"는 **dev DX**가 목적이며 prod 성능은 무관.

**postcard 인코더(Approach B)는 YAGNI로 제외** — dev 목적엔 Tier 3(JSON)로 충분.

---

## 2. 핵심 기술 사실 (코드 기반)

- `invoke_rkyv_v2` 는 `command.rkyv_v2_handler`가 `Some`이면 **postcard fast handler**를 항상 사용 (`postcard::from_bytes::<I>(&payload[2..])`). typed postcard라 모든 serde 타입 처리 가능.
- `rkyv_v2_handler = None`이면 **fallback** → `rkyv_v2_decode` (Tier 3 = JSON / Tier 1/2 = schema-driven).
- 현재 `build_command`는 항상 `rkyv_v2_handler = Some(postcard)` → fallback은 사실상 dead code.
- **Tier 3 wire**: request `[command_id: u16 LE][json_string]`, response `build_rkyv_v2_response_encoder(_, tier3=true)` 포맷.

→ 동적 명령을 Tier 3로 올리려면: `build_command`에 `force_tier3` 옵션 → `rkyv_v2_handler = None`, `rkyv_v2_decode = build_tier3_json_decoder()`, response encoder tier3.

---

## 3. 컴포넌트

### 3.1 Rust (`crates/rustra`)

1. **`build_command` force_tier3 옵션**
   - 새 인자 `force_tier3: bool`. true면:
     - `rkyv_v2_handler = None` (postcard fast 우회)
     - `rkyv_v2_decode = build_tier3_json_decoder()`
     - `rkyv_v2_encode_response = build_rkyv_v2_response_encoder(&output_schema, true)`
     - `rkyv_v2_tier3 = true`
   - 빌드 타임 `PackageBuilder::command`는 `force_tier3=false` 유지 (정적 명령은 기존 동작).

2. **`register` / `register_fn` → `force_tier3=true`**
   - 런타임 신규 등록 명령은 항상 Tier 3. (TS codec이 없으므로)
   - **`replace`는 `force_tier3=false` 유지** — 교체 대상이 정적 명령일 경우 같은 I/O 타입이면 기존 TS codec 그대로 동작. (타입이 바뀌면 dev 한정 edge case.)

3. **`Package::live_schema() -> Value` (공개)**
   - 현재 명령 전체 스키마 반환 (`{name, commandId, inputSchema, outputSchema}`). 기존 private `schema()` 재사용.

4. **`rustra_ffi_get_schema(out_len: *mut usize) -> *mut u8`** (ffi.rs)
   - `get_package()`의 live schema를 JSON 바이트로 반환. read-only (debug/release 모두). 해제는 `rustra_ffi_free`.

### 3.2 JSI bridge (`RustraJSIBridge.cpp`)

5. `getSchema` → `rustra_ffi_get_schema` 노출 (`makeInvoke` 패턴, ArrayBuffer 반환).

### 3.3 TS (`@rustra/types`)

6. **`getLiveSchema(native)`**
   - `native.getSchema()` → JSON parse → `Map<name, { commandId, inputSchema, outputSchema }>` (lazy 캐시, refresh 가능).

7. **`createRkyvV2Engine` Tier 3 fallback**
   - `invoke(name, args)`:
     - `name`이 static codec registry에 있으면 → 기존 fast path (postcard).
     - 없으면 → **Tier 3 fallback**: live schema에서 `commandId` 조회 → `[id][JSON.stringify(args)]` → `native.invokeRkyvV2` → Tier 3 response 디코드.
   - 하나의 엔진이 정적(fast) + 동적(Tier 3) 모두 처리.

### 3.4 예제 (`DynamicRegistryApp`)

8. 데모 확장: 동적 명령 등록 → live schema 조회(id/타입 표시) → **rkyvV2 엔진 하나로** 동적 명령 호출 (JSON 엔진 대체).

---

## 4. 데이터 흐름 (동적 명령 호출, dev)

```
TS rkyvV2Engine.invoke('dynCmd', {a:1, b:2})
  → static registry miss → Tier 3 fallback
  → live_schema에서 'dynCmd'.commandId = N 조회
  → payload = [N LE][JSON.stringify({a:1,b:2})]
  → native.invokeRkyvV2(payload)
  → Rust invoke_rkyv_v2:
      rkyv_v2_handler = None → fallback
      rkyv_v2_decode (Tier3) → JSON → Value
      invoke_json → 핸들러
      rkyv_v2_encode_response (tier3) → 바이트
  → TS 디코드 → 결과
```

정적 명령은 기존과 동일 (postcard fast handler). prod는 frozen라 동적 명령 자체가 없음.

---

## 5. 에러 / 엣지

- live schema에 없는 동적 명령 호출 → Tier 3 fallback 시 id 조회 실패 → `command.not_found`.
- 동적 명령 등록 전 schema 조회 → 해당 명령 없음 (자연스러움).
- `replace`로 정적 명령을 **다른 타입** 핸들러로 교체 → TS static codec과 schema 불일치 (dev 한정 edge case, 문서화).
- frozen(release)에서도 schema 조회/정적 호출은 정상 (read-only).

---

## 6. 테스트

- **Rust**: `register`로 동적 명령 등록 → `invoke_rkyv_v2`에 `[id][json]` 전송 → 성공 (Tier 3). `live_schema()`에 동적 명령 포함. release에선 동적 명령 invoke 시 `registry.frozen`(register 자체가 막힘).
- **TS**: `createRkyvV2Engine` Tier 3 fallback 단위 테스트 (mock native: static miss → getSchema → invokeRkyvV2 흐름).
- **RN 시뮬레이터**: 동적 명령을 rkyvV2 단일 엔진으로 호출 + live schema(id/타입) 표시. 기존 JSON 엔진 사용 제거.

---

## 7. 영향 범위

- `crates/rustra/src/lib.rs`: `build_command` force_tier3, register/register_fn 전달, `live_schema()` 추가.
- `crates/rustra/src/ffi.rs`: `rustra_ffi_get_schema` 추가.
- `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp`: `getSchema` 노출.
- `packages/types/src/...`: `getLiveSchema`, rkyvV2 엔진 Tier 3 fallback.
- 예제 데마 확장.
- prod(정적/fast-path) 영향 없음.

---

## 8. 제외 (YAGNI)

- TS postcard runtime encoder (Approach B) — 속도가 dev에 문제 안 되면 추가 불필요. 나중에 같은 경로 위에 올릴 수 있는 확장 포인트.
- 런타임 codegen(타입 안전 헬퍼) — Approach C.
- live schema push 방식 — pull(조회)로 충분.
