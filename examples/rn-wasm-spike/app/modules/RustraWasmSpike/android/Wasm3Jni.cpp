// Wasm3Jni.cpp — JNI bridge: wasm3 engine + native staticlib baseline.
//
// Implements the native methods of dev.rustra.wasmspike.EngineHandle.
// The wasm call protocol mirrors scripts/wasm3-smoke-main.c exactly.
#include <android/log.h>
#include <jni.h>

#include "wasm3.h"

#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#define LOG_TAG "RustraWasmSpike"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// staticlib C surface (same spike_* names as the wasm exports)
extern "C" {
uint8_t *spike_invoke(const uint8_t *payload, size_t payload_len, size_t *out_len);
uint8_t *spike_contract_hash(size_t *out_len);
void spike_free(uint8_t *ptr, size_t len);
}

namespace {

std::mutex g_engine_mutex;

struct WasmEngine {
  IM3Environment env = nullptr;
  IM3Runtime runtime = nullptr;
  IM3Module module = nullptr;
  uint32_t engine_version = 0;
  char contract_hash[65] = {0};
  double instantiate_ms = 0.0;

  void teardown() {
    std::lock_guard<std::mutex> lock(g_engine_mutex);
    if (runtime) {
      m3_FreeRuntime(runtime);
      runtime = nullptr;
    }
    if (env) {
      m3_FreeEnvironment(env);
      env = nullptr;
    }
    module = nullptr;
  }
};

double now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

bool call_export(WasmEngine *e, const char *name, std::vector<uint32_t> args, uint32_t *ret) {
  IM3Function fn = nullptr;
  M3Result r = m3_FindFunctionIn(&fn, e->module, name);
  if (r) {
    LOGE("find %s: %s", name, r);
    return false;
  }
  switch (args.size()) {
  case 0: r = m3_CallV(fn); break;
  case 1: r = m3_CallV(fn, args[0]); break;
  case 2: r = m3_CallV(fn, args[0], args[1]); break;
  case 3: r = m3_CallV(fn, args[0], args[1], args[2]); break;
  default: return false;
  }
  if (r) {
    LOGE("call %s: %s", name, r);
    return false;
  }
  if (ret) {
    uint32_t v = 0;
    r = m3_GetResultsV(fn, &v);
    if (r) {
      LOGE("ret %s: %s", name, r);
      return false;
    }
    *ret = v;
  }
  return true;
}

bool mem_of(WasmEngine *e, uint8_t **mem, size_t *size) {
  *mem = m3_GetMemory(e->module, size, 0);
  return *mem != nullptr;
}

std::string hex_encode(const uint8_t *data, size_t len) {
  static const char *digits = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 0x0f]);
  }
  return out;
}

std::vector<uint8_t> make_envelope(const char *cmd, const char *args_json) {
  size_t cl = strlen(cmd), al = strlen(args_json);
  std::vector<uint8_t> out;
  out.push_back(static_cast<uint8_t>(cl));
  out.insert(out.end(), cmd, cmd + cl);
  size_t v = al;
  do {
    uint8_t byte = static_cast<uint8_t>(v & 0x7f);
    v >>= 7;
    if (v) byte |= 0x80;
    out.push_back(byte);
  } while (v);
  out.insert(out.end(), args_json, args_json + al);
  return out;
}

