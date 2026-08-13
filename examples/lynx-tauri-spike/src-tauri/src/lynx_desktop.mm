// rustra-bridge × Lynx × Tauri — desktop surface integration (경로 A).
//
// host.cpp(windowless headless)에서 env init · bundle 로드 · FML 펌프 · RustraModule
// N-API · extension-module BTS 주입 패턴을 재사용하고, windowless RGBA renderer 블록을
// LynxView::Builder::SetParent(nsview) 로 교체한다. Lynx 가 Tauri window 의 NSView 를
// 부모로 삼아 직접 렌더링한다(경로 A). FML 펌프는 Tauri 메인 루프(MainEventsCleared) 에서
// lynx_spike_pump() 로 매 틱 호출된다.
//
// libLynx 의 UIThread/MessageLoop C++ 심볼은 local visibility 로 숨겨져 있어 Mach-O
// image base + offset 으로 해결한다(ABI-pinned to SDK 4.0 / engine 3.2). 이는 headless
// 자산과 동일한 메커니즘이며, 본 경로에서도 BTS/runtime 메시지 루프 전진에 필요하다.
//
// USE_WEAK_SUFFIX_NAPI 정의(-D): Lynx N-API 심볼이 *_weak 접미사.

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>
#include <vector>
#include <fstream>
#include <atomic>

#include <mach-o/dyld.h>

#include "capi/lynx_env_capi.h"
#include "capi/lynx_view_builder_capi.h"
#include "capi/lynx_view_capi.h"
#include "capi/lynx_view_client_capi.h"
#include "capi/lynx_load_meta_capi.h"
#include "capi/lynx_native_module_capi.h"
#include "capi/lynx_extension_module_capi.h"
#include "capi/lynx_extension_module_types_capi.h"
#include "capi/lynx_generic_resource_fetcher_capi.h"
#include "capi/lynx_resource_request_capi.h"
#include "capi/lynx_resource_response_capi.h"

// ── Rust FFI (rustra-calculator-example staticlib) ────────────────────────
extern "C" {
const uint8_t *rustra_calculator_invoke_rkyv_v2(const uint8_t *payload,
                                                size_t len, size_t *out_len);
void rustra_calculator_free_buffer(void *ptr, size_t len);
// calculator 패키지를 FFI 레지스트리에 idempotent 등록.
// Apple 은 __mod_init_func constructor 가 자동 등록하지만, Windows(PE)/Android(ELF)
// 에는 그런 constructor 가 없으므로 lynx_spike_init 시작부에서 명시 호출한다.
// (rustra_calculator_init 는 여러 번 불러도 안전하다.)
void rustra_calculator_init(void);
}

// ── globals ───────────────────────────────────────────────────────────────
static std::atomic<bool> g_load_success{false};
static std::atomic<bool> g_first_screen{false};
static std::atomic<bool> g_error{false};
static std::atomic<bool> g_runtime_ready{false};
static std::atomic<int> g_invoke_count{0};
static std::atomic<int> g_results_acked{0};
static std::atomic<int> g_result_value{-999};
// invokeRkyvV2 핸들러 본체(진입→리턴) 소요 ns. end-to-end(JS/QuickJS) 와 대조해
// N-API 경계 + Promise 스케줄링 오버헤드를 분리하는 데 사용.
static std::vector<double> g_invoke_times_ns;
static std::mutex g_invoke_times_mtx;

static lynx_view_t *g_view = nullptr;
static lynx_extension_module_t *g_ext_module = nullptr;
static napi_env_weak g_bts_env = nullptr;

// ── fml::MessageLoop pump (resolved by offset from libLynx.dylib) ──────────
// headless host.cpp 와 동일 메커니즘. SetParent 경로에서도 BTS/runtime 작업 전진에 필요.
typedef void *(*FmlIsInitFn)(void);
typedef void (*FmlRunExpiredFn)(void *impl);
typedef void (*UiThreadInitFn)(void *platform_loop);
static FmlIsInitFn g_fml_is_init = nullptr;
static FmlRunExpiredFn g_fml_run_expired = nullptr;
static UiThreadInitFn g_ui_thread_init = nullptr;

