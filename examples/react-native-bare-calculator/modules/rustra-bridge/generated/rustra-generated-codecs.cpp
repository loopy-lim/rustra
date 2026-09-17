// ── rustra generated ────────────────────────────────────────
// File:   rustra-generated-codecs.cpp
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → cpp codec renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────
// C++ postcard codec for the RN JSI fast path (B1).
#include "rustra-generated-codecs.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <jsi/jsi.h>
#include <initializer_list>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace facebook::jsi;
namespace jsi = facebook::jsi;
namespace rc = rustra::codec;
namespace rustra::generated {
const char* compiled_contract_hash() { return "e70c24c62944ff78fb6ca58b5658d85bb5cff49af4acc96b3a78bedcbdfb0a58"; }
}

// Each invocation owns its captured map values until canonical encoding finishes.
// Small maps avoid a vector allocation; larger maps retain bounded reservation.
class RustraMapEntries {
public:
  using Entry = std::pair<std::string, jsi::Value>;
  RustraMapEntries(jsi::Runtime& rt, size_t count) : use_inline_(count <= inline_entries_.size()) {
    if (count > heap_entries_.max_size()) throw jsi::JSError(rt, "rustra: map size exceeds native capacity");
    if (!use_inline_) heap_entries_.reserve(std::min<size_t>(count, 64));
  }
  void emplace_back(std::string&& key, jsi::Value&& value) {
    if (use_inline_) inline_entries_[size_] = Entry(std::move(key), std::move(value));
    else heap_entries_.emplace_back(std::move(key), std::move(value));
    ++size_;
  }
  Entry* begin() { return use_inline_ ? inline_entries_.data() : heap_entries_.data(); }
  Entry* end() { return begin() + size_; }
  size_t size() const { return size_; }
private:
  std::array<Entry, 4> inline_entries_;
  std::vector<Entry> heap_entries_;
  size_t size_ = 0;
  bool use_inline_;
};

// UTF8 may replace lone UTF16 surrogates. Preserve the prior normalized lookup
// for replacement-containing keys; ordinary keys retain their original JSI string.
[[maybe_unused]] static jsi::Value rustra_map_value(jsi::Runtime& rt, const jsi::Object& object, const jsi::String& key, const std::string& utf8) {
  if (utf8.find("\xEF\xBF\xBD") == std::string::npos) return object.getProperty(rt, key);
  return object.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(utf8.data()), utf8.size()));
}

[[maybe_unused]] static double rustra_f64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");
  double number = value.asNumber();
  if (!std::isfinite(number)) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be finite");
  return number;
}
[[maybe_unused]] static int64_t rustra_i64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  if (value.isBigInt()) return value.asBigInt(rt).asInt64(rt);
  double number = rustra_f64(rt, value, field);
  constexpr double maxSafe = 9007199254740991.0;
  if (std::trunc(number) != number || number < -maxSafe || number > maxSafe)
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a safe integer or bigint");
  return static_cast<int64_t>(number);
}
[[maybe_unused]] static uint64_t rustra_u64(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  if (value.isBigInt()) return value.asBigInt(rt).asUint64(rt);
  double number = rustra_f64(rt, value, field);
  constexpr double maxSafe = 9007199254740991.0;
  if (std::trunc(number) != number || number < 0.0 || number > maxSafe)
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a non-negative safe integer or bigint");
  return static_cast<uint64_t>(number);
}
[[maybe_unused]] static uint8_t rustra_u8(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  if (!value.isNumber()) throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a number");
  double number = value.asNumber();
  if (!(number >= 0.0 && number <= 255.0))
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");
  uint8_t byte = static_cast<uint8_t>(number);
  if (static_cast<double>(byte) != number)
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be an integer in 0..255");
  return byte;
}
struct RustraByteSpan { const uint8_t* data; size_t size; };
[[maybe_unused]] static RustraByteSpan rustra_bytes(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  if (!value.isObject())
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray, ArrayBuffer, or number[]");
  auto object = value.asObject(rt);
  if (object.isArrayBuffer(rt)) {
    auto buffer = object.getArrayBuffer(rt);
    auto size = buffer.length(rt);
    auto* data = buffer.data(rt);
    if (size > 0 && data == nullptr)
      throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached ArrayBuffer storage");
    return {data, size};
  }
  auto bytesPerElement = object.getProperty(rt, "BYTES_PER_ELEMENT");
  auto bufferValue = object.getProperty(rt, "buffer");
  auto offsetValue = object.getProperty(rt, "byteOffset");
  auto lengthValue = object.getProperty(rt, "byteLength");
  if (!bytesPerElement.isNumber() || bytesPerElement.asNumber() != 1.0 || !bufferValue.isObject() || !bufferValue.asObject(rt).isArrayBuffer(rt) || !offsetValue.isNumber() || !lengthValue.isNumber())
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' must be a one-byte TypedArray or ArrayBuffer");
  auto buffer = bufferValue.asObject(rt).getArrayBuffer(rt);
  auto bufferSize = buffer.length(rt);
  double offsetNumber = offsetValue.asNumber();
  double lengthNumber = lengthValue.asNumber();
  if (!std::isfinite(offsetNumber) || !std::isfinite(lengthNumber) || std::trunc(offsetNumber) != offsetNumber || std::trunc(lengthNumber) != lengthNumber || offsetNumber < 0.0 || lengthNumber < 0.0 || offsetNumber > static_cast<double>(bufferSize) || lengthNumber > static_cast<double>(bufferSize) - offsetNumber)
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' view is outside its ArrayBuffer");
  auto offset = static_cast<size_t>(offsetNumber);
  auto size = static_cast<size_t>(lengthNumber);
  auto* data = buffer.data(rt);
  if (bufferSize > 0 && data == nullptr)
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' has detached TypedArray storage");
  return {size == 0 ? data : data + offset, size};
}
[[maybe_unused]] static float rustra_f32(jsi::Runtime& rt, const jsi::Value& value, const char* field) {
  double number = rustra_f64(rt, value, field);
  if (number < -std::numeric_limits<float>::max() || number > std::numeric_limits<float>::max())
    throw jsi::JSError(rt, std::string("rustra: '") + field + "' is outside the f32 range");
  return static_cast<float>(number);
}

namespace rustra::generated {
struct BoundCodecContext {
  const uint16_t commandId;
  const std::vector<jsi::PropNameID> input;
  const std::vector<jsi::PropNameID> output;
private:
  static std::vector<jsi::PropNameID> ownNames(Runtime& rt, std::initializer_list<const char*> names) {
    std::vector<jsi::PropNameID> result; result.reserve(names.size());
    for (auto name : names) result.push_back(jsi::PropNameID::forAscii(rt, name));
    return result;
  }
  BoundCodecContext(Runtime& rt, uint16_t id, std::initializer_list<const char*> in, std::initializer_list<const char*> out)
    : commandId(id), input(ownNames(rt, in)), output(ownNames(rt, out)) {}
  friend std::shared_ptr<const BoundCodecContext> make_bound_codec_context(Runtime&, uint16_t);
};
std::shared_ptr<const BoundCodecContext> make_bound_codec_context(Runtime& rt, uint16_t commandId) {
  switch (commandId) {
    case 1: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"a", "b"}, {"value"}));
    case 23: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"a", "b"}, {"value"}));
    case 25: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"data"}, {"data"}));
    case 26: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"name", "value"}, {"name", "value"}));
    case 24: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"value"}, {"value"}));
    case 18: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"channel", "ticks"}, {"sent", "droppedSends"}));
    case 31: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"channel", "ticks"}, {"sent", "droppedSends"}));
    case 4: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"max", "min", "value"}, {"value"}));
    case 8: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"name", "value"}, {"item", "active", "name", "value"}));
    case 10: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"a", "b"}, {"value"}));
    case 11: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"ticks", "stepDelayMs"}, {"emitted"}));
    case 17: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"limit", "offset"}, {"next"}));
    case 5: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"name"}, {"message"}));
    case 3: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"n"}, {"result"}));
    case 2: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"a", "b"}, {"value"}));
    case 34: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"nodes", "id", "name", "tag", "note", "metadata", "children"}, {"nodes", "id", "name", "tag", "note", "metadata", "children"}));
    case 35: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"tree", "nodes", "id", "name", "tag", "note", "metadata", "children"}, {"found", "id", "name", "visited"}));
    case 38: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"id"}, {"found", "id", "name", "visited"}));
    case 37: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"id"}, {"found", "id", "name", "visited"}));
    case 36: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"nodes", "id", "name", "tag", "note", "metadata", "children"}, {"nodes"}));
    case 9: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"item", "active", "name", "value"}, {"doubled", "item", "active", "name", "value"}));
    case 22: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"handle"}, {"closed"}));
    case 19: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"initial"}, {"handle"}));
    case 20: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"handle", "key"}, {"found", "value"}));
    case 21: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"handle", "key", "value"}, {"entries"}));
    case 12: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"op"}, {"ok", "frozen", "message"}));
    case 15: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"scores"}, {"count", "total"}));
    case 13: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"a", "b"}, {"value"}));
    case 14: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"data"}, {"checksum", "len"}));
    case 16: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"pair", "value", "_"}, {"first", "second"}));
    case 6: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"numbers"}, {"count", "total"}));
    case 7: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"s"}, {"result"}));
    case 28: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {"samples", "offset"}, {"max", "adjusted"}));
    case 32: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {}, {}));
    case 27: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {}, {}));
    case 33: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {}, {}));
    case 30: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {}, {}));
    case 29: return std::shared_ptr<const BoundCodecContext>(new BoundCodecContext(rt, commandId, {}, {}));
    default: throw JSError(rt, "rustra: no bound codec for cmd_id " + std::to_string(commandId));
  }
}
} // namespace rustra::generated