// Instantiate; returns empty string on success else error message.
std::string instantiate(WasmEngine *e, const char *path) {
  e->teardown();

  FILE *f = fopen(path, "rb");
  if (!f) return "cannot open wasm file";
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> buf(sz);
  if (fread(buf.data(), 1, sz, f) != static_cast<size_t>(sz)) {
    fclose(f);
    return "short read on wasm file";
  }
  fclose(f);

  double t0 = now_ms();
  e->env = m3_NewEnvironment();
  if (!e->env) return "m3_NewEnvironment failed";
  e->runtime = m3_NewRuntime(e->env, 256u * 1024 * 1024, nullptr);
  if (!e->runtime) return "m3_NewRuntime failed";

  M3Result r = m3_ParseModule(e->env, &e->module, buf.data(), static_cast<uint32_t>(buf.size()));
  if (r) return std::string("parse: ") + r;
  r = m3_LoadModule(e->runtime, e->module);
  if (r) return std::string("load: ") + r;
  e->instantiate_ms = now_ms() - t0;

  uint32_t ver = 0;
  if (!call_export(e, "spike_engine_version", {}, &ver)) return "spike_engine_version failed";
  e->engine_version = ver;

  uint32_t len_off = 0;
  if (!call_export(e, "spike_alloc", {4}, &len_off)) return "spike_alloc failed";
  uint8_t *mem = nullptr;
  size_t msz = 0;
  if (!mem_of(e, &mem, &msz)) return "m3_GetMemory failed";
  memset(mem + len_off, 0, 4);
  uint32_t hash_off = 0;
  if (!call_export(e, "spike_contract_hash", {len_off}, &hash_off))
    return "spike_contract_hash failed";
  if (!mem_of(e, &mem, &msz)) return "m3_GetMemory(2) failed";
  uint32_t hash_len = 0;
  memcpy(&hash_len, mem + len_off, 4);
  if (hash_len != 64) return "hash length != 64";
  memcpy(e->contract_hash, mem + hash_off, 64);
  e->contract_hash[64] = 0;
  call_export(e, "spike_free", {hash_off, 64}, nullptr);
  call_export(e, "spike_unstage", {len_off, 4}, nullptr);

  LOGI("instantiated: version=%u hash=%.64s in %.1f ms", e->engine_version, e->contract_hash,
       e->instantiate_ms);
  return "";
}

// Full wasm invoke; false sets err.
bool wasm_invoke(WasmEngine *e, const std::vector<uint8_t> &req, std::vector<uint8_t> *resp,
                 std::string *err) {
  uint32_t req_off = 0, len_off = 0, resp_off = 0, resp_len = 0;
  if (!call_export(e, "spike_alloc", {static_cast<uint32_t>(req.size())}, &req_off)) {
    *err = "spike_alloc(req) failed";
    return false;
  }
  if (!call_export(e, "spike_alloc", {4}, &len_off)) {
    *err = "spike_alloc(4) failed";
    return false;
  }
  uint8_t *mem = nullptr;
  size_t msz = 0;
  if (!mem_of(e, &mem, &msz)) {
    *err = "m3_GetMemory failed";
    return false;
  }
  memset(mem + len_off, 0, 4);
  memcpy(mem + req_off, req.data(), req.size());
  if (!call_export(e, "spike_invoke", {req_off, static_cast<uint32_t>(req.size()), len_off},
                   &resp_off)) {
    *err = "spike_invoke failed (trap)";
    return false;
  }
  if (!mem_of(e, &mem, &msz)) { // memory may have grown
    *err = "m3_GetMemory(2) failed";
    return false;
  }
  memcpy(&resp_len, mem + len_off, 4);
  resp->assign(resp_len, 0);
  memcpy(resp->data(), mem + resp_off, resp_len);
  call_export(e, "spike_free", {resp_off, resp_len}, nullptr);
  call_export(e, "spike_unstage", {req_off, static_cast<uint32_t>(req.size())}, nullptr);
  call_export(e, "spike_unstage", {len_off, 4}, nullptr);
  return true;
}

jstring to_jstring(JNIEnv *env, const std::string &s) {
  return env->NewStringUTF(s.c_str());
}

} // namespace

