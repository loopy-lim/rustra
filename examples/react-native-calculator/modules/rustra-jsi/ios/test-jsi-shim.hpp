// test-jsi-shim.hpp — rustra-generated-codecs 컴파일/round-trip 테스트용 최소 JSI shim.
//
// 진짜 React jsi/jsi.h 가 아님. 디바이스(Xcode) 빌드와 무관하게 생성된 코덱이
// (1) 컴파일되고 (2) postcard 바이트가 Rust 와 일치하는지 검증하기 위한 독립 헤더.
// 생성된 코덱이 사용하는 API 표면(Runtime/Value/Object/Array/String)만 모킹.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace facebook::jsi {

class Runtime {};
class Object;
class Array;

class String {
public:
  String() = default;
  static String createFromUtf8(Runtime&, const uint8_t* data, size_t len) {
    return String(std::string(reinterpret_cast<const char*>(data), len));
  }
  std::string utf8(Runtime&) const { return s_; }

private:
  explicit String(std::string s) : s_(std::move(s)) {}
  std::string s_;
  friend class Value;
};

namespace detail {
struct ObjectData;
struct ArrayData;
} // namespace detail

class Value {
public:
  enum class Kind { Undefined, Number, Bool, String, Object, Array };

  Value() : kind_(Kind::Undefined) {}
  Value(double n) : kind_(Kind::Number), num_(n) {}
  Value(bool b) : kind_(Kind::Bool), bool_(b) {}

  Value(Runtime&, double n) : kind_(Kind::Number), num_(n) {}
  Value(Runtime&, bool b) : kind_(Kind::Bool), bool_(b) {}
  Value(Runtime&, const Object& o);
  Value(Runtime&, const Array& a);

  // Object/Array 는 shared_ptr 로 공유 — 복사/이동 모두 저렴.
  Value(const Object& o);
  Value(const Array& a);

  Kind kind() const { return kind_; }
  bool isObject() const { return kind_ == Kind::Object; }
  bool isUndefined() const { return kind_ == Kind::Undefined; }

  double asNumber() const {
    if (kind_ != Kind::Number) throw std::runtime_error("not a number");
    return num_;
  }
  bool getBool() const {
    if (kind_ != Kind::Bool) throw std::runtime_error("not a bool");
    return bool_;
  }
  String getString(Runtime&) const {
    if (kind_ != Kind::String) throw std::runtime_error("not a string");
    return str_;
  }
  String asString(Runtime& rt) const { return getString(rt); }
  class Object asObject(Runtime&) const;
  class Object getObject(Runtime&) const;

private:
  Kind kind_ = Kind::Undefined;
  double num_ = 0;
  bool bool_ = false;
  String str_;
  std::shared_ptr<detail::ObjectData> obj_;
  std::shared_ptr<detail::ArrayData> arr_;

  friend class Object;
  friend class Array;
};

namespace detail {
struct ObjectData {
  std::unordered_map<std::string, Value> props;
};
struct ArrayData {
  std::vector<Value> items;
};
} // namespace detail

class ArrayBuffer; // forward — Object::getArrayBuffer 반환형(정의는 아래)

class Object {
public:
  Object(Runtime&) : data_(std::make_shared<detail::ObjectData>()) {}
  Object() : data_(std::make_shared<detail::ObjectData>()) {}

  bool isArray(Runtime&) const { return static_cast<bool>(arr_); }
  class Array getArray(Runtime&) const;

  Value getProperty(Runtime& rt, const std::string& name) const {
    auto it = data_->props.find(name);
    if (it == data_->props.end()) return Value();
    return it->second;
  }
  // 생성된 코덱은 PropertyName 가 아닌 문자열 이름으로 접근한다.
  Value getProperty(Runtime& rt, const char* name) const {
    return getProperty(rt, std::string(name));
  }
  // 실 RN jsi 계약과 동일한 String 오버로드 — map 코덱이 std::string →
  // jsi::String 변환 후 접근한다.
  Value getProperty(Runtime& rt, const String& name) const {
    return getProperty(rt, name.utf8(rt));
  }

  void setProperty(Runtime&, const std::string& name, Value v) {
    data_->props[name] = std::move(v);
  }
  void setProperty(Runtime& rt, const std::string& name, double n) {
    setProperty(rt, name, Value(n));
  }
  void setProperty(Runtime& rt, const std::string& name, bool b) {
    setProperty(rt, name, Value(b));
  }
  void setProperty(Runtime& rt, const std::string& name, const String& s) {
    Value v; v.kind_ = Value::Kind::String; v.str_ = s; setProperty(rt, name, std::move(v));
  }
  void setProperty(Runtime& rt, const std::string& name, const Object& o) {
    setProperty(rt, name, Value(o));
  }
  void setProperty(Runtime& rt, const std::string& name, const Array& a);
  void setProperty(Runtime& rt, const char* name, Value v) { setProperty(rt, std::string(name), std::move(v)); }
  void setProperty(Runtime& rt, const char* name, double n) { setProperty(rt, std::string(name), n); }
  void setProperty(Runtime& rt, const char* name, bool b) { setProperty(rt, std::string(name), b); }
  void setProperty(Runtime& rt, const char* name, const String& s) { setProperty(rt, std::string(name), s); }
  void setProperty(Runtime& rt, const char* name, const Object& o) { setProperty(rt, std::string(name), o); }
  void setProperty(Runtime& rt, const char* name, const Array& a);

