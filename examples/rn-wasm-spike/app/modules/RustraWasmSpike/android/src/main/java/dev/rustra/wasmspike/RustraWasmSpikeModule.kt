package dev.rustra.wasmspike

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.File

/**
 * RN native module driving BOTH engines:
 *  - wasm3 interpreting a .wasm engine (bundle or swapped file, no restart)
 *  - the native staticlib rustra engine (byte-equality baseline)
 *
 * The wasm3 driver lives in C (Wasm3Jni.cpp) and is reached through JNI; the
 * staticlib is called directly from C++ in the same JNI library.
 */
class RustraWasmSpikeModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    companion object {
        init {
            System.loadLibrary("rustra_wasm_spike")
        }
    }

    private val engine = EngineHandle()

    override fun getName() = "RustraWasmSpikeModule"

    override fun onCatalystInstanceDestroy() {
        engine.destroy()
    }

    @ReactMethod
    fun loadBundledEngine(promise: Promise) {
        try {
            // .wasm ships in the module's assets/ and is staged to cacheDir
            // (wasm3 needs a real file path to fread).
            val dir = File(ctx.cacheDir, "wasm-engine").apply { mkdirs() }
            val dst = File(dir, "engine_v1.wasm")
            ctx.assets.open("engine_v1.wasm").use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
            promise.resolve(engine.instantiate(dst.absolutePath))
        } catch (e: Exception) {
            promise.reject("load_failed", e.message, e)
        }
    }

    @ReactMethod
    fun reloadWasm(newPath: String, promise: Promise) {
        try {
            promise.resolve(engine.instantiate(newPath))
        } catch (e: Exception) {
            promise.reject("reload_failed", e.message, e)
        }
    }

    /** Swap flow (Android): host pushes engine_v2.wasm via run-as into
     * filesDir; re-instantiate from there with NO app restart. */
    @ReactMethod
    fun reloadWasmFromAppFiles(promise: Promise) {
        try {
            val path = File(ctx.filesDir, "engine_v2.wasm")
            if (!path.exists()) {
                promise.reject("engine_v2_missing", "files/engine_v2.wasm not present", null)
                return
            }
            promise.resolve(engine.instantiate(path.absolutePath))
        } catch (e: Exception) {
            promise.reject("reload_failed", e.message, e)
        }
    }

    @ReactMethod
    fun evalCommandWasm(bytes: ReadableArray, promise: Promise) {
        try {
            val req = ByteArray(bytes.size()) { bytes.getInt(it).toByte() }
            val t0 = System.nanoTime()
            val resp = engine.wasmInvoke(req)
            val ms = (System.nanoTime() - t0) / 1_000_000.0
            promise.resolve(
                Arguments.createMap().apply {
                    putString("hex", resp.toHex())
                    putDouble("ms", ms)
                }
            )
        } catch (e: Exception) {
            promise.reject("wasm_invoke_failed", e.message, e)
        }
    }

    @ReactMethod
    fun evalCommandNative(bytes: ReadableArray, promise: Promise) {
        try {
            val req = ByteArray(bytes.size()) { bytes.getInt(it).toByte() }
            val t0 = System.nanoTime()
            val resp = engine.nativeInvoke(req)
            val ms = (System.nanoTime() - t0) / 1_000_000.0
            promise.resolve(
                Arguments.createMap().apply {
                    putString("hex", resp.toHex())
                    putDouble("ms", ms)
                }
            )
        } catch (e: Exception) {
            promise.reject("native_invoke_failed", e.message, e)
        }
    }

    @ReactMethod
    fun makeEnvelope(command: String, argsJson: String, promise: Promise) {
        try {
            val env = engine.makeEnvelope(command, argsJson)
            val arr: WritableNativeArray = WritableNativeArray()
            for (b in env) arr.pushInt(b.toInt() and 0xff)
            promise.resolve(
                Arguments.createMap().apply {
                    putString("hex", env.toHex())
                    putArray("bytes", arr)
                }
            )
        } catch (e: Exception) {
            promise.reject("envelope_failed", e.message, e)
        }
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}

/** JNI bridge; native methods implemented in cpp/Wasm3Jni.cpp */
private class EngineHandle {
    private var nativePtr: Long = 0

    external fun nativeInstantiate(path: String): Map<String, Any>?
    external fun nativeWasmInvoke(req: ByteArray): ByteArray
    external fun nativeNativeInvoke(req: ByteArray): ByteArray
    external fun nativeMakeEnvelope(command: String, argsJson: String): ByteArray
    external fun nativeDestroy()

    fun instantiate(path: String): WritableMap {
        val m = nativeInstantiate(path)
            ?: throw IllegalStateException("instantiate returned null (see logcat)")
        // JNI returns a plain HashMap, which the bridge cannot serialize —
        // convert to a WritableMap (spike scope: string/number values only).
        return Arguments.createMap().apply {
            for ((k, v) in m.entries) {
                when (v) {
                    is Number -> putDouble(k.toString(), v.toDouble())
                    else -> putString(k.toString(), v.toString())
                }
            }
        }
    }

    fun wasmInvoke(req: ByteArray): ByteArray = nativeWasmInvoke(req)
    fun nativeInvoke(req: ByteArray): ByteArray = nativeNativeInvoke(req)
    fun makeEnvelope(command: String, argsJson: String): ByteArray =
        nativeMakeEnvelope(command, argsJson)

    fun destroy() {
        if (nativePtr != 0L) {
            nativeDestroy()
            nativePtr = 0L
        }
    }
}
