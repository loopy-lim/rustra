#pragma once

#include <jsi/jsi.h>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

namespace rustra {

extern "C" {
  // ── Generic FFI (from rustra::ffi) ──────────────────────
  uint8_t* rustra_ffi_invoke(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_ffi_invoke_json(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_ffi_invoke_postcard(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  void rustra_ffi_free(uint8_t* ptr, size_t len);

  // ── Event sink push delivery (from rustra::ffi) ─────────
  // C 호스트가 Rust → JS 이벤트 푸시용 콜백을 등록/해제한다.
  // 콜백은 emit 호출 스레드에서 실행된다 — 호스트가 JS 런타임 스레드로
  // 마샬링해야 한다 (아래 EventDispatcher).
  // 콜백은 예외를 던지면 안 된다: Rust 프레임을 통과하는 외국 예외은
  // Rust 가 잡을 수 없어 프로세스 abort 다 ("C-unwind" ABI 계약).
  typedef void (*rustra_event_callback_t)(
    void* user_data, const char* name, const char* payload);
  void rustra_ffi_event_sink_register(
    rustra_event_callback_t callback, void* user_data);
  void rustra_ffi_event_sink_unregister(void);

  // ── Per-example FFI (benchmark legacy) ──────────────────
  uint8_t* rustra_calculator_invoke_bytes(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_raw(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_msgpack(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_bincode(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_postcard(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_rkyv(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_hybrid(
    const uint8_t* payload, size_t payload_len, size_t* out_len);
  uint8_t* rustra_calculator_invoke_rkyv_v2(
    const uint8_t* payload, size_t payload_len, size_t* out_len);

  // ── Cancellation (from rustra::ffi) ─────────────────────
  // invocation_id 로 진행 중 async 호출을 협력적 취소한다.
  bool rustra_ffi_invoke_cancel(uint64_t invocation_id);

  // ── rkyv V2 async (follow-up 3) ──────────────────────────
  // `rustra_calculator_invoke_rkyv_v2` 의 async 변형 — invocation_id 발급 +
  // cancel 체크포인트 포함. 응답 버퍼는 on_complete 콜백 안에서
  // rustra_calculator_free_buffer 로 해제해야 한다.
  typedef void (*rustra_calculator_async_callback_t)(
    void* user_data, uint8_t* resp, size_t resp_len);
  void rustra_calculator_invoke_rkyv_v2_async(
    const uint8_t* payload, size_t payload_len, void* user_data,
    rustra_calculator_async_callback_t on_complete, uint64_t* invocation_id);

  void rustra_calculator_free_buffer(uint8_t* ptr, size_t len);

  // sync rkyv V2 응답 전용 해제 — rustra_calculator_invoke_rkyv_v2 가 코어
  // rustra_ffi_invoke_rkyv_v2 로 위임되어 응답이 코어 FFI 레이아웃(8B 헤더)으로
  // 할당된다. rustra_calculator_free_buffer 와 교환 불가.
  void rustra_calculator_free_rkyv_v2_buffer(uint8_t* ptr, size_t len);

  // ── (Tier 1) rkyv V2 caller-buffer — malloc→memcpy→free 사이클 제거 ──
  // buf=null → size-probe(0 반환, 필요 크기는 *out_len). buf≠null → 직접 기록,
  // 반환값은 기록한 바이트 수. capacity 부족 시 SIZE_MAX 반환(재probe 신호).
  // probe→write 2단계 사이 핸들러는 코어 probe 캐시로 1회만 실행된다.
  size_t rustra_ffi_invoke_rkyv_v2_into(
    const uint8_t* payload, size_t payload_len,
    uint8_t* buf, size_t capacity, size_t* out_len);
}

/// Cached function entry — stores PropNameID + pre-created JS Function.
struct CachedFunction {
  facebook::jsi::PropNameID propNameId;
  facebook::jsi::Function function;
};

/// Rust → JS 이벤트 푸시 디스패처.
///
/// FFI C 콜백(emitting 스레드)이 (name, payload_json) 을 큐에 적재하면
/// JS 런타임 스레드의 CallInvoker 가 큐를 drain 해 per-name JS 콜백으로
/// 전달한다. CallInvoker 가 없는 호스트(유닛 테스트 등)는 `__rustraNative`
/// 의 `drainEvents()` HostFunction 로 폴링 drain 할 수 있다.
///
/// 스레딩 계약:
/// - `onRustEvent` (FFI 콜백) — 어느 스레드에서든. 뮤텍스로 보호된 큐에
///   적재만 하고 JS 객체를 건드리지 않는다.
/// - `drain` — 반드시 JS 런타임 스레드에서. `Function::call` 은 JS 스레드에서만
///   안전하다 (CallInvoker 콜백 내부 또는 JS 가 drainEvents() 를 호출할 때).
/// - 큐는 고정 용량(1024) drop-oldest — JS 가 느려도 emit 스레드를 블록하지
///   않는다 (Rust EventBus 정책과 동일).
class EventDispatcher : public std::enable_shared_from_this<EventDispatcher> {
public:
  /// JS 스레드 마샬링용 CallInvoker 설정. installRustraJSI* 에서 호출된다.
  void setCallInvoker(std::shared_ptr<void> invoker);

  /// 현재 설치된 type-erased CallInvoker (없으면 nullptr).
  /// `invokeTypedAsync` 가 결과를 JS 스레드로 마샬링할 때 빌려간다.
  std::shared_ptr<void> currentCallInvoker() {
    std::lock_guard<std::mutex> lock(mutex_);
    return callInvoker_;
  }

  /// (name, callback) JS 리스너 등록/해제. JS 스레드에서 호출됨
  /// (HostFunction 경유). 같은 이름에 두 번 등록하면 마지막이 이긴다.
  void setListener(facebook::jsi::Runtime& rt, const std::string& name,
                   facebook::jsi::Function callback);
  void removeListener(const std::string& name);

  /// FFI C 콜백 — emitting 스레드에서 호출된다. 큐 적재 + CallInvoker 로
  /// drain 예약만 한다.
  static void onRustEvent(void* user_data, const char* name, const char* payload);

  /// 큐의 모든 이벤트를 JS 리스너로 전달한다. JS 런타임 스레드에서만 호출.
  void drain(facebook::jsi::Runtime& rt);

  /// 미처리 이벤트 수 (JS 폴링/디버그용).
  size_t pendingCount();

private:
  void scheduleDrainLocked();

  std::mutex mutex_;
  std::deque<std::pair<std::string, std::string>> queue_;
  size_t capacity_ = 1024;
  size_t dropped_ = 0;
  bool drainScheduled_ = false;
  std::shared_ptr<void> callInvoker_;
  /// per-name JS 콜백 레지스트리 — drain 에서만 접근(JS 스레드).
  std::unordered_map<std::string, facebook::jsi::Function> listeners_;
};

/// Optimized HostObject that caches all JSI functions on first access.
/// Avoids per-call string comparison and Function::createFromHostFunction allocation.
class RustraHostObject : public facebook::jsi::HostObject {
public:
  explicit RustraHostObject(facebook::jsi::Runtime& rt);

  facebook::jsi::Value get(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name) override;

  void set(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name,
    const facebook::jsi::Value& value) override {}

  std::vector<facebook::jsi::PropNameID> getPropertyNames(
    facebook::jsi::Runtime& rt) override;

  /// 설치 평탄화용: 캐시된 함수 이름 목록 (getPropertyNames 와 동일 로직,
  /// non-virtual). installRustraJSIWithInvoker 가 일반 Object 에 함수들을
  /// 프로퍼티로 박을 때 열거에 사용한다.
  std::vector<facebook::jsi::PropNameID> propertyNames(
    facebook::jsi::Runtime& rt);

  /// 설치 평탄화용: 이름으로 캐시된 Function 반환 (get 과 동일 스캔 로직,
  /// Value 래핑 대신 Function 자체 — cloneObject 로 같은 JS 함수를 참조하는
  /// 새 핸들). 못 찾으면 throw — 설치 경로는 propertyNames 로 얻은 이름만
  /// 쓰므로 정상적으로는 도달 안 함.
  facebook::jsi::Function getFunction(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name);

private:
  /// Cache of function name → {PropNameID, Function}.
  /// Populated lazily on first property access for each name.
  std::unordered_map<std::string, std::unique_ptr<CachedFunction>> cache_;
};

void installRustraJSI(facebook::jsi::Runtime& rt);

/// installRustraJSI + JS 스레드 CallInvoker 주입. iOS(RCTCxxBridge) 와
/// Android(CallInvokerHolder) 플랫폼 글루가 각자의 방식으로 CallInvoker 를
/// 얻어 이 진입점으로 넘긴다.
///
/// CallInvoker 타입은 `facebook::react::CallInvoker` 이지만 이 헤더는
/// ReactAndroid/React-callinvoker 헤더에 의존하지 않는다 — 플랫폼 글루가
/// `void` shared_ptr 로 type-erase 해서 전달하고, .cpp 가 내부에서
/// static_cast 로 복원한다(단일 정의 지점 유지).
void installRustraJSIWithInvoker(
  facebook::jsi::Runtime& rt,
  std::shared_ptr<void> typeErasedCallInvoker);

} // namespace rustra
