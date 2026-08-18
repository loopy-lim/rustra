# rkyv V2 → Nitro 격차 극복 (P0+P1) 구현 플랜

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** RN JSI typed 경로(async 5.4µs)의 JSI 부대비용을 제거해 Nitro(1.9µs) 대비 동등~우위 수준(~1.5µs)으로 단축한다. 와이어/스키마/공개 API는 불변.

**Architecture:** 3단계 최적화 — (1) 설치 시점에 JSI HostObject 스캔을 일반 JS 객체 프로퍼티로 평평화(호출당 22회 선형 스캔 제거), (2) cmd_id 기반 `invokeTypedById` 진입점 추가로 문자열 마샬링+비교체인 제거 + `hasStaticCodec` JS 캐시로 JSI 호출 2→1회, (3) ArrayBuffer 생성자/에러 postcard 파서 캐시. 모두 기존 typed fast path 위의 추가 최적화로, 동적 명령/Tier 3/OTA 경로는 그대로.

**Tech Stack:** C++17 (JSI), TypeScript (@rustra/types, @rustra/cli codegen), 기존 테스트 인프라(node --test, run-cpp-codec-tests.sh, cargo test)

**성공 기준 (측정 방법 Task 7):**
- `native.invokeRkyvV2(preEncoded)` JSI 호 홉: 8.3µs → 3µs 이하 (측정 환경 편차 고려 상대 비교)
- typed async(`addNumbers(INPUT)`): 5.4µs → 3µs 이하
- 기존 테스트 전부 통과 (`npm run test:packages`, `run-cpp-codec-tests.sh`, `cargo test -p rustra`)

**핵심 제약 (반드시 지킬 것):**
- `examples/.../generated/` 는 코드젠 산출물 — 직접 수정 금지, `codegen` 재실행으로 갱신 (memory: codegen-dual-path-regen)
- 커밋 후 lefthook prettier가 재스테이징 없이 포맷하므로 커밋 직후 `git add <files> && git commit --amend --no-edit` 습관화 (memory: lefthook-prettier-amend)
- C++ 코덱 바이트는 Rust postcard와 byte-exact해야 함 (run-cpp-codec-tests.sh가 검증)
- generated/ 는 prettier 제외 대상 (memory 확인됨)

---

### Task 1: invokeTyped 에러 postcard 파싱을 비멤버 헬퍼로 추출

**배경:** 현재 `invokeTyped`/`invokeTypedBatch`/`invokeTypedAsync` 3곳에 동일한 에러 와이어 파싱이 인라인 복제되어 있어 Task 3(생성자 캐시)과 Task 4에서 3곳을 동시에 수정해야 한다. 먼저 하나의 `static` 헬퍼로 통합해 이후 태스크의 수정 지점을 1곳으로 만든다.

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (invokeTyped 에러 분기 ~line 382-402, batch ~line 461-479, async ~line 586-599)

**Step 1: 헬퍼 작성 (리팩터링이므로 테스트는 기존 것 사용)**

`RustraJSIBridge.cpp` 상단 `extractBytes` 헬퍼 아래에 추가:

```cpp
// ── rkyv V2 에러 와이어 파싱 ────────────────────────────────
// 에러 프레임: [ok:0][pad to @8][err_len u16 LE @8][postcard{code,message} @10]
// postcard 파싱 실패 시 원시 바이트로 폴백한다(계약: 실패해도 throw 아님).
static std::string parseRkyvV2Error(const uint8_t* resp, size_t out_len) {
  if (out_len < 10) return "RustraJSI: malformed error response";
  uint16_t errLen = (uint16_t)resp[8] | ((uint16_t)resp[9] << 8);
  size_t avail = out_len > 10 ? out_len - 10 : 0;
  size_t bodyLen = errLen <= avail ? errLen : avail;
  try {
    rc::Reader errReader(resp + 10, bodyLen);
    std::string code = errReader.read_string();
    std::string message = errReader.read_string();
    return code + ": " + message;
  } catch (...) {
    return std::string(reinterpret_cast<const char*>(resp + 10), bodyLen);
  }
}
```

