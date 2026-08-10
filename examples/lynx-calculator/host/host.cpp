// rustra-bridge × Lynx — headless render + screenshot harness.
//
// Loads the rspeedy-built ReactLynx bundle into the real Lynx engine
// (libLynx.dylib, software windowless renderer), registers a N-API native
// module "RustraModule" whose invokeRkyvV2() calls the Rust rkyv V2 FFI,
// renders to an offscreen surface, and dumps the first presented frame to a
// raw pixel file (converted to PNG separately).
//
// Driving model (mirrors oliver/node-lynx's proven FmlMessageLoopPump):
//   1. base::UIThread::Init() on the host (main) thread → binds the Lynx
//      UIThread to THIS thread's fml::MessageLoop.
//   2. create view, load bundle, enter_foreground.
//   3. pump loop: drain the Clay headless-engine task channel (renderer
//      on_post_task → run_task) AND pump the bound fml::MessageLoop via
//      MessageLoopImpl::RunExpiredTasksNow() every ~1ms.
//
// The UIThread/MessageLoop C++ symbols are *local* (hidden visibility) in the
// prebuilt libLynx.dylib, so they are resolved at runtime by Mach-O image
// base + fixed offset (offsets verified against the disassembly of this exact
// dylib). This is ABI-pinned to libLynx.dylib SDK 4.0 / engine 3.2.
//
// (USE_WEAK_SUFFIX_NAPI is defined via -D; Lynx's N-API symbols are *_weak.)

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>
#include <thread>
#include <chrono>
#include <vector>
#include <fstream>
#include <atomic>

#include <mach-o/dyld.h>
#include <string.h>

#include "capi/lynx_env_capi.h"
#include "capi/lynx_view_builder_capi.h"
#include "capi/lynx_view_capi.h"
#include "capi/lynx_view_client_capi.h"
#include "capi/lynx_load_meta_capi.h"
#include "capi/lynx_windowless_renderer_capi.h"
#include "capi/lynx_native_module_capi.h"
#include "capi/lynx_extension_module_capi.h"
#include "capi/lynx_extension_module_types_capi.h"
#include "capi/lynx_generic_resource_fetcher_capi.h"
#include "capi/lynx_resource_request_capi.h"
#include "capi/lynx_resource_response_capi.h"
#include "capi/lynx_vsync_monitor_capi.h"

// ── Rust FFI (rustra-calculator-example staticlib) ────────────────────────
extern "C" {
const uint8_t *rustra_calculator_invoke_rkyv_v2(const uint8_t *payload,
                                                size_t len, size_t *out_len);
void rustra_calculator_free_buffer(void *ptr, size_t len);
}

// ── Task 7: native window/surface (AppKit bridge in host_ui.mm) ────────────
// The windowless software renderer gives us an RGBA buffer per frame; these
// blit it into a real NSWindow. All calls happen on the main (pump) thread.
extern "C" {
void rustra_ui_init(uint32_t pixel_w, uint32_t pixel_h);
void rustra_ui_blit(const uint8_t *rgba, uint32_t pixel_w, uint32_t pixel_h);
void rustra_ui_poll_events(void);
bool rustra_ui_should_close(void);
bool rustra_ui_dump_layer_png(const char *path);
void rustra_ui_request_close(void);
}

#include <csignal>
// SIGTERM/SIGINT → graceful window close so the pump loop exits cleanly and the
// post-loop dumps (layer PNG, frame.raw) still run.
static void on_signal(int) { rustra_ui_request_close(); }

// ── globals: captured frame + sync ────────────────────────────────────────
static std::mutex g_mtx;
static std::vector<uint8_t> g_pixels;
static size_t g_row_bytes = 0;
static size_t g_height = 0;
static std::atomic<bool> g_presented{false};
static std::atomic<bool> g_load_success{false};
static std::atomic<bool> g_first_screen{false};
static std::atomic<bool> g_error{false};
static std::atomic<int> g_invoke_count{0};
static std::atomic<int> g_r_posted{0}, g_r_run{0};
static std::atomic<bool> g_runtime_ready{false};
static lynx_windowless_renderer_t *g_renderer = nullptr;

// Task 7: when true, blit each presented frame into a real NSWindow and keep
// the window open (until close / deadline) instead of the headless settle-exit.
static bool g_window_mode = false;