static void complex_encode_ref_ChannelHandle(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_ChannelHandle(jsi::Runtime&, rc::Reader&, size_t);
static void complex_encode_ref_Item(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_Item(jsi::Runtime&, rc::Reader&, size_t);
static void complex_encode_ref_OpKind(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_OpKind(jsi::Runtime&, rc::Reader&, size_t);
static void complex_encode_ref_ParityNode(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_ParityNode(jsi::Runtime&, rc::Reader&, size_t);
static void complex_encode_ref_ParityTree(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_ParityTree(jsi::Runtime&, rc::Reader&, size_t);
static void complex_encode_ref_ResourceHandle(jsi::Runtime&, const jsi::Value&, rc::Writer&, size_t);
static jsi::Value complex_decode_ref_ResourceHandle(jsi::Runtime&, rc::Reader&, size_t);

static void complex_encode_ref_ChannelHandle(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  w.push_uvar(rustra_u64(rt, value, "complex integer"));
}
static jsi::Value complex_decode_ref_ChannelHandle(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= 9007199254740991ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }(); }
static void complex_encode_ref_Item(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  { if (!value.isObject() || value.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = value.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "active");
    if (!_cx1.isBool()) throw jsi::JSError(rt, "complex boolean expected");
    w.push_bool(_cx1.getBool());
    auto _cx2 = _cx0.getProperty(rt, "name");
    if (!_cx2.isString()) throw jsi::JSError(rt, "complex string expected");
    w.push_string(_cx2.getString(rt).utf8(rt));
    auto _cx3 = _cx0.getProperty(rt, "value");
    w.push_i64(rustra_i64(rt, _cx3, "complex integer"));
  }
}
static jsi::Value complex_decode_ref_Item(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "active", jsi::Value(r.read_bool())); _cx0.setProperty(rt, "name", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); _cx0.setProperty(rt, "value", [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }()); return _cx0; }(); }
static void complex_encode_ref_OpKind(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  { int _cx0 = -1;
    if (value.isString() && value.getString(rt).utf8(rt) == std::string("Clear")) _cx0 = 0;
    if (value.isObject() && value.asObject(rt).hasProperty(rt, "Set")) _cx0 = 1;
    if (_cx0 < 0) throw jsi::JSError(rt, "complex oneOf value mismatch");
    w.push_uvar(static_cast<uint64_t>(_cx0));
    if (_cx0 == 0) {
      if (!(value.isString() && value.getString(rt).utf8(rt) == std::string("Clear"))) throw jsi::JSError(rt, "complex literal mismatch");
    }
    if (_cx0 == 1) {
      auto _cx1 = value.asObject(rt);
      { if (!_cx1.getProperty(rt, "Set").isObject() || _cx1.getProperty(rt, "Set").asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
        auto _cx2 = _cx1.getProperty(rt, "Set").asObject(rt);
        auto _cx3 = _cx2.getProperty(rt, "value");
        w.push_i64(rustra_i64(rt, _cx3, "complex integer"));
      }
    }
  }
}
static jsi::Value complex_decode_ref_OpKind(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _cx0 = r.read_uvar(); if (_cx0 == 0) return jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>("Clear"), sizeof("Clear") - 1); if (_cx0 == 1) return [&]() -> jsi::Value { auto _cx2 = jsi::Object(rt); _cx2.setProperty(rt, "Set", [&]() -> jsi::Value { auto _cx1 = jsi::Object(rt); _cx1.setProperty(rt, "value", [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }()); return _cx1; }()); return _cx2; }(); throw std::runtime_error("complex oneOf index out of range"); }(); }
static void complex_encode_ref_ParityNode(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  { if (!value.isObject() || value.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = value.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "id");
    w.push_f64(rustra_f64(rt, _cx1, "complex number"));
    auto _cx2 = _cx0.getProperty(rt, "name");
    if (!_cx2.isString()) throw jsi::JSError(rt, "complex string expected");
    w.push_string(_cx2.getString(rt).utf8(rt));
    auto _cx3 = _cx0.getProperty(rt, "tag");
    if (!_cx3.isString()) throw jsi::JSError(rt, "complex string expected");
    w.push_string(_cx3.getString(rt).utf8(rt));
    auto _cx4 = _cx0.getProperty(rt, "note"); if (_cx0.hasProperty(rt, "note") && !_cx4.isUndefined()) { w.push_u8(1);
      { if (_cx4.isNull() || _cx4.isUndefined()) { w.push_u8(0); } else { w.push_u8(1);
        if (!_cx4.isString()) throw jsi::JSError(rt, "complex string expected");
        w.push_string(_cx4.getString(rt).utf8(rt));
      } }
    } else { w.push_u8(0); }
    auto _cx5 = _cx0.getProperty(rt, "metadata");
    { if (!_cx5.isObject() || _cx5.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object map expected");
      auto _cx6 = _cx5.asObject(rt); auto _cx7 = _cx6.getPropertyNames(rt);
      std::vector<std::pair<std::string, jsi::Value>> _cx8;
      for (size_t _i = 0; _i < _cx7.length(rt); _i++) { auto _key = _cx7.getValueAtIndex(rt, _i).getString(rt).utf8(rt); auto _property = _cx6.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_key.data()), _key.size())); _cx8.push_back({_key, std::move(_property)}); }
      std::sort(_cx8.begin(), _cx8.end(), [](const auto& _a, const auto& _b) { const auto& a = _a.first; const auto& b = _b.first; const size_t n = std::min(a.size(), b.size()); for (size_t i = 0; i < n; ++i) { const auto ca = static_cast<unsigned char>(a[i]); const auto cb = static_cast<unsigned char>(b[i]); if (ca != cb) return ca < cb; } return a.size() < b.size(); });
      w.push_uvar(_cx8.size()); for (auto& _entry : _cx8) { w.push_string(_entry.first); auto& _value = _entry.second;
        if (!_value.isString()) throw jsi::JSError(rt, "complex string expected");
        w.push_string(_value.getString(rt).utf8(rt));
      } }
    auto _cx9 = _cx0.getProperty(rt, "children");
    { auto _cx10 = _cx9.asObject(rt);
      if (!_cx9.isObject() || !_cx10.isArray(rt)) throw jsi::JSError(rt, "complex array expected");
      auto _cx11 = _cx10.getArray(rt); auto _cx12 = _cx11.length(rt);
      w.push_uvar(_cx12);
      for (size_t _i = 0; _i < _cx12; _i++) {
        w.push_f64(rustra_f64(rt, _cx11.getValueAtIndex(rt, _i), "complex number"));
      } }
  }
}
static jsi::Value complex_decode_ref_ParityNode(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "id", jsi::Value(r.read_f64())); _cx0.setProperty(rt, "name", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); _cx0.setProperty(rt, "tag", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); auto _cx2 = r.read_u8(); if (_cx2 > 1) throw std::runtime_error("complex optional field presence tag"); if (_cx2 == 1) _cx0.setProperty(rt, "note", [&]() -> jsi::Value { auto _cx1 = r.read_u8(); if (_cx1 == 0) return jsi::Value::null(); if (_cx1 != 1) throw std::runtime_error("complex optional presence tag"); return [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }(); }()); _cx0.setProperty(rt, "metadata", [&]() -> jsi::Value { auto _cx3 = r.read_uvar(); if (_cx3 > 100000) throw std::runtime_error("complex map length exceeds 100000"); auto _cx4 = jsi::Object(rt); for (size_t _i = 0; _i < _cx3; _i++) { auto _cx5 = r.read_string_view(); auto _keyValue = jsi::String::createFromUtf8(rt, _cx5.data, _cx5.size); _cx4.setProperty(rt, _keyValue, [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); } return _cx4; }()); _cx0.setProperty(rt, "children", [&]() -> jsi::Value { auto _cx6 = r.read_uvar(); if (_cx6 > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto _cx7 = jsi::Array(rt, static_cast<size_t>(_cx6)); for (size_t _i = 0; _i < _cx6; _i++) _cx7.setValueAtIndex(rt, _i, jsi::Value(r.read_f64())); return _cx7; }()); return _cx0; }(); }
static void complex_encode_ref_ParityTree(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  { if (!value.isObject() || value.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = value.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "nodes");
    { auto _cx2 = _cx1.asObject(rt);
      if (!_cx1.isObject() || !_cx2.isArray(rt)) throw jsi::JSError(rt, "complex array expected");
      auto _cx3 = _cx2.getArray(rt); auto _cx4 = _cx3.length(rt);
      w.push_uvar(_cx4);
      for (size_t _i = 0; _i < _cx4; _i++) {
        complex_encode_ref_ParityNode(rt, _cx3.getValueAtIndex(rt, _i), w, _depth + 1 + 1);
      } }
  }
}
static jsi::Value complex_decode_ref_ParityTree(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "nodes", [&]() -> jsi::Value { auto _cx1 = r.read_uvar(); if (_cx1 > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto _cx2 = jsi::Array(rt, static_cast<size_t>(_cx1)); for (size_t _i = 0; _i < _cx1; _i++) _cx2.setValueAtIndex(rt, _i, complex_decode_ref_ParityNode(rt, r, _depth + 1 + 1)); return _cx2; }()); return _cx0; }(); }
static void complex_encode_ref_ResourceHandle(jsi::Runtime& rt, const jsi::Value& value, rc::Writer& w, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32");
  w.push_uvar(rustra_u64(rt, value, "complex integer"));
}
static jsi::Value complex_decode_ref_ResourceHandle(jsi::Runtime& rt, rc::Reader& r, size_t _depth) { if (_depth > 32) throw std::runtime_error("complex value depth exceeds 32"); return [&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= 9007199254740991ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }(); }
static void encode_body_addNumbers(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_0), "a"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "b"));
}
static void encode_addNumbers(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(1); w.push_u8(0); // cmd_id = 1 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "a"), jsi::PropNameID::forAscii(rt, "b")};
  encode_body_addNumbers(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_addNumbers(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: addNumbers expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(1); w.push_u8(0); // cmd_id = 1 LE
  w.push_i64(rustra_i64(rt, argv[0], "a"));
  w.push_i64(rustra_i64(rt, argv[1], "b"));
}

static jsi::Value decode_body_addNumbers(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_addNumbers(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_addNumbers(rt, resultObj, r, _properties.data());
}

static void encode_body_benchAdd(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_0), "a"));
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_1), "b"));
}
static void encode_benchAdd(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(23); w.push_u8(0); // cmd_id = 23 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "a"), jsi::PropNameID::forAscii(rt, "b")};
  encode_body_benchAdd(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_benchAdd(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: benchAdd expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(23); w.push_u8(0); // cmd_id = 23 LE
  w.push_f64(rustra_f64(rt, argv[0], "a"));
  w.push_f64(rustra_f64(rt, argv[1], "b"));
}

static jsi::Value decode_body_benchAdd(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_benchAdd(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_benchAdd(rt, resultObj, r, _properties.data());
}

static void encode_body_benchEchoBytes(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { const auto& _v = argsObj.getProperty(rt, _prop_0); auto _o = _v.asObject(rt); if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "data[]"); } else { auto _span = rustra_bytes(rt, _v, "data"); w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }
}
static void encode_benchEchoBytes(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(25); w.push_u8(0); // cmd_id = 25 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "data")};
  encode_body_benchEchoBytes(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_benchEchoBytes(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: benchEchoBytes expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(25); w.push_u8(0); // cmd_id = 25 LE
  { const auto& _v = argv[0]; auto _o = _v.asObject(rt); if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "data[]"); } else { auto _span = rustra_bytes(rt, _v, "data"); w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }
}

static jsi::Value decode_body_benchEchoBytes(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _n = r.read_uvar(); auto _bytes = r.read_bytes_view((size_t)_n); resultObj.setProperty(rt, _prop_0, rustra::generated::make_array_buffer(rt, _bytes.data, _bytes.size)); }
  return std::move(resultObj);
}
static jsi::Value decode_benchEchoBytes(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "data")};
  return decode_body_benchEchoBytes(rt, resultObj, r, _properties.data());
}

static void encode_body_benchEchoPair(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_1), "value"));
}
static void encode_benchEchoPair(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(26); w.push_u8(0); // cmd_id = 26 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  encode_body_benchEchoPair(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_benchEchoPair(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: benchEchoPair expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(26); w.push_u8(0); // cmd_id = 26 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
  w.push_f64(rustra_f64(rt, argv[1], "value"));
}

static jsi::Value decode_body_benchEchoPair(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_0, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  resultObj.setProperty(rt, _prop_1, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_benchEchoPair(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_benchEchoPair(rt, resultObj, r, _properties.data());
}

static void encode_body_benchEchoString(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_benchEchoString(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(24); w.push_u8(0); // cmd_id = 24 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  encode_body_benchEchoString(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_benchEchoString(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: benchEchoString expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(24); w.push_u8(0); // cmd_id = 24 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_benchEchoString(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_0, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  return std::move(resultObj);
}
static jsi::Value decode_benchEchoString(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_benchEchoString(rt, resultObj, r, _properties.data());
}

static void encode_body_channelDemo(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "channel"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "ticks"));
}
static void encode_channelDemo(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(18); w.push_u8(0); // cmd_id = 18 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "channel"), jsi::PropNameID::forAscii(rt, "ticks")};
  encode_body_channelDemo(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_channelDemo(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: channelDemo expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(18); w.push_u8(0); // cmd_id = 18 LE
  w.push_uvar(rustra_u64(rt, argv[0], "channel"));
  w.push_i64(rustra_i64(rt, argv[1], "ticks"));
}

static jsi::Value decode_body_channelDemo(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, (double)r.read_i64());
  resultObj.setProperty(rt, _prop_1, (double)r.read_i64());
  return std::move(resultObj);
}
static jsi::Value decode_channelDemo(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "sent"), jsi::PropNameID::forAscii(rt, "droppedSends")};
  return decode_body_channelDemo(rt, resultObj, r, _properties.data());
}

