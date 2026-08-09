#include "RustraJSIBridge.hpp"
#include "rustra-generated-codecs.hpp"
#include <cstring>
#include <jsi/jsi.h>

namespace rustra {

using namespace facebook::jsi;
namespace gen = rustra::generated;
namespace rc = rustra::codec;

// ── ArrayBuffer helpers ────────────────────────────────────

static Value createArrayBuffer(Runtime& rt, const uint8_t* data, size_t size) {
  Function arrayBufferCtor = rt.global()
    .getPropertyAsFunction(rt, "ArrayBuffer");
  Object ab = arrayBufferCtor.callAsConstructor(rt, static_cast<double>(size))
    .getObject(rt);
  ArrayBuffer buf = ab.getArrayBuffer(rt);
  std::memcpy(buf.data(rt), data, size);
  return ab;
}

static std::pair<const uint8_t*, size_t> extractBytes(Runtime& rt, const Value& value) {
  auto obj = value.asObject(rt);

  if (obj.isArrayBuffer(rt)) {
    auto buf = obj.getArrayBuffer(rt);
    return {buf.data(rt), buf.size(rt)};
  }

  auto bufferProp = obj.getProperty(rt, "buffer");
  if (bufferProp.isObject() && bufferProp.asObject(rt).isArrayBuffer(rt)) {
    auto buf = bufferProp.asObject(rt).getArrayBuffer(rt);
    auto byteOffset = static_cast<size_t>(obj.getProperty(rt, "byteOffset").asNumber());
    auto byteLength = static_cast<size_t>(obj.getProperty(rt, "byteLength").asNumber());
    return {buf.data(rt) + byteOffset, byteLength};
  }

  throw JSError(rt, "RustraJSI: expected ArrayBuffer or TypedArray");
}

// ── HostObject with cached functions ───────────────────────

using InvokeFn = uint8_t*(*)(const uint8_t*, size_t, size_t*);

// live schema FFI (from rustra crate)
extern "C" uint8_t* rustra_ffi_get_schema(size_t* out_len);

RustraHostObject::RustraHostObject(Runtime& rt) {
  auto makeInvoke = [&](const char* name, InvokeFn fn, const char* err) {
    auto propNameId = PropNameID::forAscii(rt, name);
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [fn, err](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, std::string("RustraJSI: requires 1 argument — ") + err);
        }
        auto [data, size] = extractBytes(rt, args[0]);
        size_t out_len = 0;
        uint8_t* result = fn(data, size, &out_len);
        if (!result) {
          throw JSError(rt, std::string("RustraJSI: ") + err);
        }
        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_ffi_free(result, out_len);
        return returnValue;
      });
    cache_[name] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  };

  // ── Generic FFI paths (default, json, postcard) ────────────
  makeInvoke("invoke",        rustra_ffi_invoke,              "Rust returned null");
  makeInvoke("invokeJson",    rustra_ffi_invoke_json,         "Rust json returned null");
  makeInvoke("invokePostcardFFI", rustra_ffi_invoke_postcard, "Rust postcard FFI returned null");

  // ── Per-example benchmark paths (legacy) ───────────────────
  makeInvoke("invokeBytes",   rustra_calculator_invoke_bytes,  "Rust bytes returned null");
  makeInvoke("invokeMsgpack",  rustra_calculator_invoke_msgpack, "Rust msgpack returned null");
  makeInvoke("invokeBincode",  rustra_calculator_invoke_bincode, "Rust bincode returned null");
  makeInvoke("invokeLegacyPostcard", rustra_calculator_invoke_postcard,"Rust postcard returned null");
  makeInvoke("invokeRkyv",     rustra_calculator_invoke_rkyv,    "Rust rkyv returned null");
  makeInvoke("invokeHybrid",   rustra_calculator_invoke_hybrid,  "Rust hybrid returned null");
  makeInvoke("invokeRkyvV2",   rustra_calculator_invoke_rkyv_v2, "Rust rkyv v2 returned null");
  makeInvoke("invokeRaw",      rustra_calculator_invoke_raw,     "Rust invoke_raw returned null");

  // noop: returns input bytes unchanged
  {
    auto propNameId = PropNameID::forAscii(rt, "noop");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 0,
      [](Runtime& rt, const Value&, const Value* args, size_t) -> Value {
        auto [data, size] = extractBytes(rt, args[0]);
        return createArrayBuffer(rt, data, size);
      });
    cache_["noop"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // getSchema: live schema query → rustra_ffi_get_schema (정적 + 동적 명령)
  {
    auto propNameId = PropNameID::forAscii(rt, "getSchema");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 0,
      [](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        size_t out_len = 0;
        uint8_t* data = rustra_ffi_get_schema(&out_len);
        if (!data) {
          throw JSError(rt, "RustraJSI: getSchema returned null");
        }
        auto returnValue = createArrayBuffer(rt, data, out_len);
        rustra_ffi_free(data, out_len);
        return returnValue;
      });
    cache_["getSchema"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── B1 fast path: 정적 명령을 C++ postcard 코덱으로 인코딩/디코딩 ──
  // JS 측 codec.encode/decode(~3.4µs)를 C++로 옮겨 JS↔바이트 왕복을 제거.
  // 동적 명령은 hasStaticCodec() == false → JS가 Tier 3 JSON fallback.

  // hasStaticCodec(name): codegen 시점에 알려진 정적 명령인지 반환.
  {
    auto propNameId = PropNameID::forAscii(rt, "hasStaticCodec");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI: hasStaticCodec requires 1 argument");
        }
        std::string name = args[0].asString(rt).utf8(rt);
        return Value(rt, gen::has_static_codec(name));
      });
    cache_["hasStaticCodec"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // invokeTyped(name, args): 정적 명령 전용 postcard fast path.
  // 흐름: encode_by_name → invoke_rkyv_v2 FFI → decode_by_name.
  // Rust 에러면 JSError throw, 성공이면 디코딩된 JS 객체 반환.
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTyped");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: invokeTyped requires (name, args)");
        }
        std::string name = args[0].asString(rt).utf8(rt);

        // 1) JS 객체 → postcard 요청 바이트 ([cmd_id u16 LE][postcard(I)])
        rc::Writer w;
        if (!gen::encode_by_name(rt, name, args[1], w)) {
          throw JSError(rt, "RustraJSI: no C++ codec for '" + name + "'");
        }
        auto req = w.take();

        // 2) Rust FFI (rkyv V2 단일 엔진). 응답: [ok][pad 7][postcard(O) @8]
        size_t out_len = 0;
        uint8_t* resp = rustra_calculator_invoke_rkyv_v2(req.data(), req.size(), &out_len);
        if (!resp) {
          throw JSError(rt, "RustraJSI: invokeRkyvV2 returned null");
        }

        // 3) 응답 헤더 분기. ok=1 → postcard 바디 디코딩, ok=0 → 에러 메시지.
        if (out_len < 1) {
          rustra_ffi_free(resp, out_len);
          throw JSError(rt, "RustraJSI: empty rkyv v2 response");
        }
        if (resp[0] == 0) {
          // 에러 와이어: [ok:0][pad to @8][err_len u16 LE @8][err @10]
          if (out_len < 10) {
            rustra_ffi_free(resp, out_len);
            throw JSError(rt, "RustraJSI: malformed error response");
          }
          uint16_t errLen = (uint16_t)resp[8] | ((uint16_t)resp[9] << 8);
          size_t avail = out_len > 10 ? out_len - 10 : 0;
          std::string err(reinterpret_cast<const char*>(resp + 10),
                           errLen <= avail ? errLen : avail);
          rustra_ffi_free(resp, out_len);
          throw JSError(rt, err);
        }

        // 성공: postcard(O) @8 부터 디코딩.
        if (out_len < 8) {
          rustra_ffi_free(resp, out_len);
          throw JSError(rt, "RustraJSI: malformed success response");
        }
        rc::Reader r(resp + 8, out_len - 8);
        Value result = gen::decode_by_name(rt, name, r);
        rustra_ffi_free(resp, out_len);
        return result;
      });
    cache_["invokeTyped"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── P0-2 invokeTypedBatch: N 개 정적 명령을 단 한 번의 JSI 횡단으로 처리 ──
  // 잦은 단건 호출의 JSI 경계 비용(N-1 회 횡단 + JS 재진입)을 상쇄 → jank 완화.
  // 흐름: names/args 배열을 받아 C++ 루프에서 encode→FFI→decode → 결과 JS Array 1회 반환.
  // 모든 항목이 정적 코덱이어야 함(JS 가 hasStaticCodec 으로 사전 검증). 첫 에러에서 throw.
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTypedBatch");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: invokeTypedBatch requires (names, args)");
        }
        Array names = args[0].asObject(rt).getArray(rt);
        Array inputs = args[1].asObject(rt).getArray(rt);
        size_t n = names.length(rt);
        if (inputs.length(rt) != n) {
          throw JSError(rt, "RustraJSI: invokeTypedBatch names/args length mismatch");
        }

        Array results(rt, n);
        for (size_t i = 0; i < n; i++) {
          std::string name = names.getValueAtIndex(rt, i).asString(rt).utf8(rt);
          const Value& oneArgs = inputs.getValueAtIndex(rt, i);

          // encode (정적 명령 필수)
          rc::Writer w;
          if (!gen::encode_by_name(rt, name, oneArgs, w)) {
            throw JSError(rt, "RustraJSI: batch item has no C++ codec for '" + name + "'");
          }
          auto req = w.take();

          // FFI
          size_t out_len = 0;
          uint8_t* resp = rustra_calculator_invoke_rkyv_v2(req.data(), req.size(), &out_len);
          if (!resp) {
            throw JSError(rt, "RustraJSI: invokeRkyvV2 returned null (batch item " + name + ")");
          }

          // 응답 분기: ok=1 → decode, ok=0 → 에러 throw (fail-fast)
          if (out_len < 1) {
            rustra_ffi_free(resp, out_len);
            throw JSError(rt, "RustraJSI: empty rkyv v2 response (batch)");
          }
          if (resp[0] == 0) {
            if (out_len < 10) {
              rustra_ffi_free(resp, out_len);
              throw JSError(rt, "RustraJSI: malformed error response (batch)");
            }
            uint16_t errLen = (uint16_t)resp[8] | ((uint16_t)resp[9] << 8);
            size_t avail = out_len > 10 ? out_len - 10 : 0;
            std::string err(reinterpret_cast<const char*>(resp + 10),
                             errLen <= avail ? errLen : avail);
            rustra_ffi_free(resp, out_len);
            throw JSError(rt, err);
          }
          if (out_len < 8) {
            rustra_ffi_free(resp, out_len);
            throw JSError(rt, "RustraJSI: malformed success response (batch)");
          }
          rc::Reader r(resp + 8, out_len - 8);
          Value decoded = gen::decode_by_name(rt, name, r);
          rustra_ffi_free(resp, out_len);
          results.setValueAtIndex(rt, i, decoded);
        }
        return results;
      });
    cache_["invokeTypedBatch"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }
}

Value RustraHostObject::get(Runtime& rt, const PropNameID& name) {
  // Fast path: compare PropNameID against cached entries.
  // This avoids string allocation from name.utf8(rt).
  for (auto& [key, cached] : cache_) {
    if (PropNameID::compare(rt, name, cached->propNameId)) {
      return Value(rt, cached->function);
    }
  }
  return Value::undefined();
}

std::vector<PropNameID> RustraHostObject::getPropertyNames(Runtime& rt) {
  std::vector<PropNameID> names;
  names.reserve(cache_.size());
  for (auto& [key, cached] : cache_) {
    names.push_back(PropNameID::forUtf8(rt, key));
  }
  return names;
}

// ── Install ────────────────────────────────────────────────

// Deterministic package registration (avoids relying on __mod_init_func which
// can be dead-stripped in debug iOS static-lib builds).
extern "C" void rustra_calculator_init();

void installRustraJSI(Runtime& rt) {
  rustra_calculator_init();
  auto hostObject = std::make_shared<RustraHostObject>(rt);
  auto obj = Object::createFromHostObject(rt, hostObject);
  rt.global().setProperty(rt, "__rustraNative", Value(rt, obj));
}

} // namespace rustra
