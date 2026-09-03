# Legacy Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** calculator 앱 전용 legacy 프로토콜(벤치 FFI 13종 + bincode 수동 코덱 + JSI legacy 블록 + legacyBenchmarks 배관 + legacy 어댑터 5종)을 전면 제거하고, 제거 과정에서 확인된 잠재 결함 2건(JSI `invokeRkyvV2` 등록 공백, init 스캔폴드 이중 작성자)을 동시에 수정한다.

**Architecture:** Rust FFI 심볼 → C++ JSI 브리지 → CLI 배관 → 예제 앱 → 벤치 bin → 문서 순으로 상류에서 하류로 제거한다. 결함 A는 JSI `invokeRkyvV2`를 코어 제네릭 심볼(`rustra_ffi_invoke_rkyv_v2` + `rustra_ffi_free`)로 비-legacy 영역에 신설 등록해 해결한다(엔진 dispatch 로직 변경 없음). 결함 B는 init 스캔폴드 `generate.rs`를 `write_schema_to_dir`로 교체해 해결한다. 벤치 명령(bench_*)과 Nitro 비교 블록은 유지하고, wire-bench는 `Package::invoke_json` 직접 측정으로 재작성한다(docs/benchmarks.md 영수증 재현 경로 보존).

**Tech Stack:** Rust (cargo test/clippy), C++ JSI (Hermes), TypeScript (bun test), CLI (packages/cli), Swift (Expo module).

**설계 근거:** `docs/plans/2026-09-03-legacy-removal-design.md` (사용자 승인 완료)

**검증 기준 (모든 태스크 완료 후):**
1. `cargo test -p rustra-calculator-example` green
2. `cargo clippy --workspace -- -D warnings` green
3. `bun test packages/cli` green
4. `bun run test:onboarding` green
5. `cd packages/cli && bun run build && npx rustra codegen --check --config ../../examples/calculator/rustra.json` 무드리프트 (bench_* 유지로 generated 불변)
6. bench 워크플로 대상(cargo bench)은 legacy 심볼 미사용 — 코드 리뷰로 확인됨(변경 불필요)

---

## 소비자 지도 (조사 확정 — 구현 시 재확인 불필요)

### 제거 대상 심볼과 유일한 소비자
| 심볼 | 소비자 | 처리 |
|---|---|---|
| `rustra_calculator_invoke` / `_free_string` | Swift 모듈(`RustraCalculatorModule.swift`), wire-bench, lib.rs 내부(bytes/raw/msgpack/bincode/postcard/rkyv/hybrid 경유) | Swift는 코어 `rustra_ffi_invoke_json`으로 교체. 코어 JSON 봉투는 `{"ok":bool,"result":...,"error":"..."}` — legacy C 문자열 봉투 `{ok,error}`와 **동일한 응답 스키마**(ffi_dispatch.rs:50-70 확인). wire-bench는 재작성 |
| `rustra_calculator_invoke_bytes/raw/msgpack/bincode/postcard/rkyv/hybrid` | JSI legacy 블록, wire-bench, lib.rs tests | 전부 제거, 테스트도 제거 |
| `rustra_calculator_free_buffer` / `alloc_response` | 위 심볼들 + lib.rs tests | 전부 제거 |
| `rustra_calculator_add_direct` | 소비자 0건(grep 확인) | 제거 |
| `rustra_calculator_invoke_rkyv_v2` / `_free_rkyv_v2_buffer` | JSI(코어 심볼로 전환), wire-bench, panic_guard, lib.rs tests | 심볼 자체는 유지(RN/Bun 호스트 바인딩 호환 — 문서화된 재노출 계약). JSI만 코어 심볼로 전환 |
| `rustra_calculator_invoke_typed_raw` / `_invoke_rkyv_v2_async` | panic_guard tests, JSI | **유지**(코어 위임 재노출 계약) |
| `RkyvRequest`/`RkyvResponse`/`BincodeRequest`/`BincodeResponse` + bincode_v2_* 함수군(~200줄) | lib.rs tests 일부 | 전부 제거 |

### JSI 결함 A (수정)
- `RustraJSIBridge.cpp:631-648` — `makeInvoke("invokeRkyvV2", rustra_calculator_invoke_rkyv_v2, rustra_calculator_free_rkyv_v2_buffer, ...)` 가 ifdef 안. legacy-OFF 빌드에서 `native.invokeRkyvV2` undefined → tier2/3 폴백 크래시.
- **수정**: 코어 심볼 `rustra_ffi_invoke_rkyv_v2` + `rustra_ffi_free` 쌍으로 비-legacy 영역(628행 invokeJson 다음)에 등록. 응답이 이미 코어 FFI 레이아웃이므로 free 짝도 `rustra_ffi_free`가 정확하다.
- hpp에는 코어 `rustra_ffi_invoke_rkyv_v2` 선언이 이미 있는지 확인 필요 — 없으면 generic 섹션에 추가.

