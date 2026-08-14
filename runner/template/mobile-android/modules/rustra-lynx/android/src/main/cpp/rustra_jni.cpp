// rustra runner 템플릿 Lynx Android JNI.
// Kotlin RustraModule.nativeInvokeRkyvV2(ByteArray) → Rust FFI (rkyv V2 fast-path).
// 스파이크 examples/lynx-calculator/modules/rustra-lynx/android/src/main/cpp/rustra_jni.cpp
// 에서 정제 추출 — FFI 심볼만 rustra_template_* (create-runner.sh 가 prefix 치환).
#include <jni.h>
#include <cstdint>
#include <cstdlib>

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

// .so 로드 시(System.loadLibrary) 1회 호출 — 패키지 등록을 확정한다.
extern "C" jint JNI_OnLoad(JavaVM * /*vm*/, void * /*reserved*/) {
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
