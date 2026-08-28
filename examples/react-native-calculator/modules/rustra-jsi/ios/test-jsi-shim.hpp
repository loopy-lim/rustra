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

class Runtime;
class Function;
class BigInt {
public:
  static BigInt fromInt64(Runtime&, int64_t v) { return BigInt(v); }
  static BigInt fromUint64(Runtime&, uint64_t v) { return BigInt(static_cast<int64_t>(v)); }

  int64_t asInt64(Runtime&) const { return v_; }
  uint64_t asUint64(Runtime&) const { return static_cast<uint64_t>(v_); }

private:
  explicit BigInt(int64_t v) : v_(v) {}
  BigInt() = default;
  int64_t v_ = 0;
  friend class Value;
};

class Runtime {
public:
  /// 실제 jsi::Runtime 팩토리 미러 — B1 bigint 디코드가 생성 코드에서 호출.
  /// shim 은 raw 64비트를 그대로 보관한다(임의 정밀 불요).
  virtual ~Runtime() = default;
  BigInt createBigIntFromInt64(int64_t v) { return BigInt::fromInt64(*this, v); }
  BigInt createBigIntFromUint64(uint64_t v) { return BigInt::fromUint64(*this, v); }

  /// 실제 jsi::Runtime::global() 미러 — B2 Set 직결이 전역 Set/Array 생성자
  /// 조회에 사용한다. 정의는 파일 말미(Function/Object 완성 후).
  class Object global();
};
class Object;
class Array;

// PropNameID — 실 RN jsi 계약의 최소 표면. 생성 코덱의 cachedProp 캐시가
// 쓴다. shim 에서는 이름 문자열을 그대로 들고 있다(비교/조회는 이름 기반).
class PropNameID {
public:
  static PropNameID forAscii(Runtime&, const std::string& name) {
    return PropNameID{name};
  }
  const std::string& utf8(Runtime&) const { return name_; }

private:
  std::string name_;
  explicit PropNameID(std::string name) : name_(std::move(name)) {}
};

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
struct FunctionData;
} // namespace detail

class Value {
public:
  enum class Kind { Undefined, Null, Number, Bool, BigInt, String, Object, Array };

  Value() : kind_(Kind::Undefined) {}
  Value(double n) : kind_(Kind::Number), num_(n) {}
  Value(bool b) : kind_(Kind::Bool), bool_(b) {}

  /// 실제 jsi::Value::null() 정적 팩토리 미러 — 생성 코드의 Option<T> 디코드
  /// (태그 0 → null) emit 이 호출한다. kind Null 을 별도로 둔다.
  static Value null() {
    Value v;
    v.kind_ = Kind::Null;
    return v;
  }
  bool isNull() const { return kind_ == Kind::Null; }

  Value(Runtime&, double n) : kind_(Kind::Number), num_(n) {}
  Value(Runtime&, bool b) : kind_(Kind::Bool), bool_(b) {}
  /// 실제 jsi::Value(Runtime&, const BigInt&) 미러 — B1 bigint 디코드 경로.
  Value(Runtime&, const BigInt& b) : kind_(Kind::BigInt), big_(b) {}
  Value(const String& s) : kind_(Kind::String), str_(s) {}
  Value(String&& s) : kind_(Kind::String), str_(std::move(s)) {}
  Value(Runtime&, const String& s) : kind_(Kind::String), str_(s) {}
  Value(Runtime&, const Object& o);
  Value(Runtime&, const Array& a);

  // Object/Array 는 shared_ptr 로 공유 — 복사/이동 모두 저렴.
  Value(const Object& o);
  Value(const Array& a);
  Value(const Function& o);

  Kind kind() const { return kind_; }
  // In real JSI, Array is an Object value as well; generated complex array
  // encoders rely on that relationship before calling asObject().
  bool isObject() const { return kind_ == Kind::Object || kind_ == Kind::Array; }
  bool isNumber() const { return kind_ == Kind::Number; }
  bool isBool() const { return kind_ == Kind::Bool; }
  bool isBigInt() const { return kind_ == Kind::BigInt; }
  bool isString() const { return kind_ == Kind::String; }
  bool isUndefined() const { return kind_ == Kind::Undefined; }

  BigInt asBigInt(Runtime&) const {
    if (kind_ != Kind::BigInt) throw std::runtime_error("not a bigint");
    return big_;
  }

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
  class Function asFunction(Runtime&) const;
  bool isFunction() const { return kind_ == Kind::Object && fn_ != nullptr; }

private:
  Kind kind_ = Kind::Undefined;
  double num_ = 0;
  bool bool_ = false;
  BigInt big_;
  String str_;
  std::shared_ptr<detail::ObjectData> obj_;
  std::shared_ptr<detail::ArrayData> arr_;
  std::shared_ptr<detail::FunctionData> fn_;