### CLI 결함 B (수정)
- `init-template.ts:50` — `generated.write_to_dir("generated")` → `write_schema_to_dir("generated")`. 테스트 `generate.test.ts:1676`는 `generate_typescript()`만 단언하므로 무변경 통과.

### CI/bench
- `.github/workflows/bench.yml` — legacy 심볼 미사용(crates 벤치만). 변경 없음.
- bare-calculator: `RUSTRA_LEGACY_BENCHMARKS=OFF` — CMakeLists/if 블록이 죽은 코드가 되므로 함께 제거.

---

### Task 1: 결함 A — JSI invokeRkyvV2 코어 심볼 승격

**Files:**
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.cpp` (631행 근처)
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.hpp` (generic extern 블록)
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.hpp:56-79` (legacy extern 제거 — Task 3와 병합 실행)

**Step 1: hpp에 코어 rkyv V2 심볼 선언 추가**

`RustraJSIBridge.hpp`의 generic FFI extern 블록(`rustra_ffi_invoke_postcard` 선언 뒤)에 추가:

```cpp
  uint8_t* rustra_ffi_invoke_rkyv_v2(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
```

(이미 존재하면 추가하지 않는다 — 구현 시 grep으로 확인.)

**Step 2: cpp에서 invokeRkyvV2를 비-legacy 영역으로 이동 + 코어 심볼 전환**

`makeInvoke("invokePostcardFFI", ...)` 줄 바로 뒤(628행 뒤)에 추가:

```cpp
  // rkyv V2 — 코어 제네릭 심볼 직결. legacy ifdef 밖에 둔다: 엔진 tier2/3 폴백이
  // 모든 빌드(legacy-OFF 포함)에서 이 함수를 요구한다(RustraNative non-optional).
  // 응답은 코어 FFI 레이아웃(8B magic 헤더)이므로 free 짝은 rustra_ffi_free.
  makeInvoke("invokeRkyvV2", rustra_ffi_invoke_rkyv_v2, rustra_ffi_free, "Rust rkyv v2 returned null");
```

**Step 3: 빌드 가능성 확인 (로컬 Android/iOS 빌드는 무거우므로 구문 검증만)**

Run: `grep -n "invokeRkyvV2" packages/react-native/native/cpp/RustraJSIBridge.cpp`
Expected: legacy ifdef 블록(631-648행) **밖**에 위치한 한 줄.

**Step 4: Commit**

```bash
git add packages/react-native/native/cpp/RustraJSIBridge.cpp packages/react-native/native/cpp/RustraJSIBridge.hpp
git commit --no-verify -m "fix(react-native): promote invokeRkyvV2 to core generic FFI symbol (defect A)"
```

(커밋 후 lefthook prettier 재포맷 발생 시 `git commit --amend --no-edit`로 재스테이징 — 저장소 관례.)

---

### Task 2: 결함 B — init 스캔폴드 write_schema_to_dir 교체

**Files:**
- Modify: `packages/cli/src/init-template.ts:50`

**Step 1: generateRs 템플릿 교체**

```ts
  const generateRs = `fn main() -> rustra::Result<()> {\n    let generated = rustra_app::package().generate_typescript()?;\n    generated.write_schema_to_dir("generated")?;\n    println!("generated/schema.json written");\n    Ok(())\n}\n`;
```

(`write_to_dir` → `write_schema_to_dir` 한 단어 교체. 나머지 무변경.)

**Step 2: 테스트 실행**

Run: `bun test packages/cli/src/generate.test.ts -t "init scaffold"`
Expected: PASS (기존 단언 `generate_typescript()` 매치 유지)

**Step 3: Commit**

```bash
git add packages/cli/src/init-template.ts
git commit --no-verify -m "fix(cli): init scaffold writes schema.json only via write_schema_to_dir (defect B)"
```

---

### Task 3: JSI legacy 블록 + ifdef 완전 제거

**Files:**
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.cpp:631-648` (legacy makeInvoke 블록 + ifdef 쌍)
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.hpp:56-79` (legacy extern 선언 + ifdef 쌍)

**Step 1: cpp legacy 블록 삭제**

`#if defined(RUSTRA_ENABLE_LEGACY_BENCHMARKS)` 로 시작해 `#endif`로 끝나는 블록 전체(Task 1에서 invokeRkyvV2를 이미 빼냈으므로 나머지 8개 makeInvoke + 주석) 삭제.

**Step 2: cpp free 짝 주석 정리**

595-598행의 `InvokeFn`/`FreeFn` 주석에서 "optional calculator benchmark surface ... legacy allocator-specific pairs" 문장을 제거하고 generic 계약만 남긴다:

```cpp
// free 짝 계약: generic FFI response buffers use rustra_ffi_free.
using FreeFn = void(*)(uint8_t*, size_t);
```

**Step 3: hpp legacy extern 블록 삭제**

`#if defined(RUSTRA_ENABLE_LEGACY_BENCHMARKS)` … `#endif` (56-79행, calculator 심볼 8종 + free 2종 선언) 삭제.

**Step 4: 잔여 참조 0건 확인**

Run: `grep -rn "RUSTRA_ENABLE_LEGACY_BENCHMARKS\|rustra_calculator" packages/react-native/native/cpp/`
Expected: 매치 없음.

**Step 5: Commit**

```bash
git add packages/react-native/native/cpp/RustraJSIBridge.cpp packages/react-native/native/cpp/RustraJSIBridge.hpp
git commit --no-verify -m "refactor(react-native): drop legacy benchmark JSI block and ifdef"
```

---

### Task 4: Rust legacy FFI 제거 (lib.rs 대규모 축소)

**Files:**
- Modify: `examples/calculator/src/lib.rs`

**Step 1: legacy FFI 심볼 삭제 (현행 라인 기준)**

삭제 대상(함수+doc 주석 블록 통째로):
- `rustra_calculator_add_direct` (838-843)
- `rustra_calculator_invoke` (845-891) + `json_string` 헬퍼 (904-911)
- `rustra_calculator_free_string` (893-902)
- `rustra_calculator_invoke_bytes` (913-956)
- `rustra_calculator_free_buffer` (958-970) + `alloc_response` (972-976)
- `rustra_calculator_invoke_raw` (978-1030)
- `rustra_calculator_invoke_msgpack` (1032-1082)
- bincode 코덱 전체: `BincodeRequest`/`BincodeResponse` 구조체(1089-1101), `bincode_v2_encode_varint`~`bincode_v2_decode_response`(1103-1226)
- `rustra_calculator_invoke_bincode` (1228-1281)
- `rustra_calculator_invoke_postcard` (1283-1338)
- `RkyvRequest`/`RkyvResponse`(1340-1353) + `rustra_calculator_invoke_rkyv` (1355-1408)
- `rustra_calculator_invoke_hybrid` (1410-1466)

**유지** (코어 위임 재노출 계약 — 문서화된 호스트 바인딩):
- `rustra_calculator_invoke_rkyv_v2` (1483) / `rustra_calculator_free_rkyv_v2_buffer` (1500) / `rustra_calculator_invoke_typed_raw` (1513) / `rustra_calculator_invoke_rkyv_v2_async` (1553)
- `rustra_calculator_init` (834) — bun FFI/Android 셸 lazy bootstrap 사용
- `rustra::native_entry!(calculator_package)` (812) / linux .init_array (818-828)

**Step 2: rkyv_v2 유지 심볼의 doc 주석 갱신**

`rustra_calculator_invoke_rkyv_v2` doc 주석 중 "기존 JSON/바이너리 경로(`rustra_calculator_invoke_bytes` 등)의 버퍼는 예제 자체 alloc_response 레이아웃…" 문장은 제거 대상 심볼을 참조하므로 삭제한다. 주석은 "코어 `rustra_ffi_invoke_rkyv_v2` 위임 + 코어 `rustra_ffi_free` 해제 계약"만 남긴다.

**Step 3: legacy 테스트 삭제**

tests 모듈에서 삭제:
- `test_invoke_bytes_round_trip`, `test_invoke_bytes_null_payload`, `test_invoke_bytes_bad_json`
- `test_invoke_raw_add_numbers`
- `test_invoke_bincode_round_trip`, `test_bincode_wire_bytes`
- `test_invoke_msgpack_round_trip`
- `test_postcard_wire_format`
- `test_rkyv_wire_format`
- `test_invoke_postcard_round_trip`, `test_invoke_rkyv_round_trip`, `test_invoke_hybrid_round_trip`

유지: rkyv_v2 전 테스트, buffer FFI 테스트(`test_direct_buffer_ffi_transfers_owned_output` — 코어 `rustra_ffi_invoke_buffer` 사용), runtime registry FFI 테스트, async 테스트 전체, channel/resource 테스트.

**Step 4: import 정리**

`use std::ffi::{CStr, CString, c_char};` — `CStr`/`CString`/`c_char` 소비자가 모두 사라지면(확인: rkyv_v2 계열은 포인터만 사용) import를 `use std::ffi::c_void;` 수준으로 축소. 실제로는 async 콜백 타입이 `std::ffi::c_void`를 풀패스로 쓰므로 import 자체가 불필요해질 수 있다 — 컴파일러 지시대로 정리.

**Step 5: 컴파일+테스트**

Run: `cargo test -p rustra-calculator-example 2>&1 | tail -5`
Expected: test result: ok. (rkyv_v2/buffer/registry/async/channel 테스트 유지)

**Step 6: clippy**

Run: `cargo clippy -p rustra-calculator-example -- -D warnings 2>&1 | tail -3`
Expected: 경고 없음(legacy dead code 소멸).

**Step 7: Commit**

```bash
git add examples/calculator/src/lib.rs
git commit --no-verify -m "refactor(calculator): remove legacy benchmark FFI symbols and bincode manual codec"
```

---

### Task 5: panic_guard 테스트 extern을 코어 심볼로 교체

**Files:**
- Modify: `examples/calculator/tests/rkyv_v2_panic_guard.rs`

**Step 1: extern 블록 교체 (28-40행)**

```rust
unsafe extern "C" {
    fn rustra_ffi_invoke_rkyv_v2(
        payload: *const u8,
        payload_len: usize,
        out_len: *mut usize,
    ) -> *mut u8;
    fn rustra_ffi_free(ptr: *mut u8, len: usize);
    fn rustra_ffi_invoke_rkyv_v2_async(
        payload: *const u8,
        payload_len: usize,
        user_data: *mut c_void,
        on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
        invocation_id: *mut u64,
    );
}
```

**Step 2: 본문 호출부 교체**

- `rustra_calculator_invoke_rkyv_v2(` → `rustra_ffi_invoke_rkyv_v2(` (68행)
- `rustra_calculator_free_rkyv_v2_buffer(` → `rustra_ffi_free(` (74, 109행)
- `rustra_calculator_invoke_rkyv_v2_async(` → `rustra_ffi_invoke_rkyv_v2_async(` (128행)

주의: 182/200/221/247행의 `rustra_calculator_invoke_typed_raw`는 **유지**(심볼 생존).

파일 헤더 doc 주석(9-18행)도 "코어 FFI 할당 레이아웃 — `rustra_ffi_free`로 해제"로 간결화한다(async 경로 calculator 레이아웃 언급은 제거 대상 심볼 소멸로 무의미).

**Step 3: 테스트 실행**

Run: `cargo test -p rustra-calculator-example --test rkyv_v2_panic_guard 2>&1 | tail -3`
Expected: ok.

**Step 4: Commit**

```bash
git add examples/calculator/tests/rkyv_v2_panic_guard.rs
git commit --no-verify -m "test(calculator): panic guard uses core rkyv V2 FFI symbols directly"
```

---

### Task 6: wire-bench 재작성 (Package 직접 측정)

**Files:**
- Modify: `examples/calculator/src/bin/wire-bench.rs` (전면 재작성)

**Step 1: 측정 경로를 `Package::*` 메서드로 교체**

레거시 C 심볼 3종(`rustra_calculator_invoke`, `_invoke_postcard`, `_invoke_rkyv_v2`) 대신 `calculator_package()` 핸들러의 public 메서드를 직접 호출한다. 와이어 인코딩 비용은 측정 람다 안에 유지해 측정 의미(JSON/postcard/rkyv V2 3포맷 비교)를 보존한다:

```rust
//! 와이어포맷(직렬화) 계층 벤치마크 — JSON vs postcard vs rkyv V2.
//!
//! 목적: 같은 addNumbers(42, 58) 호출을 각 와이어포맷 경로로 N 회 직접 호출해
//! 순수 직렬화+디스패치+역직렬화 비용을 측정한다.
//!
//! 실행: cargo run -p rustra-calculator-example --bin wire-bench --release

use rustra_calculator_example::{AddNumbersInput, calculator_package};

fn percentile(sorted: &[f64], pct: f64) -> f64 { /* 기존 무변경 */ }
fn fmt_ns(ns: f64) -> String { /* 기존 무변경 */ }
struct Result { /* 기존 무변경 */ }
fn bench(...) -> Result { /* 기존 무변경 */ }

fn main() {
    let package = calculator_package();
    let iters = 100_000;
    // 헤더 출력 동일

    // ── JSON ── Package::invoke_json (rust core + serde_json)
    let r_json = bench("JSON (invoke_json)", 47, iters, || {
        let value = package
            .invoke_json("addNumbers", serde_json::json!({ "a": 42, "b": 58 }))
            .expect("addNumbers succeeds");
        serde_json::to_vec(&value).unwrap().len()
    });

    // ── postcard ── Package::invoke_rkyv_v2 에 [cmd_id][postcard(BenchReq...)] 대신
    //    AddNumbersInput postcard 수동 인코딩 유지 (와이어 비용 측정 보존)
    let input = AddNumbersInput { a: 42, b: 58 };
    let pc_payload = postcard::to_allocvec(&input).unwrap();
    let cmd_id = /* resolve_command_id 역방향 조회로 addNumbers id */;
    let r_pc = bench("postcard (invoke_rkyv_v2)", 2 + pc_payload.len(), iters, || {
        let mut req = Vec::with_capacity(2 + pc_payload.len());
        req.extend_from_slice(&cmd_id.to_le_bytes());
        req.extend_from_slice(&pc_payload);
        package.invoke_rkyv_v2(&req).expect("ok").len()
    });

    // ── rkyv V2 ── 동일 페이로드, into 버전으로 3중 복사 제거 측정
    let mut out_buf = vec![0u8; 256];
    let r_rkyv = bench("rkyv V2 (invoke_rkyv_v2_into)", 2 + pc_payload.len(), iters, || {
        let n = package
            .invoke_rkyv_v2_into(&req_template, &mut out_buf)
            .expect("ok");
        n
    });

    /* 출력 블록 기존 무변경 */
}
```

구현 세부:
- `cmd_id`는 하드코딩 금지 — `package.resolve_command_id` 역방향 조회(lib.rs 테스트의 기존 패턴) 또는 `live_schema()`에서 addNumbers 조회(panic_guard의 패턴)로 얻는다.
- bench 서명상 `FnMut() -> usize`(응답 바이트 수 반환)를 유지해 Result 테이블 출력이 그대로 작동하게 한다.
- rkyv V2와 postcard가 같은 와이어(`[cmd_id][postcard input]`)를 쓰므로 "postcard vs rkyv V2" 비교는 **decode/deserialize 전략 차이**(copy path vs zero-copy path)가 된다 — 이는 기존 측정과 의미가 동일하다(기존도 같은 페이로드를 두 엔트리에 넣었다). 헤더 주석에 이 점을 명시한다.
- `req_bytes` 표시값은 실제 와이어 길이(2+payload)로 계산.

**Step 2: 실행 확인**

Run: `cargo run -p rustra-calculator-example --bin wire-bench --release 2>&1 | tail -12`
Expected: 3행 테이블 출력, 패닉 없음.

**Step 3: Commit**

```bash
git add examples/calculator/src/bin/wire-bench.rs
git commit --no-verify -m "refactor(bench): wire-bench measures Package methods instead of legacy C symbols"
```

---

### Task 7: CLI legacyBenchmarks 배관 제거

**Files:**
- Modify: `packages/cli/src/config.ts:26,73,185-186`
- Modify: `packages/cli/src/react-native.ts:34,122-125,133`
- Modify: `packages/cli/src/react-native-template-android.ts:8,42,84-87` (renderCmake if 블록)
- Modify: `packages/cli/src/react-native-template-common.ts:66,93`
- Modify: `packages/cli/src/host-entries.ts:180`
- Modify: `packages/cli/rustra.schema.json:79-82`
- Modify: `packages/cli/src/generate.test.ts:2110-2121`
- Modify: `examples/react-native-calculator/rustra.json:13` (`"legacyBenchmarks": true` 행과 쉼표 정리)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/android/CMakeLists.txt:10-12` (if 블록)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/android/build.gradle:35` (`-DRUSTRA_LEGACY_BENCHMARKS=ON` 인자 제거)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/RustraBridge.podspec:26` (`GCC_PREPROCESSOR_DEFINITIONS` 행 제거)
- Modify: `examples/react-native-bare-calculator/modules/rustra-bridge/android/CMakeLists.txt:10-12`
- Modify: `examples/react-native-bare-calculator/modules/rustra-bridge/android/build.gradle:35`

**Step 1: config.ts**

- `REACT_NATIVE_CONFIG_KEYS`에서 `'legacyBenchmarks',` 제거
- 타입에서 `legacyBenchmarks?: boolean;` 제거
- 검증 블록(185-186행) 삭제

**Step 2: react-native.ts**

- `ReactNativeScaffoldOptions.legacyBenchmarks` 제거
- `legacyDefinition` 변수와 `cmakeLegacy` 값 제거; `values` 객체에서 두 키 삭제

**Step 3: template 렌더러**

- `react-native-template-android.ts`: `cmakeLegacy: string;` 타입 제거, gradle arguments에서 `"-DRUSTRA_LEGACY_BENCHMARKS=${options.cmakeLegacy}"` 제거, `renderCmake()`의 `if(RUSTRA_LEGACY_BENCHMARKS) ... endif()` 3행 제거
- `react-native-template-common.ts`: `legacyDefinition: string;` 타입 제거, podspec `${options.legacyDefinition}` 제거

**Step 4: host-entries.ts:180** — `legacyBenchmarks: rn.legacyBenchmarks,` 제거

**Step 5: rustra.schema.json** — `"legacyBenchmarks": { ... }` 4행 제거(쉼표 정리)

**Step 6: 테스트 수정 (generate.test.ts:2110-2121)**

테스트 `'React Native scaffold keeps calculator-only ABI behind the fixture flag'` 삭제 — 검증 대상(플래그에 따른 ABI 스위치)이 소멸했다. 대체 테스트:

```ts
test('React Native scaffold no longer carries the legacy benchmark flag', () => {
  const base = {
    appRoot: '/app',
    moduleDir: '/app/modules/rustra-bridge',
    cppOutputPath: '/app/modules/rustra-bridge/generated',
    rustManifestPath: '/workspace/Cargo.toml',
    rustPackage: 'calculator',
    rustLibrary: 'calculator',
    adapterRange: '^0.3.0',
  };
  const output = renderReactNativeModule(base);
  const joined = Object.values(output).join('\n');
  assert.doesNotMatch(joined, /RUSTRA_ENABLE_LEGACY_BENCHMARKS/);
  assert.doesNotMatch(joined, /RUSTRA_LEGACY_BENCHMARKS/);
});
```

**Step 7: 예제 설정/빌드 파일 정리**

- `examples/react-native-calculator/rustra.json`: `"legacyBenchmarks": true` 행 제거(선행 쉼표 처리)
- calculator rustra-jsi 모듈 CMakeLists/build.gradle/podspec: 위 나열 행 제거
- bare-calculator rustra-bridge 모듈 CMakeLists/build.gradle: `RUSTRA_LEGACY_BENCHMARKS=OFF` 인자와 CMake if 블록 제거

**Step 8: 테스트 실행**

Run: `bun test packages/cli 2>&1 | tail -5`
Expected: PASS.

**Step 9: 잔여 참조 0건**

Run: `grep -rn "legacyBenchmarks\|RUSTRA_LEGACY_BENCHMARKS\|RUSTRA_ENABLE_LEGACY_BENCHMARKS" packages examples --include="*.ts" --include="*.json" --include="*.txt" --include="*.gradle" --include="*.podspec" 2>/dev/null | grep -v node_modules | grep -v generated`
Expected: 매치 없음.

**Step 10: Commit**

```bash
git add -A packages/cli examples/react-native-calculator/rustra.json examples/react-native-calculator/modules examples/react-native-bare-calculator/modules
git commit --no-verify -m "refactor(cli): drop legacyBenchmarks config plumbing and example build flags"
```

---

### Task 8: RN 예제 legacy 어댑터·Swift·BenchmarkApp 정리

**Files:**
- Delete: `examples/react-native-calculator/src/adapters/{msgpack,bincode,hybrid,rkyv,postcard}-adapter.ts`
- Delete: `examples/react-native-calculator/src/adapters/bincode-adapter.test.mjs`
- Modify: `examples/react-native-calculator/BenchmarkApp.tsx`
- Modify: `examples/react-native-calculator/modules/rustra-calculator/ios/RustraCalculatorModule.swift`
- Modify: `examples/react-native-calculator/modules/rustra-calculator/src/index.ts` (에러 메시지가 invokeRaw를 참조하는지 확인 후 필요 시 갱신)

**Step 1: BenchmarkApp.tsx 정리**

- import 5종 제거(30, 32-35행): bincode/msgpack/rkyv/hybrid/postcard 엔진. 유지: json-adapter(31행), rkyv-v2-adapter(36행).
- 엔진 생성 4행 제거(167, 169-171행): `msgpackEngine`, `postcardEngine`, `rkyvEngine`, `hybridEngine`, `bincodeEngine`. 유지: `jsonEngine`, `rkyvV2Engine`.
- `adapters` 배열(188-196행)에서 Msgpack/Postcard/rkyv/Hybrid/Bincode 5항목 제거 → JSON/rkyvV2 2항목. for 루프는 무변경.
- 447행의 "Swift FFI invokeRaw" 문자열은 Swift 함수명 `invokeRaw`를 지칭(모듈 JS 표면) — Swift 내부 심볼 교체와 무관하므로 **유지**.

**Step 2: Swift 모듈 코어 심볼 전환**

`RustraCalculatorModule.swift`:
- 하단 `@_silgen_name` 2개를 교체:
```swift
@_silgen_name("rustra_ffi_invoke_json")
func rustra_ffi_invoke_json(_ payload: UnsafePointer<UInt8>, _ len: Int, _ outLen: UnsafeMutablePointer<Int>) -> UnsafeMutablePointer<UInt8>?

@_silgen_name("rustra_ffi_free")
func rustra_ffi_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ len: Int)
```
- `invokeRaw` AsyncFunction 본문을 바이트 경로로 교체:
```swift
AsyncFunction("invokeRaw") { (payload: String, promise: Promise) in
  let data = Array(payload.utf8)
  var outLen = 0
  let resultPtr = rustra_ffi_invoke_json(data, data.count, &outLen)
  guard let ptr = resultPtr else {
    promise.reject("ERR_INVOKE", "Rust invoke returned nil")
    return
  }
  defer { rustra_ffi_free(ptr, outLen) }
  let bytes = UnsafeBufferPointer(start: ptr, count: outLen)
  let result = String(decoding: bytes, as: UTF8.self)
  promise.resolve(result)
}
```
- `addSync`/`invokeSync`의 동기 호출도 동일 패턴 교체 (동기 Function에서 unsafe 포인터 사용 — Swift 컴파일 요건에 맞게 `let bytes = UnsafeBufferPointer(...)` 사용).
- **응답 호환성 근거**: 코어 `rustra_ffi_invoke_json` 응답은 `{"ok":bool,"result":...,"error":"..."}` (ffi_dispatch.rs:50-70, json_serialize) — Swift가 파싱하는 `json["ok"] as? Bool`, `result["value"]` 구조와 동일. 요청도 `{"command":...,"args":...}` 동일.
- Swift 동시성/포인터 캐스팅은 컴파일 검증이 로컬 iOS 빌드에서만 가능하다 — 이 태스크는 문법 정확성에 집중하고 전체 빌드 검증은 범위 밖(사용자 환경에서 수행)임을 커밋 메시지에 명시.

**Step 3: Commit**

```bash
git add -A examples/react-native-calculator
git commit --no-verify -m "refactor(rn-example): drop legacy wire adapters and switch Swift module to core invoke_json"
```

---

### Task 9: Cargo.toml 의존성 정리 + calculator 전체 검증

**Files:**
- Modify: `examples/calculator/Cargo.toml` (`rmp-serde` 제거)

**Step 1: 의존성 사용 재확인**

- `rmp_serde`: Task 4 후 사용처 0건 → `[dependencies] rmp-serde = "1"` 제거.
- `postcard`: rkyv V2 테스트/벤치가 유지하므로 유지.
- `rkyv`: 라이브러리가 이미 코어로 위임 — lib.rs에서 직접 `rkyv::` 사용이 남는지 확인. 남지 않으면 제거(테스트에서 `rkyv::`를 안 쓰는지 재확인 — wire_fixtures/panic_guard는 rkyv 미직접 사용 확인됨).

**Step 2: 전체 테스트 + clippy**

Run: `cargo test -p rustra-calculator-example 2>&1 | tail -3 && cargo clippy --workspace -- -D warnings 2>&1 | tail -3`
Expected: 모두 green.

**Step 3: Commit**

```bash
git add examples/calculator/Cargo.toml
git commit --no-verify -m "chore(calculator): drop msgpack dependency after legacy FFI removal"
```

---

### Task 10: 문서 갱신

**Files:**
- Modify: `docs/benchmarks.md` + `docs/benchmarks.ko.md` (wire-bench 섹션 215-232행 부근, 286행 legacy JSON CString 행, 418/428행 breakdown 언급)
- Modify: `docs/rust-api-guide.md:428-430` + `.ko.md:421-424` (write_to_dir deprecated 표기 — write_schema_to_dir 단일 경로로 정리)
- Modify: `docs/architecture.md:153` + `.ko.md:150` (write_to_dir deprecated 괄호 갱신)
- Modify: `docs/extending/react-native-setup.md:171-173` + `.ko.md:163-164` (legacy ABI fixture 문단 삭제)
- Modify: `examples/react-native-calculator/README.md:43` + `.ko.md:40` (legacy ABI flag 언급 제거)
- Modify: `docs/research/2026-09-03-16-00-00-dx-macro-first-assessment.md` (팔로업 정정 섹션 추가)

**Step 1: benchmarks 문서**

- wire-bench 실행 명령은 동일(`cargo run ... --bin wire-bench`) — 측정 경로가 C 심볼 → Package 메서드로 바뀌었음을 한 문장 추가하고, 테이블 수치는 "재실행 시 갱신" 주석 처리(수치 재측정은 범위 밖, 명령 재현 경로가 유효함을 보증).
- 286행 "legacy JSON CString FFI (Swift → Rust)" 행: Swift 모듈이 코어 `rustra_ffi_invoke_json` 경로로 바뀌었음을 반영해 레이블을 "core JSON FFI (Swift → Rust)"로 수정하거나 행 각주로 실측 경로 변경 명시.
- 418/428행의 "wire-bench JSON measurement" 문구는 명령 불변이므로 무변경.

**Step 2: rust-api-guide / architecture**

- guide의 Deprecated 인용 블록을 단일 경로 서술로 교체:
  > `.write_schema_to_dir(dir)` publishes only `schema.json`. The TS surfaces (`types.ts` etc.) are owned by `rustra codegen` — never regenerate them from Rust.
- architecture 표의 `(deprecated: write_to_dir())` → `(write_to_dir() 은 제거 대상 경로 — 사용 금지)` 수준의 정리. 실제 Rust API에서 `write_to_dir` 자체는 유지되므로(코어 API, 별트랙) "deprecated" 표기 자체는 유지 가능 — init 스캔폴드가 더 이상 사용하지 않음만 반영.

**Step 3: setup docs / example README** — legacy ABI fixture 문단 2-3행 삭제.

**Step 4: 리서치 문서 팔로업 섹션 추가** (파일 말미에):

```markdown
## Follow-up 정정 (2026-09-03, legacy-removal 트랙)