static void resolve_liblynx_symbols() {
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    if (!name || !strstr(name, "libLynx")) continue;
    const struct mach_header *hdr = _dyld_get_image_header(i);
    auto at = [&](uintptr_t off) -> void * {
      return reinterpret_cast<void *>(reinterpret_cast<uintptr_t>(hdr) + off);
    };
    g_fml_is_init = reinterpret_cast<FmlIsInitFn>(at(0x3ecc));
    g_fml_run_expired = reinterpret_cast<FmlRunExpiredFn>(at(0x43a4));
    g_ui_thread_init = reinterpret_cast<UiThreadInitFn>(at(0x9329bc));
    fprintf(stderr,
            "[spike] resolved libLynx @%p: IsInit=%p RunExpired=%p UIThreadInit=%p\n",
            (void *)hdr, (void *)g_fml_is_init, (void *)g_fml_run_expired,
            (void *)g_ui_thread_init);
    return;
  }
  fprintf(stderr,
          "[spike] WARNING: libLynx not found — FML pump disabled\n");
}

static bool pump_fml_message_loop() {
  if (!g_fml_is_init || !g_fml_run_expired) return false;
  void *ml = g_fml_is_init();
  if (!ml) return false;
  void *impl = *reinterpret_cast<void **>(ml);
  if (!impl) return false;
  g_fml_run_expired(impl);
  return true;
}

// ── N-API native module: RustraModule.invokeRkyvV2(ArrayBuffer) → ArrayBuffer
static napi_value_weak InvokeRkyvV2(napi_env_weak env,
                                    napi_callback_info_weak info) {
  auto t0 = std::chrono::steady_clock::now();
  g_invoke_count.fetch_add(1, std::memory_order_relaxed);
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return nullptr;
  void *data = nullptr;
  size_t len = 0;
  napi_get_arraybuffer_info_weak(env, args[0], &data, &len);

  size_t out_len = 0;
  const uint8_t *out =
      rustra_calculator_invoke_rkyv_v2((const uint8_t *)data, len, &out_len);
  fprintf(stderr, "[spike] invokeRkyvV2: in=%zu out=%zu ok=%u\n", len, out_len,
          out ? (unsigned)out[0] : 0xff);

  napi_value_weak result = nullptr;
  void *dest = nullptr;
  napi_create_arraybuffer_weak(env, out_len, &dest, &result);
  std::memcpy(dest, out, out_len);
  rustra_calculator_free_buffer((void *)out, out_len);
  {
    auto t1 = std::chrono::steady_clock::now();
    double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
    std::lock_guard<std::mutex> lk(g_invoke_times_mtx);
    g_invoke_times_ns.push_back(ns);
  }
  return result;
}

// JS→native ack: addNumbers().then() 안에서만 호출. resultAcked=1 val=42 가 rkyv 왕복 증거.
static napi_value_weak AckResult(napi_env_weak env,
                                 napi_callback_info_weak info) {
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc >= 1) {
    int32_t v = -777;
    napi_get_value_int32_weak(env, args[0], &v);
    g_result_value.store(v, std::memory_order_relaxed);
    fprintf(stderr, "[spike] ackResult val=%d\n", v);
  }
  g_results_acked.fetch_add(1, std::memory_order_relaxed);
  fprintf(stderr, "[spike] ackResult: results_acked=%d\n",
          g_results_acked.load());
  return nullptr;
}

// JS→host: 런타임 벤치마크 수치 전달. App.tsx 가 QuickJS end-to-end 측정값
// (js.avg_us / js.p50_us / js.p99_us ...)을 [bench] 라인으로 로깅한다.
// host 측 invokeRkyvV2 본체 타이밍과 대조 → N-API 경계+Promise 오버헤드 분리.
static napi_value_weak BenchResult(napi_env_weak env,
                                   napi_callback_info_weak info) {
  size_t argc = 2;
  napi_value_weak args[2] = {nullptr, nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc >= 2) {
    char buf[128] = {0};
    size_t len = 0;
    napi_get_value_string_utf8_weak(env, args[0], buf, sizeof(buf), &len);
    double v = 0;
    napi_get_value_double_weak(env, args[1], &v);
    fprintf(stderr, "[bench] %s=%.3f\n", buf, v);
  }
  return nullptr;
}

