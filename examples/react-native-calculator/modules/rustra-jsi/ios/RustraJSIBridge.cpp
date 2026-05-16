#include "RustraJSIBridge.hpp"
#include <cstring>
#include <jsi/jsi.h>

namespace rustra {

using namespace facebook::jsi;

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
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
    cache_[name] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  };

  makeInvoke("invoke",        rustra_calculator_invoke_bytes,   "Rust returned null");
  makeInvoke("invokeMsgpack",  rustra_calculator_invoke_msgpack, "Rust msgpack returned null");
  makeInvoke("invokeBincode",  rustra_calculator_invoke_bincode, "Rust bincode returned null");
  makeInvoke("invokePostcard", rustra_calculator_invoke_postcard,"Rust postcard returned null");
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

void installRustraJSI(Runtime& rt) {
  auto hostObject = std::make_shared<RustraHostObject>(rt);
  auto obj = Object::createFromHostObject(rt, hostObject);
  rt.global().setProperty(rt, "__rustraNative", Value(rt, obj));
}

} // namespace rustra
