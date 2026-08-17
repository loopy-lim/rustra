// rustra runner 템플릿 — desktop surface integration, Windows 포팅 (경로 A, SetParent).
//
// lynx_desktop.mm 의 Windows 등가. WINDOWS.md 의 3포인트 포팅 가이드 구현체:
//   포인트 1 — SetParent HWND: main.rs Win32 분기가 이미 전달 (NativeWindow=HWND).
//   포인트 2 — 명시 rustra_template_init(): PE 에는 __mod_init_func 가 없다.
//   포인트 3 — FML 심볼 해석: GetProcAddress(최선) → PE 오프셋(fallback) 순서.
//
// ⚠️ 컴파일/검증은 Windows 머신 필요 (MSVC + Windows SDK + lynx_sdk_windows_x64).
//    검증 게이트: ../verify-windows.ps1 (6패턴). 이 파일은 Windows 머신 확보 후
//    dumpbin /exports lynx.dll 결과를 보고 FML 오프셋/export 여부를 확정한다.
//    macOS 와 달리 libLynx 심볼이 export 테이블에 있을 수 있다 — 그 경우
//    오프셋 핵이 아니라 GetProcAddress 정식 경로로 해결된다 (ABI 부채 없음).
//
// libLynx.dll 의 경로: Lynx SDK 설치 디렉터리를 LYNX_SDK 환경변수로 받는다
// (build.rs 의 Windows 분기와 동일 규약). LoadLibraryW 로 명시 로드.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <atomic>
#include <fstream>
#include <string>
#include <vector>

#include <windows.h>

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

// ── Rust FFI (rustra-template-backend staticlib) ───────────────────────────
extern "C" {
const uint8_t *rustra_template_invoke_rkyv_v2(const uint8_t *payload,
                                              size_t len, size_t *out_len);
void rustra_template_free_buffer(void *ptr, size_t len);
// PE 생성자가 없으므로 init 시작부에서 명시 호출 (포인트 2).
void rustra_template_init(void);
void rustra_template_register_desktop_registry(void);
}

// ── globals ───────────────────────────────────────────────────────────────
static std::atomic<bool> g_load_success{false};
static std::atomic<bool> g_first_screen{false};
static std::atomic<bool> g_error{false};
static std::atomic<bool> g_runtime_ready{false};
static std::atomic<int> g_invoke_count{0};
static std::atomic<int> g_results_acked{0};

static lynx_view_t *g_view = nullptr;
static lynx_extension_module_t *g_ext_module = nullptr;
static HMODULE g_lynx_dll = nullptr;

// ── fml::MessageLoop pump (포인트 3: export 조회 → PE 오프셋 fallback) ─────
typedef void *(*FmlIsInitFn)(void);
typedef void (*FmlRunExpiredFn)(void *impl);
typedef void (*UiThreadInitFn)(void *platform_loop);
static FmlIsInitFn g_fml_is_init = nullptr;
static FmlRunExpiredFn g_fml_run_expired = nullptr;
static UiThreadInitFn g_ui_thread_init = nullptr;

// Windows SDK lynx.dll 에서 심볼을 해석한다.
//   1차 — GetProcAddress 정식 export 조회(이름은 dumpbin 으로 확정 필요;
//         후보: fml::MessageLoop::IsInit / RunExpired, base::UIThread::Init).
//   2차 — PE image base + 오프셋 핵(macOS 와 동일 기법, ABI-pinned).
// dumpbin 결과에 따라 kFmlIsInitExportName 등을 확정한다. 오프셋은
// SDK 4.0.1 x64 바이너리에서 dumpbin/objdump 로 재추출해 채운다 —
// 현재 0 은 "미확정" 을 의미한다 (확정 전까지 pump 비활성, 정직한 실패).
static constexpr const char *kLynxDllName = "lynx.dll";
static constexpr const char *kFmlIsInitExportName = nullptr;   // dumpbin 으로 확정
static constexpr const char *kFmlRunExpiredExportName = nullptr;
static constexpr const char *kUiThreadInitExportName = nullptr;
static constexpr uintptr_t kFmlIsInitOffset = 0;    // PE 오프셋 fallback (미확정)
static constexpr uintptr_t kFmlRunExpiredOffset = 0;
static constexpr uintptr_t kUiThreadInitOffset = 0;