  // bytes 코덱 테스트용 — 정의는 클래스 외부(ArrayBuffer 정의 뒤).
  inline class ArrayBuffer getArrayBuffer(Runtime&) const;

  // 키 열거 — 실 RN jsi::Object::getPropertyNames 는 jsi::Array 를 반환한다.
  // 동일 계약으로 맞춘다(생성 코드는 색인 루프로 접근).
  Array getPropertyNames(Runtime& rt) const;

  std::shared_ptr<detail::ObjectData> data_;
  // JS 에서 Array 는 Object 의 일종. Value(Array) → asObject → getArray 경로 지원용.
  std::shared_ptr<detail::ArrayData> arr_;
};

class Array {
public:
  Array() : data_(std::make_shared<detail::ArrayData>()) {}
  Array(Runtime&, size_t n) : data_(std::make_shared<detail::ArrayData>()) {
    data_->items.resize(n);
  }

  size_t length(Runtime&) const { return data_->items.size(); }
  Value getValueAtIndex(Runtime&, size_t i) const { return data_->items[i]; }
  void setValueAtIndex(Runtime&, size_t i, Value v) { data_->items[i] = std::move(v); }
  void setValueAtIndex(Runtime& rt, size_t i, double n) { setValueAtIndex(rt, i, Value(n)); }
  void setValueAtIndex(Runtime& rt, size_t i, bool b) { setValueAtIndex(rt, i, Value(b)); }
  void setValueAtIndex(Runtime& rt, size_t i, const String& s) {
    Value v; v.kind_ = Value::Kind::String; v.str_ = s;
    setValueAtIndex(rt, i, std::move(v));
  }

  std::shared_ptr<detail::ArrayData> data_;
};

inline void Object::setProperty(Runtime& rt, const std::string& name, const Array& a) {
  setProperty(rt, name, Value(a));
}
inline Array Object::getPropertyNames(Runtime& rt) const {
  Array out(rt, data_->props.size());
  size_t i = 0;
  for (const auto& kv : data_->props) {
    // 키 자체를 문자열 값으로 — 실 RN 과 동일하게 이름 배열을 반환.
    String name = String::createFromUtf8(
        rt, reinterpret_cast<const uint8_t*>(kv.first.data()), kv.first.size());
    Value v; v.kind_ = Value::Kind::String; v.str_ = name;
    out.setValueAtIndex(rt, i++, std::move(v));
  }
  return out;
}
inline void Object::setProperty(Runtime& rt, const char* name, const Array& a) {
  setProperty(rt, std::string(name), a);
}
inline Array Object::getArray(Runtime&) const {
  Array a;
  a.data_ = arr_;
  return a;
}

inline Value::Value(const Object& o) : kind_(Kind::Object), obj_(o.data_), arr_(o.arr_) {}

/// ArrayBuffer 최소 구현 — bytes(Vec<u8>) 코덱의 JS 표면. 실 RN 런타임은
/// jsi::ArrayBuffer 를 제공한다(동일 data(rt)/length(rt) 계약).
class ArrayBuffer {
public:
  ArrayBuffer() = default;
  explicit ArrayBuffer(Runtime&, size_t n) : bytes_(n) {}
  uint8_t* data(Runtime&) { return bytes_.data(); }
  const uint8_t* data(Runtime&) const { return bytes_.data(); }
  size_t length(Runtime&) const { return bytes_.size(); }

private:
  std::vector<uint8_t> bytes_;
};

inline ArrayBuffer Object::getArrayBuffer(Runtime&) const { return ArrayBuffer(); }
inline Value::Value(const Array& a) : kind_(Kind::Array), arr_(a.data_) {}
inline Value::Value(Runtime&, const Object& o) : kind_(Kind::Object), obj_(o.data_), arr_(o.arr_) {}
inline Value::Value(Runtime&, const Array& a) : kind_(Kind::Array), arr_(a.data_) {}
inline Object Value::asObject(Runtime&) const {
  // JS 에서 Array 는 Object — Array 값도 Object 핸들로 꺼낸 뒤 getArray 로 재해석.
  if (kind_ == Kind::Array) {
    Object o;
    o.arr_ = arr_;
    return o;
  }
  if (kind_ != Kind::Object) throw std::runtime_error("not an object");
  Object o;
  o.data_ = obj_;
  o.arr_ = arr_;
  return o;
}
inline Object Value::getObject(Runtime& rt) const { return asObject(rt); }

/// RN jsi::JSError 의 최소 대체 — 생성된 코덱이 throw JSError(rt, msg) 로 사용.
class JSError : public std::runtime_error {
public:
  JSError(Runtime&, std::string msg) : std::runtime_error(std::move(msg)) {}
};

} // namespace facebook::jsi

// RN 의 실제 jsi/jsi.h 와 동일 — jsi::Foo 한정자가 동작하도록 별칭 제공.
namespace jsi = facebook::jsi;