static void encode_body_channelDemoBytes(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "channel"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "ticks"));
}
static void encode_channelDemoBytes(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(31); w.push_u8(0); // cmd_id = 31 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "channel"), jsi::PropNameID::forAscii(rt, "ticks")};
  encode_body_channelDemoBytes(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_channelDemoBytes(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: channelDemoBytes expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(31); w.push_u8(0); // cmd_id = 31 LE
  w.push_uvar(rustra_u64(rt, argv[0], "channel"));
  w.push_i64(rustra_i64(rt, argv[1], "ticks"));
}

static jsi::Value decode_body_channelDemoBytes(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, (double)r.read_uvar());
  resultObj.setProperty(rt, _prop_1, (double)r.read_uvar());
  return std::move(resultObj);
}
static jsi::Value decode_channelDemoBytes(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "sent"), jsi::PropNameID::forAscii(rt, "droppedSends")};
  return decode_body_channelDemoBytes(rt, resultObj, r, _properties.data());
}

static void encode_body_clamp(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_0), "max"));
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_1), "min"));
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_2), "value"));
}
static void encode_clamp(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(4); w.push_u8(0); // cmd_id = 4 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 3> _properties{jsi::PropNameID::forAscii(rt, "max"), jsi::PropNameID::forAscii(rt, "min"), jsi::PropNameID::forAscii(rt, "value")};
  encode_body_clamp(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 3회 제거.
static void encode_pos_clamp(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 3) throw jsi::JSError(rt, "rustra: clamp expects 3 positional argument(s), got " + std::to_string(argc));
  w.push_u8(4); w.push_u8(0); // cmd_id = 4 LE
  w.push_f64(rustra_f64(rt, argv[0], "max"));
  w.push_f64(rustra_f64(rt, argv[1], "min"));
  w.push_f64(rustra_f64(rt, argv[2], "value"));
}

static jsi::Value decode_body_clamp(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_clamp(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_clamp(rt, resultObj, r, _properties.data());
}

static void encode_body_createItem(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "value"));
}
static void encode_createItem(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(8); w.push_u8(0); // cmd_id = 8 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  encode_body_createItem(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_createItem(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: createItem expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(8); w.push_u8(0); // cmd_id = 8 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
  w.push_i64(rustra_i64(rt, argv[1], "value"));
}

static jsi::Value decode_body_createItem(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  { auto _obj = jsi::Object(rt);
    _obj.setProperty(rt, _prop_1, r.read_bool());
    { auto _s = r.read_string_view(); _obj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
    _obj.setProperty(rt, _prop_3, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
    resultObj.setProperty(rt, _prop_0, _obj); }
  return std::move(resultObj);
}
static jsi::Value decode_createItem(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 4> _properties{jsi::PropNameID::forAscii(rt, "item"), jsi::PropNameID::forAscii(rt, "active"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_createItem(rt, resultObj, r, _properties.data());
}

static void encode_body_divide(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_0), "a"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "b"));
}
static void encode_divide(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(10); w.push_u8(0); // cmd_id = 10 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "a"), jsi::PropNameID::forAscii(rt, "b")};
  encode_body_divide(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_divide(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: divide expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(10); w.push_u8(0); // cmd_id = 10 LE
  w.push_i64(rustra_i64(rt, argv[0], "a"));
  w.push_i64(rustra_i64(rt, argv[1], "b"));
}

static jsi::Value decode_body_divide(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_divide(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_divide(rt, resultObj, r, _properties.data());
}

static void encode_body_emitDemo(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_0), "ticks"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "stepDelayMs"));
}
static void encode_emitDemo(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(11); w.push_u8(0); // cmd_id = 11 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "ticks"), jsi::PropNameID::forAscii(rt, "stepDelayMs")};
  encode_body_emitDemo(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_emitDemo(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: emitDemo expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(11); w.push_u8(0); // cmd_id = 11 LE
  w.push_i64(rustra_i64(rt, argv[0], "ticks"));
  w.push_i64(rustra_i64(rt, argv[1], "stepDelayMs"));
}

static jsi::Value decode_body_emitDemo(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_emitDemo(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "emitted")};
  return decode_body_emitDemo(rt, resultObj, r, _properties.data());
}

static void encode_body_gauge(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "limit"));
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_1), "offset"));
}
static void encode_gauge(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(17); w.push_u8(0); // cmd_id = 17 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "limit"), jsi::PropNameID::forAscii(rt, "offset")};
  encode_body_gauge(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_gauge(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: gauge expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(17); w.push_u8(0); // cmd_id = 17 LE
  w.push_uvar(rustra_u64(rt, argv[0], "limit"));
  w.push_uvar(rustra_u64(rt, argv[1], "offset"));
}

static jsi::Value decode_body_gauge(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= 9007199254740991ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_gauge(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "next")};
  return decode_body_gauge(rt, resultObj, r, _properties.data());
}

static void encode_body_greet(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_greet(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(5); w.push_u8(0); // cmd_id = 5 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "name")};
  encode_body_greet(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_greet(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: greet expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(5); w.push_u8(0); // cmd_id = 5 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_greet(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_0, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  return std::move(resultObj);
}
static jsi::Value decode_greet(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "message")};
  return decode_body_greet(rt, resultObj, r, _properties.data());
}

static void encode_body_isEven(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_0), "n"));
}
static void encode_isEven(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(3); w.push_u8(0); // cmd_id = 3 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "n")};
  encode_body_isEven(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_isEven(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: isEven expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(3); w.push_u8(0); // cmd_id = 3 LE
  w.push_i64(rustra_i64(rt, argv[0], "n"));
}

static jsi::Value decode_body_isEven(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  return std::move(resultObj);
}
static jsi::Value decode_isEven(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "result")};
  return decode_body_isEven(rt, resultObj, r, _properties.data());
}

