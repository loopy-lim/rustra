// rustra-bridge Lynx Android JNI.
// Kotlin RustraModule.nativeInvokeRkyvV2(ByteArray) → Rust FFI (rkyv V2 fast-path).
#include <jni.h>
#include <cstdint>
#include <cstdlib>

extern "C" {
// Rust staticlib (examples/calculator) 심볼.
uint8_t *rustra_calculator_invoke_rkyv_v2(const uint8_t *payload, size_t payload_len,
                                          size_t *out_len);
void rustra_calculator_free_buffer(uint8_t *ptr, size_t len);
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
  uint8_t *out = rustra_calculator_invoke_rkyv_v2(
      reinterpret_cast<const uint8_t *>(in_bytes), static_cast<size_t>(len), &out_len);

  // 입력 버���는 복사본만 썼으므로 변경사항 없이 해제(JNI_ABORT).
  env->ReleaseByteArrayElements(payload, in_bytes, JNI_ABORT);

  if (out == nullptr || out_len == 0) {
    if (out != nullptr) {
      rustra_calculator_free_buffer(out, out_len);
    }
    return env->NewByteArray(0);
  }

  jbyteArray result = env->NewByteArray(static_cast<jsize>(out_len));
  if (result != nullptr) {
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(out_len),
                            reinterpret_cast<const jbyte *>(out));
  }
  rustra_calculator_free_buffer(out, out_len);
  return result;
}