static void resolve_liblynx_symbols() {
  // lynx.dll 은 프로세스에 이미 로드돼 있을 수 있다(링크된 경우). 우선 확인.
  g_lynx_dll = GetModuleHandleA(kLynxDllName);
  if (!g_lynx_dll) {
    // LYNX_SDK 디렉터리에서 명시 로드 시도.
    const char *sdk = std::getenv("LYNX_SDK");
    if (sdk) {
      std::string path = std::string(sdk) + "\\bin\\" + kLynxDllName;
      g_lynx_dll = LoadLibraryA(path.c_str());
    }
  }
  if (!g_lynx_dll) {
    fprintf(stderr, "[template] WARNING: %s not loaded — FML pump disabled\n",
            kLynxDllName);
    return;
  }

  // 1차: 정식 export 조회 (이름이 확정된 경우에만).
  if (kFmlIsInitExportName)
    g_fml_is_init = reinterpret_cast<FmlIsInitFn>(
        GetProcAddress(g_lynx_dll, kFmlIsInitExportName));
  if (kFmlRunExpiredExportName)
    g_fml_run_expired = reinterpret_cast<FmlRunExpiredFn>(
        GetProcAddress(g_lynx_dll, kFmlRunExpiredExportName));
  if (kUiThreadInitExportName)
    g_ui_thread_init = reinterpret_cast<UiThreadInitFn>(
        GetProcAddress(g_lynx_dll, kUiThreadInitExportName));

  // 2차: PE image base + 오프셋 (오프셋이 확정된 경우에만).
  uintptr_t base = reinterpret_cast<uintptr_t>(g_lynx_dll);
  if (!g_fml_is_init && kFmlIsInitOffset)
    g_fml_is_init = reinterpret_cast<FmlIsInitFn>(base + kFmlIsInitOffset);
  if (!g_fml_run_expired && kFmlRunExpiredOffset)
    g_fml_run_expired =
        reinterpret_cast<FmlRunExpiredFn>(base + kFmlRunExpiredOffset);
  if (!g_ui_thread_init && kUiThreadInitOffset)
    g_ui_thread_init =
        reinterpret_cast<UiThreadInitFn>(base + kUiThreadInitOffset);

  fprintf(stderr,
          "[template] resolved %s @%p: IsInit=%p RunExpired=%p UIThreadInit=%p "
          "(export=%s)\n",
          kLynxDllName, (void *)g_lynx_dll, (void *)g_fml_is_init,
          (void *)g_fml_run_expired, (void *)g_ui_thread_init,
          kFmlIsInitExportName ? "yes" : "offset/undetermined");
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

// ── N-API native module (lynx_desktop.mm 과 동일 — USE_WEAK_SUFFIX_NAPI) ──
static napi_value_weak InvokeRkyvV2(napi_env_weak env,
                                    napi_callback_info_weak info) {
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
      rustra_template_invoke_rkyv_v2((const uint8_t *)data, len, &out_len);
  fprintf(stderr, "[template] invokeRkyvV2: in=%zu out=%zu ok=%u\n", len,
          out_len, out ? (unsigned)out[0] : 0xff);

  napi_value_weak result = nullptr;
  void *dest = nullptr;
  napi_create_arraybuffer_weak(env, out_len, &dest, &result);
  std::memcpy(dest, out, out_len);
  rustra_template_free_buffer((void *)out, out_len);
  return result;
}

static napi_value_weak AckResult(napi_env_weak env,
                                 napi_callback_info_weak info) {
  size_t argc = 1;
  napi_value_weak args[1] = {nullptr};
  napi_get_cb_info_weak(env, info, &argc, args, nullptr, nullptr);
  if (argc >= 1) {
    int32_t v = -777;
    napi_get_value_int32_weak(env, args[0], &v);
    fprintf(stderr, "[template] ackResult val=%d\n", v);
  }
  g_results_acked.fetch_add(1, std::memory_order_relaxed);
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
  fprintf(stderr, "[template] RustraModule native module registered (N-API)\n");
  return exports;
}

// ── extension-module: BTS-thread NativeModules injector (vsync 패턴) ──────
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
  fprintf(stderr, "[template] %s: install RustraModule (NativeModules %s)\n",
          hook, created ? "ABSENT->created" : "present");
}

static void OnExtRuntimeAttach(lynx_extension_module_t * /*self*/,
                               napi_env_weak env,
                               lynx_vsync_observer_t * /*vso*/) {
  napi_value_weak global = nullptr;
  napi_get_global_weak(env, &global);
  InstallRustraNative(env, global, "runtime_attach");
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
  fprintf(stderr, "[template] extension module created (attach+ready bound)\n");
  return m;
}

// ── generic resource fetcher ───────────────────────────────────────────────
static std::vector<uint8_t> g_js_bundle;
static std::string g_bundle_url;

static void FetchResource(lynx_generic_resource_fetcher_t * /*f*/,
                          lynx_resource_request_t *req,
                          lynx_resource_response_t *resp) {
  const char *url = lynx_resource_request_get_url(req);
  lynx_resource_type_e type = lynx_resource_request_get_type(req);
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
  } else {
    lynx_resource_response_set_code(resp, 404);
    lynx_resource_response_set_error_message(resp, "not served by host");
  }
  lynx_resource_response_callback(resp);
}