// ── event push (Rust/host → ReactLynx) ────────────────────────────────────
// The host ticker posts TickTask to the BTS runtime via the extension module;
// TickTask calls the JS listener registered via RustraModule.subscribeTick.
static lynx_extension_module_t *g_ext_module = nullptr;
static lynx_vsync_observer_t *g_vsync_observer = nullptr;
static napi_env_weak g_bts_env = nullptr;
static napi_ref_weak g_tick_ref = nullptr;
static std::atomic<int> g_tick_count{0};
static std::atomic<int> g_ticks_delivered{0};
static std::atomic<int> g_ticks_acked{0};  // JS confirm: ackTick() calls
static std::atomic<int> g_results_acked{0};
static std::atomic<int> g_result_value{-999};  // value JS acked (proves no-fallback)

static uint64_t now_ns() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

// ── task queue: Clay headless-engine (renderer) task channel ──────────────
// The Clay headless engine posts raster/commit tasks via on_post_task; we run
// them via lynx_windowless_renderer_run_task. The Lynx UIThread's own tasks
// are pumped separately via the fml::MessageLoop pump below.
struct QueuedTask {
  lynx_task_t task;
  uint64_t due_ns;
};
static std::mutex g_task_mtx;
static std::vector<QueuedTask> g_tasks;

static void enqueue_task(lynx_task_t task, uint64_t interval_ns) {
  g_r_posted.fetch_add(1, std::memory_order_relaxed);
  std::lock_guard<std::mutex> lk(g_task_mtx);
  g_tasks.push_back({task, now_ns() + interval_ns});
}

// ── fml::MessageLoop pump (resolved by offset from libLynx.dylib) ──────────
// libLynx.dylib hides (local visibility) the C++ MessageLoop/UIThread symbols,
// so we resolve three functions by Mach-O image base + offset. Offsets are
// pinned to this dylib build (SDK 4.0 / engine 3.2) and were verified by
// disassembly:
//   IsInitializedForCurrentThread @ 0x3ecc : static, returns MessageLoop*
//   MessageLoopImpl::RunExpiredTasksNow   @ 0x43a4 : virtual dispatch, this=x0
//   UIThread::Init(void*)                 @ 0x9329bc: if !HasInit, binds
//                                                  UIThread to current thread's
//                                                  fml::MessageLoop (nullptr →
//                                                  default posix loop).
// MessageLoop layout (per Run/Terminate disasm): impl_ lives at offset 0,
// i.e. impl = *(void**)message_loop.
typedef void *(*FmlIsInitFn)(void);
typedef void (*FmlRunExpiredFn)(void *impl);
typedef void (*UiThreadInitFn)(void *platform_loop);
static FmlIsInitFn g_fml_is_init = nullptr;
static FmlRunExpiredFn g_fml_run_expired = nullptr;
static UiThreadInitFn g_ui_thread_init = nullptr;
static std::atomic<long> g_fml_checks{0}, g_fml_pumped{0};

static void resolve_liblynx_symbols() {
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *name = _dyld_get_image_name(i);
    if (!name || !strstr(name, "libLynx")) continue;
    const struct mach_header *hdr = _dyld_get_image_header(i);
    // __TEXT vmaddr == 0 for this PIE dylib, so symbol_addr = hdr + offset.
    auto at = [&](uintptr_t off) -> void * {
      return reinterpret_cast<void *>(reinterpret_cast<uintptr_t>(hdr) + off);
    };
    g_fml_is_init = reinterpret_cast<FmlIsInitFn>(at(0x3ecc));
    g_fml_run_expired = reinterpret_cast<FmlRunExpiredFn>(at(0x43a4));
    g_ui_thread_init = reinterpret_cast<UiThreadInitFn>(at(0x9329bc));
    fprintf(stderr,
            "[rustra] resolved libLynx @%p: IsInit=%p RunExpired=%p "
            "UIThreadInit=%p\n",
            (void *)hdr, (void *)g_fml_is_init, (void *)g_fml_run_expired,
            (void *)g_ui_thread_init);
    return;
  }
  fprintf(stderr,
          "[rustra] WARNING: libLynx not found among %u dyld images — FML "
          "pump disabled (pipeline will stall)\n",
          _dyld_image_count());
}

// Drain the current thread's fml::MessageLoop. Must be called on the SAME
// thread that ran UIThread::Init() (the UIThread's owner). Returns true if a
// loop was found and pumped.
static bool pump_fml_message_loop() {
  if (!g_fml_is_init || !g_fml_run_expired) return false;
  g_fml_checks.fetch_add(1, std::memory_order_relaxed);
  void *ml = g_fml_is_init();  // MessageLoop::IsInitializedForCurrentThread()
  if (!ml) return false;
  void *impl = *reinterpret_cast<void **>(ml);  // impl_ at offset 0
  if (!impl) return false;
  g_fml_run_expired(impl);  // MessageLoopImpl::RunExpiredTasksNow()
  g_fml_pumped.fetch_add(1, std::memory_order_relaxed);
  return true;
}

