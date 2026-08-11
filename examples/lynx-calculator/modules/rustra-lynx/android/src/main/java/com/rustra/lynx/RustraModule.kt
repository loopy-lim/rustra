package com.rustra.lynx

import android.content.Context
import android.util.Log
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule

private const val TAG = "spike-android"

/**
 * rustra-bridge Lynx Android Native Module.
 *
 * JS 의 NativeModules.RustraModule.invokeRkyvV2(ArrayBuffer) 가 JNI 로 라우팅되어
 * Rust staticlib 의 rkyv V2 fast-path 를 호출한다.
 *
 * - `com.lynx.jsbridge.LynxModule`(abstract) 필수 상속. 프레임워크가 Context 를
 *   넘겨 리플렉션 생성하므로 Context 생성자가 필요하다.
 * - `@LynxMethod`(`com.lynx.jsbridge`) 로 메서드 노출. JS 식별자는 Kotlin 메서드명
 *   그대로(reflection) — iOS 의 +methodLookup 사전 매핑이 Android 에는 없다.
 * - Lynx 타입 매핑: ArrayBuffer ↔ ByteArray(`byte[]` → 시그니처 'a').
 *
 * iOS 등가: RustraModule<LynxModule> + +methodLookup(@selector(invokeRkyvV2:)).
 */
class RustraModule(context: Context) : LynxModule(context) {

    @LynxMethod
    fun invokeRkyvV2(payload: ByteArray): ByteArray {
        // 결정적 logcat 증거(iOS RustraModule.m NSLog 과 대칭).
        // hex 까지 남겨 와이어 포맷 바이트가 일치하는지 확인한다.
        Log.i(TAG, "rkyv in bytes=${payload.size} hex=${payload.toHex()}")
        val out = nativeInvokeRkyvV2(payload)
        Log.i(TAG, "rkyv out bytes=${out.size} hex=${out.toHex()}")
        return out
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it) }

    private external fun nativeInvokeRkyvV2(payload: ByteArray): ByteArray

    companion object {
        init {
            System.loadLibrary("rustra_lynx")
        }
    }
}