  friend class Object;
  friend class Array;
  friend class Function;
  friend bool valueEquals(Runtime&, const Value&, const Value&);
};

namespace detail {
struct ObjectData {
  std::unordered_map<std::string, Value> props;
  std::shared_ptr<std::vector<uint8_t>> bytes;
};
struct ArrayData {
  std::vector<Value> items;
};
struct FunctionData {
  // shim 함수는 이름으로 식별한다(Set/Array.from 등 전역 빌트인 흉내).
  std::string name;
};
} // namespace detail

class ArrayBuffer; // forward — Object::getArrayBuffer 반환형(정의는 아래)

class Object {
public:
  Object(Runtime&) : data_(std::make_shared<detail::ObjectData>()) {}
  Object() : data_(std::make_shared<detail::ObjectData>()) {}
  Object(Runtime&, const ArrayBuffer& buffer);

  // B2: 실 jsi 계약 — o instanceof ctor / getPropertyAsFunction.
  bool instanceOf(Runtime&, const class Function& ctor) const;
  class Function getPropertyAsFunction(Runtime&, const char* name) const;

  bool isArray(Runtime&) const { return static_cast<bool>(arr_); }
  bool isArrayBuffer(Runtime&) const { return static_cast<bool>(data_->bytes); }
  class Array getArray(Runtime&) const;