// ── N-API native module: RustraModule.invokeRkyvV2(ArrayBuffer) → ArrayBuffer
static napi_value_weak InvokeRkyvV2(napi_env_weak env,
                                    napi_callback_info_weak info) {
  g_invoke_count.fetch_add(1, std::memory_order_relaxed);
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    fprintf(stderr, "[rustra] invokeRkyvV2: no payload arg\n");
    return nullptr;
  }
  void *data = nullptr;
  size_t len = 0;
  napi_get_arraybuffer_info_weak(env, args[0], &data, &len);

  size_t out_len = 0;
  const uint8_t *out =
      rustra_calculator_invoke_rkyv_v2((const uint8_t *)data, len, &out_len);
  // rkyv V2 response layout: [ok:u8][7B pad][postcard Output]. ok==1 ⇒ the
  // Rust command succeeded; this is the no-fallback proof that the result
  // round-tripped to JS (distinguishes success from the JS .catch fallback).
  fprintf(stderr,
          "[rustra] invokeRkyvV2: in=%zu out=%zu ok=%u\n", len, out_len,
          out ? (unsigned)out[0] : 0xff);

  napi_value_weak result = nullptr;
  void *dest = nullptr;
  napi_create_arraybuffer_weak(env, out_len, &dest, &result);
  std::memcpy(dest, out, out_len);
  rustra_calculator_free_buffer((void *)out, out_len);
  return result;
}

// ── event push: RustraModule.subscribeTick(cb) ────────────────────────────
// JS registers a tick listener; we hold it as a strong napi_ref and remember
// the BTS env so TickTask (posted via lynx_extension_module_post_task_to_runtime)
// can invoke it on the BTS thread.
static napi_value_weak SubscribeTick(napi_env_weak env,
                                     napi_callback_info_weak info) {
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    fprintf(stderr, "[rustra] subscribeTick: no callback arg\n");
    return nullptr;
  }
  if (g_tick_ref) napi_delete_reference_weak(env, g_tick_ref);
  napi_create_reference_weak(env, args[0], 1, &g_tick_ref);
  g_bts_env = env;
  fprintf(stderr, "[rustra] subscribeTick: listener installed (env=%p)\n",
          (void *)env);
  return nullptr;
}

// JS→native ack: the tick listener calls this to confirm receipt. Comparing
// delivered vs acked proves the JS callback actually executed (criterion 10).
static napi_value_weak AckTick(napi_env_weak /*env*/,
                               napi_callback_info_weak /*info*/) {
  g_ticks_acked.fetch_add(1, std::memory_order_relaxed);
  return nullptr;
}

// JS→native ack for the invoke result. The App calls ackResult(out) inside the
// addNumbers().then() — i.e. ONLY on the success path, with the decoded Rust
// value. resultAcked=1 val=42 proves the Rust result reached JS without the
// catch() fallback firing (the fallback never calls ackResult). This is the
// non-visual, no-fallback proof that complements ok=1/out=9.
static napi_value_weak AckResult(napi_env_weak env,
                                 napi_callback_info_weak info) {
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc >= 1) {
    int32_t v = -777;
    napi_get_value_int32_weak(env, args[0], &v);
    g_result_value.store(v, std::memory_order_relaxed);
  }
  g_results_acked.fetch_add(1, std::memory_order_relaxed);
  return nullptr;
}

// Runs ON the BTS thread (scheduled by lynx_extension_module_post_task_to_runtime).
// Calls the registered JS tick listener with an incrementing counter — the
// Rust/host → ReactLynx event-push path.
static void TickTask(void * /*user_data*/) {
  fprintf(stderr, "[rustra] TickTask: ran on bts=%d ref=%d env=%d\n",
          g_ext_module ? (int)lynx_extension_module_is_running_on_bts_thread(
                             g_ext_module)
                       : -1,
          g_tick_ref ? 1 : 0, g_bts_env ? 1 : 0);
  if (!g_tick_ref || !g_bts_env) return;
  napi_value_weak cb = nullptr;
  napi_get_reference_value_weak(g_bts_env, g_tick_ref, &cb);
  if (!cb) return;
  int n = g_tick_count.fetch_add(1, std::memory_order_relaxed) + 1;
  napi_value_weak global = nullptr, num = nullptr, result = nullptr;
  napi_get_global_weak(g_bts_env, &global);
  napi_create_int32_weak(g_bts_env, n, &num);
  napi_status_weak s =
      napi_call_function_weak(g_bts_env, global, cb, 1, &num, &result);
  g_ticks_delivered.fetch_add(1, std::memory_order_relaxed);
  fprintf(stderr, "[rustra] TickTask: delivered n=%d call_status=%d\n", n,
          (int)s);
}

