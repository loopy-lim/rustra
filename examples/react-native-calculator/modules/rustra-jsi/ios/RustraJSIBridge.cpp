#include "RustraJSIBridge.hpp"
#include <cstring>
#include <jsi/jsi.h>

namespace rustra {

using namespace facebook::jsi;

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

Value RustraHostObject::get(Runtime& rt, const PropNameID& name) {
  auto propName = name.utf8(rt);

  if (propName == "noop") {
    return Function::createFromHostFunction(
      rt, name, 0,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        auto [data, size] = extractBytes(rt, args[0]);
        return createArrayBuffer(rt, data, size);
      });
  }

  if (propName == "invokeRaw") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeRaw requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_raw(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust invoke_raw returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invoke") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invoke requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_bytes(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust returned null (invalid payload)");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokeMsgpack") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeMsgpack requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_msgpack(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust msgpack returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokeBincode") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeBincode requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_bincode(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust bincode returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokePostcard") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokePostcard requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_postcard(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust postcard returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokeRkyv") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeRkyv requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_rkyv(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust rkyv returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokeHybrid") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeHybrid requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_hybrid(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust hybrid returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  if (propName == "invokeRkyvV2") {
    return Function::createFromHostFunction(
      rt, name, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI.invokeRkyvV2 requires 1 argument: (payload)");
        }

        auto [data, size] = extractBytes(rt, args[0]);

        size_t out_len = 0;
        uint8_t* result = rustra_calculator_invoke_rkyv_v2(data, size, &out_len);

        if (!result) {
          throw JSError(rt, "RustraJSI: Rust rkyv v2 returned null");
        }

        auto returnValue = createArrayBuffer(rt, result, out_len);
        rustra_calculator_free_buffer(result, out_len);
        return returnValue;
      });
  }

  return Value::undefined();
}

std::vector<PropNameID> RustraHostObject::getPropertyNames(Runtime& rt) {
  std::vector<PropNameID> names;
  names.reserve(9);
  names.push_back(PropNameID::forAscii(rt, "invoke"));
  names.push_back(PropNameID::forAscii(rt, "invokeMsgpack"));
  names.push_back(PropNameID::forAscii(rt, "invokeBincode"));
  names.push_back(PropNameID::forAscii(rt, "invokePostcard"));
  names.push_back(PropNameID::forAscii(rt, "invokeRkyv"));
  names.push_back(PropNameID::forAscii(rt, "invokeHybrid"));
  names.push_back(PropNameID::forAscii(rt, "invokeRkyvV2"));
  names.push_back(PropNameID::forAscii(rt, "invokeRaw"));
  names.push_back(PropNameID::forAscii(rt, "noop"));
  return names;
}

void installRustraJSI(Runtime& rt) {
  auto hostObject = std::make_shared<RustraHostObject>();
  auto obj = Object::createFromHostObject(rt, hostObject);
  rt.global().setProperty(rt, "__rustraNative", Value(rt, obj));
}

} // namespace rustra
