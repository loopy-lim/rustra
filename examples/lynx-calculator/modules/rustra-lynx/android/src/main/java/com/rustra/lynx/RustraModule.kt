package com.rustra.lynx

import com.lynx.react.bridge.LynxMethod

/**
 * rustra-bridge Lynx Android Native Module.
 *
 * JS 의 NativeModules.RustraModule.invokeRkyvV2(ArrayBuffer) 가 JNI 로 라우팅되어
 * Rust staticlib 의 rkyv V2 fast-path 를 호출한다.
 *
 * Lynx 타입 매핑: ArrayBuffer ↔ ByteArray.
 */
class RustraModule {

    @LynxMethod
    fun invokeRkyvV2(payload: ByteArray): ByteArray {
        return nativeInvokeRkyvV2(payload)
    }

    private external fun nativeInvokeRkyvV2(payload: ByteArray): ByteArray

    companion object {
        init {
            System.loadLibrary("rustra_lynx")
        }
    }
}
