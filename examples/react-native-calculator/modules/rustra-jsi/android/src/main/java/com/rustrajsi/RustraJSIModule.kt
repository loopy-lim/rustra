package com.rustrajsi

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class RustraJSIModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    init {
      System.loadLibrary("rustrajsi")
    }
  }

  override fun getName(): String = "RustraJSI"

  @ReactMethod
  fun install(promise: Promise) {
    val jsContextPointer = reactApplicationContext.javaScriptContextHolder?.get()
    if (jsContextPointer == null || jsContextPointer == 0L) {
      promise.reject("ERR_NO_RUNTIME", "JavaScript context pointer is null")
      return
    }

    // JS 스레드 CallInvoker — 이벤트 푸시 drain 을 JS 런타임 스레드로 마샬링한다.
    // CallInvokerHolderImpl 은 CatalystInstance 가 만든 C++ CallInvoker 를
    // 감싼 하이브리드 객체. newInstance() 로 fbjni 레퍼를 만들어 JNI 로 넘기면
    // C++ 쪽에서 cthis()->getCallInvoker() 로 실제 invoker 를 꺼낸다.
    val holder = reactApplicationContext.jsCallInvokerHolder
    val success = nativeInstall(jsContextPointer, holder)
    if (success) {
      promise.resolve(true)
    } else {
      promise.reject("ERR_INSTALL", "Failed to install RustraJSI onto runtime")
    }
  }

  private external fun nativeInstall(
    jsContextNativePointer: Long,
    jsCallInvokerHolder: com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder?
  ): Boolean
}