invokeTyped, invokeTypedBatch, invokeTypedAsync의 3개 에러 분기를 이 헬퍼 호출로 치환한다. 각 분기의 기존 `malformed` 메시지는 유지되어야 하므로, batch/async의 `out_len < 10` 사전 검사는 각자 남기고 `parseRkyvV2Error`는 postcard 본문 파싱만 담당하도록 시그니처를 조정한다:

```cpp
// postcard 본문(@10 이후)만 파싱 — malformed 검사는 호출부에서 이미 완료.
static std::string parseRkyvV2ErrorBody(const uint8_t* resp, size_t out_len) {
  uint16_t errLen = (uint16_t)resp[8] | ((uint16_t)resp[9] << 8);
  size_t avail = out_len > 10 ? out_len - 10 : 0;
  size_t bodyLen = errLen <= avail ? errLen : avail;
  try {
    rc::Reader errReader(resp + 10, bodyLen);
    std::string code = errReader.read_string();
    std::string message = errReader.read_string();
    return code + ": " + message;
  } catch (...) {
    return std::string(reinterpret_cast<const char*>(resp + 10), bodyLen);
  }
}
```

**Step 2: 컴파일 검증**

Run: `cd examples/react-native-calculator/modules/rustra-jsi/ios && ./run-cpp-codec-tests.sh`
Expected: `OK: all C++ codec tests passed` (브리지는 본 스크립트가 컴파일하지 않으므로, 컴파일 확인은 Task 6의 통합 빌드에서 함 — 여기서는 논리 리뷰만)

실제 컴파일 확인이 필요하면 Xcode 없이 syntax-check만:
```bash
clang++ -std=c++17 -fsyntax-only -I examples/react-native-calculator/modules/rustra-jsi/ios examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp 2>&1 | head -5
```
(단, jsi.h/ReactCommon 헤더가 없어 실패할 수 있음 — 그 경우 Task 6에서 통합 검증. 이때는 논리 리뷰로 대체하고 커밋하지 않고 Task 2로 진행)

**Step 3: Commit**

```bash
git add examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
git commit -m "refactor(jsi): rkyv V2 에러 와이어 파싱을 공유 헬퍼로 추출"
git add -u && git commit --amend --no-edit  # lefthook prettier 반영 (C++는 미적용이지만 안전하게)
```

---

### Task 2: JSI 함수들을 일반 JS 객체 프로퍼티로 평평화 (핵심 최적화 #1)

**배경:** `RustraHostObject::get`이 22개 엔트리를 `PropNameID::compare`로 선형 스캔한다(호출당 가상 호출 최대 22회). Nitro 방식대로 설치 시점에 일반 `jsi::Object`에 프로퍼티로 박아두면 이후 조회는 순수 JS 프로퍼티 로드가 된다. **기대 효과 −1~2µs/호출.**

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (`RustraHostObject::get`/`getPropertyNames` ~line 640-658, `installRustraJSIWithInvoker` ~line 666-674)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.hpp`
- Test: 기존 `packages/react-native/src/index.test.ts` + 새 유닛 테스트 없음 (JSI 동작은 시뮬레이터 벤치로 검증)

**Step 1: 설치 함수 변경**

`installRustraJSIWithInvoker`에서 HostObject 대신 평범한 Object 생성으로 전환한다. HostObject 클래스와 `get`/`getPropertyNames`는 **Android JNI 경로 호환을 위해 유지**하되(아래 Step 2 확인 후 제거 여부 결정), install 경로만 교체:

```cpp
void installRustraJSIWithInvoker(Runtime& rt,
                                  std::shared_ptr<void> typeErasedCallInvoker) {
  rustra_calculator_init();
  auto dispatcher = getEventDispatcher();
  dispatcher->setCallInvoker(std::move(typeErasedCallInvoker));

  // 평평한 일반 JS 객체에 모든 함수를 프로퍼티로 박는다 — 이후
  // native.invokeRkyvV2(...) 조회가 HostObject 콜백(엔트리당 compare 가상
  // 호출)이 아니라 엔진의 인라인 프로퍼티 로드가 된다 (Nitro 평탄화 방식).
  // 캐시는 HostObject 내부 cache_ 대신 이 객체 자체가 된다.
  auto hostObject = std::make_shared<RustraHostObject>(rt);  // 함수 팩토리로만 사용
  Object obj(rt);
  for (auto& name : hostObject->propertyNames(rt)) {
    obj.setProperty(rt, name, hostObject->getFunction(rt, name));
  }
  rt.global().setProperty(rt, "__rustraNative", std::move(obj));
}
```

이를 위해 `RustraJSIBridge.hpp`의 `RustraHostObject`에 public 접근자 2개 추가:

```cpp
  /// 설치 평탄화용: 캐시된 함수 이름 목록.
  std::vector<PropNameID> propertyNames(Runtime& rt);  // 기존 getPropertyNames를 public 래퍼로
  /// 설치 평탄화용: 이름으로 캐시된 함수 반환.
  Function getFunction(Runtime& rt, const PropNameID& name);
