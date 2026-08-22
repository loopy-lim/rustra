#include "RustraJSIBridge.hpp"
#include "rustra-generated-codecs.hpp"
#include <cstdio>
#include <cstring>
#include <jsi/jsi.h>
#include <optional>

// CallInvoker 는 순수 C++ 헤더(ReactCommon/callinvoker)다 — iOS/Android 모두
// 동일 경로로 제공된다. 플랫폼 글루(.mm / jni.cpp) 가 invoker 를 얻어
// type-erase 해 전달하므로 이 파일은 플랫폼 헤더에 의존하지 않는다.
#if defined(__APPLE__)
#include <ReactCommon/CallInvoker.h>
#elif defined(__ANDROID__)
#include <ReactCommon/CallInvoker.h>
#endif

namespace rustra {

using namespace facebook::jsi;
namespace gen = rustra::generated;
namespace rc = rustra::codec;

// ── ArrayBuffer helpers ────────────────────────────────────

/// ArrayBuffer 생성자 캐시 — 첫 호출 시 1회 조회, 이후 재사용.
/// jsi::Function 은 move-only 이므로 optional 에 move 저장한다.
/// RN reload 로 Runtime 이 교체되면 installRustraJSIWithInvoker 가
/// 재호출되므로 그 시점에 reset 한다 — 구 Runtime 소유 핸들이
/// dangling 되지 않게 (아래 Install 절).
/// 스레드 계약: JS 스레드에서만 접근 — host 함수와 install 모두 JS 스레드에서 실행.
static std::optional<Function> g_arrayBufferCtor;

static Function& arrayBufferCtor(Runtime& rt) {
  if (!g_arrayBufferCtor) {
    g_arrayBufferCtor = rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
  }
  return *g_arrayBufferCtor;
}

static Value createArrayBuffer(Runtime& rt, const uint8_t* data, size_t size) {
  Object ab = arrayBufferCtor(rt).callAsConstructor(rt, static_cast<double>(size))
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
    // 클램프 — JS 가 건네는 byteOffset/byteLength 는 임의 값일 수 있다
    // (duck-typed 객체 통과). buf 범위 밖이면 네이티브 힙 OOB 읽기가 되므로
    // 명시적 에러로 거부한다. NaN/음수도 여기서 걸러진다.
    auto offsetProp = obj.getProperty(rt, "byteOffset");
    auto lengthProp = obj.getProperty(rt, "byteLength");
    if (!offsetProp.isNumber() || !lengthProp.isNumber()) {
      throw JSError(rt, "RustraJSI: byteOffset/byteLength must be numbers");
    }
    double offsetNum = offsetProp.asNumber();
    double lengthNum = lengthProp.asNumber();
    if (!(offsetNum >= 0.0) || !(lengthNum >= 0.0)) { // NaN 도 거부
      throw JSError(rt, "RustraJSI: invalid byteOffset/byteLength (negative or NaN)");
    }
    size_t bufSize = buf.size(rt);
    if (offsetNum > static_cast<double>(bufSize) ||
        lengthNum > static_cast<double>(bufSize) - offsetNum) {
      throw JSError(rt, "RustraJSI: byteOffset/byteLength out of buffer bounds");
    }
    auto byteOffset = static_cast<size_t>(offsetNum);
    auto byteLength = static_cast<size_t>(lengthNum);
    return {buf.data(rt) + byteOffset, byteLength};
  }

  throw JSError(rt, "RustraJSI: expected ArrayBuffer or TypedArray");
}

// ── rkyv V2 에러 와이어 파싱 ────────────────────────────────
// 에러 프레임: [ok:0][pad to @8][err_len u16 LE @8][postcard{code,message} @10]
// postcard 파싱 실패 시 원시 바이트로 폴백한다(계약: 실패해도 throw 아님).
// malformed(out_len < 10) 검사는 호출부에서 이미 완료했음을 전제로 한다.
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