static void encode_body_multiply(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_0), "a"));
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_1), "b"));
}
static void encode_multiply(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(2); w.push_u8(0); // cmd_id = 2 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "a"), jsi::PropNameID::forAscii(rt, "b")};
  encode_body_multiply(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_multiply(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: multiply expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(2); w.push_u8(0); // cmd_id = 2 LE
  w.push_f64(rustra_f64(rt, argv[0], "a"));
  w.push_f64(rustra_f64(rt, argv[1], "b"));
}

static jsi::Value decode_body_multiply(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_multiply(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_multiply(rt, resultObj, r, _properties.data());
}

static void encode_body_parityEcho(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  const auto& _prop_4 = _properties[4];
  const auto& _prop_5 = _properties[5];
  const auto& _prop_6 = _properties[6];
  { auto _arr = argsObj.getProperty(rt, _prop_0).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n);
    for (size_t _i = 0; _i < _n; _i++) { auto _obj = _arr.getValueAtIndex(rt, _i).getObject(rt);
      w.push_f64(rustra_f64(rt, _obj.getProperty(rt, _prop_1), "id"));
      { auto _v = _obj.getProperty(rt, _prop_2).getString(rt).utf8(rt); w.push_string(_v); }
      { auto _v = _obj.getProperty(rt, _prop_3).getString(rt).utf8(rt); w.push_string(_v); }
      { auto _option_value = _obj.getProperty(rt, _prop_4); if (_option_value.isNull() || _option_value.isUndefined()) { w.push_u8(0); } else { w.push_u8(1); { auto _v = _option_value.getString(rt).utf8(rt); w.push_string(_v); } } }
      { auto _o = _obj.getProperty(rt, _prop_5).asObject(rt); auto _names = _o.getPropertyNames(rt); const auto _count = _names.length(rt); RustraMapEntries _entries(rt, _count); for (size_t _j = 0; _j < _count; _j++) { auto _key = _names.getValueAtIndex(rt, _j).getString(rt); auto _k = _key.utf8(rt); auto _value = rustra_map_value(rt, _o, _key, _k); _entries.emplace_back(std::move(_k), std::move(_value)); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; w.push_string(_e.getString(rt).utf8(rt)); } }
      { auto _arr = _obj.getProperty(rt, _prop_6).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_f64(rustra_f64(rt, _arr.getValueAtIndex(rt, _i), "children[]")); }
    } }
}
static void encode_parityEcho(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(34); w.push_u8(0); // cmd_id = 34 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 7> _properties{jsi::PropNameID::forAscii(rt, "nodes"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "tag"), jsi::PropNameID::forAscii(rt, "note"), jsi::PropNameID::forAscii(rt, "metadata"), jsi::PropNameID::forAscii(rt, "children")};
  encode_body_parityEcho(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_parityEcho(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  const auto& _prop_4 = _properties[4];
  const auto& _prop_5 = _properties[5];
  const auto& _prop_6 = _properties[6];
  { auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n);
    for (size_t _i = 0; _i < _n; _i++) { auto _obj = jsi::Object(rt);
      _obj.setProperty(rt, _prop_1, r.read_f64());
      { auto _s = r.read_string_view(); _obj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
      { auto _s = r.read_string_view(); _obj.setProperty(rt, _prop_3, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
      { auto _tag = r.read_u8(); if (_tag == 0) { _obj.setProperty(rt, _prop_4, jsi::Value::null()); } else { { auto _s = r.read_string_view(); _obj.setProperty(rt, _prop_4, jsi::String::createFromUtf8(rt, _s.data, _s.size)); } } }
      { auto _n = r.read_uvar(); auto _map = jsi::Object(rt); for (size_t _i = 0; _i < _n; _i++) { auto _ks = r.read_string_view(); auto _k = jsi::PropNameID::forUtf8(rt, _ks.data, _ks.size); { auto _vs = r.read_string_view(); _map.setProperty(rt, _k, jsi::String::createFromUtf8(rt, _vs.data, _vs.size)); } } _obj.setProperty(rt, _prop_5, std::move(_map)); }
      { auto _n = r.read_uvar(); auto _arr = jsi::Array(rt, (size_t)_n); for (size_t _i = 0; _i < _n; _i++) { _arr.setValueAtIndex(rt, _i, r.read_f64()); } _obj.setProperty(rt, _prop_6, _arr); }
      _arr.setValueAtIndex(rt, _i, std::move(_obj)); }
    resultObj.setProperty(rt, _prop_0, _arr); }
  return std::move(resultObj);
}
static jsi::Value decode_parityEcho(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 7> _properties{jsi::PropNameID::forAscii(rt, "nodes"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "tag"), jsi::PropNameID::forAscii(rt, "note"), jsi::PropNameID::forAscii(rt, "metadata"), jsi::PropNameID::forAscii(rt, "children")};
  return decode_body_parityEcho(rt, resultObj, r, _properties.data());
}

static void encode_body_parityFind(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  const auto& _prop_4 = _properties[4];
  const auto& _prop_5 = _properties[5];
  const auto& _prop_6 = _properties[6];
  const auto& _prop_7 = _properties[7];
  { auto _struct_2 = argsObj.getProperty(rt, _prop_0).asObject(rt);
    { auto _arr = _struct_2.getProperty(rt, _prop_1).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n);
      for (size_t _i = 0; _i < _n; _i++) { auto _obj = _arr.getValueAtIndex(rt, _i).getObject(rt);
        w.push_f64(rustra_f64(rt, _obj.getProperty(rt, _prop_2), "id"));
        { auto _v = _obj.getProperty(rt, _prop_3).getString(rt).utf8(rt); w.push_string(_v); }
        { auto _v = _obj.getProperty(rt, _prop_4).getString(rt).utf8(rt); w.push_string(_v); }
        { auto _option_value = _obj.getProperty(rt, _prop_5); if (_option_value.isNull() || _option_value.isUndefined()) { w.push_u8(0); } else { w.push_u8(1); { auto _v = _option_value.getString(rt).utf8(rt); w.push_string(_v); } } }
        { auto _o = _obj.getProperty(rt, _prop_6).asObject(rt); auto _names = _o.getPropertyNames(rt); const auto _count = _names.length(rt); RustraMapEntries _entries(rt, _count); for (size_t _j = 0; _j < _count; _j++) { auto _key = _names.getValueAtIndex(rt, _j).getString(rt); auto _k = _key.utf8(rt); auto _value = rustra_map_value(rt, _o, _key, _k); _entries.emplace_back(std::move(_k), std::move(_value)); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; w.push_string(_e.getString(rt).utf8(rt)); } }
        { auto _arr = _obj.getProperty(rt, _prop_7).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_f64(rustra_f64(rt, _arr.getValueAtIndex(rt, _i), "children[]")); }
      } }
  }
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_2), "id"));
}
static void encode_parityFind(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(35); w.push_u8(0); // cmd_id = 35 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 8> _properties{jsi::PropNameID::forAscii(rt, "tree"), jsi::PropNameID::forAscii(rt, "nodes"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "tag"), jsi::PropNameID::forAscii(rt, "note"), jsi::PropNameID::forAscii(rt, "metadata"), jsi::PropNameID::forAscii(rt, "children")};
  encode_body_parityFind(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_parityFind(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  resultObj.setProperty(rt, _prop_1, r.read_f64());
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  resultObj.setProperty(rt, _prop_3, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_parityFind(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 4> _properties{jsi::PropNameID::forAscii(rt, "found"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "visited")};
  return decode_body_parityFind(rt, resultObj, r, _properties.data());
}

static void encode_body_parityIndexed(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_0), "id"));
}
static void encode_parityIndexed(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(38); w.push_u8(0); // cmd_id = 38 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "id")};
  encode_body_parityIndexed(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_parityIndexed(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: parityIndexed expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(38); w.push_u8(0); // cmd_id = 38 LE
  w.push_f64(rustra_f64(rt, argv[0], "id"));
}

static jsi::Value decode_body_parityIndexed(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  resultObj.setProperty(rt, _prop_1, r.read_f64());
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  resultObj.setProperty(rt, _prop_3, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_parityIndexed(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 4> _properties{jsi::PropNameID::forAscii(rt, "found"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "visited")};
  return decode_body_parityIndexed(rt, resultObj, r, _properties.data());
}

static void encode_body_parityResident(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  w.push_f64(rustra_f64(rt, argsObj.getProperty(rt, _prop_0), "id"));
}
static void encode_parityResident(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(37); w.push_u8(0); // cmd_id = 37 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "id")};
  encode_body_parityResident(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_parityResident(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: parityResident expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(37); w.push_u8(0); // cmd_id = 37 LE
  w.push_f64(rustra_f64(rt, argv[0], "id"));
}

static jsi::Value decode_body_parityResident(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  resultObj.setProperty(rt, _prop_1, r.read_f64());
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  resultObj.setProperty(rt, _prop_3, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_parityResident(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 4> _properties{jsi::PropNameID::forAscii(rt, "found"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "visited")};
  return decode_body_parityResident(rt, resultObj, r, _properties.data());
}

static void encode_body_parityStore(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  const auto& _prop_4 = _properties[4];
  const auto& _prop_5 = _properties[5];
  const auto& _prop_6 = _properties[6];
  { auto _arr = argsObj.getProperty(rt, _prop_0).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n);
    for (size_t _i = 0; _i < _n; _i++) { auto _obj = _arr.getValueAtIndex(rt, _i).getObject(rt);
      w.push_f64(rustra_f64(rt, _obj.getProperty(rt, _prop_1), "id"));
      { auto _v = _obj.getProperty(rt, _prop_2).getString(rt).utf8(rt); w.push_string(_v); }
      { auto _v = _obj.getProperty(rt, _prop_3).getString(rt).utf8(rt); w.push_string(_v); }
      { auto _option_value = _obj.getProperty(rt, _prop_4); if (_option_value.isNull() || _option_value.isUndefined()) { w.push_u8(0); } else { w.push_u8(1); { auto _v = _option_value.getString(rt).utf8(rt); w.push_string(_v); } } }
      { auto _o = _obj.getProperty(rt, _prop_5).asObject(rt); auto _names = _o.getPropertyNames(rt); const auto _count = _names.length(rt); RustraMapEntries _entries(rt, _count); for (size_t _j = 0; _j < _count; _j++) { auto _key = _names.getValueAtIndex(rt, _j).getString(rt); auto _k = _key.utf8(rt); auto _value = rustra_map_value(rt, _o, _key, _k); _entries.emplace_back(std::move(_k), std::move(_value)); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; w.push_string(_e.getString(rt).utf8(rt)); } }
      { auto _arr = _obj.getProperty(rt, _prop_6).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_f64(rustra_f64(rt, _arr.getValueAtIndex(rt, _i), "children[]")); }
    } }
}
static void encode_parityStore(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(36); w.push_u8(0); // cmd_id = 36 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 7> _properties{jsi::PropNameID::forAscii(rt, "nodes"), jsi::PropNameID::forAscii(rt, "id"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "tag"), jsi::PropNameID::forAscii(rt, "note"), jsi::PropNameID::forAscii(rt, "metadata"), jsi::PropNameID::forAscii(rt, "children")};
  encode_body_parityStore(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_parityStore(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_f64());
  return std::move(resultObj);
}
static jsi::Value decode_parityStore(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "nodes")};
  return decode_body_parityStore(rt, resultObj, r, _properties.data());
}

static void encode_body_processItem(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  { auto _struct_2 = argsObj.getProperty(rt, _prop_0).asObject(rt);
    { auto _v = _struct_2.getProperty(rt, _prop_1).getBool(); w.push_bool(_v); }
    { auto _v = _struct_2.getProperty(rt, _prop_2).getString(rt).utf8(rt); w.push_string(_v); }
    w.push_i64(rustra_i64(rt, _struct_2.getProperty(rt, _prop_3), "value"));
  }
}
static void encode_processItem(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(9); w.push_u8(0); // cmd_id = 9 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 4> _properties{jsi::PropNameID::forAscii(rt, "item"), jsi::PropNameID::forAscii(rt, "active"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  encode_body_processItem(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_processItem(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  const auto& _prop_3 = _properties[3];
  const auto& _prop_4 = _properties[4];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  { auto _obj = jsi::Object(rt);
    _obj.setProperty(rt, _prop_2, r.read_bool());
    { auto _s = r.read_string_view(); _obj.setProperty(rt, _prop_3, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
    _obj.setProperty(rt, _prop_4, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
    resultObj.setProperty(rt, _prop_1, _obj); }
  return std::move(resultObj);
}
static jsi::Value decode_processItem(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 5> _properties{jsi::PropNameID::forAscii(rt, "doubled"), jsi::PropNameID::forAscii(rt, "item"), jsi::PropNameID::forAscii(rt, "active"), jsi::PropNameID::forAscii(rt, "name"), jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_processItem(rt, resultObj, r, _properties.data());
}

static void encode_body_resourceClose(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "handle"));
}
static void encode_resourceClose(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(22); w.push_u8(0); // cmd_id = 22 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "handle")};
  encode_body_resourceClose(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_resourceClose(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: resourceClose expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(22); w.push_u8(0); // cmd_id = 22 LE
  w.push_uvar(rustra_u64(rt, argv[0], "handle"));
}

static jsi::Value decode_body_resourceClose(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  return std::move(resultObj);
}
static jsi::Value decode_resourceClose(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "closed")};
  return decode_body_resourceClose(rt, resultObj, r, _properties.data());
}

static void encode_body_resourceOpen(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _o = argsObj.getProperty(rt, _prop_0).asObject(rt); auto _names = _o.getPropertyNames(rt); const auto _count = _names.length(rt); RustraMapEntries _entries(rt, _count); for (size_t _j = 0; _j < _count; _j++) { auto _key = _names.getValueAtIndex(rt, _j).getString(rt); auto _k = _key.utf8(rt); auto _value = rustra_map_value(rt, _o, _key, _k); _entries.emplace_back(std::move(_k), std::move(_value)); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; w.push_string(_e.getString(rt).utf8(rt)); } }
}
static void encode_resourceOpen(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(19); w.push_u8(0); // cmd_id = 19 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "initial")};
  encode_body_resourceOpen(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_resourceOpen(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, (double)r.read_uvar());
  return std::move(resultObj);
}
static jsi::Value decode_resourceOpen(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "handle")};
  return decode_body_resourceOpen(rt, resultObj, r, _properties.data());
}

static void encode_body_resourceRead(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "handle"));
  { auto _v = argsObj.getProperty(rt, _prop_1).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_resourceRead(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(20); w.push_u8(0); // cmd_id = 20 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "handle"), jsi::PropNameID::forAscii(rt, "key")};
  encode_body_resourceRead(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_resourceRead(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: resourceRead expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(20); w.push_u8(0); // cmd_id = 20 LE
  w.push_uvar(rustra_u64(rt, argv[0], "handle"));
  { auto _s = argv[1].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_resourceRead(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  { auto _tag = r.read_u8(); if (_tag == 0) { resultObj.setProperty(rt, _prop_1, jsi::Value::null()); } else { { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_1, jsi::String::createFromUtf8(rt, _s.data, _s.size)); } } }
  return std::move(resultObj);
}
static jsi::Value decode_resourceRead(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "found"), jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_resourceRead(rt, resultObj, r, _properties.data());
}

static void encode_body_resourceWrite(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  w.push_uvar(rustra_u64(rt, argsObj.getProperty(rt, _prop_0), "handle"));
  { auto _v = argsObj.getProperty(rt, _prop_1).getString(rt).utf8(rt); w.push_string(_v); }
  { auto _v = argsObj.getProperty(rt, _prop_2).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_resourceWrite(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(21); w.push_u8(0); // cmd_id = 21 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 3> _properties{jsi::PropNameID::forAscii(rt, "handle"), jsi::PropNameID::forAscii(rt, "key"), jsi::PropNameID::forAscii(rt, "value")};
  encode_body_resourceWrite(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 3회 제거.
static void encode_pos_resourceWrite(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 3) throw jsi::JSError(rt, "rustra: resourceWrite expects 3 positional argument(s), got " + std::to_string(argc));
  w.push_u8(21); w.push_u8(0); // cmd_id = 21 LE
  w.push_uvar(rustra_u64(rt, argv[0], "handle"));
  { auto _s = argv[1].asString(rt).utf8(rt); w.push_string(_s); }
  { auto _s = argv[2].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_resourceWrite(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, (double)r.read_i64());
  return std::move(resultObj);
}
static jsi::Value decode_resourceWrite(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "entries")};
  return decode_body_resourceWrite(rt, resultObj, r, _properties.data());
}

static void encode_body_rustraRegistryDemo(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_rustraRegistryDemo(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(12); w.push_u8(0); // cmd_id = 12 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "op")};
  encode_body_rustraRegistryDemo(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_rustraRegistryDemo(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: rustraRegistryDemo expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(12); w.push_u8(0); // cmd_id = 12 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_rustraRegistryDemo(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  resultObj.setProperty(rt, _prop_0, r.read_bool());
  resultObj.setProperty(rt, _prop_1, r.read_bool());
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_2, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  return std::move(resultObj);
}
static jsi::Value decode_rustraRegistryDemo(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 3> _properties{jsi::PropNameID::forAscii(rt, "ok"), jsi::PropNameID::forAscii(rt, "frozen"), jsi::PropNameID::forAscii(rt, "message")};
  return decode_body_rustraRegistryDemo(rt, resultObj, r, _properties.data());
}

static void encode_body_scoreTotal(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _o = argsObj.getProperty(rt, _prop_0).asObject(rt); auto _names = _o.getPropertyNames(rt); const auto _count = _names.length(rt); RustraMapEntries _entries(rt, _count); for (size_t _j = 0; _j < _count; _j++) { auto _key = _names.getValueAtIndex(rt, _j).getString(rt); auto _k = _key.utf8(rt); auto _value = rustra_map_value(rt, _o, _key, _k); _entries.emplace_back(std::move(_k), std::move(_value)); } std::sort(_entries.begin(), _entries.end(), [](const auto& _a, const auto& _b){ return _a.first < _b.first; }); w.push_uvar(_entries.size()); for (auto& _it : _entries) { w.push_string(_it.first); jsi::Value& _e = _it.second; w.push_i64(rustra_i64(rt, _e, "scores{}")); } }
}
static void encode_scoreTotal(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(15); w.push_u8(0); // cmd_id = 15 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "scores")};
  encode_body_scoreTotal(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_scoreTotal(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, (double)r.read_uvar());
  resultObj.setProperty(rt, _prop_1, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_scoreTotal(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "count"), jsi::PropNameID::forAscii(rt, "total")};
  return decode_body_scoreTotal(rt, resultObj, r, _properties.data());
}

static void encode_body_secureCompute(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_0), "a"));
  w.push_i64(rustra_i64(rt, argsObj.getProperty(rt, _prop_1), "b"));
}
static void encode_secureCompute(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(13); w.push_u8(0); // cmd_id = 13 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "a"), jsi::PropNameID::forAscii(rt, "b")};
  encode_body_secureCompute(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 2회 제거.
static void encode_pos_secureCompute(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 2) throw jsi::JSError(rt, "rustra: secureCompute expects 2 positional argument(s), got " + std::to_string(argc));
  w.push_u8(13); w.push_u8(0); // cmd_id = 13 LE
  w.push_i64(rustra_i64(rt, argv[0], "a"));
  w.push_i64(rustra_i64(rt, argv[1], "b"));
}

static jsi::Value decode_body_secureCompute(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_secureCompute(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "value")};
  return decode_body_secureCompute(rt, resultObj, r, _properties.data());
}

static void encode_body_sizeOf(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { const auto& _v = argsObj.getProperty(rt, _prop_0); auto _o = _v.asObject(rt); if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "data[]"); } else { auto _span = rustra_bytes(rt, _v, "data"); w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }
}
static void encode_sizeOf(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(14); w.push_u8(0); // cmd_id = 14 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "data")};
  encode_body_sizeOf(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_sizeOf(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: sizeOf expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(14); w.push_u8(0); // cmd_id = 14 LE
  { const auto& _v = argv[0]; auto _o = _v.asObject(rt); if (_o.isArray(rt)) { auto _arr = _o.getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); auto _dst = w.append_uninitialized(_n); for (size_t _i = 0; _i < _n; _i++) _dst[_i] = rustra_u8(rt, _arr.getValueAtIndex(rt, _i), "data[]"); } else { auto _span = rustra_bytes(rt, _v, "data"); w.push_uvar(_span.size); w.push_bytes(_span.data, _span.size); } }
}

static jsi::Value decode_body_sizeOf(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, (double)r.read_uvar());
  resultObj.setProperty(rt, _prop_1, (double)r.read_uvar());
  return std::move(resultObj);
}
static jsi::Value decode_sizeOf(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "checksum"), jsi::PropNameID::forAscii(rt, "len")};
  return decode_body_sizeOf(rt, resultObj, r, _properties.data());
}

static void encode_body_span(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  const auto& _prop_2 = _properties[2];
  { auto _arr = argsObj.getProperty(rt, _prop_0).asObject(rt).getArray(rt);
    { auto _v = _arr.getValueAtIndex(rt, 0).getString(rt).utf8(rt); w.push_string(_v); }
    w.push_i64(rustra_i64(rt, _arr.getValueAtIndex(rt, 1), "_"));
  }
}
static void encode_span(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(16); w.push_u8(0); // cmd_id = 16 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 3> _properties{jsi::PropNameID::forAscii(rt, "pair"), jsi::PropNameID::forAscii(rt, "value"), jsi::PropNameID::forAscii(rt, "_")};
  encode_body_span(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_span(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_0, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  resultObj.setProperty(rt, _prop_1, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_span(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "first"), jsi::PropNameID::forAscii(rt, "second")};
  return decode_body_span(rt, resultObj, r, _properties.data());
}

static void encode_body_sumList(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _arr = argsObj.getProperty(rt, _prop_0).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_i64(rustra_i64(rt, _arr.getValueAtIndex(rt, _i), "numbers[]")); }
}
static void encode_sumList(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(6); w.push_u8(0); // cmd_id = 6 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "numbers")};
  encode_body_sumList(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_sumList(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, (double)r.read_i64());
  resultObj.setProperty(rt, _prop_1, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_sumList(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "count"), jsi::PropNameID::forAscii(rt, "total")};
  return decode_body_sumList(rt, resultObj, r, _properties.data());
}

static void encode_body_toUpper(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _v = argsObj.getProperty(rt, _prop_0).getString(rt).utf8(rt); w.push_string(_v); }
}
static void encode_toUpper(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(7); w.push_u8(0); // cmd_id = 7 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "s")};
  encode_body_toUpper(rt, argsObj, w, _properties.data());
}

// (Tier 1 positional) 개별 인자 → 직접 인코딩. argsObj 경유 대비 JSI 프로퍼티 조회 1회 제거.
static void encode_pos_toUpper(jsi::Runtime& rt, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  if (argc != 1) throw jsi::JSError(rt, "rustra: toUpper expects 1 positional argument(s), got " + std::to_string(argc));
  w.push_u8(7); w.push_u8(0); // cmd_id = 7 LE
  { auto _s = argv[0].asString(rt).utf8(rt); w.push_string(_s); }
}

static jsi::Value decode_body_toUpper(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  { auto _s = r.read_string_view(); resultObj.setProperty(rt, _prop_0, jsi::String::createFromUtf8(rt, _s.data, _s.size)); }
  return std::move(resultObj);
}
static jsi::Value decode_toUpper(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 1> _properties{jsi::PropNameID::forAscii(rt, "result")};
  return decode_body_toUpper(rt, resultObj, r, _properties.data());
}

static void encode_body_wideAgg(jsi::Runtime& rt, const jsi::Object& argsObj, rc::Writer& w, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  { auto _arr = argsObj.getProperty(rt, _prop_0).asObject(rt).getArray(rt); auto _n = _arr.length(rt); w.push_uvar(_n); for (size_t _i = 0; _i < _n; _i++) w.push_uvar(rustra_u64(rt, _arr.getValueAtIndex(rt, _i), "samples[]")); }
  { auto _option_value = argsObj.getProperty(rt, _prop_1); if (_option_value.isNull() || _option_value.isUndefined()) { w.push_u8(0); } else { w.push_u8(1); w.push_i64(rustra_i64(rt, _option_value, "offset")); } }
}
static void encode_wideAgg(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(28); w.push_u8(0); // cmd_id = 28 LE
  auto argsObj = args.asObject(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "samples"), jsi::PropNameID::forAscii(rt, "offset")};
  encode_body_wideAgg(rt, argsObj, w, _properties.data());
}

static jsi::Value decode_body_wideAgg(jsi::Runtime& rt, jsi::Object& resultObj, rc::Reader& r, const jsi::PropNameID* _properties) {
  const auto& _prop_0 = _properties[0];
  const auto& _prop_1 = _properties[1];
  resultObj.setProperty(rt, _prop_0, [&]() -> jsi::Value { auto _v = r.read_uvar(); if (_v <= 9007199254740991ull) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromUint64(rt, _v)); }());
  resultObj.setProperty(rt, _prop_1, [&]() -> jsi::Value { auto _v = r.read_i64(); if (_v >= -9007199254740991ll && _v <= 9007199254740991ll) return jsi::Value(static_cast<double>(_v)); return jsi::Value(rt, jsi::BigInt::fromInt64(rt, _v)); }());
  return std::move(resultObj);
}
static jsi::Value decode_wideAgg(jsi::Runtime& rt, rc::Reader& r) {
  auto resultObj = jsi::Object(rt);
  const std::array<jsi::PropNameID, 2> _properties{jsi::PropNameID::forAscii(rt, "max"), jsi::PropNameID::forAscii(rt, "adjusted")};
  return decode_body_wideAgg(rt, resultObj, r, _properties.data());
}

static void encode_complex_deviceDemo(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(32); w.push_u8(0);
  if (!args.isNull()) throw jsi::JSError(rt, "complex null expected");
}

static jsi::Value decode_complex_deviceDemo(jsi::Runtime& rt, rc::Reader& r) {
  return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "os", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); return _cx0; }();
}

static void encode_complex_echoGroups(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(27); w.push_u8(0);
  { if (!args.isObject() || args.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = args.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "groups");
    { if (!_cx1.isObject() || _cx1.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object map expected");
      auto _cx2 = _cx1.asObject(rt); auto _cx3 = _cx2.getPropertyNames(rt);
      std::vector<std::pair<std::string, jsi::Value>> _cx4;
      for (size_t _i = 0; _i < _cx3.length(rt); _i++) { auto _key = _cx3.getValueAtIndex(rt, _i).getString(rt).utf8(rt); auto _property = _cx2.getProperty(rt, jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(_key.data()), _key.size())); _cx4.push_back({_key, std::move(_property)}); }
      std::sort(_cx4.begin(), _cx4.end(), [](const auto& _a, const auto& _b) { const auto& a = _a.first; const auto& b = _b.first; const size_t n = std::min(a.size(), b.size()); for (size_t i = 0; i < n; ++i) { const auto ca = static_cast<unsigned char>(a[i]); const auto cb = static_cast<unsigned char>(b[i]); if (ca != cb) return ca < cb; } return a.size() < b.size(); });
      w.push_uvar(_cx4.size()); for (auto& _entry : _cx4) { w.push_string(_entry.first); auto& _value = _entry.second;
        { auto _cx5 = _value.asObject(rt);
          if (!_value.isObject() || !_cx5.isArray(rt)) throw jsi::JSError(rt, "complex array expected");
          auto _cx6 = _cx5.getArray(rt); auto _cx7 = _cx6.length(rt);
          w.push_uvar(_cx7);
          for (size_t _i = 0; _i < _cx7; _i++) {
            if (!_cx6.getValueAtIndex(rt, _i).isString()) throw jsi::JSError(rt, "complex string expected");
            w.push_string(_cx6.getValueAtIndex(rt, _i).getString(rt).utf8(rt));
          } }
      } }
  }
}

static jsi::Value decode_complex_echoGroups(jsi::Runtime& rt, rc::Reader& r) {
  return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "groups", [&]() -> jsi::Value { auto _cx1 = r.read_uvar(); if (_cx1 > 100000) throw std::runtime_error("complex map length exceeds 100000"); auto _cx2 = jsi::Object(rt); for (size_t _i = 0; _i < _cx1; _i++) { auto _cx3 = r.read_string_view(); auto _keyValue = jsi::String::createFromUtf8(rt, _cx3.data, _cx3.size); _cx2.setProperty(rt, _keyValue, [&]() -> jsi::Value { auto _cx4 = r.read_uvar(); if (_cx4 > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto _cx5 = jsi::Array(rt, static_cast<size_t>(_cx4)); for (size_t _i = 0; _i < _cx4; _i++) _cx5.setValueAtIndex(rt, _i, [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); return _cx5; }()); } return _cx2; }()); return _cx0; }();
}

static void encode_complex_kindEcho(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(33); w.push_u8(0);
  { if (!args.isObject() || args.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = args.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "kind");
    complex_encode_ref_OpKind(rt, _cx1, w, 0 + 1);
  }
}

static jsi::Value decode_complex_kindEcho(jsi::Runtime& rt, rc::Reader& r) {
  return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "echoed", complex_decode_ref_OpKind(rt, r, 0 + 1)); return _cx0; }();
}

static void encode_complex_platformNativeInfo(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(30); w.push_u8(0);
  if (!args.isNull()) throw jsi::JSError(rt, "complex null expected");
}

static jsi::Value decode_complex_platformNativeInfo(jsi::Runtime& rt, rc::Reader& r) {
  return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "os", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); _cx0.setProperty(rt, "windowKind", [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); return _cx0; }();
}

static void encode_complex_tagSet(jsi::Runtime& rt, const jsi::Value& args, rc::Writer& w) {
  w.push_u8(29); w.push_u8(0);
  { if (!args.isObject() || args.asObject(rt).isArray(rt)) throw jsi::JSError(rt, "complex object expected");
    auto _cx0 = args.asObject(rt);
    auto _cx1 = _cx0.getProperty(rt, "ids");
    { auto _cx3 = [&]() -> jsi::Array {
        if (!_cx1.isObject()) throw jsi::JSError(rt, "complex Set or array expected");
        auto _cx2 = _cx1.asObject(rt);
        if (_cx2.isArray(rt)) return _cx2.getArray(rt);
        if (!_cx2.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Set"))) throw jsi::JSError(rt, "complex Set or array expected");
        auto _from = rt.global().getPropertyAsFunction(rt, "Array").getPropertyAsFunction(rt, "from");
        return _from.call(rt, jsi::Value(rt, _cx1)).asObject(rt).getArray(rt);
      }();
      auto _cx4 = _cx3.length(rt);
      w.push_uvar(_cx4);
      for (size_t _i = 0; _i < _cx4; _i++) {
        w.push_i64(rustra_i64(rt, _cx3.getValueAtIndex(rt, _i), "complex integer"));
      } }
  }
}

static jsi::Value decode_complex_tagSet(jsi::Runtime& rt, rc::Reader& r) {
  return [&]() -> jsi::Value { auto _cx0 = jsi::Object(rt); _cx0.setProperty(rt, "tags", [&]() -> jsi::Value { auto _cx1 = r.read_uvar(); if (_cx1 > 100000) throw std::runtime_error("complex collection length exceeds 100000"); auto _cx2 = jsi::Array(rt, static_cast<size_t>(_cx1)); for (size_t _i = 0; _i < _cx1; _i++) _cx2.setValueAtIndex(rt, _i, [&]() -> jsi::Value { auto _s = r.read_string_view(); return jsi::String::createFromUtf8(rt, _s.data, _s.size); }()); return rt.global().getPropertyAsFunction(rt, "Set").callAsConstructor(rt, jsi::Value(rt, _cx2)); }()); return _cx0; }();
}

namespace rustra::generated {

bool encode_bound(Runtime& rt, const BoundCodecContext& context, const Value& args, rc::Writer& w) {
  switch (context.commandId) {
    case 1: {
      w.push_u8(1); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_addNumbers(rt, argsObj, w, context.input.data()); return true;
    }
    case 23: {
      w.push_u8(23); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_benchAdd(rt, argsObj, w, context.input.data()); return true;
    }
    case 25: {
      w.push_u8(25); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_benchEchoBytes(rt, argsObj, w, context.input.data()); return true;
    }
    case 26: {
      w.push_u8(26); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_benchEchoPair(rt, argsObj, w, context.input.data()); return true;
    }
    case 24: {
      w.push_u8(24); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_benchEchoString(rt, argsObj, w, context.input.data()); return true;
    }
    case 18: {
      w.push_u8(18); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_channelDemo(rt, argsObj, w, context.input.data()); return true;
    }
    case 31: {
      w.push_u8(31); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_channelDemoBytes(rt, argsObj, w, context.input.data()); return true;
    }
    case 4: {
      w.push_u8(4); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_clamp(rt, argsObj, w, context.input.data()); return true;
    }
    case 8: {
      w.push_u8(8); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_createItem(rt, argsObj, w, context.input.data()); return true;
    }
    case 10: {
      w.push_u8(10); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_divide(rt, argsObj, w, context.input.data()); return true;
    }
    case 11: {
      w.push_u8(11); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_emitDemo(rt, argsObj, w, context.input.data()); return true;
    }
    case 17: {
      w.push_u8(17); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_gauge(rt, argsObj, w, context.input.data()); return true;
    }
    case 5: {
      w.push_u8(5); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_greet(rt, argsObj, w, context.input.data()); return true;
    }
    case 3: {
      w.push_u8(3); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_isEven(rt, argsObj, w, context.input.data()); return true;
    }
    case 2: {
      w.push_u8(2); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_multiply(rt, argsObj, w, context.input.data()); return true;
    }
    case 34: {
      w.push_u8(34); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_parityEcho(rt, argsObj, w, context.input.data()); return true;
    }
    case 35: {
      w.push_u8(35); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_parityFind(rt, argsObj, w, context.input.data()); return true;
    }
    case 38: {
      w.push_u8(38); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_parityIndexed(rt, argsObj, w, context.input.data()); return true;
    }
    case 37: {
      w.push_u8(37); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_parityResident(rt, argsObj, w, context.input.data()); return true;
    }
    case 36: {
      w.push_u8(36); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_parityStore(rt, argsObj, w, context.input.data()); return true;
    }
    case 9: {
      w.push_u8(9); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_processItem(rt, argsObj, w, context.input.data()); return true;
    }
    case 22: {
      w.push_u8(22); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_resourceClose(rt, argsObj, w, context.input.data()); return true;
    }
    case 19: {
      w.push_u8(19); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_resourceOpen(rt, argsObj, w, context.input.data()); return true;
    }
    case 20: {
      w.push_u8(20); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_resourceRead(rt, argsObj, w, context.input.data()); return true;
    }
    case 21: {
      w.push_u8(21); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_resourceWrite(rt, argsObj, w, context.input.data()); return true;
    }
    case 12: {
      w.push_u8(12); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_rustraRegistryDemo(rt, argsObj, w, context.input.data()); return true;
    }
    case 15: {
      w.push_u8(15); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_scoreTotal(rt, argsObj, w, context.input.data()); return true;
    }
    case 13: {
      w.push_u8(13); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_secureCompute(rt, argsObj, w, context.input.data()); return true;
    }
    case 14: {
      w.push_u8(14); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_sizeOf(rt, argsObj, w, context.input.data()); return true;
    }
    case 16: {
      w.push_u8(16); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_span(rt, argsObj, w, context.input.data()); return true;
    }
    case 6: {
      w.push_u8(6); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_sumList(rt, argsObj, w, context.input.data()); return true;
    }
    case 7: {
      w.push_u8(7); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_toUpper(rt, argsObj, w, context.input.data()); return true;
    }
    case 28: {
      w.push_u8(28); w.push_u8(0);
      auto argsObj = args.asObject(rt);
      encode_body_wideAgg(rt, argsObj, w, context.input.data()); return true;
    }
    case 32: encode_complex_deviceDemo(rt, args, w); return true;
    case 27: encode_complex_echoGroups(rt, args, w); return true;
    case 33: encode_complex_kindEcho(rt, args, w); return true;
    case 30: encode_complex_platformNativeInfo(rt, args, w); return true;
    case 29: encode_complex_tagSet(rt, args, w); return true;
    default: return false;
  }
}

Value decode_bound(Runtime& rt, const BoundCodecContext& context, rc::Reader& r) {
  switch (context.commandId) {
    case 1: {
      auto resultObj = jsi::Object(rt);
      return decode_body_addNumbers(rt, resultObj, r, context.output.data());
    }
    case 23: {
      auto resultObj = jsi::Object(rt);
      return decode_body_benchAdd(rt, resultObj, r, context.output.data());
    }
    case 25: {
      auto resultObj = jsi::Object(rt);
      return decode_body_benchEchoBytes(rt, resultObj, r, context.output.data());
    }
    case 26: {
      auto resultObj = jsi::Object(rt);
      return decode_body_benchEchoPair(rt, resultObj, r, context.output.data());
    }
    case 24: {
      auto resultObj = jsi::Object(rt);
      return decode_body_benchEchoString(rt, resultObj, r, context.output.data());
    }
    case 18: {
      auto resultObj = jsi::Object(rt);
      return decode_body_channelDemo(rt, resultObj, r, context.output.data());
    }
    case 31: {
      auto resultObj = jsi::Object(rt);
      return decode_body_channelDemoBytes(rt, resultObj, r, context.output.data());
    }
    case 4: {
      auto resultObj = jsi::Object(rt);
      return decode_body_clamp(rt, resultObj, r, context.output.data());
    }
    case 8: {
      auto resultObj = jsi::Object(rt);
      return decode_body_createItem(rt, resultObj, r, context.output.data());
    }
    case 10: {
      auto resultObj = jsi::Object(rt);
      return decode_body_divide(rt, resultObj, r, context.output.data());
    }
    case 11: {
      auto resultObj = jsi::Object(rt);
      return decode_body_emitDemo(rt, resultObj, r, context.output.data());
    }
    case 17: {
      auto resultObj = jsi::Object(rt);
      return decode_body_gauge(rt, resultObj, r, context.output.data());
    }
    case 5: {
      auto resultObj = jsi::Object(rt);
      return decode_body_greet(rt, resultObj, r, context.output.data());
    }
    case 3: {
      auto resultObj = jsi::Object(rt);
      return decode_body_isEven(rt, resultObj, r, context.output.data());
    }
    case 2: {
      auto resultObj = jsi::Object(rt);
      return decode_body_multiply(rt, resultObj, r, context.output.data());
    }
    case 34: {
      auto resultObj = jsi::Object(rt);
      return decode_body_parityEcho(rt, resultObj, r, context.output.data());
    }
    case 35: {
      auto resultObj = jsi::Object(rt);
      return decode_body_parityFind(rt, resultObj, r, context.output.data());
    }
    case 38: {
      auto resultObj = jsi::Object(rt);
      return decode_body_parityIndexed(rt, resultObj, r, context.output.data());
    }
    case 37: {
      auto resultObj = jsi::Object(rt);
      return decode_body_parityResident(rt, resultObj, r, context.output.data());
    }
    case 36: {
      auto resultObj = jsi::Object(rt);
      return decode_body_parityStore(rt, resultObj, r, context.output.data());
    }
    case 9: {
      auto resultObj = jsi::Object(rt);
      return decode_body_processItem(rt, resultObj, r, context.output.data());
    }
    case 22: {
      auto resultObj = jsi::Object(rt);
      return decode_body_resourceClose(rt, resultObj, r, context.output.data());
    }
    case 19: {
      auto resultObj = jsi::Object(rt);
      return decode_body_resourceOpen(rt, resultObj, r, context.output.data());
    }
    case 20: {
      auto resultObj = jsi::Object(rt);
      return decode_body_resourceRead(rt, resultObj, r, context.output.data());
    }
    case 21: {
      auto resultObj = jsi::Object(rt);
      return decode_body_resourceWrite(rt, resultObj, r, context.output.data());
    }
    case 12: {
      auto resultObj = jsi::Object(rt);
      return decode_body_rustraRegistryDemo(rt, resultObj, r, context.output.data());
    }
    case 15: {
      auto resultObj = jsi::Object(rt);
      return decode_body_scoreTotal(rt, resultObj, r, context.output.data());
    }
    case 13: {
      auto resultObj = jsi::Object(rt);
      return decode_body_secureCompute(rt, resultObj, r, context.output.data());
    }
    case 14: {
      auto resultObj = jsi::Object(rt);
      return decode_body_sizeOf(rt, resultObj, r, context.output.data());
    }
    case 16: {
      auto resultObj = jsi::Object(rt);
      return decode_body_span(rt, resultObj, r, context.output.data());
    }
    case 6: {
      auto resultObj = jsi::Object(rt);
      return decode_body_sumList(rt, resultObj, r, context.output.data());
    }
    case 7: {
      auto resultObj = jsi::Object(rt);
      return decode_body_toUpper(rt, resultObj, r, context.output.data());
    }
    case 28: {
      auto resultObj = jsi::Object(rt);
      return decode_body_wideAgg(rt, resultObj, r, context.output.data());
    }
    case 32: return decode_complex_deviceDemo(rt, r);
    case 27: return decode_complex_echoGroups(rt, r);
    case 33: return decode_complex_kindEcho(rt, r);
    case 30: return decode_complex_platformNativeInfo(rt, r);
    case 29: return decode_complex_tagSet(rt, r);
    default: throw JSError(rt, "rustra: no bound codec");
  }
}

bool encode_by_name(Runtime& rt, const std::string& name, const Value& args, rc::Writer& w) {
  if (name == "addNumbers") { encode_addNumbers(rt, args, w); return true; }
  if (name == "benchAdd") { encode_benchAdd(rt, args, w); return true; }
  if (name == "benchEchoBytes") { encode_benchEchoBytes(rt, args, w); return true; }
  if (name == "benchEchoPair") { encode_benchEchoPair(rt, args, w); return true; }
  if (name == "benchEchoString") { encode_benchEchoString(rt, args, w); return true; }
  if (name == "channelDemo") { encode_channelDemo(rt, args, w); return true; }
  if (name == "channelDemoBytes") { encode_channelDemoBytes(rt, args, w); return true; }
  if (name == "clamp") { encode_clamp(rt, args, w); return true; }
  if (name == "createItem") { encode_createItem(rt, args, w); return true; }
  if (name == "divide") { encode_divide(rt, args, w); return true; }
  if (name == "emitDemo") { encode_emitDemo(rt, args, w); return true; }
  if (name == "gauge") { encode_gauge(rt, args, w); return true; }
  if (name == "greet") { encode_greet(rt, args, w); return true; }
  if (name == "isEven") { encode_isEven(rt, args, w); return true; }
  if (name == "multiply") { encode_multiply(rt, args, w); return true; }
  if (name == "parityEcho") { encode_parityEcho(rt, args, w); return true; }
  if (name == "parityFind") { encode_parityFind(rt, args, w); return true; }
  if (name == "parityIndexed") { encode_parityIndexed(rt, args, w); return true; }
  if (name == "parityResident") { encode_parityResident(rt, args, w); return true; }
  if (name == "parityStore") { encode_parityStore(rt, args, w); return true; }
  if (name == "processItem") { encode_processItem(rt, args, w); return true; }
  if (name == "resourceClose") { encode_resourceClose(rt, args, w); return true; }
  if (name == "resourceOpen") { encode_resourceOpen(rt, args, w); return true; }
  if (name == "resourceRead") { encode_resourceRead(rt, args, w); return true; }
  if (name == "resourceWrite") { encode_resourceWrite(rt, args, w); return true; }
  if (name == "rustraRegistryDemo") { encode_rustraRegistryDemo(rt, args, w); return true; }
  if (name == "scoreTotal") { encode_scoreTotal(rt, args, w); return true; }
  if (name == "secureCompute") { encode_secureCompute(rt, args, w); return true; }
  if (name == "sizeOf") { encode_sizeOf(rt, args, w); return true; }
  if (name == "span") { encode_span(rt, args, w); return true; }
  if (name == "sumList") { encode_sumList(rt, args, w); return true; }
  if (name == "toUpper") { encode_toUpper(rt, args, w); return true; }
  if (name == "wideAgg") { encode_wideAgg(rt, args, w); return true; }
  if (name == "deviceDemo") { encode_complex_deviceDemo(rt, args, w); return true; }
  if (name == "echoGroups") { encode_complex_echoGroups(rt, args, w); return true; }
  if (name == "kindEcho") { encode_complex_kindEcho(rt, args, w); return true; }
  if (name == "platformNativeInfo") { encode_complex_platformNativeInfo(rt, args, w); return true; }
  if (name == "tagSet") { encode_complex_tagSet(rt, args, w); return true; }
  return false; // 동적 명령 — JS 가 Tier 3 fallback 처리
}

Value decode_by_name(Runtime& rt, const std::string& name, rc::Reader& r) {
  if (name == "addNumbers") return decode_addNumbers(rt, r);
  if (name == "benchAdd") return decode_benchAdd(rt, r);
  if (name == "benchEchoBytes") return decode_benchEchoBytes(rt, r);
  if (name == "benchEchoPair") return decode_benchEchoPair(rt, r);
  if (name == "benchEchoString") return decode_benchEchoString(rt, r);
  if (name == "channelDemo") return decode_channelDemo(rt, r);
  if (name == "channelDemoBytes") return decode_channelDemoBytes(rt, r);
  if (name == "clamp") return decode_clamp(rt, r);
  if (name == "createItem") return decode_createItem(rt, r);
  if (name == "divide") return decode_divide(rt, r);
  if (name == "emitDemo") return decode_emitDemo(rt, r);
  if (name == "gauge") return decode_gauge(rt, r);
  if (name == "greet") return decode_greet(rt, r);
  if (name == "isEven") return decode_isEven(rt, r);
  if (name == "multiply") return decode_multiply(rt, r);
  if (name == "parityEcho") return decode_parityEcho(rt, r);
  if (name == "parityFind") return decode_parityFind(rt, r);
  if (name == "parityIndexed") return decode_parityIndexed(rt, r);
  if (name == "parityResident") return decode_parityResident(rt, r);
  if (name == "parityStore") return decode_parityStore(rt, r);
  if (name == "processItem") return decode_processItem(rt, r);
  if (name == "resourceClose") return decode_resourceClose(rt, r);
  if (name == "resourceOpen") return decode_resourceOpen(rt, r);
  if (name == "resourceRead") return decode_resourceRead(rt, r);
  if (name == "resourceWrite") return decode_resourceWrite(rt, r);
  if (name == "rustraRegistryDemo") return decode_rustraRegistryDemo(rt, r);
  if (name == "scoreTotal") return decode_scoreTotal(rt, r);
  if (name == "secureCompute") return decode_secureCompute(rt, r);
  if (name == "sizeOf") return decode_sizeOf(rt, r);
  if (name == "span") return decode_span(rt, r);
  if (name == "sumList") return decode_sumList(rt, r);
  if (name == "toUpper") return decode_toUpper(rt, r);
  if (name == "wideAgg") return decode_wideAgg(rt, r);
  if (name == "deviceDemo") return decode_complex_deviceDemo(rt, r);
  if (name == "echoGroups") return decode_complex_echoGroups(rt, r);
  if (name == "kindEcho") return decode_complex_kindEcho(rt, r);
  if (name == "platformNativeInfo") return decode_complex_platformNativeInfo(rt, r);
  if (name == "tagSet") return decode_complex_tagSet(rt, r);
  throw JSError(rt, "rustra: no C++ codec for '" + name + "'");
}

bool encode_by_id(Runtime& rt, uint16_t cmd_id, const Value& args, rc::Writer& w) {
  switch (cmd_id) {
    case 1: encode_addNumbers(rt, args, w); return true;
    case 23: encode_benchAdd(rt, args, w); return true;
    case 25: encode_benchEchoBytes(rt, args, w); return true;
    case 26: encode_benchEchoPair(rt, args, w); return true;
    case 24: encode_benchEchoString(rt, args, w); return true;
    case 18: encode_channelDemo(rt, args, w); return true;
    case 31: encode_channelDemoBytes(rt, args, w); return true;
    case 4: encode_clamp(rt, args, w); return true;
    case 8: encode_createItem(rt, args, w); return true;
    case 10: encode_divide(rt, args, w); return true;
    case 11: encode_emitDemo(rt, args, w); return true;
    case 17: encode_gauge(rt, args, w); return true;
    case 5: encode_greet(rt, args, w); return true;
    case 3: encode_isEven(rt, args, w); return true;
    case 2: encode_multiply(rt, args, w); return true;
    case 34: encode_parityEcho(rt, args, w); return true;
    case 35: encode_parityFind(rt, args, w); return true;
    case 38: encode_parityIndexed(rt, args, w); return true;
    case 37: encode_parityResident(rt, args, w); return true;
    case 36: encode_parityStore(rt, args, w); return true;
    case 9: encode_processItem(rt, args, w); return true;
    case 22: encode_resourceClose(rt, args, w); return true;
    case 19: encode_resourceOpen(rt, args, w); return true;
    case 20: encode_resourceRead(rt, args, w); return true;
    case 21: encode_resourceWrite(rt, args, w); return true;
    case 12: encode_rustraRegistryDemo(rt, args, w); return true;
    case 15: encode_scoreTotal(rt, args, w); return true;
    case 13: encode_secureCompute(rt, args, w); return true;
    case 14: encode_sizeOf(rt, args, w); return true;
    case 16: encode_span(rt, args, w); return true;
    case 6: encode_sumList(rt, args, w); return true;
    case 7: encode_toUpper(rt, args, w); return true;
    case 28: encode_wideAgg(rt, args, w); return true;
    case 32: encode_complex_deviceDemo(rt, args, w); return true;
    case 27: encode_complex_echoGroups(rt, args, w); return true;
    case 33: encode_complex_kindEcho(rt, args, w); return true;
    case 30: encode_complex_platformNativeInfo(rt, args, w); return true;
    case 29: encode_complex_tagSet(rt, args, w); return true;
    default: return false; // 동적/알 수 없는 cmd_id — JS 가 Tier 3 fallback 처리
  }
}

Value decode_by_id(Runtime& rt, uint16_t cmd_id, rc::Reader& r) {
  switch (cmd_id) {
    case 1: return decode_addNumbers(rt, r);
    case 23: return decode_benchAdd(rt, r);
    case 25: return decode_benchEchoBytes(rt, r);
    case 26: return decode_benchEchoPair(rt, r);
    case 24: return decode_benchEchoString(rt, r);
    case 18: return decode_channelDemo(rt, r);
    case 31: return decode_channelDemoBytes(rt, r);
    case 4: return decode_clamp(rt, r);
    case 8: return decode_createItem(rt, r);
    case 10: return decode_divide(rt, r);
    case 11: return decode_emitDemo(rt, r);
    case 17: return decode_gauge(rt, r);
    case 5: return decode_greet(rt, r);
    case 3: return decode_isEven(rt, r);
    case 2: return decode_multiply(rt, r);
    case 34: return decode_parityEcho(rt, r);
    case 35: return decode_parityFind(rt, r);
    case 38: return decode_parityIndexed(rt, r);
    case 37: return decode_parityResident(rt, r);
    case 36: return decode_parityStore(rt, r);
    case 9: return decode_processItem(rt, r);
    case 22: return decode_resourceClose(rt, r);
    case 19: return decode_resourceOpen(rt, r);
    case 20: return decode_resourceRead(rt, r);
    case 21: return decode_resourceWrite(rt, r);
    case 12: return decode_rustraRegistryDemo(rt, r);
    case 15: return decode_scoreTotal(rt, r);
    case 13: return decode_secureCompute(rt, r);
    case 14: return decode_sizeOf(rt, r);
    case 16: return decode_span(rt, r);
    case 6: return decode_sumList(rt, r);
    case 7: return decode_toUpper(rt, r);
    case 28: return decode_wideAgg(rt, r);
    case 32: return decode_complex_deviceDemo(rt, r);
    case 27: return decode_complex_echoGroups(rt, r);
    case 33: return decode_complex_kindEcho(rt, r);
    case 30: return decode_complex_platformNativeInfo(rt, r);
    case 29: return decode_complex_tagSet(rt, r);
    default: throw JSError(rt, "rustra: no C++ codec for cmd_id " + std::to_string(cmd_id));
  }
}

bool has_static_codec(const std::string& name) {
  if (name == "addNumbers") return true;
  if (name == "benchAdd") return true;
  if (name == "benchEchoBytes") return true;
  if (name == "benchEchoPair") return true;
  if (name == "benchEchoString") return true;
  if (name == "channelDemo") return true;
  if (name == "channelDemoBytes") return true;
  if (name == "clamp") return true;
  if (name == "createItem") return true;
  if (name == "divide") return true;
  if (name == "emitDemo") return true;
  if (name == "gauge") return true;
  if (name == "greet") return true;
  if (name == "isEven") return true;
  if (name == "multiply") return true;
  if (name == "parityEcho") return true;
  if (name == "parityFind") return true;
  if (name == "parityIndexed") return true;
  if (name == "parityResident") return true;
  if (name == "parityStore") return true;
  if (name == "processItem") return true;
  if (name == "resourceClose") return true;
  if (name == "resourceOpen") return true;
  if (name == "resourceRead") return true;
  if (name == "resourceWrite") return true;
  if (name == "rustraRegistryDemo") return true;
  if (name == "scoreTotal") return true;
  if (name == "secureCompute") return true;
  if (name == "sizeOf") return true;
  if (name == "span") return true;
  if (name == "sumList") return true;
  if (name == "toUpper") return true;
  if (name == "wideAgg") return true;
  if (name == "deviceDemo") return true;
  if (name == "echoGroups") return true;
  if (name == "kindEcho") return true;
  if (name == "platformNativeInfo") return true;
  if (name == "tagSet") return true;
  return false;
}

bool has_static_codec_id(uint16_t cmd_id) {
  switch (cmd_id) {
    case 1: return true;
    case 23: return true;
    case 25: return true;
    case 26: return true;
    case 24: return true;
    case 18: return true;
    case 31: return true;
    case 4: return true;
    case 8: return true;
    case 10: return true;
    case 11: return true;
    case 17: return true;
    case 5: return true;
    case 3: return true;
    case 2: return true;
    case 34: return true;
    case 35: return true;
    case 38: return true;
    case 37: return true;
    case 36: return true;
    case 9: return true;
    case 22: return true;
    case 19: return true;
    case 20: return true;
    case 21: return true;
    case 12: return true;
    case 15: return true;
    case 13: return true;
    case 14: return true;
    case 16: return true;
    case 6: return true;
    case 7: return true;
    case 28: return true;
    case 32: return true;
    case 27: return true;
    case 33: return true;
    case 30: return true;
    case 29: return true;
    default: return false;
  }
}

/// (Tier 1) positional 인자를 직접 인코딩 가능한 cmd_id 집합 — JS 폴백 판별용.
bool has_pos_codec(uint16_t cmd_id) {
  if (cmd_id == 1) return true;
  if (cmd_id == 23) return true;
  if (cmd_id == 25) return true;
  if (cmd_id == 26) return true;
  if (cmd_id == 24) return true;
  if (cmd_id == 18) return true;
  if (cmd_id == 31) return true;
  if (cmd_id == 4) return true;
  if (cmd_id == 8) return true;
  if (cmd_id == 10) return true;
  if (cmd_id == 11) return true;
  if (cmd_id == 17) return true;
  if (cmd_id == 5) return true;
  if (cmd_id == 3) return true;
  if (cmd_id == 2) return true;
  if (cmd_id == 38) return true;
  if (cmd_id == 37) return true;
  if (cmd_id == 22) return true;
  if (cmd_id == 20) return true;
  if (cmd_id == 21) return true;
  if (cmd_id == 12) return true;
  if (cmd_id == 13) return true;
  if (cmd_id == 14) return true;
  if (cmd_id == 7) return true;
  return false;
}

/// (Tier 1) 개별 Value 인자 → postcard 바이트. 명령별 코덱이 argc를 정확히 검증한다.
void encode_pos_by_id(jsi::Runtime& rt, uint16_t cmd_id, const jsi::Value* argv, size_t argc, rc::Writer& w) {
  switch (cmd_id) {
    case 1: encode_pos_addNumbers(rt, argv, argc, w); return;
    case 23: encode_pos_benchAdd(rt, argv, argc, w); return;
    case 25: encode_pos_benchEchoBytes(rt, argv, argc, w); return;
    case 26: encode_pos_benchEchoPair(rt, argv, argc, w); return;
    case 24: encode_pos_benchEchoString(rt, argv, argc, w); return;
    case 18: encode_pos_channelDemo(rt, argv, argc, w); return;
    case 31: encode_pos_channelDemoBytes(rt, argv, argc, w); return;
    case 4: encode_pos_clamp(rt, argv, argc, w); return;
    case 8: encode_pos_createItem(rt, argv, argc, w); return;
    case 10: encode_pos_divide(rt, argv, argc, w); return;
    case 11: encode_pos_emitDemo(rt, argv, argc, w); return;
    case 17: encode_pos_gauge(rt, argv, argc, w); return;
    case 5: encode_pos_greet(rt, argv, argc, w); return;
    case 3: encode_pos_isEven(rt, argv, argc, w); return;
    case 2: encode_pos_multiply(rt, argv, argc, w); return;
    case 38: encode_pos_parityIndexed(rt, argv, argc, w); return;
    case 37: encode_pos_parityResident(rt, argv, argc, w); return;
    case 22: encode_pos_resourceClose(rt, argv, argc, w); return;
    case 20: encode_pos_resourceRead(rt, argv, argc, w); return;
    case 21: encode_pos_resourceWrite(rt, argv, argc, w); return;
    case 12: encode_pos_rustraRegistryDemo(rt, argv, argc, w); return;
    case 13: encode_pos_secureCompute(rt, argv, argc, w); return;
    case 14: encode_pos_sizeOf(rt, argv, argc, w); return;
    case 7: encode_pos_toUpper(rt, argv, argc, w); return;
    default: throw JSError(rt, "rustra: no positional codec for cmd_id " + std::to_string(cmd_id));
  }
}

bool has_buffer_codec(uint16_t cmd_id) {
  switch (cmd_id) {
    case 25: return true;
    default: return false;
  }
}

void encode_buffer_by_id(uint16_t cmd_id, const uint8_t* data, size_t size, rc::Writer& w) {
  if (size > 0 && data == nullptr) throw std::invalid_argument("rustra: null byte buffer");
  switch (cmd_id) {
    case 25:
      w.push_u8(25); w.push_u8(0);
      w.push_uvar(size);
      if (size > 0) w.push_bytes(data, size);
      return;
    case 14:
      w.push_u8(14); w.push_u8(0);
      w.push_uvar(size);
      if (size > 0) w.push_bytes(data, size);
      return;
    default: throw std::invalid_argument("rustra: no buffer codec for cmd_id " + std::to_string(cmd_id));
  }
}

Value decode_buffer_result_by_id(Runtime& rt, uint16_t cmd_id, Value buffer) {
  switch (cmd_id) {
    case 25: {
      auto result = Object(rt);
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "data"), std::move(buffer));
      return result;
    }
    default: throw JSError(rt, "rustra: no buffer result codec for cmd_id " + std::to_string(cmd_id));
  }
}

Value decode_buffer_bound(Runtime& rt, const BoundCodecContext& context, Value buffer) {
  switch (context.commandId) {
    case 25: {
      auto result = Object(rt);
      result.setProperty(rt, context.output[0], std::move(buffer));
      return result;
    }
    default: throw JSError(rt, "rustra: no bound buffer result codec");
  }
}

bool has_raw_codec(uint16_t cmd_id) {
  switch (cmd_id) {
    case 1: return true;
    case 23: return true;
    case 4: return true;
    case 10: return true;
    case 11: return true;
    case 17: return true;
    case 3: return true;
    case 2: return true;
    case 22: return true;
    case 13: return true;
    default: return false;
  }
}

void encode_raw_slots(Runtime& rt, uint16_t cmd_id, const Value* argv, size_t argc, uint64_t* slots) {
  switch (cmd_id) {
    case 1: {
      if (argc != 2) throw JSError(rt, "rustra: addNumbers expects 2 raw argument(s), got " + std::to_string(argc));
      { int64_t value = rustra_i64(rt, argv[0], "a"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { int64_t value = rustra_i64(rt, argv[1], "b"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    case 23: {
      if (argc != 2) throw JSError(rt, "rustra: benchAdd expects 2 raw argument(s), got " + std::to_string(argc));
      { double value = rustra_f64(rt, argv[0], "a"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { double value = rustra_f64(rt, argv[1], "b"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    case 4: {
      if (argc != 3) throw JSError(rt, "rustra: clamp expects 3 raw argument(s), got " + std::to_string(argc));
      { double value = rustra_f64(rt, argv[0], "max"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { double value = rustra_f64(rt, argv[1], "min"); std::memcpy(&slots[1], &value, sizeof(value)); }
      { double value = rustra_f64(rt, argv[2], "value"); std::memcpy(&slots[2], &value, sizeof(value)); }
      return;
    }
    case 10: {
      if (argc != 2) throw JSError(rt, "rustra: divide expects 2 raw argument(s), got " + std::to_string(argc));
      { int64_t value = rustra_i64(rt, argv[0], "a"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { int64_t value = rustra_i64(rt, argv[1], "b"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    case 11: {
      if (argc != 2) throw JSError(rt, "rustra: emitDemo expects 2 raw argument(s), got " + std::to_string(argc));
      { int64_t value = rustra_i64(rt, argv[0], "ticks"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { int64_t value = rustra_i64(rt, argv[1], "stepDelayMs"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    case 17: {
      if (argc != 2) throw JSError(rt, "rustra: gauge expects 2 raw argument(s), got " + std::to_string(argc));
      slots[0] = rustra_u64(rt, argv[0], "limit");
      slots[1] = rustra_u64(rt, argv[1], "offset");
      return;
    }
    case 3: {
      if (argc != 1) throw JSError(rt, "rustra: isEven expects 1 raw argument(s), got " + std::to_string(argc));
      { int64_t value = rustra_i64(rt, argv[0], "n"); std::memcpy(&slots[0], &value, sizeof(value)); }
      return;
    }
    case 2: {
      if (argc != 2) throw JSError(rt, "rustra: multiply expects 2 raw argument(s), got " + std::to_string(argc));
      { double value = rustra_f64(rt, argv[0], "a"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { double value = rustra_f64(rt, argv[1], "b"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    case 22: {
      if (argc != 1) throw JSError(rt, "rustra: resourceClose expects 1 raw argument(s), got " + std::to_string(argc));
      slots[0] = rustra_u64(rt, argv[0], "handle");
      return;
    }
    case 13: {
      if (argc != 2) throw JSError(rt, "rustra: secureCompute expects 2 raw argument(s), got " + std::to_string(argc));
      { int64_t value = rustra_i64(rt, argv[0], "a"); std::memcpy(&slots[0], &value, sizeof(value)); }
      { int64_t value = rustra_i64(rt, argv[1], "b"); std::memcpy(&slots[1], &value, sizeof(value)); }
      return;
    }
    default: throw JSError(rt, "rustra: no raw input codec for cmd_id " + std::to_string(cmd_id));
  }
}

Value decode_raw_result(Runtime& rt, uint16_t cmd_id, uint64_t slot) {
  switch (cmd_id) {
    case 1: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 23: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value);
      return std::move(result);
    }
    case 4: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value);
      return std::move(result);
    }
    case 10: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 11: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "emitted"), value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 17: {
      Object result(rt);
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "next"), slot <= 9007199254740991ull ? jsi::Value(static_cast<double>(slot)) : jsi::Value(rt, jsi::BigInt::fromUint64(rt, slot)));
      return std::move(result);
    }
    case 3: {
      Object result(rt);
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "result"), slot != 0);
      return std::move(result);
    }
    case 2: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value);
      return std::move(result);
    }
    case 22: {
      Object result(rt);
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "closed"), slot != 0);
      return std::move(result);
    }
    case 13: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, jsi::PropNameID::forAscii(rt, "value"), value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    default: throw JSError(rt, "rustra: no raw result codec for cmd_id " + std::to_string(cmd_id));
  }
}

Value decode_raw_bound(Runtime& rt, const BoundCodecContext& context, uint64_t slot) {
  switch (context.commandId) {
    case 1: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 23: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value);
      return std::move(result);
    }
    case 4: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value);
      return std::move(result);
    }
    case 10: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 11: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    case 17: {
      Object result(rt);
      result.setProperty(rt, context.output[0], slot <= 9007199254740991ull ? jsi::Value(static_cast<double>(slot)) : jsi::Value(rt, jsi::BigInt::fromUint64(rt, slot)));
      return std::move(result);
    }
    case 3: {
      Object result(rt);
      result.setProperty(rt, context.output[0], slot != 0);
      return std::move(result);
    }
    case 2: {
      Object result(rt);
      double value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value);
      return std::move(result);
    }
    case 22: {
      Object result(rt);
      result.setProperty(rt, context.output[0], slot != 0);
      return std::move(result);
    }
    case 13: {
      Object result(rt);
      int64_t value; std::memcpy(&value, &slot, sizeof(value));
      result.setProperty(rt, context.output[0], value >= -9007199254740991ll && value <= 9007199254740991ll ? jsi::Value(static_cast<double>(value)) : jsi::Value(rt, jsi::BigInt::fromInt64(rt, value)));
      return std::move(result);
    }
    default: throw JSError(rt, "rustra: no bound raw result codec");
  }
}

} // namespace rustra::generated