// VSync-driven tick: scheduled via lynx_vsync_observer_request_animation_frame.
// The VSyncMonitor wakes the BTS per frame, so this callback reaches the runtime
// even when the view is idle (unlike post_task_to_runtime in this headless host).
// Fires on the BTS thread; calls the registered JS tick listener.
static void VsyncTickCb(void * /*user_data*/, int64_t /*ts1*/,
                        int64_t /*ts2*/) {
  int on_bts = g_ext_module
                   ? (int)lynx_extension_module_is_running_on_bts_thread(g_ext_module)
                   : -1;
  fprintf(stderr, "[rustra] VsyncTickCb: on_bts=%d ref=%d env=%d\n", on_bts,
          g_tick_ref ? 1 : 0, g_bts_env ? 1 : 0);
  if (!g_tick_ref || !g_bts_env) return;
  napi_value_weak cb = nullptr;
  napi_get_reference_value_weak(g_bts_env, g_tick_ref, &cb);
  if (!cb) return;
  int n = g_tick_count.fetch_add(1, std::memory_order_relaxed) + 1;
  napi_value_weak global = nullptr, num = nullptr, result = nullptr;
  napi_get_global_weak(g_bts_env, &global);
  napi_create_int32_weak(g_bts_env, n, &num);
  napi_status_weak s =
      napi_call_function_weak(g_bts_env, global, cb, 1, &num, &result);
  g_ticks_delivered.fetch_add(1, std::memory_order_relaxed);
  fprintf(stderr, "[rustra] VsyncTickCb: delivered n=%d status=%d\n", n,
          (int)s);
}

static napi_value_weak RustraModuleCreator(napi_env_weak env,
                                           napi_value_weak exports,
                                           const char * /*module_name*/,
                                           void * /*opaque*/) {
  napi_value_weak fn = nullptr;
  napi_create_function_weak(env, "invokeRkyvV2", NAPI_AUTO_LENGTH,
                            InvokeRkyvV2, nullptr, &fn);
  napi_set_named_property_weak(env, exports, "invokeRkyvV2", fn);
  fprintf(stderr, "[rustra] RustraModule native module registered (N-API)\n");
  return exports;
}

// ── extension-module: BTS-thread NativeModules injector ───────────────────
// ReactLynx reads `globalThis.NativeModules.RustraModule` at bundle module-eval
// time and captures it; if it's undefined there, getRustraNative() throws and
// every later invoke fails with "Rustra not configured". The native-module
// path's creator never reaches the BTS global, so we install the module
// ourselves on every BTS lifecycle hook that hands us (env, global).
//
// runtime_ready and runtime_attach both fire on the BTS thread before the
// bundle's module-eval. We install on both to cover whichever realm/timing the
// app JS actually reads from.
static void InstallRustraNative(napi_env_weak env, napi_value_weak global,
                                const char *hook) {
  napi_value_weak exports = nullptr, fn = nullptr;
  napi_create_object_weak(env, &exports);
  napi_create_function_weak(env, "invokeRkyvV2", NAPI_AUTO_LENGTH,
                            InvokeRkyvV2, nullptr, &fn);
  napi_set_named_property_weak(env, exports, "invokeRkyvV2", fn);
  napi_create_function_weak(env, "subscribeTick", NAPI_AUTO_LENGTH,
                            SubscribeTick, nullptr, &fn);
  napi_set_named_property_weak(env, exports, "subscribeTick", fn);
  napi_create_function_weak(env, "ackTick", NAPI_AUTO_LENGTH, AckTick, nullptr,
                            &fn);
  napi_set_named_property_weak(env, exports, "ackTick", fn);
  napi_create_function_weak(env, "ackResult", NAPI_AUTO_LENGTH, AckResult,
                            nullptr, &fn);
  napi_set_named_property_weak(env, exports, "ackResult", fn);

  // Ensure NativeModules exists. runtime_ready/runtime_attach can fire before
  // the framework installs NativeModules; napi_get_named_property returns
  // `undefined` for a missing prop, and a set on undefined silently no-ops
  // (leaving a pending exception). Create it if absent.
  napi_value_weak nm = nullptr;
  napi_get_named_property_weak(env, global, "NativeModules", &nm);
  napi_valuetype_weak vt = napi_undefined_weak;
  napi_typeof_weak(env, nm, &vt);
  bool created = (vt != napi_object_weak);
  if (created) {
    napi_create_object_weak(env, &nm);
    napi_set_named_property_weak(env, global, "NativeModules", nm);
  }
  napi_status_weak s_nm =
      napi_set_named_property_weak(env, nm, "RustraModule", exports);
  // Belt-and-suspenders: also publish on the global directly.
  napi_status_weak s_g =
      napi_set_named_property_weak(env, global, "RustraModule", exports);
  fprintf(stderr,
          "[rustra] %s: install RustraModule (NativeModules %s; status nm=%d "
          "g=%d)\n",
          hook, created ? "ABSENT->created" : "present", (int)s_nm, (int)s_g);
}