// ── typed invoke 공통 tail ──────────────────────────────────
// invokeTyped / invokeTypedById / invokeTypedBatch(ById) 의 FFI 이후 꼬리:
// dispatch → 헤더 분기(null / empty / ok=0 에러 / malformed) → (성공 시)
// decoder → free. encode/decode 진입(by name / by id)만 호출부에서 다르다.
// decoder 는 성공 응답 바디(Reader)를 JS Value 로 변환한다.
// 에러면 JSError throw — 기존 세 경로의 메시지 텍스트를 그대로 보존한다:
//   - tailSuffix: malformed 계열(empty/error/success) 접미 — 단건 "", 배치 " (batch)".
//   - batchItemName: 이름 기반 배치 루프의 항목 이름. FFI null 접미
//     " (batch item <name>)" 조립에만 쓴다(에러 시 1회 조립 — hot path 비용 0).
//     nullptr 면 null 접미로 tailSuffix 를 쓴다(단건/byId 배치).
// free 짝 계약: (Tier 1) typedInvokeTail 은 caller-buffer 변형
// (rustra_ffi_invoke_rkyv_v2_into) 을 쓴다 — Rust 가 응답을 할당하지 않고
// 스택 버퍼에 직접 기록하므로 free 짝이 필요 없다(malloc→memcpy→free 제거).
// probe→write 2단계 사이 핸들러는 코어 probe 캐시로 정확히 1회 실행된다.
// 스택 버퍼가 부족한 대형 응답만 기존 alloc 경로(rustra_calculator_invoke_rkyv_v2 +
// free_rkyv_v2_buffer)로 폴백한다.
template <typename Decode>
static Value typedInvokeTail(Runtime& rt, const std::vector<uint8_t>& req,
                             const char* tailSuffix, Decode decode,
                             const std::string* batchItemName = nullptr) {
  // (Tier 1) 고정 스택 버퍼 — 대부분의 응답(숫자/작은 객체)이 여기에 들어온다.
  // 부족하면 아래 폴백 경로가 처리하므로 안전하다.
  constexpr size_t kStackCap = 512;
  uint8_t stackBuf[kStackCap];
  size_t out_len = 0;
  const uint8_t* resp = nullptr;
  bool heapResp = false;

  // 1단계: size-probe(buf=null) — 필요 크기만 얻는다(핸들러 실행 포함, 코어
  // thread_local 캐시에 저장 — 다음 write 단계는 dispatch 없이 같은 바이트).
  size_t needed = 0;
  size_t probe = rustra_ffi_invoke_rkyv_v2_into(
    req.data(), req.size(), nullptr, 0, &needed);
  (void)probe; // probe 단계 반환값은 항상 0
  if (needed > 0 && needed <= kStackCap) {
    // 2단계: 스택 버퍼에 직접 기록 — 코어 캐시 히트로 핸들러 재실행 없음.
    size_t n = rustra_ffi_invoke_rkyv_v2_into(
      req.data(), req.size(), stackBuf, kStackCap, &out_len);
    if (n != SIZE_MAX && n > 0) {
      resp = stackBuf;
    }
  }
  if (!resp && needed > kStackCap) {
    // 스택 버퍼 부족 — alloc 경로로 폴백(대형 응답). 이 경로는 probe 캐시를
    // 소진했으므로 dispatch 가 1회 더 실행될 수 있다(비멱등 핸들러의 큰 응답).
    // 대형 응답에서 1회 추가 실행은 alloc 절약과의 트레이드오프다 — 향후
    // 재사용 힙 버퍼로 제거 가능(별도 최적화).
    resp = rustra_calculator_invoke_rkyv_v2(req.data(), req.size(), &out_len);
    heapResp = true;
  }
  if (!resp) {
    std::string nullSuffix(tailSuffix);
    if (batchItemName) nullSuffix = " (batch item " + *batchItemName + ")";
    throw JSError(rt, "RustraJSI: invokeRkyvV2 returned null" + nullSuffix);
  }
  if (out_len < 1) {
    if (heapResp) rustra_calculator_free_rkyv_v2_buffer(const_cast<uint8_t*>(resp), out_len);
    throw JSError(rt, std::string("RustraJSI: empty rkyv v2 response") + tailSuffix);
  }
  if (resp[0] == 0) {
    // 에러 와이어: [ok:0][pad to @8][err_len u16 LE @8][err @10]
    if (out_len < 10) {
      if (heapResp) rustra_calculator_free_rkyv_v2_buffer(const_cast<uint8_t*>(resp), out_len);
      throw JSError(rt, std::string("RustraJSI: malformed error response") + tailSuffix);
    }
    std::string errStr = parseRkyvV2ErrorBody(resp, out_len);
    if (heapResp) rustra_calculator_free_rkyv_v2_buffer(const_cast<uint8_t*>(resp), out_len);
    throw JSError(rt, errStr);
  }

  // 성공: postcard(O) @8 부터 디코딩.
  if (out_len < 8) {
    if (heapResp) rustra_calculator_free_rkyv_v2_buffer(const_cast<uint8_t*>(resp), out_len);
    throw JSError(rt, std::string("RustraJSI: malformed success response") + tailSuffix);
  }
  rc::Reader r(resp + 8, out_len - 8);
  Value result = decode(r);
  // 스택 버퍼 경로는 free 불필요(할당 자체가 없다). 대형 응답 폴백만 해제.
  if (heapResp) rustra_calculator_free_rkyv_v2_buffer(const_cast<uint8_t*>(resp), out_len);
  return result;
}

// ── EventDispatcher: Rust → JS push delivery ───────────────
//
// 스레드 마샬링 설계:
//   emitting 스레드(FFI 콜백)          JS 런타임 스레드
//   ────────────────────────────      ─────────────────────────────
//   onRustEvent()                       CallInvoker::invokeAsync
//     lock → queue.push_back             → drain(rt)
//     (drop-oldest if full)                lock → swap queue out
//     invokeAsync(drain) 예약              for each event:
//   ── never touches JS objects ─           listeners_[name].call(payload)
//
// CallInvoker 가 없으면(테스트/폴백) JS 가 drainEvents() 를 폴링 호출해
// 동일한 drain 을 수동으로 실행한다. 두 경로는 같은 drain_scheduled_ 플래그로
// 중복 실행을 막는다.

/// 전역 디스패처 — installRustraJSI 가 생성, 프로세스당 하나.
/// HostObject 와 별개로 살아있어야 FFI 콜백(HostObject 생명주기 밖) 이
/// 안전하게 참조할 수 있다.
static std::shared_ptr<EventDispatcher> g_eventDispatcher = nullptr;
static std::mutex g_dispatcherMutex;

static std::shared_ptr<EventDispatcher> getEventDispatcher() {
  std::lock_guard<std::mutex> lock(g_dispatcherMutex);
  if (!g_eventDispatcher) {
    g_eventDispatcher = std::make_shared<EventDispatcher>();
  }
  return g_eventDispatcher;
}

void EventDispatcher::setCallInvoker(std::shared_ptr<void> invoker) {
  std::lock_guard<std::mutex> lock(mutex_);
  callInvoker_ = std::move(invoker);
  // RN 리로드 대응: install 은 새 Runtime 의 JS 스레드에서 매번 실행되므로
  // 이전 Runtime 소유의 jsi::Function 리스너를 여기서 비운다(방치 시 UAF).
  // 큐의 잔여 이벤트도 이전 런타임 대상이므로 함께 폐기한다.
  // 단, mutex_ 를 잡은 채 FFI unregister 를 호출하면 onRustEvent 가 같은
  // 락을 잡으려 해 교착할 수 있으므로 해제는 락 밖에서.
  const bool hadListeners = !listeners_.empty();
  listeners_.clear();
  queue_.clear();
  if (hadListeners) {
    // 리스너가 있던 상태로 리로드된 경우 싱크를 해제해 둔다 — 새 번들이
    // setListener 로 다시 등록하면 그때 재설치된다.
    rustra_ffi_event_sink_unregister();
  }
}