§"죽은 코드" 주장(`__RUstra_doc_` 소비자 없음)은 **오독**이었다. build! 매크로가
생성하는 `__RUstra_doc_<fn>` 상수는 `command_doc()`으로 흡수되어 schema
description이 되고, TS 코드젠이 이를 JSDoc으로 렌더링한다. 실증:
`examples/calculator/generated/types.ts:110`의 `/** 발행할 progress.tick 이벤트 수. */`
가 `emit_demo` 입력 필드 doc에서 온 것이다. 해당 갭 항목(a/2/6번)은 무효.
```

**Step 5: Commit**

```bash
git add docs examples/react-native-calculator/README.md examples/react-native-calculator/README.ko.md
git commit --no-verify -m "docs: reflect legacy benchmark removal and correct __RUstra_doc_ dead-code claim"
```

---

### Task 11: changesets

**Files:**
- Create: `.changeset/legacy-removal-types.md`
- Create: `.changeset/legacy-removal-cli.md`
- Create: `.changeset/legacy-removal-react-native.md`

**Step 1: changeset 작성**

`.changeset/legacy-removal-types.md`:
```markdown
---
'@rustra/types': minor
---

RustraNative shrinks to the supported surface: `invokeMsgpack`, `invokeBincode`,
`invokePostcard`, `invokeRkyv`, `invokeHybrid`, and `invokeRaw` are removed.
The generic transport (`invoke`, `invokeRkyvV2`) and typed fast paths
(`invokeTyped*`, `getCodecCapabilities`) are unchanged. Apps that compared
wire formats should use `invokeRkyvV2` codecs or the generic `invoke`.
```

`.changeset/legacy-removal-cli.md`:
```markdown
---
'@rustra/cli': minor
---