static napi_value_weak RustraModuleCreator(napi_env_weak env,
                                           napi_value_weak exports,
                                           const char * /*module_name*/,
                                           void * /*opaque*/) {
  napi_value_weak fn = nullptr;
  napi_create_function_weak(env, "invokeRkyvV2", NAPI_AUTO_LENGTH, InvokeRkyvV2,
                            nullptr, &fn);
  napi_set_named_property_weak(env, exports, "invokeRkyvV2", fn);
  fprintf(stderr, "[spike] RustraModule native module registered (N-API)\n");
  return exports;
}

// ── extension-module: BTS-thread NativeModules injector ───────────────────
static void InstallRustraNative(napi_env_weak env, napi_value_weak global,
                                const char *hook) {
  napi_value_weak exports = nullptr, fn = nullptr;
  napi_create_object_weak(env, &exports);
  napi_create_function_weak(env, "invokeRkyvV2", NAPI_AUTO_LENGTH,
                            InvokeRkyvV2, nullptr, &fn);
  napi_set_named_property_weak(env, exports, "invokeRkyvV2", fn);
  napi_create_function_weak(env, "ackResult", NAPI_AUTO_LENGTH, AckResult,
                            nullptr, &fn);
  napi_set_named_property_weak(env, exports, "ackResult", fn);
  napi_create_function_weak(env, "benchResult", NAPI_AUTO_LENGTH, BenchResult,
                            nullptr, &fn);
  napi_set_named_property_weak(env, exports, "benchResult", fn);

  napi_value_weak nm = nullptr;
  napi_get_named_property_weak(env, global, "NativeModules", &nm);
  napi_valuetype_weak vt = napi_undefined_weak;
  napi_typeof_weak(env, nm, &vt);
  bool created = (vt != napi_object_weak);
  if (created) {
    napi_create_object_weak(env, &nm);
    napi_set_named_property_weak(env, global, "NativeModules", nm);
  }
  napi_set_named_property_weak(env, nm, "RustraModule", exports);
  napi_set_named_property_weak(env, global, "RustraModule", exports);
  fprintf(stderr, "[spike] %s: install RustraModule (NativeModules %s)\n", hook,
          created ? "ABSENT->created" : "present");
}

static void OnExtRuntimeAttach(lynx_extension_module_t * /*self*/,
                               napi_env_weak env,
                               lynx_vsync_observer_t * /*vso*/) {
  napi_value_weak global = nullptr;
  napi_get_global_weak(env, &global);
  InstallRustraNative(env, global, "runtime_attach");
  g_bts_env = env;
}

static void OnExtRuntimeReady(lynx_extension_module_t * /*self*/,
                              napi_env_weak env, napi_value_weak global,
                              const char * /*url*/) {
  InstallRustraNative(env, global, "runtime_ready ");
}

static lynx_extension_module_t *RustraExtCreator(void * /*opaque*/) {
  lynx_extension_module_t *m = lynx_extension_module_create(nullptr);
  lynx_extension_module_set_napi_module_creator(m, RustraModuleCreator);
  lynx_extension_module_bind_runtime_attach(m, OnExtRuntimeAttach);
  lynx_extension_module_bind_runtime_ready(m, OnExtRuntimeReady);
  g_ext_module = m;
  fprintf(stderr, "[spike] extension module created (attach+ready bound)\n");
  return m;
}

// ── generic resource fetcher: serve the rspeedy JS bundle by URL ───────────
static std::vector<uint8_t> g_js_bundle;
static std::string g_bundle_url;