void EventDispatcher::setListener(facebook::jsi::Runtime& rt,
                                   const std::string& name,
                                   facebook::jsi::Function callback) {
  // JS 스레드에서만 호출됨(HostFunction 경유) — listeners_ 락 없이 접근.
  // jsi::Function 은 default-constructible 하지 않으므로 insert_or_assign 사용
  // (operator[] 는 기본 생성을 요구한다).
  bool wasEmpty = listeners_.empty();
  listeners_.insert_or_assign(name, std::move(callback));
  // 첫 리스너 등록 시 FFI 싱크를 설치한다(폴링 경로 → 푸시 전환).
  if (wasEmpty) {
    rustra_ffi_event_sink_register(&EventDispatcher::onRustEvent, this);
  }
}

void EventDispatcher::removeListener(const std::string& name) {
  listeners_.erase(name);
  // 마지막 리스너 제거 시 FFI 싱크 해제(푸시 → 폴링 복귀).
  if (listeners_.empty()) {
    rustra_ffi_event_sink_unregister();
  }
}

void EventDispatcher::onRustEvent(void* user_data, const char* name,
                                   const char* payload) {
  auto* self = static_cast<EventDispatcher*>(user_data);
  if (!self || !name || !payload) return;

  std::lock_guard<std::mutex> lock(self->mutex_);
  if (self->queue_.size() >= self->capacity_) {
    self->queue_.pop_front();
    ++self->dropped_;
  }
  self->queue_.emplace_back(name, payload);
  self->scheduleDrainLocked();
}

void EventDispatcher::scheduleDrainLocked() {
  // 락을 잡은 상태에서 호출됨. CallInvoker 가 있으면 drain 을 JS 스레드로
  // 예약한다 — invokeAsync 자체는 스레드 안전하다.
  if (drainScheduled_ || !callInvoker_) return;
  drainScheduled_ = true;

  auto self = shared_from_this();
  std::shared_ptr<void> invoker = callInvoker_;
  auto weak = std::weak_ptr<EventDispatcher>(self);
#if defined(__APPLE__) || defined(__ANDROID__)
  auto* nativeInvoker = static_cast<facebook::react::CallInvoker*>(invoker.get());
  nativeInvoker->invokeAsync([weak](facebook::jsi::Runtime& rt) {
    if (auto dispatcher = weak.lock()) {
      dispatcher->drain(rt);
    }
  });
#endif
}

void EventDispatcher::drain(facebook::jsi::Runtime& rt) {
  // JS 런타임 스레드에서만 호출된다(CallInvoker 콜백 또는 drainEvents()).
  std::deque<std::pair<std::string, std::string>> events;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    drainScheduled_ = false;
    events.swap(queue_);
  }

  for (auto& [name, payload] : events) {
    auto it = listeners_.find(name);
    if (it == listeners_.end()) continue;
    try {
      // 페이로드는 JSON 문자열 그대로 JS 로 — 파싱은 TS 래퍼에서 1회.
      // (JSI 경계를 넘기는 비용 < C++ 에서 JSON 파서를 두는 비용)
      it->second.call(rt, facebook::jsi::String::createFromUtf8(
        rt, reinterpret_cast<const uint8_t*>(payload.data()), payload.size()));
    } catch (const facebook::jsi::JSError& e) {
      // JS 콜백이 throw 해도 drain 은 계속한다 — 나머지 이벤트가 유실되지
      // 않게 한다(Rust 싱크의 패닉 격리 정책과 대칭).
      fprintf(stderr, "RustraJSI: event listener for '%s' threw: %s\n",
              name.c_str(), e.getMessage().c_str());
    }
  }
}

size_t EventDispatcher::pendingCount() {
  std::lock_guard<std::mutex> lock(mutex_);
  return queue_.size();
}

// enable_shared_from_this — scheduleDrainLocked 가 안전하게 self 를 캡처.
// (클래스 정의는 헤더에 있으므로 여기는 static_assert 로 계약 문서화)
static_assert(sizeof(EventDispatcher) > 0, "EventDispatcher must be complete");

// ── ChannelDispatcher: 채널 핸들별 유니캐스트 회신 (타입 패리티 2단계) ──
//
// EventDispatcher 와 동일한 마샬링 구조다 — FFI 콜백(send 스레드)은 큐에
// 적재만, JS 스레드 drain 이 callbacks_[handle] 호출. 차이점:
// - 콜백 레지스트리 키가 이벤트 이름(브로드캐스트)이 아니라 핸들(유니캐스트).
// - reset() 시 Rust 채널도 함께 drop — 채널은 호출 귀속이라 리로드된
//   런타임의 핸들은 무의미하다(이벤트 리스너와 달리 재등록되지 않는다).

static std::shared_ptr<ChannelDispatcher> g_channelDispatcher = nullptr;
static std::mutex g_channelDispatcherMutex;

static std::shared_ptr<ChannelDispatcher> getChannelDispatcher() {
  std::lock_guard<std::mutex> lock(g_channelDispatcherMutex);
  if (!g_channelDispatcher) {
    g_channelDispatcher = std::make_shared<ChannelDispatcher>();
  }
  return g_channelDispatcher;
}

void ChannelDispatcher::setCallInvoker(std::shared_ptr<void> invoker) {
  // mutex_ 없이 콜백 맵 정리(레지스트리는 JS 스레드 전용) 후 락 내부에서
  // invoker 교체·채널 drop. drop 이 FFI 를 호출하므로 reset() 은 락 밖 실행.
  std::vector<uint32_t> toDrop;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    callInvoker_ = std::move(invoker);
    for (auto& [h, _cb] : callbacks_) toDrop.push_back(h);
    callbacks_.clear();
    queue_.clear();
    drainScheduled_ = false;
  }
  // 리로드 대응: 귀속 채널 전부를 Rust 쪽에서도 drop(락 밖 — FFI 재진입 방지).
  for (uint32_t h : toDrop) {
    rustra_ffi_channel_drop(h);
  }
}

