// rustra runner 템플릿 Lynx Android JNI.
// Kotlin RustraModule.nativeInvokeRkyvV2(ByteArray) → Rust FFI (rkyv V2 fast-path)
// + MobileBridge 플랫폼 콜백(assets 파일 읽기 / 알림) 등록.
#include <jni.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/log.h>

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "template-android", __VA_ARGS__)

extern "C" {
// Rust staticlib (rustra-template-backend) 심볼.
uint8_t *rustra_template_invoke_rkyv_v2(const uint8_t *payload, size_t payload_len,
                                        size_t *out_len);
void rustra_template_free_buffer(uint8_t *ptr, size_t len);
// 패키지를 FFI 용으로 idempotent 등록.
// Apple 은 __mod_init_func constructor 가 자동 등록하지만, Android(ELF) 는
// 그런 constructor 가 없으므로 JNI_OnLoad 에서 명시 호출해야 한다.
void rustra_template_init(void);
}

// ── MobileBridge ABI (backend/src/capabilities.rs 계약) ────────────────────
typedef struct rustra_bridge {
  uint8_t *(*read_file)(const uint8_t *path_ptr, size_t path_len, size_t *out_len);
  int32_t (*notify)(const uint8_t *title_ptr, size_t title_len, const uint8_t *body_ptr,
                    size_t body_len);
  void (*free)(uint8_t *ptr, size_t len);
} rustra_bridge_t;
extern void rustra_template_register_mobile_registry(const rustra_bridge_t *bridge);

// ── 플랫폼 콜백 상태 ────────────────────────────────────────────────────────
// JavaVM 은 JNI_OnLoad 에 캐시; Context/AAssetManager 는 RustraModule.kt 가
// installBridge(env, context) 로 주입한다 (JNI_OnLoad 시점엔 Activity 가 없다).
static JavaVM *g_vm = nullptr;
static jobject g_asset_manager_global = nullptr;  // AAssetManager 래핑 (GlobalRef)
static jobject g_context_global = nullptr;        // 알림용 application context

// JNI env 획득 (콜백은 임의 스레드에서 불릴 수 있다).
static JNIEnv *get_env(bool *attached) {
  JNIEnv *env = nullptr;
  *attached = false;
  if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK) return env;
  if (g_vm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
    *attached = true;
    return env;
  }
  return nullptr;
}

// assets/<path> 를 읽는다 (번들과 같은 assets 루트 — config.json 을 assets 에 두면 읽힌다).
// 실패 시 앱 내부 저장소(filesDir) 폴백. 플랫폼이 malloc 하고 Rust 가 복사 후 free_cb 로 반납.
static uint8_t *read_file_cb(const uint8_t *path_ptr, size_t path_len, size_t *out_len) {
  std::string path(reinterpret_cast<const char *>(path_ptr), path_len);
  *out_len = 0;

  JNIEnv *env = nullptr;
  bool attached = false;
  env = get_env(&attached);
  if (env == nullptr || g_asset_manager_global == nullptr) {
    LOGI("bridge read_file(%s): env/asset manager not ready", path.c_str());
    return nullptr;
  }

  AAssetManager *mgr = AAssetManager_fromJava(env, g_asset_manager_global);
  AAsset *asset = mgr ? AAssetManager_open(mgr, path.c_str(), AASSET_MODE_BUFFER) : nullptr;
  if (asset) {
    off_t len = AAsset_getLength(asset);
    uint8_t *buf = static_cast<uint8_t *>(malloc(static_cast<size_t>(len)));
    AAsset_read(asset, buf, static_cast<size_t>(len));
    AAsset_close(asset);
    *out_len = static_cast<size_t>(len);
    LOGI("bridge read_file(%s): %ld bytes (assets)", path.c_str(), static_cast<long>(len));
    if (attached) g_vm->DetachCurrentThread();
    return buf;
  }

  // 폴백: Context.openFileInput (filesDir/<path>) — private 저장소.
  if (g_context_global != nullptr) {
    jclass ctx_cls = env->GetObjectClass(g_context_global);
    jmethodID mid = env->GetMethodID(ctx_cls, "openFileInput",
                                     "(Ljava/lang/String;)Ljava/io/FileInputStream;");
    jstring jpath = env->NewStringUTF(path.c_str());
    jobject fis = mid ? env->CallObjectMethod(g_context_global, mid, jpath) : nullptr;
    if (fis) {
      jclass fis_cls = env->GetObjectClass(fis);
      jmethodID read_all = env->GetMethodID(
          fis_cls, "readAllBytes", "()()[B");
      jbyteArray arr = static_cast<jbyteArray>(env->CallObjectMethod(fis, read_all));
      env->DeleteLocalRef(fis);
      if (arr) {
        jsize len = env->GetArrayLength(arr);
        uint8_t *buf = static_cast<uint8_t *>(malloc(static_cast<size_t>(len)));
        env->GetByteArrayRegion(arr, 0, len, reinterpret_cast<jbyte *>(buf));
        *out_len = static_cast<size_t>(len);
        LOGI("bridge read_file(%s): %d bytes (filesDir)", path.c_str(), (int)len);
        if (attached) g_vm->DetachCurrentThread();
        return buf;
      }
    } else {
      LOGI("bridge read_file(%s): not found (assets/filesDir)", path.c_str());
    }
  }
  if (attached) g_vm->DetachCurrentThread();
  return nullptr;
}