static void FetchResource(lynx_generic_resource_fetcher_t * /*f*/,
                          lynx_resource_request_t *req,
                          lynx_resource_response_t *resp) {
  const char *url = lynx_resource_request_get_url(req);
  lynx_resource_type_e type = lynx_resource_request_get_type(req);
  fprintf(stderr, "[spike] fetch type=%d url=%s\n", (int)type,
          url ? url : "(null)");
  bool match = url && g_bundle_url.find(url) != std::string::npos;
  if (!match && url) match = std::string(url).find("index.") != std::string::npos
                              && std::string(url).find(".js") != std::string::npos;
  if (match || type == kLynxResourceTypeExternalJSSource ||
      type == kLynxResourceTypeLynxCoreJS) {
    uint8_t *copy = (uint8_t *)std::malloc(g_js_bundle.size());
    std::memcpy(copy, g_js_bundle.data(), g_js_bundle.size());
    lynx_resource_response_set_code(resp, 200);
    lynx_resource_response_set_data(
        resp, copy, g_js_bundle.size(),
        [](uint8_t *p, size_t, void *) { std::free(p); }, nullptr);
    fprintf(stderr, "[spike]   -> served %zu JS bytes\n", g_js_bundle.size());
  } else {
    lynx_resource_response_set_code(resp, 404);
    lynx_resource_response_set_error_message(resp, "not served by host");
  }
  lynx_resource_response_callback(resp);
}

// ── view client callbacks ─────────────────────────────────────────────────
static void OnLoadSuccess(lynx_view_client_t * /*c*/) {
  g_load_success.store(true, std::memory_order_release);
  fprintf(stderr, "[spike] on_load_success\n");
}
static void OnFirstScreen(lynx_view_client_t * /*c*/) {
  g_first_screen.store(true, std::memory_order_release);
  fprintf(stderr, "[spike] on_first_screen\n");
}
static void OnReceivedError(lynx_view_client_t * /*c*/, int code,
                            const char *msg) {
  g_error.store(true, std::memory_order_release);
  fprintf(stderr, "[spike] on_received_error code=%d msg=%s\n", code,
          msg ? msg : "(null)");
}
static void OnRuntimeReady(lynx_view_client_t * /*c*/) {
  g_runtime_ready.store(true, std::memory_order_release);
  fprintf(stderr, "[spike] on_runtime_ready\n");
}

// ── Lynx init (Tauri setup 단계, 메인 스레드에서 1회 호출) ──────────────────
extern "C" int lynx_spike_init(void *parent_nsview, const char *bundle_path,
                               const char *icu_path) {
  // Rust FFI 패키지 등록 — Apple 은 자동 등록되지만 Windows/ELF 는 명시 필요(위 참조).
  rustra_calculator_init();
  fprintf(stderr, "[spike] rustra_calculator_init() (explicit, cross-platform)\n");

  resolve_liblynx_symbols();

  // 1. Bind Lynx UIThread to THIS thread(Tauri 메인 루프 스레드)의 fml::MessageLoop.
  //    lynx_spike_pump() 도 같은 스레드(MainEventsCleared)에서 호출되므로 일관.
  if (g_ui_thread_init) {
    g_ui_thread_init(nullptr);
    fprintf(stderr, "[spike] base::UIThread::Init() bound to main thread\n");
  }

  // 2. Env: ICU + RustraModule 등록(native module + extension module).
  lynx_env_set_icu_data_path(icu_path);
  fprintf(stderr, "[spike] Lynx SDK %s, icu=%s\n", lynx_env_get_sdk_version(),
          lynx_env_get_icu_data_path());
  lynx_env_register_native_module("RustraModule", RustraModuleCreator, nullptr);
  lynx_env_register_extension_module("RustraModule", RustraExtCreator,
                                     /*is_lazy_create=*/0, nullptr);

  // 3. Build view. 경로 A: windowless renderer 없이 SetParent(parent_nsview).
  lynx_view_builder_t *builder = lynx_view_builder_create();
  lynx_view_builder_set_screen_size(builder, 390.f, 844.f, 2.0f);
  lynx_view_builder_set_frame(builder, 0.f, 0.f, 390.f, 844.f);
  lynx_view_builder_set_icu_data_path(builder, icu_path);
  lynx_view_builder_set_parent(builder, (NativeWindow)parent_nsview);
  lynx_view_builder_register_native_module(builder, "RustraModule",
                                           RustraModuleCreator, nullptr);

  lynx_generic_resource_fetcher_t *fetcher =
      lynx_generic_resource_fetcher_create(nullptr);
  lynx_generic_resource_fetcher_bind_fetch_resource(fetcher, FetchResource);
  lynx_view_builder_set_generic_resource_fetcher(builder, fetcher);

  g_view = lynx_view_create(builder, nullptr);

  lynx_view_client_t *client = lynx_view_client_create(nullptr);
  lynx_view_client_bind_on_load_success(client, OnLoadSuccess);
  lynx_view_client_bind_on_first_screen(client, OnFirstScreen);
  lynx_view_client_bind_on_runtime_ready(client, OnRuntimeReady);
  lynx_view_client_bind_on_received_error(client, OnReceivedError);
  lynx_view_add_client(g_view, client);

  // 4. Load the rspeedy .lynx.bundle.
  std::ifstream bf(bundle_path, std::ios::binary);
  if (!bf) {
    fprintf(stderr, "[spike] cannot open bundle %s\n", bundle_path);
    return 2;
  }
  g_js_bundle.assign((std::istreambuf_iterator<char>(bf)),
                     std::istreambuf_iterator<char>());
  g_bundle_url = bundle_path;
  fprintf(stderr, "[spike] bundle %s: %zu bytes\n", bundle_path,
          g_js_bundle.size());

  lynx_load_meta_t *meta = lynx_load_meta_create();
  lynx_load_meta_set_url(meta, bundle_path);
  lynx_load_meta_set_binary_data(
      meta, g_js_bundle.data(), g_js_bundle.size(),
      [](uint8_t *, size_t, void *) {}, nullptr);
  lynx_view_load_template(g_view, meta);
  lynx_load_meta_release(meta);

  lynx_view_enter_foreground(g_view);
  fprintf(stderr, "[spike] lynx_view_enter_foreground\n");
  return 0;
}