uint32_t ChannelDispatcher::create(facebook::jsi::Runtime& rt,
                                    facebook::jsi::Function callback) {
  // JS 스레드에서만 호출됨(HostFunction 경유). FFI 가 핸들을 선발급하고
  // 콜백이 그 핸들을 캡처해 회신하므로, 여기선 JS 콜백만 핸들 키로 등록.
  (void)rt;
  uint32_t handle = rustra_ffi_channel_create(&ChannelDispatcher::onChannelPayload, this);
  if (handle == 0) return 0; // 발급 실패 sentinel — 사실상 도달하지 않는다.
  callbacks_.insert_or_assign(handle, std::move(callback));
  return handle;
}

bool ChannelDispatcher::drop(uint32_t handle) {
  // JS 스레드 호출. Rust 채널 해제 후 콜백 제거. 해제 후 drain 에 이미
  // 적재된 해당 핸들 페이로드는 콜백 부재로 무시된다(유니캐스트 만료).
  int dropped = rustra_ffi_channel_drop(handle);
  callbacks_.erase(handle);
  return dropped == 1;
}

void ChannelDispatcher::onChannelPayload(void* user_data, uint32_t handle,
                                          const char* payload) {
  // send 스레드에서 호출 — JS 객체 미접근, 큐 적재 + drain 예약만.
  auto* self = static_cast<ChannelDispatcher*>(user_data);
  if (!self || !payload) return;

  std::lock_guard<std::mutex> lock(self->mutex_);
  if (self->queue_.size() >= self->capacity_) {
    self->queue_.pop_front(); // drop-oldest — JS 가 느려도 send 스레드 비블록
  }
  // payload 는 NUL 종결 C 문자열 — FfiChannelSink 가 CString 으로 만들어
  // 전달했으므로 여기서 복사해 소유한다(콜백 반환 후 무효).
  self->queue_.emplace_back(handle, std::string(payload));
  self->scheduleDrainLocked();
}

void ChannelDispatcher::drain(facebook::jsi::Runtime& rt) {
  // JS 런타임 스레드에서만 호출(CallInvoker 콜백 또는 폴링).
  std::deque<std::pair<uint32_t, std::string>> items;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    drainScheduled_ = false;
    items.swap(queue_);
  }
  for (auto& [handle, payload] : items) {
    auto it = callbacks_.find(handle);
    if (it == callbacks_.end()) continue; // 만료 채널 — 조용히 무시
    try {
      // 페이로드는 JSON 문자열 그대로 JS 로 — 파싱은 TS 래퍼에서 1회.
      it->second.call(rt, facebook::jsi::String::createFromUtf8(rt, payload));
    } catch (const std::exception&) {
      // JS 콜백 예외는 무시 — 이벤트 drain 과 동일 정책(호출자 보호).
    }
  }
}

void ChannelDispatcher::scheduleDrainLocked() {
  if (drainScheduled_ || !callInvoker_) return;
  drainScheduled_ = true;

  auto self = shared_from_this();
  std::shared_ptr<void> invoker = callInvoker_;
  auto weak = std::weak_ptr<ChannelDispatcher>(self);
#if defined(__APPLE__) || defined(__ANDROID__)
  auto* nativeInvoker = static_cast<facebook::react::CallInvoker*>(invoker.get());
  nativeInvoker->invokeAsync([weak](facebook::jsi::Runtime& rt) {
    if (auto dispatcher = weak.lock()) {
      dispatcher->drain(rt);
    }
  });
#endif
}

void ChannelDispatcher::reset() {
  // 리로드 대응 전체 폐기 — JS 콜백 맵·큐 클리어 후 Rust 채널 drop(락 밖).
  std::vector<uint32_t> toDrop;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [h, _cb] : callbacks_) toDrop.push_back(h);
    callbacks_.clear();
    queue_.clear();
    drainScheduled_ = false;
  }
  for (uint32_t h : toDrop) {
    rustra_ffi_channel_drop(h);
  }
}

// ── HostObject with cached functions ───────────────────────

using InvokeFn = uint8_t*(*)(const uint8_t*, size_t, size_t*);

// free 짝 계약: 응답 버퍼는 할당한 쪽의 전용 free 함수로만 해제한다.
//   - rustra_ffi_* 심볼(rustra crate): alloc_response 가 ptr-8 에 8바이트
//     magic 헤더를 붙인 레이아웃 → rustra_ffi_free 가 헤더를 역산해 해제.
//   - rustra_calculator_* 심볼(example crate): magic 헤더 없는 Box<[u8]> →
//     rustra_calculator_free_buffer.
// calculator 응답을 rustra_ffi_free 로 해제하면 ptr-8 언더리드(8B OOB read)
// 후 magic 불일치로 해제가 거절되어 호출당 누수가 난다(실제 버그였음).
// typedInvokeTail 주석(위)과 동일한 계약 — makeInvoke 는 심볼별로 짝을
// 명시적으로 받아 등록 시점에 매칭한다.
using FreeFn = void(*)(uint8_t*, size_t);

// live schema FFI (from rustra crate)
extern "C" uint8_t* rustra_ffi_get_schema(size_t* out_len);
extern "C" uint8_t* rustra_ffi_contract_hash(size_t* out_len);