// NotificationManagerCompat 로 알림. POST_NOTIFICATIONS 권한은 런타임 요청 필요
// (Manifest 선언만으로는 Android 13+ 에서 무시). 반환 0=요청 접수.
static int32_t notify_cb(const uint8_t *title_ptr, size_t title_len,
                         const uint8_t *body_ptr, size_t body_len) {
  JNIEnv *env = nullptr;
  bool attached = false;
  env = get_env(&attached);
  if (env == nullptr || g_context_global == nullptr) {
    LOGI("bridge notify: env/context not ready");
    return -1;
  }

  jstring title =
      env->NewStringUTF(std::string(reinterpret_cast<const char *>(title_ptr), title_len).c_str());
  jstring body =
      env->NewStringUTF(std::string(reinterpret_cast<const char *>(body_ptr), body_len).c_str());

  // NotificationManagerCompat.notify(id, notification) — 리플렉션 대신 안전한
  // 경로: androidx.core 의 NotificationCompat.Builder 를 Kotlin 쪽(RustraModule.kt)
  // helper 로 두고 여기선 그 헬퍼를 호출한다. 의존성 최소화를 위해 Kotlin 헬퍼 경유.
  jclass cls = env->FindClass("com/rustra/lynx/RustraBridgeHelper");
  if (cls) {
    jmethodID notify_mid =
        env->GetStaticMethodID(cls, "notify",
                               "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V");
    if (notify_mid) {
      env->CallStaticVoidMethod(cls, notify_mid, g_context_global, title, body);
      LOGI("bridge notify OK");
      if (attached) g_vm->DetachCurrentThread();
      return 0;
    }
  }
  LOGI("bridge notify: RustraBridgeHelper not found");
  if (attached) g_vm->DetachCurrentThread();
  return -2;
}

// 플랫폼 버퍼 해제 — 이 파일의 콜백이 malloc 한 버퍼를 free 한다.
static void free_cb(uint8_t *ptr, size_t len) {
  (void)len;
  free(ptr);
}

static const rustra_bridge_t RUSTRA_ANDROID_BRIDGE = {
    .read_file = read_file_cb,
    .notify = notify_cb,
    .free = free_cb,
};

// RustraModule.kt 가 LynxView 빌드 전 호출 — Context/AAssetManager 주입 후 브리지 등록.
extern "C" JNIEXPORT void JNICALL
Java_com_rustra_lynx_RustraModule_installBridge(JNIEnv *env, jclass, jobject context,
                                                jobject asset_manager) {
  if (g_context_global == nullptr && context != nullptr) {
    g_context_global = env->NewGlobalRef(context);
  }
  if (g_asset_manager_global == nullptr && asset_manager != nullptr) {
    g_asset_manager_global = env->NewGlobalRef(asset_manager);
  }
  rustra_template_register_mobile_registry(&RUSTRA_ANDROID_BRIDGE);
  LOGI("MobileBridge registered (file+notify)");
}

// ── rkyv V2 디스패치 ───────────────────────────────────────────────────────

// .so 로드 시(System.loadLibrary) 1회 호출 — 패키지 등록을 확정한다.
extern "C" jint JNI_OnLoad(JavaVM *vm, void * /*reserved*/) {
  g_vm = vm;
  rustra_template_init();
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_rustra_lynx_RustraModule_nativeInvokeRkyvV2(JNIEnv *env, jobject /*thiz*/,
                                                     jbyteArray payload) {
  jsize len = env->GetArrayLength(payload);
  jbyte *in_bytes = env->GetByteArrayElements(payload, nullptr);
  if (in_bytes == nullptr) {
    return env->NewByteArray(0);
  }

  size_t out_len = 0;
  uint8_t *out = rustra_template_invoke_rkyv_v2(
      reinterpret_cast<const uint8_t *>(in_bytes), static_cast<size_t>(len), &out_len);

  // 입력 버퍼는 복사본만 썼으므로 변경사항 없이 해제(JNI_ABORT).
  env->ReleaseByteArrayElements(payload, in_bytes, JNI_ABORT);

  if (out == nullptr || out_len == 0) {
    if (out != nullptr) {
      rustra_template_free_buffer(out, out_len);
    }
    return env->NewByteArray(0);
  }

  jbyteArray result = env->NewByteArray(static_cast<jsize>(out_len));
  if (result != nullptr) {
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(out_len),
                            reinterpret_cast<const jbyte *>(out));
  }
  rustra_template_free_buffer(out, out_len);
  return result;
}