The `reactNative.legacyBenchmarks` config key is removed, along with the
`RUSTRA_LEGACY_BENCHMARKS` / `RUSTRA_ENABLE_LEGACY_BENCHMARKS` build flags from
generated modules. `rustra init` scaffolds now write `schema.json` only
(`write_schema_to_dir`) instead of the stale dual pass that also regenerated
TS surfaces from Rust.
```

`.changeset/legacy-removal-react-native.md`:
```markdown
---
'@rustra/react-native': minor
---

The JSI host object drops the calculator-only legacy benchmark functions
(`invokeBytes`, `invokeMsgpack`, `invokeBincode`, `invokePostcard`,
`invokeLegacyPostcard`, `invokeRkyv`, `invokeHybrid`, `invokeRaw`). Defect fix:
`invokeRkyvV2` is now registered outside the legacy ifdef and binds to the core
generic symbols (`rustra_ffi_invoke_rkyv_v2` + `rustra_ffi_free`), so
legacy-OFF builds no longer crash the engine's tier-2/3 fallbacks.
```

**Step 2: Commit**

```bash
git add .changeset
git commit --no-verify -m "chore: add changesets for legacy removal (types, cli, react-native)"
```

---

### Task 12: 최종 검증 6항목 + 커밋 정리

**Step 1: 전체 검증 (설계 문서 기준)**

```bash
cargo test -p rustra-calculator-example 2>&1 | tail -3
cargo clippy --workspace -- -D warnings 2>&1 | tail -3
bun test packages/cli 2>&1 | tail -5
bun run test:onboarding 2>&1 | tail -5
```

**Step 2: codegen 무드리프트**

```bash
bun run --cwd packages/cli build
bunx --cwd packages/cli rustra codegen --check --config examples/calculator/rustra.json
```
Expected: drift 없음 (bench_* 커맨드 유지로 schema.json 불변). bare-calculator도 동일 확인.

**Step 3: types/react-native 패키지 테스트**

```bash
bun run test:types 2>&1 | tail -3
bun run --cwd packages/react-native test 2>&1 | tail -3
```
(RustraNative 축소가 타입 테스트 모키타입에 영향 없음 확인 — makeNative는 RkyvV2SchemaNative만 사용하므로 예상 무영향.)

**Step 4: 실패 시 처리 원칙**

- TS 타입 에러가 RustraNative 축소에서 나면: 소비자가 legacy 메서드를 쓰는 것이므로 해당 소비자를 rkyvV2/generic 경로로 전환 (예제 밖 코어 패키지 코드에서는 발생 예정 없음 — 사전 grep 확인 완료).
- clippy가 유지 심볼의 dead_code를 지적하면: 심볼이 extern "C" pub이므로 dead_code 아님 — 경고 내용 확인 후 판단.

**Step 5: 최종 커밋 (검증 산출물 등이 스테이징됐다면)**

```bash
git status --short   # 의도치 않은 파일 잔존 확인
git log --oneline -12
```

---

## 명시적 범위 밖 (설계 문서 승인 사항 — 구현 금지)

- on_unimplemented 매크로 구현, 등록 목록 일원화, stdio_main! 매크로화 (별트랙)
- #[bridge_type] 스포츠코트 전환 (별트랙)
- BenchmarkApp 기본 엔트리 변경 (벤치 유지 결정)
- 코어 `write_to_dir` Rust API 자체의 제거 (별트랙 — 이번엔 소비자 교체만)
- 벤치 수치 재측정 (benchmarks.md 표 수치 갱신 — 명령 재현 경로만 보증)
- `bench.yml` 워크플로 변경 (legacy 미사용 확인됨)
