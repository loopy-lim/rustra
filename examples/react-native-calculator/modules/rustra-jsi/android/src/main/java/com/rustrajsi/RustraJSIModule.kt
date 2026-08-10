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
    val success = nativeInstall(jsContextPointer)
    if (success) {
      promise.resolve(true)
    } else {
      promise.reject("ERR_INSTALL", "Failed to install RustraJSI onto runtime")
    }
  }

  private external fun nativeInstall(jsContextPointer: Long): Boolean
}
