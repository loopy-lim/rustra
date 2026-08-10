#include <jni.h>
#include <jsi/jsi.h>
#include <android/log.h>
#include "RustraJSIBridge.hpp"

#define LOG_TAG "RustraJSI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jboolean JNICALL
Java_com_rustrajsi_RustraJSIModule_nativeInstall(
    JNIEnv* env,
    jobject ths,
    jlong jsContextNativePointer
) {
  if (jsContextNativePointer == 0) {
    LOGE("nativeInstall: jsContextNativePointer is null");
    return JNI_FALSE;
  }

  auto* runtime = reinterpret_cast<facebook::jsi::Runtime*>(jsContextNativePointer);
  if (!runtime) {
    LOGE("nativeInstall: failed to cast pointer to facebook::jsi::Runtime");
    return JNI_FALSE;
  }

  try {
    rustra::installRustraJSI(*runtime);
    LOGI("RustraJSI bindings successfully installed on Android JSI Runtime");
    return JNI_TRUE;
  } catch (const std::exception& ex) {
    LOGE("nativeInstall exception: %s", ex.what());
    return JNI_FALSE;
  } catch (...) {
    LOGE("nativeInstall unknown exception");
    return JNI_FALSE;
  }
}