RustraHostObject::RustraHostObject(Runtime& rt) {
  auto makeInvoke = [&](const char* name, InvokeFn fn, FreeFn freeFn, const char* err) {
    auto propNameId = PropNameID::forAscii(rt, name);
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [fn, freeFn, err](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
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
        freeFn(result, out_len);
        return returnValue;
      });
    cache_[name] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  };

  // ── Generic FFI paths (default, json, postcard) — magic 헤더 레이아웃이므로
  //    rustra_ffi_free 로 해제 짝. ─────────────────────────────
  makeInvoke("invoke",        rustra_ffi_invoke,              rustra_ffi_free, "Rust returned null");
  makeInvoke("invokeJson",    rustra_ffi_invoke_json,         rustra_ffi_free, "Rust json returned null");
  makeInvoke("invokePostcardFFI", rustra_ffi_invoke_postcard, rustra_ffi_free, "Rust postcard FFI returned null");

  // ── Per-example benchmark paths (legacy) — calculator 응답(magic 헤더 없는
  //    Box<[u8]>)이므로 rustra_calculator_free_buffer 로 해제 짝. ──
  makeInvoke("invokeBytes",   rustra_calculator_invoke_bytes,  rustra_calculator_free_buffer, "Rust bytes returned null");
  makeInvoke("invokeMsgpack",  rustra_calculator_invoke_msgpack, rustra_calculator_free_buffer, "Rust msgpack returned null");
  makeInvoke("invokeBincode",  rustra_calculator_invoke_bincode, rustra_calculator_free_buffer, "Rust bincode returned null");
  // Keep the public JS adapter name aligned with RustraNative. This is the
  // calculator's legacy postcard envelope (command + a + b), while
  // invokePostcardFFI above is the generic framework envelope.
  makeInvoke("invokePostcard", rustra_calculator_invoke_postcard, rustra_calculator_free_buffer, "Rust postcard returned null");
  makeInvoke("invokeLegacyPostcard", rustra_calculator_invoke_postcard, rustra_calculator_free_buffer, "Rust postcard returned null");
  makeInvoke("invokeRkyv",     rustra_calculator_invoke_rkyv,    rustra_calculator_free_buffer, "Rust rkyv returned null");
  makeInvoke("invokeHybrid",   rustra_calculator_invoke_hybrid,  rustra_calculator_free_buffer, "Rust hybrid returned null");
  // rkyv V2 는 코어 rustra_ffi_invoke_rkyv_v2 로 위임된 뒤라 응답이 코어 FFI
  // 레이아웃(8B magic 헤더)이다 — 전용 free 짝 필수(Phase 2 위임 시 누락돼
  // ArrayBuffer 경로에서 double-free/unallocated-free 크래시를 일으켰다).
  makeInvoke("invokeRkyvV2",   rustra_calculator_invoke_rkyv_v2, rustra_calculator_free_rkyv_v2_buffer, "Rust rkyv v2 returned null");
  makeInvoke("invokeRaw",      rustra_calculator_invoke_raw,     rustra_calculator_free_buffer, "Rust invoke_raw returned null");

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

  // getContractHash: (F5) native 빌드 계약 해시 → rustra_ffi_contract_hash.
  // 엔진 옵션 contractHash 설정 시 JS 가 생성된 GENERATED_CONTRACT_HASH 와
  // 비교해 스키마 드리프트(contract.mismatch)를 검증한다.
  {
    auto propNameId = PropNameID::forAscii(rt, "getContractHash");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 0,
      [](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        size_t out_len = 0;
        uint8_t* data = rustra_ffi_contract_hash(&out_len);
        if (!data) {
          throw JSError(rt, "RustraJSI: getContractHash returned null");
        }
        auto returnValue = createArrayBuffer(rt, data, out_len);
        rustra_ffi_free(data, out_len);
        return returnValue;
      });
    cache_["getContractHash"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── Event push: onEvent(name, cb) / offEvent(name) / drainEvents() ──
  // JS 콜백 등록은 HostFunction 에서 즉시 EventDispatcher 에 반영된다.
  // 등록 시점에 FFI 싱크가 설치되고, 이후 emit 은 큐 → CallInvoker → drain 경로로
  // 이 콜백에 도달한다. 페이로드는 JSON 문자열 — TS 래퍼가 JSON.parse 1회.
  {
    auto dispatcher = getEventDispatcher();
    auto propNameId = PropNameID::forAscii(rt, "onEvent");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [dispatcher](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: onEvent requires (name, callback)");
        }
        std::string name = args[0].asString(rt).utf8(rt);
        if (!args[1].isObject() || !args[1].asObject(rt).isFunction(rt)) {
          throw JSError(rt, "RustraJSI: onEvent callback must be a function");
        }
        Function cb = args[1].asObject(rt).getFunction(rt);
        dispatcher->setListener(rt, name, std::move(cb));
        return Value::undefined();
      });
    cache_["onEvent"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }
  {
    auto dispatcher = getEventDispatcher();
    auto propNameId = PropNameID::forAscii(rt, "offEvent");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [dispatcher](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI: offEvent requires (name)");
        }
        std::string name = args[0].asString(rt).utf8(rt);
        dispatcher->removeListener(name);
        return Value::undefined();
      });
    cache_["offEvent"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }
  // drainEvents(): CallInvoker 없는 호스트의 JS 폴링 drain. 반환값 = 처리된
  // 이벤트 수. CallInvoker 경로가 켜져 있으면 보통 비어 있다(자동 drain 됨).
  {
    auto dispatcher = getEventDispatcher();
    auto propNameId = PropNameID::forAscii(rt, "drainEvents");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 0,
      [dispatcher](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        size_t before = dispatcher->pendingCount();
        dispatcher->drain(rt);
        return Value(static_cast<double>(before));
      });
    cache_["drainEvents"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── Channel: createChannel(cb) / dropChannel(handle) (타입 패리티 2단계) ──
  // createChannel 은 JS 콜백에 u32 핸들을 발급해 되돌려준다 — JS 는 이 값을
  // 커맨드 인자 channel(ChannelHandle = number) 로 그대로 전달한다.
  // Rust 가 channel.send 하면 onChannelPayload → (드레인) → 등록한 cb(payload).
  // 호출 완료/취소 시 dropChannel(handle) — 이후 send 는 조용히 만료(false).
  {
    auto dispatcher = getChannelDispatcher();
    auto propNameId = PropNameID::forAscii(rt, "createChannel");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [dispatcher](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject() || !args[0].asObject(rt).isFunction(rt)) {
          throw JSError(rt, "RustraJSI: createChannel requires (callback)");
        }
        Function cb = args[0].asObject(rt).getFunction(rt);
        uint32_t handle = dispatcher->create(rt, std::move(cb));
        return Value(static_cast<double>(handle));
      });
    cache_["createChannel"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }
  {
    auto dispatcher = getChannelDispatcher();
    auto propNameId = PropNameID::forAscii(rt, "dropChannel");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [dispatcher](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI: dropChannel requires (handle)");
        }
        uint32_t handle = static_cast<uint32_t>(args[0].asNumber());
        return Value(dispatcher->drop(handle) ? true : false);
      });
    cache_["dropChannel"] = std::make_unique<CachedFunction>(
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

        // 2) Rust FFI (rkyv V2 단일 엔진) + 응답 tail — 공통 헬퍼로
        //    (typedInvokeTail 주석의 free 짝 계약: rustra_calculator_free_buffer).
        //    decoder 만 이름 기반 decode_by_name.
        return typedInvokeTail(rt, req, "", [&rt, &name](rc::Reader& r) {
          return gen::decode_by_name(rt, name, r);
        });
      });
    cache_["invokeTyped"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── P0-3: invokeTypedById(cmdId, args) — id 인덱싱 typed 진입 ──
  // invokeTyped 와 동일한 흐름(encode→FFI→decode)이지만 문자열 마샬링과
  // C++ 이름 비교체인 대신 u16 cmd_id switch 디스패치를 쓴다. JS 엔진은
  // 정적 명령 집합을 엔진 생애 1회 스윕(hasStaticCodec)으로 캐시해 이 진입으로
  // 호출한다 — JSI 횡단 2→1, 문자열 2→0. 미발견 cmd_id 는 encode_by_id 가
  // false 를 반환해 JSError 로 명시 실패한다(호출侧 캐시 불변식 위반 노출).
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTypedById");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: invokeTypedById requires (cmdId, args)");
        }
        uint16_t cmdId = static_cast<uint16_t>(args[0].asNumber());

        // 1) JS 객체 → postcard 요청 바이트 ([cmd_id u16 LE][postcard(I)])
        rc::Writer w;
        if (!gen::encode_by_id(rt, cmdId, args[1], w)) {
          throw JSError(rt, "RustraJSI: no C++ codec for cmd_id " + std::to_string(cmdId));
        }
        auto req = w.take();

        // 2) Rust FFI + 응답 tail — invokeTyped 와 동일하지만 decoder 만
        //    u16 디스패치 decode_by_id (free 짝: rustra_calculator_free_buffer).
        return typedInvokeTail(rt, req, "", [&rt, cmdId](rc::Reader& r) {
          return gen::decode_by_id(rt, cmdId, r);
        });
      });
    cache_["invokeTypedById"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── (Tier 1) invokeTypedPos(cmdId, a, b, …) — positional 인자 직접 진입 ──
  // JS 측 인자 객체 리터럴 {a, b} 생성과 C++ asObject/getProperty 순회를 모두
  // 건너뛴다 — HostFunction 스택의 Value 배열에서 postcard 바이트로 직렬화.
  // encode_pos_by_id 는 스칼라(≤3필드) 명령만 커버한다: 미지원 cmd_id 는
  // JSError 로 명시 실패하고 JS 엔진은 invokeTypedById 로 폴백한다.
  // argc 는 JS 코드젠(positional facade)이 시그니처로 보장하지만 런타임
  // 가드도 둔다(수동 호출 방어).
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTypedPos");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 4,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI: invokeTypedPos requires (cmdId, ...fields)");
        }
        uint16_t cmdId = static_cast<uint16_t>(args[0].asNumber());
        const Value* argv = count > 1 ? args + 1 : nullptr;
        size_t argc = count > 1 ? count - 1 : 0;

        rc::Writer w;
        gen::encode_pos_by_id(rt, cmdId, argv, argc, w); // 미지원 시 throw
        auto req = w.take();

        return typedInvokeTail(rt, req, "", [&rt, cmdId](rc::Reader& r) {
          return gen::decode_by_id(rt, cmdId, r);
        });
      });
    cache_["invokeTypedPos"] = std::make_unique<CachedFunction>(
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

          // FFI + 응답 tail — 공통 헬퍼 (fail-fast: 첫 에러에서 throw).
          // 접미 계약 유지: null → " (batch item <name>)", malformed → " (batch)".
          Value decoded = typedInvokeTail(rt, req, " (batch)",
                                          [&rt, &name](rc::Reader& r) {
                                            return gen::decode_by_name(rt, name, r);
                                          },
                                          &name);
          results.setValueAtIndex(rt, i, decoded);
        }
        return results;
      });
    cache_["invokeTypedBatch"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── P0-2 byId: invokeTypedBatchById(cmdIds, args) — id 인덱싱 배치 진입 ──
  // invokeTypedBatch 와 동일 계약(단일 횡단, fail-fast, 결과 Array 순서 보존)이지만
  // encode/decode 를 이름 대신 u16 cmd_id 로 디스패치한다 — 항목당 문자열
  // 마샬링 2회(name 인자 + 응답 decode_by_name)를 제거한다. JS 엔진은 정적
  // 명령 id 캐시(P0-3 ensureStaticIds)에서 id 배열을 조립해 이 진입으로 호출한다.
  // 미발견 cmd_id 는 encode_by_id 가 false 를 반환해 JSError 로 명시 실패한다.
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeTypedBatchById");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 2,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) {
          throw JSError(rt, "RustraJSI: invokeTypedBatchById requires (cmdIds, args)");
        }
        Array ids = args[0].asObject(rt).getArray(rt);
        Array inputs = args[1].asObject(rt).getArray(rt);
        size_t n = ids.length(rt);
        if (inputs.length(rt) != n) {
          throw JSError(rt, "RustraJSI: invokeTypedBatchById cmdIds/args length mismatch");
        }

        Array results(rt, n);
        for (size_t i = 0; i < n; i++) {
          uint16_t cmdId =
            static_cast<uint16_t>(ids.getValueAtIndex(rt, i).asNumber());
          const Value& oneArgs = inputs.getValueAtIndex(rt, i);

          // encode by id (정적 cmd_id 필수)
          rc::Writer w;
          if (!gen::encode_by_id(rt, cmdId, oneArgs, w)) {
            throw JSError(rt,
              "RustraJSI: batch item has no C++ codec for cmd_id " + std::to_string(cmdId));
          }
          auto req = w.take();

          // FFI + 응답 tail — 공통 헬퍼 (fail-fast: 첫 에러에서 throw).
          // 접미는 이름 기반 배치와 동일하게 유지한다: null → " (batch)",
          // malformed → " (batch)". 항목 이름을 알 수 없는 byId 경로의
          // null 접미는 이름 조립 없이 배치 접미를 그대로 쓴다.
          Value decoded = typedInvokeTail(rt, req, " (batch)",
                                          [&rt, cmdId](rc::Reader& r) {
                                            return gen::decode_by_id(rt, cmdId, r);
                                          });
          results.setValueAtIndex(rt, i, decoded);
        }
        return results;
      });
    cache_["invokeTypedBatchById"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // ── follow-up 3: invokeTypedAsync + invokeCancel ────────────
  // invokeTypedAsync(name, args, onSuccess, onError) → invocation id (number).
  // 결과는 CallInvoker 로 JS 스레드에 마샬링된다. id 로 invokeCancel(id) 호출 시
  // Rust 취소 체크포인트(워커 dispatch 전)까지 전파된다. 구형 계약(void 반환)
  // 호환은 JS 어댑터가 처리한다.

  {
    // on_complete C 콜백 컨텍스트 — 힙에 두고 user_data 로 전달. 콜백 1회 실행
    // 후 자기 자신을 해제한다(정확히 1회).
    struct AsyncCallContext {
      std::string commandName;
      facebook::jsi::Function onSuccess;
      facebook::jsi::Function onError;
      std::shared_ptr<void> callInvoker; // type-erased CallInvoker (or null)
      std::mutex mutex;                  // 아직 marshalling 중인지 가드
      bool done = false;                 // 정확히 1회 딜리버리
    };

    auto propNameId = PropNameID::forAscii(rt, "invokeTypedAsync");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 4,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 4) {
          throw JSError(rt, "RustraJSI: invokeTypedAsync requires (name, args, onSuccess, onError)");
        }
        std::string name = args[0].asString(rt).utf8(rt);
        if (!args[2].isObject() || !args[2].asObject(rt).isFunction(rt) ||
            !args[3].isObject() || !args[3].asObject(rt).isFunction(rt)) {
          throw JSError(rt, "RustraJSI: invokeTypedAsync callbacks must be functions");
        }

        // CallInvoker — EventDispatcher 의 전역 디스패처에서 빌려온다.
        std::shared_ptr<void> invoker = getEventDispatcher()->currentCallInvoker();

        if (!invoker) {
          throw JSError(rt,
            "RustraJSI: invokeTypedAsync requires a CallInvoker — "
            "install via installRustraJSIWithInvoker");
        }

        auto* ctx = new AsyncCallContext{
          name,
          args[2].asObject(rt).getFunction(rt),
          args[3].asObject(rt).getFunction(rt),
          std::move(invoker),
          {},
          false,
        };

        // 1) JS 객체 → postcard 요청 바이트 (invokeTyped 와 동일한 인코딩).
        rc::Writer w;
        if (!gen::encode_by_name(rt, name, args[1], w)) {
          delete ctx;
          throw JSError(rt, "RustraJSI: no C++ codec for '" + name + "'");
        }
        auto req = w.take();

        // 2) 비동기 FFI — id 를 동기 반환한다 (취소 핸들).
        uint64_t invocationId = 0;
        rustra_calculator_invoke_rkyv_v2_async(
          req.data(), req.size(), ctx,
          [](void* user_data, uint8_t* resp, size_t resp_len) {
            // Rust 워커 스레드에서 실행 — JS 객체를 건드리지 않고, 결과를
            // 소유한 뒤 CallInvoker 로 JS 스레드에 마샬링한다.
            auto* ctx = static_cast<AsyncCallContext*>(user_data);
            std::vector<uint8_t> frame;
            if (resp && resp_len > 0) {
              frame.assign(resp, resp + resp_len);
              rustra_calculator_free_buffer(resp, resp_len);
            }
            std::shared_ptr<void> invoker;
            {
              std::lock_guard<std::mutex> lock(ctx->mutex);
              invoker = ctx->callInvoker;
            }
            auto* nativeInvoker =
              static_cast<facebook::react::CallInvoker*>(invoker.get());
            auto* rawCtx = ctx;
            nativeInvoker->invokeAsync([rawCtx, frame = std::move(frame)](facebook::jsi::Runtime& rt) {
              std::unique_ptr<AsyncCallContext> owned(rawCtx); // 1회 실행 후 해제
              std::lock_guard<std::mutex> lock(owned->mutex);
              if (owned->done) return;
              owned->done = true;
              const std::string& name = owned->commandName;
              const size_t out_len = frame.size();
              const uint8_t* resp = frame.data();
              if (out_len < 1) {
                owned->onError.call(rt, "RustraJSI: empty rkyv v2 async response");
                return;
              }
              if (resp[0] == 0) {
                // 에러 와이어: [ok:0][pad][err_len u16 @8][postcard{code,message} @10]
                if (out_len < 10) {
                  owned->onError.call(rt, "RustraJSI: malformed async error response");
                  return;
                }
                // postcard {code, message} → "code: message" 문자열 (RustraError
                // Display 형태) — JS parseRustraErrorString 가 코드를 복구한다.
                // 파싱 실패 시 원시 바이트 폴백(onError 누락 없음).
                owned->onError.call(rt, parseRkyvV2ErrorBody(resp, out_len));
                return;
              }
              if (out_len < 8) {
                owned->onError.call(rt, "RustraJSI: malformed async success response");
                return;
              }
              try {
                rc::Reader r(resp + 8, out_len - 8);
                Value result = gen::decode_by_name(rt, name, r);
                owned->onSuccess.call(rt, std::move(result));
              } catch (const facebook::jsi::JSError& e) {
                // 디코딩 실패는 에러 콜백으로 정규화 — 콜백 누락 방지.
                owned->onError.call(rt, e.getMessage());
              }
            });
          },
          &invocationId);

        // JS 는 동기적으로 id 를 받는다 — abort 전파에 쓸 취소 핸들.
        return Value(static_cast<double>(invocationId));
      });
    cache_["invokeTypedAsync"] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  }

  // invokeCancel(id) → boolean — 진행 중 async 호출의 협력적 취소.
  {
    auto propNameId = PropNameID::forAscii(rt, "invokeCancel");
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, "RustraJSI: invokeCancel requires (invocationId)");
        }
        uint64_t id = static_cast<uint64_t>(args[0].asNumber());
        return Value(rustra_ffi_invoke_cancel(id));
      });
    cache_["invokeCancel"] = std::make_unique<CachedFunction>(
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

std::vector<PropNameID> RustraHostObject::propertyNames(Runtime& rt) {
  // getPropertyNames 와 동일 로직의 non-virtual 버전 — 설치 평탄화 전용.
  return getPropertyNames(rt);
}

Function RustraHostObject::getFunction(Runtime& rt, const PropNameID& name) {
  // get 과 동일 스캔이지만 Value 가 아닌 Function 반환. 이 jsi 버전의
  // Function 은 move-only(Pointer 계열, 복사 생성자 삭제)라 Object::getFunction
  // 의 const& 오버로드가 runtime.cloneObject 로 새 핸들을 만들어 준다 —
  // 같은 Runtime 힙의 동일 JS 함수 객체를 참조하므로 사실상의 복사다.
  for (auto& [key, cached] : cache_) {
    if (PropNameID::compare(rt, name, cached->propNameId)) {
      return cached->function.getFunction(rt);
    }
  }
  // 설치 경로는 propertyNames 로 얻은 이름만 전달하므로 도달하지 않는다.
  // 그래도 침묵 대신 명시적 실패로 — 평탄화 누락을 조기에 노출한다.
  throw JSError(rt, "RustraJSI: getFunction — unknown property");
}

// ── Install ────────────────────────────────────────────────

// Deterministic package registration (avoids relying on __mod_init_func which
// can be dead-stripped in debug iOS static-lib builds).
extern "C" void rustra_calculator_init();

void installRustraJSIWithInvoker(Runtime& rt,
                                  std::shared_ptr<void> typeErasedCallInvoker) {
  rustra_calculator_init();
  // RN reload 로 새 Runtime 이 설치되는 시점 — 캐시된 Function 핸들은
  // 구 Runtime 힙을 참조하므로 여기서 반드시 비운다.
  g_arrayBufferCtor.reset();
  auto dispatcher = getEventDispatcher();
  dispatcher->setCallInvoker(typeErasedCallInvoker);
  // 채널 디스패처도 동일 CallInvoker 공유(2단계) — reset 내부에서 이전
  // 런타임 귀속 채널을 Rust 쪽까지 폐기한다.
  getChannelDispatcher()->setCallInvoker(std::move(typeErasedCallInvoker));

  // 평탄화(Nitro 방식): 모든 호스트 함수를 일반 JS 객체의 프로퍼티로 설치
  // 시점에 박는다. 이후 native.invokeRkyvV2(...) 조회가 HostObject get 콜백
  // (엔트리당 compare 가상 호출, 최대 22회) 대신 엔진의 인라인 프로퍼티
  // 로드가 된다. 동작 불변: 프로퍼티 목록과 각 함수는 기존과 동일하며,
  // unknown 프로퍼티 조회는 HostObject 의 undefined 반환과 마찬가지로
  // JS undefined 로 귀결된다.
  // RustraHostObject 는 함수 팩토리로만 사용 — get/getPropertyNames
  // 오버라이드는 다른 설치 경로 호환용 안전 폴백으로 유지된다.
  auto hostObject = std::make_shared<RustraHostObject>(rt);
  Object obj(rt);
  for (auto& propName : hostObject->propertyNames(rt)) {
    // setProperty(PropNameID, T&&) 오버로드 — Function 은 Object 파생이라
    // detail::toValue 가 Value(rt, function) 로 변환한다.
    obj.setProperty(rt, propName, hostObject->getFunction(rt, propName));
  }
  rt.global().setProperty(rt, "__rustraNative", std::move(obj));
}

void installRustraJSI(Runtime& rt) {
  // CallInvoker 없는 설치(레거시 경로) — 이벤트 푸시는 JS 가 drainEvents() 로
  // 폴링해야 한다. 프로덕션 플랫폼 글루는 installRustraJSIWithInvoker 사용.
  installRustraJSIWithInvoker(rt, nullptr);
}

} // namespace rustra