extern "C" {

// Single shared engine for ALL JNI entry points (instantiate/invoke/destroy).
// (Previously each entry point had its own `static WasmEngine` — invoke ran
// against an unloaded engine and every export lookup failed.)
static WasmEngine g_engine;

JNIEXPORT jobject JNICALL
Java_dev_rustra_wasmspike_EngineHandle_nativeInstantiate(JNIEnv *env, jobject /*thiz*/,
                                                         jstring jpath) {
  const char *path = env->GetStringUTFChars(jpath, nullptr);
  std::string err = instantiate(&g_engine, path);
  env->ReleaseStringUTFChars(jpath, path);
  if (!err.empty()) {
    LOGE("instantiate: %s", err.c_str());
    return nullptr;
  }
  jclass mapClass = env->FindClass("java/util/HashMap");
  jobject map = env->NewObject(mapClass, env->GetMethodID(mapClass, "<init>", "()V"));
  jmethodID put = env->GetMethodID(
      mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  env->CallObjectMethod(map, put, to_jstring(env, "engineVersion"),
                        env->NewObject(env->FindClass("java/lang/Integer"),
                                       env->GetMethodID(env->FindClass("java/lang/Integer"),
                                                        "<init>", "(I)V"),
                                       static_cast<jint>(g_engine.engine_version)));
  env->CallObjectMethod(map, put, to_jstring(env, "contractHash"),
                        to_jstring(env, g_engine.contract_hash));
  env->CallObjectMethod(
      map, put, to_jstring(env, "instantiateMs"),
      env->NewObject(env->FindClass("java/lang/Double"),
                     env->GetMethodID(env->FindClass("java/lang/Double"), "<init>", "(D)V"),
                     static_cast<jdouble>(g_engine.instantiate_ms)));
  env->CallObjectMethod(map, put, to_jstring(env, "path"), to_jstring(env, path));
  return map;
}

JNIEXPORT jbyteArray JNICALL
Java_dev_rustra_wasmspike_EngineHandle_nativeWasmInvoke(JNIEnv *env, jobject /*thiz*/,
                                                        jbyteArray jreq) {
  jsize len = env->GetArrayLength(jreq);
  std::vector<uint8_t> req(static_cast<size_t>(len));
  env->GetByteArrayRegion(jreq, 0, len, reinterpret_cast<jbyte *>(req.data()));
  std::vector<uint8_t> resp;
  std::string err;
  if (!wasm_invoke(&g_engine, req, &resp, &err)) {
    LOGE("wasm invoke: %s", err.c_str());
    return nullptr;
  }
  jbyteArray out = env->NewByteArray(static_cast<jsize>(resp.size()));
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(resp.size()),
                          reinterpret_cast<const jbyte *>(resp.data()));
  return out;
}

JNIEXPORT jbyteArray JNICALL
Java_dev_rustra_wasmspike_EngineHandle_nativeNativeInvoke(JNIEnv *env, jobject /*thiz*/,
                                                          jbyteArray jreq) {
  jsize len = env->GetArrayLength(jreq);
  std::vector<uint8_t> req(static_cast<size_t>(len));
  env->GetByteArrayRegion(jreq, 0, len, reinterpret_cast<jbyte *>(req.data()));
  size_t resp_len = 0;
  uint8_t *resp_off = spike_invoke(req.data(), req.size(), &resp_len);
  if (!resp_off) {
    LOGE("native spike_invoke returned null");
    return nullptr;
  }
  jbyteArray out = env->NewByteArray(static_cast<jsize>(resp_len));
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(resp_len),
                          reinterpret_cast<const jbyte *>(resp_off));
  spike_free(resp_off, resp_len);
  return out;
}

JNIEXPORT jbyteArray JNICALL
Java_dev_rustra_wasmspike_EngineHandle_nativeMakeEnvelope(JNIEnv *env, jobject /*thiz*/,
                                                          jstring jcommand,
                                                          jstring jargs) {
  const char *cmd = env->GetStringUTFChars(jcommand, nullptr);
  const char *args = env->GetStringUTFChars(jargs, nullptr);
  std::vector<uint8_t> env_bytes = make_envelope(cmd, args);
  env->ReleaseStringUTFChars(jcommand, cmd);
  env->ReleaseStringUTFChars(jargs, args);
  jbyteArray out = env->NewByteArray(static_cast<jsize>(env_bytes.size()));
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(env_bytes.size()),
                          reinterpret_cast<const jbyte *>(env_bytes.data()));
  return out;
}

JNIEXPORT void JNICALL
Java_dev_rustra_wasmspike_EngineHandle_nativeDestroy(JNIEnv * /*env*/, jobject /*thiz*/) {
  g_engine.teardown();
}

} // extern "C"