// Tauri MainEventsCleared 에서 매 틱 호출 — BTS/runtime 메시지 루프 전진.
extern "C" int lynx_spike_summary();  // 아래 정의; pump 의 주기 출력용 전방 선언.
static std::atomic<int> g_pump_ticks{0};
extern "C" void lynx_spike_pump() {
  if (!g_view) return;
  pump_fml_message_loop();
  int n = g_pump_ticks.fetch_add(1, std::memory_order_relaxed) + 1;
  // first_screen 후 약 2초(120 틱 @16ms)에 summary 1회, 이후 600틱마다 재출력.
  if (g_first_screen.load() && (n == 120 || (n > 120 && n % 600 == 0))) {
    lynx_spike_summary();
  }
}

extern "C" int lynx_spike_summary() {
  fprintf(stderr,
          "[spike] SUMMARY load=%d firstscreen=%d rtready=%d error=%d "
          "invocations=%d resultAcked=%d val=%d\n",
          (int)g_load_success.load(), (int)g_first_screen.load(),
          (int)g_runtime_ready.load(), (int)g_error.load(),
          g_invoke_count.load(), g_results_acked.load(),
          g_result_value.load());

  // host 측 invokeRkyvV2 핸들러 본체(진입→리턴) 타이밍 — end-to-end(JS) 와 대조.
  // 이 구간 = N-API 인자 언팩 + Rust FFI + 응답 ArrayBuffer 빌드. JS 측 배치 avg 와의
  // 차이가 QuickJS↔N-API 경계 + Promise 마이크로태스크 스케줄링 오버헤드.
  std::vector<double> times;
  {
    std::lock_guard<std::mutex> lk(g_invoke_times_mtx);
    times = g_invoke_times_ns;
  }
  if (!times.empty()) {
    std::sort(times.begin(), times.end());
    double sum = 0;
    for (double t : times) sum += t;
    double avg = sum / static_cast<double>(times.size());
    auto pct = [&](double q) -> double {
      size_t idx = static_cast<size_t>((q / 100.0) * times.size());
      if (idx >= times.size()) idx = times.size() - 1;
      return times[idx];
    };
    fprintf(stderr,
            "[bench] host.n=%zu host.avg_ns=%.0f host.p50_ns=%.0f "
            "host.p99_ns=%.0f\n",
            times.size(), avg, pct(50.0), pct(99.0));
  }
  return (int)g_results_acked.load();
}