  Value getProperty(Runtime&, const std::string& name) const {
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
  void setProperty(Runtime& rt, const String& name, Value v) {
    setProperty(rt, name.utf8(rt), std::move(v));
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
  // PropNameID 오버로드 — cachedProp 경로(생성 코덱 decode 핫패스).
  void setProperty(Runtime& rt, const PropNameID& pid, Value v) {
    setProperty(rt, pid.utf8(rt), std::move(v));
  }
  void setProperty(Runtime& rt, const PropNameID& pid, double n) {
    setProperty(rt, pid.utf8(rt), n);
  }
  void setProperty(Runtime& rt, const PropNameID& pid, bool b) {
    setProperty(rt, pid.utf8(rt), b);
  }
  void setProperty(Runtime& rt, const PropNameID& pid, const String& s) {
    setProperty(rt, pid.utf8(rt), s);
  }
  void setProperty(Runtime& rt, const PropNameID& pid, const Object& o) {
    setProperty(rt, pid.utf8(rt), o);
  }
  void setProperty(Runtime& rt, const PropNameID& pid, const Array& a);

  // bytes 코덱 테스트용 — 정의는 클래스 외부(ArrayBuffer 정의 뒤).
  inline class ArrayBuffer getArrayBuffer(Runtime&) const;

  // 키 열거 — 실 RN jsi::Object::getPropertyNames 는 jsi::Array 를 반환한다.
  // 동일 계약으로 맞춘다(생성 코드는 색인 루프로 접근).
  Array getPropertyNames(Runtime& rt) const;

  std::shared_ptr<detail::ObjectData> data_;
  // JS 에서 Array 는 Object 의 일종. Value(Array) → asObject → getArray 경로 지원용.
  std::shared_ptr<detail::ArrayData> arr_;
  // B2: Function 도 Object 의 일종(JS 계약). getPropertyAsFunction 이
  // Function 을 Object 슬롯에 넣으므로 asObject 재해석을 위해 필요하다.
  std::shared_ptr<detail::FunctionData> fn_;
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

// B2: 최소 Function — 전역 빌트인(Set, Array.from) 조회와 callAsConstructor /
// callAsFunction 만 흉내낸다. Set 생성자는 인자 배열을 그대로 소자로 하는
// Set-like Object(size 포함)를 만들고, Array.from 은 유사 배열 객체를 Array 로
// 복사한다 — 실 JS 시맨틱의 테스트에 필요한 부분집합.
class Function : public Object {
public:
  Function() : Object() {}
  explicit Function(std::string name)
      : Object(), fdata_(std::make_shared<detail::FunctionData>()) {
    fdata_->name = std::move(name);
  }
  /// Object 슬롯에서 Function 재해석 — fn_ 공유 데이터만 이동한다.
  explicit Function(const Object& o) : Object(o), fdata_(o.fn_) {}

  Value callAsConstructor(Runtime& rt, const Value* args, size_t count) const;
  // 실제 jsi 계약과 동일한 시그니처(Function::call) — callAsFunction 은 실제
  // jsi 에 존재하지 않는다.
  Value call(Runtime& rt, const Value* args, size_t count) const;
  Value call(Runtime& rt, std::initializer_list<Value> args) const {
    return call(rt, args.begin(), args.size());
  }

  const std::string& name(Runtime&) const { return fdata_->name; }
  std::shared_ptr<detail::FunctionData> fdata_;
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
inline void Object::setProperty(Runtime& rt, const PropNameID& pid, const Array& a) {
  setProperty(rt, pid.utf8(rt), a);
}
inline Array Object::getArray(Runtime&) const {
  Array a;
  a.data_ = arr_;
  return a;
}

// B2: 실 jsi 계약 — o instanceof ctor. shim 은 프로토타입 체인이 없으므로
// Set 판별은 Set 생성자가 심은 __isSet 마커 프로퍼티로 대체한다.
inline bool Object::instanceOf(Runtime& rt, const Function& ctor) const {
  if (ctor.fdata_ && ctor.fdata_->name == "Set") {
    Value marker = getProperty(rt, "__isSet");
    return marker.isBool() && marker.getBool();
  }
  return false;
}

// B2: 실 jsi 계약 — global() 오브젝트에서 함수 프로퍼티를 Function 으로 조회.
inline Function Object::getPropertyAsFunction(Runtime& rt, const char* name) const {
  Value v = getProperty(rt, std::string(name));
  if (v.kind() == Value::Kind::Object || v.kind() == Value::Kind::Array) {
    Object o = v.asObject(rt);
    if (o.fn_) return Function(o);
  }
  throw std::runtime_error(std::string("global function not found: ") + name);
}

inline Function Value::asFunction(Runtime& rt) const {
  Object o = asObject(rt);
  if (!o.fn_) throw std::runtime_error("not a function");
  return Function(o);
}

inline Value::Value(const Object& o)
    : kind_(Kind::Object), obj_(o.data_), arr_(o.arr_), fn_(o.fn_) {}
inline Value::Value(const Function& f)
    : kind_(Kind::Object), obj_(f.data_), arr_(f.arr_), fn_(f.fdata_) {}

/// ArrayBuffer 최소 구현 — bytes(Vec<u8>) 코덱의 JS 표면. 실 RN 런타임은
/// jsi::ArrayBuffer 를 제공한다(동일 data(rt)/length(rt) 계약).
class ArrayBuffer {
public:
  ArrayBuffer() : bytes_(std::make_shared<std::vector<uint8_t>>()) {}
  explicit ArrayBuffer(Runtime&, size_t n)
      : bytes_(std::make_shared<std::vector<uint8_t>>(n)) {}
  uint8_t* data(Runtime&) { return bytes_->data(); }
  const uint8_t* data(Runtime&) const { return bytes_->data(); }
  size_t length(Runtime&) const { return bytes_->size(); }
  size_t size(Runtime&) const { return bytes_->size(); }

private:
  explicit ArrayBuffer(std::shared_ptr<std::vector<uint8_t>> bytes)
      : bytes_(std::move(bytes)) {}
  std::shared_ptr<std::vector<uint8_t>> bytes_;
  friend class Object;
};

inline Object::Object(Runtime&, const ArrayBuffer& buffer)
    : data_(std::make_shared<detail::ObjectData>()) {
  data_->bytes = buffer.bytes_;
}
inline ArrayBuffer Object::getArrayBuffer(Runtime&) const {
  return data_->bytes ? ArrayBuffer(data_->bytes) : ArrayBuffer();
}
inline Value::Value(const Array& a) : kind_(Kind::Array), arr_(a.data_) {}
inline Value::Value(Runtime&, const Object& o)
    : kind_(Kind::Object), obj_(o.data_), arr_(o.arr_), fn_(o.fn_) {}
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
  o.fn_ = fn_;
  return o;
}
inline Object Value::getObject(Runtime& rt) const { return asObject(rt); }

/// RN jsi::JSError 의 최소 대체 — 생성된 코덱이 throw JSError(rt, msg) 로 사용.
class JSError : public std::runtime_error {
public:
  JSError(Runtime&, std::string msg) : std::runtime_error(std::move(msg)) {}
};

// ── B2: 전역 빌트인(Set / Array.from) shim ─────────────────────
// 생성된 코덱의 Set 직결 경로가 rt.global().getPropertyAsFunction 로 조회하는
// 전역 생성자를 여기서 채운다. shim 의 "Set" 객체는 __items 배열 + size 프로퍼티를
// 가진 Set-like Object 이고, Array.from 은 그 __items 를 이터레이션 순서 그대로
// 복사한다 — 실 JS 시맨틱 중 코덱이 쓰는 부분집합만 재현한다.
// SameValue 근사 — Set 중복 제거용(Number/Bool/String/BigInt 비교; 객체는
// 참조 동일성). 테스트가 다루는 원소 종류만 커버하면 충분하다.
inline bool valueEquals(Runtime& rt, const Value& a, const Value& b) {
  if (a.kind() != b.kind()) {
    // number/bigint 는 절대 동일하지 않다 — shim kind 기반 비교가 그 계약과
    // 일치한다(+0/-0 은 Number 비교에서 동일).
    return false;
  }
  switch (a.kind()) {
    case Value::Kind::Number:
      return a.asNumber() == b.asNumber();
    case Value::Kind::Bool:
      return a.getBool() == b.getBool();
    case Value::Kind::String:
      return a.getString(rt).utf8(rt) == b.getString(rt).utf8(rt);
    case Value::Kind::BigInt:
      return a.asBigInt(rt).asInt64(rt) == b.asBigInt(rt).asInt64(rt);
    case Value::Kind::Object:
    case Value::Kind::Array:
      return a.obj_.get() == b.obj_.get() && a.arr_.get() == b.arr_.get();
    default:
      return true;
  }
}

namespace detail {
inline Object makeSetLike(Runtime& rt, const Value* args, size_t count) {
  Object setObj(rt);
  Array items(rt, count);
  for (size_t i = 0; i < count; i++) items.setValueAtIndex(rt, i, args[i]);
  setObj.setProperty(rt, "__items", items);
  setObj.setProperty(rt, "size", static_cast<double>(count));
  setObj.setProperty(rt, "__isSet", true);
  return setObj;
}

} // namespace detail

inline Value Function::callAsConstructor(Runtime& rt, const Value* args, size_t count) const {
  if (fdata_->name == "Set") {
    // new Set(array) — 인자 1개는 소자 배열(또는 유사 배열).
    if (count == 1 && args[0].isObject() && args[0].asObject(rt).isArray(rt)) {
      // 실제 Set 시맨틱 미러 — 소자 중복 제거(테스트 규모라 O(n²) 비교로 충분).
      Array src = args[0].asObject(rt).getArray(rt);
      std::vector<Value> uniq;
      for (size_t i = 0; i < src.length(rt); i++) {
        Value v = src.getValueAtIndex(rt, i);
        bool dup = false;
        for (const auto& seen : uniq) {
          if (valueEquals(rt, seen, v)) { dup = true; break; }
        }
        if (!dup) uniq.push_back(std::move(v));
      }
      Object setObj = detail::makeSetLike(rt, uniq.data(), uniq.size());
      return Value(rt, setObj);
    }
    // (빈 Set 경로 — makeSetLike 가 __isSet 마커를 심는다)
    return Value(rt, detail::makeSetLike(rt, args, count));
  }
  throw std::runtime_error("shim callAsConstructor: unsupported ctor " + fdata_->name);
}

inline Value Function::call(Runtime& rt, const Value* args, size_t count) const {
  if (fdata_->name == "Array.from") {
    // Array.from(setLike) — __items 배열을 이터레이션 순서 그대로 복사.
    if (count != 1 || !args[0].isObject()) throw std::runtime_error("Array.from: 1 object arg");
    Object src = args[0].asObject(rt);
    Value items = src.getProperty(rt, "__items");
    if (items.isObject() && items.asObject(rt).isArray(rt)) return items;
    if (src.isArray(rt)) return args[0];
    throw std::runtime_error("Array.from: not a set-like");
  }
  throw std::runtime_error("shim Function::call: unsupported function " + fdata_->name);
}

inline Object Runtime::global() {
  // shim 의 setProperty/propName 은 Runtime& 를 무시하므로 임시 인스턴스로 충분.
  Runtime self;
  Object g;
  Function set("Set");
  g.setProperty(self, std::string("Set"), Value(set));
  // Array.from — 생성된 코덱이 global().getPropertyAsFunction("Array")
  //   .getPropertyAsFunction("from") 체인으로 조회한다.
  Function arrayCtor("Array");
  Function arrayFrom("Array.from");
  arrayCtor.setProperty(self, std::string("from"), Value(arrayFrom));
  g.setProperty(self, std::string("Array"), Value(arrayCtor));
  return g;
}

} // namespace facebook::jsi

// RN 의 실제 jsi/jsi.h 와 동일 — jsi::Foo 한정자가 동작하도록 별칭 제공.
namespace jsi = facebook::jsi;