// ── view client callbacks ─────────────────────────────────────────────────
static void OnLoadSuccess(lynx_view_client_t * /*c*/) {
  g_load_success.store(true, std::memory_order_release);
  fprintf(stderr, "[template] on_load_success\n");
}
static void OnFirstScreen(lynx_view_client_t * /*c*/) {
  g_first_screen.store(true, std::memory_order_release);
  fprintf(stderr, "[template] on_first_screen\n");
}
static void OnReceivedError(lynx_view_client_t * /*c*/, int code,
                            const char *msg) {
  g_error.store(true, std::memory_order_release);
  fprintf(stderr, "[template] on_received_error code=%d msg=%s\n", code,
                          msg ? msg : "(null)");
}

// ── Lynx init (Tauri setup 단계, 메인 스레드에서 1회 호출) ──────────────────
extern "C" int lynx_template_init(void *parent_native_window,
                                  const char *bundle_path,
                                  const char *icu_path) {
  rustra_template_init();  // 포인트 2: PE 생성자 없음 → 명시 등록
  fprintf(stderr, "[template] rustra_template_init() (explicit, cross-platform)\n");
  rustra_template_register_desktop_registry();
  fprintf(stderr, "[template] desktop capability registry registered\n");

  resolve_liblynx_symbols();

  if (g_ui_thread_init) {
    g_ui_thread_init(nullptr);
    fprintf(stderr, "[template] base::UIThread::Init() bound to main thread\n");
  }

  lynx_env_set_icu_data_path(icu_path);
  fprintf(stderr, "[template] Lynx SDK %s, icu=%s\n",
          lynx_env_get_sdk_version(), lynx_env_get_icu_data_path());
  lynx_env_register_native_module("RustraModule", RustraModuleCreator, nullptr);
  lynx_env_register_extension_module("RustraModule", RustraExtCreator,
                                     /*is_lazy_create=*/0, nullptr);

  lynx_view_builder_t *builder = lynx_view_builder_create();
  lynx_view_builder_set_screen_size(builder, 390.f, 844.f, 2.0f);
  lynx_view_builder_set_frame(builder, 0.f, 0.f, 390.f, 844.f);
  lynx_view_builder_set_icu_data_path(builder, icu_path);
  lynx_view_builder_set_parent(builder, (NativeWindow)parent_native_window);  // HWND
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
  lynx_view_client_bind_on_runtime_ready(
      client, [](lynx_view_client_t *) {
        g_runtime_ready.store(true, std::memory_order_release);
        fprintf(stderr, "[template] on_runtime_ready\n");
      });
  lynx_view_client_bind_on_received_error(client, OnReceivedError);
  lynx_view_add_client(g_view, client);

  std::ifstream bf(bundle_path, std::ios::binary);
  if (!bf) {
    fprintf(stderr, "[template] cannot open bundle %s\n", bundle_path);
    return 2;
  }
  g_js_bundle.assign((std::istreambuf_iterator<char>(bf)),
                     std::istreambuf_iterator<char>());
  g_bundle_url = bundle_path;
  fprintf(stderr, "[template] bundle %s: %zu bytes\n", bundle_path,
          g_js_bundle.size());

  lynx_load_meta_t *meta = lynx_load_meta_create();
  lynx_load_meta_set_url(meta, bundle_path);
  lynx_load_meta_set_binary_data(
      meta, g_js_bundle.data(), g_js_bundle.size(),
      [](uint8_t *, size_t, void *) {}, nullptr);
  lynx_view_load_template(g_view, meta);
  lynx_load_meta_release(meta);

  lynx_view_enter_foreground(g_view);
  fprintf(stderr, "[template] lynx_view_enter_foreground\n");
  return 0;
}

extern "C" int lynx_template_summary();
static std::atomic<int> g_pump_ticks{0};
extern "C" void lynx_template_pump() {
  if (!g_view) return;
  pump_fml_message_loop();
  int n = g_pump_ticks.fetch_add(1, std::memory_order_relaxed) + 1;
  if (g_first_screen.load() && (n == 120 || (n > 120 && n % 600 == 0))) {
    lynx_template_summary();
  }
}

extern "C" int lynx_template_summary() {
  fprintf(stderr,
          "[template] SUMMARY load=%d firstscreen=%d rtready=%d error=%d "
          "invocations=%d resultAcked=%d\n",
          (int)g_load_success.load(), (int)g_first_screen.load(),
          (int)g_runtime_ready.load(), (int)g_error.load(),
          g_invoke_count.load(), g_results_acked.load());
  return (int)g_results_acked.load();
}