```

기존 `get`/`getPropertyNames`(HostObject 오버라이드)는 그대로 두어 안전 폴백으로 유지한다 — 평탄화 객체에서 프로퍼티가 빠진 경우에도 호환된다.

**Step 2: Android 경로 확인**

Android `rustra_jni.cpp`(runner template)가 `installRustraJSI`를 직접 호출하는지 확인한다. `grep -rn "installRustraJSI" runner/ examples/react-native-calculator/modules/*/android 2>/dev/null` — 호출부가 installRustraJSI* 만 쓰면 이 변경으로 자동 적용된다(단일 정의).

**Step 3: 빌드/테스트 검증은 Task 6에서 통합 실행** (시뮬레이터 빌드 필요). 여기서는 헤더 의존 관계 리뷰만.

**Step 4: Commit**

```bash
git add examples/react-native-calculator/modules/rustra-jsi/
git commit -m "perf(jsi): 네이티브 함수를 HostObject 스캔 대신 평평한 JS 객체로 설치"
```

---

### Task 3: ArrayBuffer 생성자 + 에러 파서 캐시 (핵심 최적화 #2)

**배경:** `createArrayBuffer`가 매 호출 `rt.global().getPropertyAsFunction(rt, "ArrayBuffer")` + `callAsConstructor`로 ArrayBuffer를 만든다(모든 invokeRkyvV2/invoke/invokeTyped 응답 경로). 생성자 1회 캐시 + 미리 만든 ArrayBuffer 재활용으로 제거한다.

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (createArrayBuffer ~line 24-32)

**Step 1: 생성자 캐시 구현**

```cpp
// ── ArrayBuffer helpers ────────────────────────────────────

/// ArrayBuffer 생성자 캐시 — 첫 호출 시 1회 조회, 이후 재사용.
/// (Runtime 생명주기 동안 불변 — JS reload 시 installRustraJSI 가 재실행되어
/// 새 Runtime 컨텍스트에서 재초기화된다. 전역 Function은 Runtime 소유이므로
/// 프로세스 전역 static 대신 설치 시점 캐시 구조체를 쓴다.)
struct RustraJsiCache {
  Function arrayBufferCtor;  // default-constructible 아님 → optional 사용
};

static Function& cachedArrayBufferCtor(Runtime& rt) {
  // 설치 시점에 초기화된 프로세스 전역 캐시. RN reload 로 Runtime 이 교체되면
  // installRustraJSIWithInvoker 가 재호출되어 여기도 재초기화된다.
  static std::optional<Function> ctor;
  if (!ctor) {
    ctor = rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
  }
  return *ctor;
}

static Value createArrayBuffer(Runtime& rt, const uint8_t* data, size_t size) {
  // 생성자 캐시 + 크기 고정 호출 — 기존과 동일한 바이너리 결과.
  Object ab = cachedArrayBufferCtor(rt).callAsConstructor(rt, static_cast<double>(size))
    .getObject(rt);
  ArrayBuffer buf = ab.getArrayBuffer(rt);
  std::memcpy(buf.data(rt), data, size);
  return ab;
}
```

⚠️ **주의:** `static std::optional<Function>`은 프로세스 전역이지만 jsi::Function은 Runtime 소유다. RN 리로드로 기존 Runtime이 죽으면 dangling된다. 안전장치: `installRustraJSIWithInvoker` 시작 부분에서 캐시를 리셋한다:

```cpp
// RN reload 대응: 새 Runtime 설치 시 정적 캐시 초기화.
resetRustraJsiCache();
```

헬퍼:
```cpp
static void resetRustraJsiCache() {
  cachedArrayBufferCtorReset();
}
```

(구현 단순화: `static std::optional<Function>`을 함수 내부가 아니라 파일 스코프로 두고 reset 함수가 `reset()` 호출.)

**Step 2: 로컬 컴파일 검증**

Task 6 통합 전 빠른 확인 — test-jsi-shim 기반 컴파일은 RustraJSIBridge.cpp가 ReactCommon 의존이라 불가. 논리 리뷰로 대체 (Function의 이동/복사 semantics: jsi::Function은 이동 전용이므로 optional에 move-assign).

**Step 3: Commit**

```bash
git add examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
git commit -m "perf(jsi): ArrayBuffer 생성자 캐시로 응답 경로 글로벌 조회 제거"
```

---

### Task 4: cmd_id 진입점 invokeTypedById + hasStaticCodec JS 캐시 (핵심 최적화 #3)

**배경:** 현재 typed dispatch가 JSI 2회 횡단(`hasStaticCodec` + `invokeTyped`) + 문자열 마샬링 2회 + C++ 13개 이름 비교 2회를 수반한다. (a) 엔진이 정적 명령 집합을 `Set`으로 캐시해 `hasStaticCodec` JSI 호출을 제거, (b) C++ `invokeTypedById(cmd_id, args)`를 추가해 문자열→비교체인을 u16 인덱싱으로 대체. **JSI 횡단 2→1, 문자열 2→0. 기대 효과 −1~1.5µs.**

**Files:**
- Modify: `packages/types/src/index.ts` (createRkyvV2Engine dispatch ~line 696-744)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (invokeTyped 옆에 invokeTypedById 추가)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/src/index.ts` (RustraNative 타입에 추가)
- Modify: `packages/cli/src/generate.ts` (generateRkyvCodecsHpp/Cpp — encode_by_id/decode_by_id/has_static_codec_id)
- Test: `packages/types/src/index.test.ts`, `packages/react-native/src/index.test.ts`
- Regenerate: `examples/react-native-calculator/modules/rustra-jsi/ios/rustra-generated-codecs.{hpp,cpp}`

**Step 1: 실패 테스트 작성 (TDD)**

`packages/types/src/index.test.ts`에 추가 — invokeTypedById가 노출되면 이를 사용하고, 없으면 기존 이름 기반 경로로 폴백하는지:

```ts
test('typed dispatch uses invokeTypedById when available', () => {
  const calls: string[] = [];
  const native = makeNative({
    invokeTypedById: (id: number, args: unknown) => {
      calls.push(`byId:${id}`);
      return { value: (args as { a: number; b: number }).a + (args as { a: number; b: number }).b };
    },
    hasStaticCodec: (name: string) => {
      calls.push(`has:${name}`);
      return name === 'addNumbers';
    },
  });
  const registry = new Map([['addNumbers', { commandId: 1, encode: () => new ArrayBuffer(4), decode: () => ({ ok: true, result: { value: 3 } }) }]]);
  const engine = createRkyvV2Engine(native as any, registry as any);
  const result = engine.invoke('addNumbers', { a: 1, b: 2 });
  assert.ok(calls.some((c) => c.startsWith('byId:')));
  assert.ok(!calls.some((c) => c.startsWith('has:')), 'hasStaticCodec JSI 호출이 없어야 함(캐시 사용)');
});
```

`makeNative` 헬퍼가 기존 테스트 파일에 있는지 확인하고, 없으면 로컬로 만든다.

**Step 2: 테스트 실행해 실패 확인**

Run: `npm run test:types 2>&1 | grep -A5 "invokeTypedById"`
Expected: FAIL (invokeTypedById 미사용)

**Step 3: 엔진 dispatch 변경 (packages/types/src/index.ts)**

`createRkyvV2Engine` 내부:

```ts
  // 정적 명령 집합의 JS 캐시 — hasStaticCodec JSI 호출을 호출당 1회에서
  // 엔진 생애 1회 스윕으로 축소한다. (첫 dispatch 때 채운다.)
  let staticCommandIds: Map<string, number> | null = null;
  const ensureStaticIds = () => {
    if (staticCommandIds || !hasTypedPath) return staticCommandIds;
    staticCommandIds = new Map();
    for (const [name, codec] of registry) {
      if (native.hasStaticCodec!(name)) staticCommandIds.set(name, codec.commandId);
    }
    return staticCommandIds;
  };

  const dispatch = async <T>(command: string, args?: unknown): Promise<T> => {
    // 1순위: C++ fast path. byId 진입이 가능하면 JSI 1회 + u16 인덱싱.
    if (hasTypedPath) {
      const ids = ensureStaticIds();
      if (ids && ids.has(command)) {
        const cmdId = ids.get(command)!;
        if (typeof native.invokeTypedById === 'function') {
          return native.invokeTypedById(cmdId, args) as T;
        }
        return native.invokeTyped!(command, args) as T;
      }
    }
    // ... (2순위/3순위는 기존 그대로)
  };
```

⚠️ 동적 명령(`registry`에 없는 이름)은 `ensureStaticIds` 미스 → 기존 Tier 3 경로. 이때 `registry` 미등록 + C++ 코덱 존재(코드젠 시점 정적)인 경우는? — `registry`가 코드젠 산출물이므로 정적 명령은 항상 registry에 있다(불변식). 문서화 주석로 명시.

⚠️ 취소/배치 경로(`invoke`, `invokeBatch`)의 `hasStaticCodec` 호출도 동일한 캐시로 교체한다(`packages/types/src/index.ts:760`, `:819`).

**Step 4: 테스트 통과 확인**

Run: `npm run test:types && cd ../.. && npm run build -w @rustra/types`
Expected: PASS

**Step 5: C++ invokeTypedById 추가**

`RustraJSIBridge.cpp` invokeTyped 바로 뒤에:

```cpp
  // invokeTypedById(cmdId, args): invokeTyped 의 id 인덱싱 변형 — 문자열
  // 마샬링과 이름 비교체인을 제거한 최단 typed 진입 (P0-#3).
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTypedById");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: invokeTypedById requires (cmdId, args)");
        }
        uint16_t cmdId = static_cast<uint16_t>(args[0].asNumber());
        rc::Writer w;
        if (!gen::encode_by_id(rt, cmdId, args[1], w)) {
          throw JSError(rt, "RustraJSI: no C++ codec for id " + std::to_string(cmdId));
        }
        auto req = w.take();
        size_t out_len = 0;
        uint8_t* resp = rustra_calculator_invoke_rkyv_v2(req.data(), req.size(), &out_len);
        if (!resp) {
          throw JSError(rt, "RustraJSI: invokeRkyvV2 returned null");
        }
        if (out_len < 1) {
          rustra_calculator_free_buffer(resp, out_len);
          throw JSError(rt, "RustraJSI: empty rkyv v2 response");
        }
        if (resp[0] == 0) {
          std::string errStr = parseRkyvV2ErrorBody(resp, out_len);
          rustra_calculator_free_buffer(resp, out_len);
          throw JSError(rt, errStr);
        }
        if (out_len < 8) {
          rustra_calculator_free_buffer(resp, out_len);
          throw JSError(rt, "RustraJSI: malformed success response");
        }
        rc::Reader r(resp + 8, out_len - 8);
        Value result = gen::decode_by_id(rt, cmdId, r);
        rustra_calculator_free_buffer(resp, out_len);
        return result;
      });
    cache_["invokeTypedById"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::make_unique<Function>(std::move(hostFn))});
  }
```

(실제 `CachedFunction` 구조는 헤더 확인 후 정확히 맞춘다 — `RustraJSIBridge.hpp` 참조.)

**Step 6: 코드젠에 encode_by_id/decode_by_id/has_static_codec_id 추가**

`packages/cli/src/generate.ts` `generateRkyvCodecsHpp`에 선언 추가:

```ts
lines.push(`/// cmd_id(u16)로 postcard 요청을 인코딩한다(정적 명령만). 미발견 시 false.\n`);
lines.push(`bool encode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n`);
lines.push(`                    const facebook::jsi::Value& args,\n`);
lines.push(`                    rustra::codec::Writer& w);\n\n`);
lines.push(`/// cmd_id(u16)로 postcard 응답 바디를 디코딩한다(정적 명령만). 미발견 시 JSError.\n`);
lines.push(`facebook::jsi::Value decode_by_id(facebook::jsi::Runtime& rt, uint16_t cmd_id,\n`);
lines.push(`                        rustra::codec::Reader& r);\n\n`);
```

`generateRkyvCodecsCpp` 구현은 **switch 문**으로 생성 (이름 비교체인과 동일한 로직, cmd_id 케이스):

```ts
const encodeCases = schema.commands
    .map((c) => `  case ${c.commandId}: encode_${commandFunctionName(c.name)}(rt, args, w); return true;`)
    .join('\n');
// switch (cmd_id) { ... default: return false; }
```

decode도 동일 구조. `has_static_codec` (이름 기반)은 유지 — JS 캐시 구축용 1회 스윕에만 쓰인다.

**Step 7: generated 재생성 + C++ 테스트 갱신**

```bash
# 코드젠 실행 (memory: codegen-dual-path-regen — Rust bin + TS CLI 둘 다 확인했으면 하나로)
npm run codegen 2>/dev/null || npx @rustra/cli generate --schema examples/calculator/generated/schema.json --out examples/react-native-calculator/modules/rustra-jsi/ios --cpp-output .
```

(정확한 명령은 `packages/cli/src/index.ts` CLI 인자 확인 후 플랜 실행 시 결정 — schema.json 경로와 out 경로가 이전과 동일한지 확인.)

`test-rustra-generated-codecs.cpp`에 by_id 케이스 추가:

```cpp
  // ── encode_by_id / decode_by_id (P0-#3) ──
  {
    Object args(rt);
    args.setProperty(rt, "a", 42.0);
    args.setProperty(rt, "b", 58.0);
    Value argsV(rt, args);

    rc::Writer w;
    bool ok = gen::encode_by_id(rt, 1, argsV, w);
    if (!ok) { std::printf("FAIL encode_by_id(1) returned false\n"); ++g_failures; }
    check_bytes(w.take(), {0x01, 0x00, 0x54, 0x74}, "encode_by_id addNumbers {42,58}");
  }
```

Run: `cd examples/react-native-calculator/modules/rustra-jsi/ios && ./run-cpp-codec-tests.sh`
Expected: `OK: all C++ codec tests passed`

**Step 8: JS 쪽 RustraNative 타입 갱신**

`examples/react-native-calculator/modules/rustra-jsi/src/index.ts` 타입과 `packages/react-native/src/index.ts` `RustraJSINative`에 `invokeTypedById?(cmdId: number, args: unknown): unknown;` 추가.

**Step 9: 전체 테스트**

Run: `npm run test:packages 2>&1 | tail -5`
Expected: 모든 패키지 테스트 PASS

**Step 10: Commit**

```bash
git add packages/types/src/index.ts packages/types/src/index.test.ts packages/cli/src/generate.ts packages/cli/src/generate.test.ts examples/react-native-calculator/modules/rustra-jsi/
git commit -m "perf(engine): cmd_id 진입점 invokeTypedById + 정적 명령 집합 JS 캐시"
```

---

### Task 5: invokeTypedBatch byId 변형 (선택, 배치 핫패스)

**배경:** 배치도 동일하게 이름 배열 마샬링 대신 id 배열로. Task 4 완료 후 진행.

**Files:**
- Modify: `packages/types/src/index.ts` (invokeBatch ~line 813-831)
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (invokeTypedBatch 옆)
- Test: `packages/types/src/index.test.ts`

동일 패턴(invokeTypedBatchById(ids, args))이므로 상세는 Task 4와 동일 — 실행 시 Task 4의 완성 코드를 참조해 대응시킨다. 배치 dispatch:

```ts
if (hasBatchPath && entries.length > 0 && entries.every((e) => staticIds?.has(e.command)) && entries.every((e) => !e.options?.signal)) {
  const ids = entries.map((e) => staticIds!.get(e.command)!);
  const results = native.invokeTypedBatchById!(ids, args) as T[];
  return Promise.resolve(results);
}
```

**Commit:** `perf(engine): invokeTypedBatchById — 배치 경로 id 인덱싱`

---

### Task 6: 통합 검증 (시뮬레이터 빌드 + 벤치마크)

**Files:** 없음 (검증 전용)

**Step 1: Rust + iOS 시뮬레이터 빌드**

```bash
cd examples/react-native-calculator/modules/rustra-jsi/ios && ./build-rust-ios.sh
cd .. && npx expo run:ios  # BenchmarkApp 교체 필요하면 교체 후
```

**Step 2: 벤치마크 실행 (BenchmarkApp.tsx)**

BenchmarkApp의 기존 벤치 실행. 확인 지표:
- `rkyvV2 JSI call` (native.invokeRkyvV2 프리인코딩 홉): 8.3µs → ≤3µs 목표
- `rkyvV2 full sync` 11.2µs → ≤5µs
- `rkyvV2 async` 5.4µs → ≤3µs
- Nitro async 대비 비율: `rkyvV2 / Nitro` 2.8x → ≤1.5x

시뮬레이터 없는 환경이면 이 단계는 스킵하고 문서에 측정 예정으로 남긴다(스로틀링 등 측정 환경 한계 때문 — 메모리: 측정은 상대 비교가 신뢰).

**Step 3: Rust 테스트**

Run: `cargo test -p rustra -p rustra-calculator-example 2>&1 | tail -3`
Expected: 전부 PASS

**Step + 문서 갱신:**

`docs/benchmarks.md` 측정 결과 표에 새 수치 추가(측정 성공 시).

**Commit:** `docs(bench): JSI fast path 최적화 후 재측정`

---

### Task 7: (선택 P1) FFI 응답 caller-buffer 변형

**배경:** Rust가 malloc→복사→JS memcpy 사이클의 3중 복사를 갖는다. caller가 제공한 버퍼에 직접 쓰는 변형은 Rust 코어 와이어 변경(rkyv V2 게이트/사이즈 체크 통과 경로)을 수반하므로 **별도 후속 플랜으로 분리**한다. 이 플랜에서는 문서(`docs/benchmarks.md` 오버헤드 분석 섹션)에 "다음 단계: FFI caller-buffer 변형으로 malloc/memcpy 제거" 한 줄만 남긴다.

---

## 실행 순서 요약

| Task | 내용 | 커밋 유형 |
|---|---|---|
| 1 | 에러 파싱 헬퍼 추출 | refactor |
| 2 | JSI 함수 평탄화 (사전 확인: `grep -rn "installRustraJSI" runner/`) | perf |
| 3 | ArrayBuffer 생성자 캐시 | perf |
| 4 | invokeTypedById + JS 캐시 | perf |
| 5 | batch byId (선택) | perf |
| 6 | 통합 검증 + 문서 | docs |
| 7 | (후속) FFI caller-buffer | 별도 플랜 |

**리스크 노트:**
- Task 2의 평탄화는 RN reload 시 재설치 계약(installRustraJSI가 매 reload 호출됨)에 의존 — 기존 동작과 동일하므로 안전.
- Task 3의 static Function 캐시는 reload 시 dangling 위험 → resetRustraJsiCache로 방어 (플랜에 명시).
- Task 4의 `ensureStaticIds`는 registry와 C++ 코덱 사이 불변식(정적 명령 ⊆ registry)에 의존 — 주석 명시.