static void OnExtRuntimeAttach(lynx_extension_module_t * /*self*/,
                               napi_env_weak env,
                               lynx_vsync_observer_t *vso) {
  napi_value_weak global = nullptr;
  napi_get_global_weak(env, &global);
  InstallRustraNative(env, global, "runtime_attach");
  g_vsync_observer = vso;  // captured so the ticker can schedule BTS callbacks
  g_bts_env = env;
  fprintf(stderr, "[rustra] runtime_attach: vsync_observer=%p env=%p\n",
          (void *)vso, (void *)env);
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
  g_ext_module = m;  // captured so the pump-loop ticker can post tasks to BTS
  fprintf(stderr, "[rustra] extension module created (attach+ready bound)\n");
  return m;
}

// ── renderer callbacks ────────────────────────────────────────────────────
static bool OnSoftwarePresent(lynx_windowless_renderer_t * /*r*/,
                              const void *allocation, size_t row_bytes,
                              size_t height) {
  std::lock_guard<std::mutex> lk(g_mtx);
  size_t n = row_bytes * height;
  g_pixels.assign((const uint8_t *)allocation, (const uint8_t *)allocation + n);
  g_row_bytes = row_bytes;
  g_height = height;
  g_presented.store(true, std::memory_order_release);
  fprintf(stderr, "[lynx] software present: %zux%zu (row_bytes=%zu)\n",
          row_bytes / 4, height, row_bytes);
  return true;
}

// Returns true if the captured frame has any non-black pixels. Lynx's
// windowless renderer emits an initial empty (all-zero) present before the
// VSyncMonitor ticks drive real rasterization, so the host must keep pumping
// past the first present until content actually lands.
static bool frame_has_content() {
  std::lock_guard<std::mutex> lk(g_mtx);
  if (g_pixels.empty()) return false;
  for (size_t i = 0; i + 3 < g_pixels.size(); i += 512) {
    if (g_pixels[i] | g_pixels[i + 1] | g_pixels[i + 2]) return true;
  }
  return false;
}

static void OnPostTask(lynx_windowless_renderer_t * /*r*/, lynx_task_t task,
                       uint64_t interval_ns) {
  enqueue_task(task, interval_ns);
}

// ── generic resource fetcher: serve the rspeedy JS bundle by URL ───────────
static std::vector<uint8_t> g_js_bundle;
static std::string g_bundle_url;

static const char *TypeName(lynx_resource_type_e t) {
  switch (t) {
    case kLynxResourceTypeTemplate: return "Template";
    case kLynxResourceTypeLynxCoreJS: return "LynxCoreJS";
    case kLynxResourceTypeExternalJSSource: return "ExternalJSSource";
    case kLynxResourceTypeExternalByteCode: return "ExternalByteCode";
    case kLynxResourceTypeLazyBundle: return "LazyBundle";
    case kLynxResourceTypeGeneric: return "Generic";
    default: return "Other";
  }
}

static void FetchResource(lynx_generic_resource_fetcher_t * /*f*/,
                          lynx_resource_request_t *req,
                          lynx_resource_response_t *resp) {
  const char *url = lynx_resource_request_get_url(req);
  lynx_resource_type_e type = lynx_resource_request_get_type(req);
  fprintf(stderr, "[rustra] fetch type=%s url=%s\n", TypeName(type),
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
    fprintf(stderr, "[rustra]   -> served %zu JS bytes\n", g_js_bundle.size());
  } else {
    lynx_resource_response_set_code(resp, 404);
    lynx_resource_response_set_error_message(resp, "not served by host");
  }
  lynx_resource_response_callback(resp);
}

// ── view client callbacks ─────────────────────────────────────────────────
static void OnLoadSuccess(lynx_view_client_t * /*c*/) {
  g_load_success.store(true, std::memory_order_release);
  fprintf(stderr, "[lynx] on_load_success\n");
}
static void OnFirstScreen(lynx_view_client_t * /*c*/) {
  g_first_screen.store(true, std::memory_order_release);
  fprintf(stderr, "[lynx] on_first_screen\n");
}
static void OnReceivedError(lynx_view_client_t * /*c*/, int code,
                            const char *msg) {
  g_error.store(true, std::memory_order_release);
  fprintf(stderr, "[lynx] on_received_error code=%d msg=%s\n", code,
          msg ? msg : "(null)");
}
static void OnRuntimeReady(lynx_view_client_t * /*c*/) {
  g_runtime_ready.store(true, std::memory_order_release);
  fprintf(stderr, "[lynx] on_runtime_ready\n");
}
static void OnPageStart(lynx_view_client_t * /*c*/, const char *url) {
  fprintf(stderr, "[lynx] on_page_start url=%s\n", url ? url : "(null)");
}

// ── Lynx driver (runs on the host MAIN thread — the UIThread's owner) ──────
static int LynxMain(const char *bundle_path, const char *out_raw,
                    const char *icu_path) {
  // 1. Bind Lynx UIThread to THIS thread's fml::MessageLoop. Idempotent:
  //    if HasInit is already set (e.g. by an earlier Init), this is a no-op
  //    but the UIThread remains bound to a concrete thread + loop we pump.
  //    Must run on the same thread as the pump loop below.
  if (g_ui_thread_init) {
    g_ui_thread_init(nullptr);
    fprintf(stderr, "[rustra] base::UIThread::Init() bound to main thread\n");
  }

  // 2. Env: ICU + register RustraModule as a global native module.
  lynx_env_set_icu_data_path(icu_path);
  fprintf(stderr, "[rustra] Lynx SDK %s, icu=%s\n",
          lynx_env_get_sdk_version(), lynx_env_get_icu_data_path());
  lynx_env_register_native_module("RustraModule", RustraModuleCreator, nullptr);
  // Extension-module path: runtime_ready fires on the BTS thread with the live
  // global, where we inject NativeModules.RustraModule. Closes the gap where
  // the native-module path never reaches the BTS global.
  lynx_env_register_extension_module("RustraModule", RustraExtCreator,
                                     /*is_lazy_create=*/0, nullptr);

  // 3. Software windowless renderer.
  g_renderer = lynx_windowless_renderer_create_with_finalizer(
      kRendererTypeSoftware, nullptr, nullptr);
  lynx_windowless_renderer_bind_on_software_present(g_renderer,
                                                    OnSoftwarePresent);
  lynx_windowless_renderer_bind_on_post_task(g_renderer, OnPostTask);

  // 4. Build view.
  lynx_view_builder_t *builder = lynx_view_builder_create();
  lynx_view_builder_set_screen_size(builder, 390.f, 844.f, 2.0f);
  lynx_view_builder_set_frame(builder, 0.f, 0.f, 390.f, 844.f);
  lynx_view_builder_set_icu_data_path(builder, icu_path);
  lynx_view_builder_set_windowless_renderer(builder, g_renderer);
  lynx_view_builder_register_native_module(builder, "RustraModule",
                                           RustraModuleCreator, nullptr);

  lynx_generic_resource_fetcher_t *fetcher =
      lynx_generic_resource_fetcher_create(nullptr);
  lynx_generic_resource_fetcher_bind_fetch_resource(fetcher, FetchResource);
  lynx_view_builder_set_generic_resource_fetcher(builder, fetcher);

  lynx_view_t *view = lynx_view_create(builder, nullptr);

  lynx_view_client_t *client = lynx_view_client_create(nullptr);
  lynx_view_client_bind_on_page_start(client, OnPageStart);
  lynx_view_client_bind_on_load_success(client, OnLoadSuccess);
  lynx_view_client_bind_on_first_screen(client, OnFirstScreen);
  lynx_view_client_bind_on_runtime_ready(client, OnRuntimeReady);
  lynx_view_client_bind_on_received_error(client, OnReceivedError);
  lynx_view_add_client(view, client);

  // 5. Load the compiled .lynx.bundle (produced by rspeedy + pluginReactLynx).
  std::ifstream bf(bundle_path, std::ios::binary);
  if (!bf) {
    fprintf(stderr, "[rustra] cannot open bundle %s\n", bundle_path);
    return 2;
  }
  g_js_bundle.assign((std::istreambuf_iterator<char>(bf)),
                     std::istreambuf_iterator<char>());
  g_bundle_url = bundle_path;
  fprintf(stderr, "[rustra] bundle %s: %zu bytes\n", bundle_path,
          g_js_bundle.size());

  {
    lynx_template_bundle_t *tb = lynx_template_bundle_create(
        g_js_bundle.data(), g_js_bundle.size(),
        [](uint8_t *, size_t, void *) {}, nullptr);
    int valid = tb ? lynx_template_bundle_is_valid(tb) : -1;
    const char *err =
        tb ? lynx_template_bundle_get_error_message(tb) : "(null tb)";
    fprintf(stderr, "[rustra] template_bundle valid=%d err=%s\n", valid,
            err ? err : "(null)");
    if (tb) lynx_template_bundle_release(tb);
  }

  lynx_load_meta_t *meta = lynx_load_meta_create();
  lynx_load_meta_set_url(meta, bundle_path);
  lynx_load_meta_set_binary_data(
      meta, g_js_bundle.data(), g_js_bundle.size(),
      [](uint8_t *, size_t, void *) {}, nullptr);
  lynx_view_load_template(view, meta);
  lynx_load_meta_release(meta);

  // 6. Enter foreground — transitions the shell to active (matches
  //    oliver's OnEnterForeground), enabling the frame/render pipeline.
  lynx_view_enter_foreground(view);
  fprintf(stderr, "[rustra] lynx_view_enter_foreground\n");

  // 7. Pump loop. Two task channels are drained each tick:
  //    (a) Clay headless-engine (renderer) tasks via run_task.
  //    (b) Lynx UIThread's fml::MessageLoop via RunExpiredTasksNow.
  //    This is the oliver FmlMessageLoopPump model.
  //
  //    The windowless software renderer emits an initial empty present, then
  //    rasterizes real content once its internal VSyncMonitor ticks (every
  //    ~16ms, delivered through the pumped FML loop). So we must keep pumping
  //    PAST the first present and capture the first frame that has non-zero
  //    pixels — not stop at the empty clear frame.
  const uint64_t deadline =
      now_ns() + (g_window_mode ? 60000000000ull  // 60s: window stays open for live view
                                : 20000000000ull);  // 20s headless hard cap
  // Minimum pump runtime so the event-push ticker (~1 tick/sec, first at +1s)
  // has time to deliver a few ticks before the content-settle early-exit.
  const uint64_t min_run_ns = now_ns() + 4000000000ull;  // 4s floor
  int present_count = 0;
  // Once a content frame is seen, keep capturing for a short settle window so
  // async state updates (e.g. a bridged result landing after first paint) are
  // reflected in the dumped frame.
  uint64_t settle_deadline = 0;
  // rustra event-push ticker: first tick delayed ~1s so JS subscribeTick lands
  // before the first delivery; then ~1 tick/sec.
  uint64_t last_tick_ns = now_ns() + 1000000000ull;
  while (now_ns() < deadline) {
    // (a) renderer task channel
    std::vector<QueuedTask> ready;
    {
      std::lock_guard<std::mutex> lk(g_task_mtx);
      uint64_t t = now_ns();
      for (auto it = g_tasks.begin(); it != g_tasks.end();) {
        if (it->due_ns <= t) {
          ready.push_back(*it);
          it = g_tasks.erase(it);
        } else {
          ++it;
        }
      }
    }
    for (auto &qt : ready) {
      g_r_run.fetch_add(1, std::memory_order_relaxed);
      lynx_windowless_renderer_run_task(g_renderer, qt.task);
    }

    // (b) fml::MessageLoop pump — advances BTS/UI/render-tree tasks and
    //     delivers VSync ticks that drive rasterization.
    pump_fml_message_loop();

    // (c) rustra event-push ticker: every ~1s post a tick to the BTS runtime,
    //     which calls the JS listener (Rust/host → ReactLynx). The BTS task
    //     runs asynchronously on the runtime thread.
    if (g_vsync_observer && now_ns() >= last_tick_ns) {
      last_tick_ns = now_ns() + 1000000000ull;
      fprintf(stderr, "[rustra] ticker: request vsync animation frame\n");
      // Schedule a BTS callback on the next vsync; the VSyncMonitor wakes the
      // runtime per frame so this reaches JS even when the view is idle.
      lynx_vsync_observer_request_animation_frame(g_vsync_observer,
                                                   (uintptr_t)1, VsyncTickCb,
                                                   nullptr);
    }

    // A new present may have landed. Reset the flag so we can detect the next
    // one. On the first content frame, open a settle window; exit once it
    // elapses (g_pixels keeps the latest presented frame).
    if (g_presented.exchange(false, std::memory_order_acq_rel)) {
      ++present_count;
      // Task 7: blit the latest frame into the NSWindow (main thread). The
      // window is created lazily on first present so it matches the frame size.
      if (g_window_mode) {
        std::lock_guard<std::mutex> lk(g_mtx);
        if (g_row_bytes && g_height) {
          uint32_t pw = (uint32_t)(g_row_bytes / 4), ph = (uint32_t)g_height;
          static bool ui_inited = false;
          if (!ui_inited) {
            rustra_ui_init(pw, ph);
            ui_inited = true;
          }
          rustra_ui_blit(g_pixels.data(), pw, ph);
        }
      }
      if (frame_has_content()) {
        if (settle_deadline == 0) {
          settle_deadline = now_ns() + 800000000ull;  // 800ms settle
          fprintf(stderr,
                  "[rustra] content frame after %d present(s); settling 800ms "
                  "for async state.\n",
                  present_count);
        }
      } else if (present_count >= 60) {
        // Safety valve: keep emitting empty frames with no content.
        fprintf(stderr,
                "[rustra] %d empty presents with no content; giving up.\n",
                present_count);
        break;
      }
    }
    if (!g_window_mode && settle_deadline != 0 &&
        now_ns() >= settle_deadline && now_ns() >= min_run_ns) {
      g_presented.store(true, std::memory_order_release);
      fprintf(stderr, "[rustra] settle complete; captured %d presents total.\n",
              present_count);
      break;
    }
    // Task 7: keep the NSWindow live by draining AppKit events without blocking,
    // and exit when the user closes the window. Coexists with the FML pump.
    if (g_window_mode) {
      rustra_ui_poll_events();
      if (rustra_ui_should_close()) {
        fprintf(stderr, "[rustra] window closed by user.\n");
        break;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  // Task 7: dump the window's layer contents (the displayed surface) to a PNG,
  // so the on-screen content can be verified without cross-process capture.
  if (g_window_mode) {
    const char *png = getenv("RUSTRA_LAYER_PNG");
    if (png && rustra_ui_dump_layer_png(png)) {
      fprintf(stderr, "[rustra] dumped window layer surface -> %s\n", png);
    }
  }

  // 8. Dump captured frame.
  {
    std::lock_guard<std::mutex> lk(g_mtx);
    std::ofstream of(out_raw, std::ios::binary);
    uint32_t w = (uint32_t)(g_row_bytes / 4);
    uint32_t h = (uint32_t)g_height;
    of.write(reinterpret_cast<const char *>(&w), 4);
    of.write(reinterpret_cast<const char *>(&h), 4);
    if (!g_pixels.empty())
      of.write((const char *)g_pixels.data(), g_pixels.size());
    fprintf(stderr,
            "[rustra] wrote %s (%ux%u) presented=%d load=%d firstscreen=%d "
            "rtready=%d error=%d invocations=%d resultAcked=%d val=%d "
            "ticks=%d/%d acked=%d | renderer "
            "posted/run=%d/%d fml checks/pumped=%ld/%ld\n",
            out_raw, w, h, (int)g_presented.load(),
            (int)g_load_success.load(), (int)g_first_screen.load(),
            (int)g_runtime_ready.load(), (int)g_error.load(),
            g_invoke_count.load(), g_results_acked.load(),
            g_result_value.load(), g_ticks_delivered.load(),
            g_tick_count.load(), g_ticks_acked.load(), g_r_posted.load(),
            g_r_run.load(),
            g_fml_checks.load(), g_fml_pumped.load());
  }

  lynx_view_release(view);
  lynx_view_client_release(client);
  lynx_windowless_renderer_release(g_renderer);
  return 0;
}

// ── main ──────────────────────────────────────────────────────────────────
int main(int argc, char **argv) {
  const char *bundle_path =
      argc > 1 ? argv[1] : "dist/static/js/index.js";
  const char *out_raw = argc > 2 ? argv[2] : "frame.raw";
  const char *icu_path = argc > 3 ? argv[3] : "data/icudtl.dat";

  // Resolve the hidden fml/UIThread symbols BEFORE driving Lynx, then run the
  // whole pipeline on THIS (main) thread so the UIThread's MessageLoop is the
  // one we pump.
  resolve_liblynx_symbols();
  g_window_mode = (getenv("RUSTRA_WINDOW") != nullptr);
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  return LynxMain(bundle_path, out_raw, icu_path);
}
