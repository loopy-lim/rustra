package dev.rustra.bridge

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

// Only JNI endpoints and library loading are replaced by the host runner. The
// generated module's install/invalidate/control flow is compiled unchanged.
object NativeProbe {
  val calls = mutableListOf<String>()
  fun install(context: ReactApplicationContext, pointer: Long, holder: CallInvokerHolder?): Boolean {
    check(context.queue.isOnThread()) { "native install entered outside the JS queue" }
    calls.add("install")
    return true
  }
  fun configure(path: String?) {}
  fun invalidate(context: ReactApplicationContext) {
    check(context.queue.isOnThread()) { "native invalidate entered outside the JS queue" }
    calls.add("invalidate")
  }
}
class Result : Promise {
  var resolved = false
  val rejected = mutableListOf<String>()
  override fun resolve(value: Any?) { resolved = true }
  override fun reject(code: String, message: String) { rejected.add(code) }
}
fun main() {
  var failures = 0
  fun test(name: String, body: () -> Unit) {
    NativeProbe.calls.clear()
    try { body(); println("PASS $name") }
    catch (error: Throwable) { failures++; System.err.println("FAIL $name: ${error.message}") }
  }
  test("install from native queue waits for the JS queue") {
    val context = ReactApplicationContext(); val module = RustraBridgeModule(context); val result = Result()
    module.install(result)
    check(!result.resolved && NativeProbe.calls.isEmpty()) { "install ran before JS queue reconciliation" }
    context.queue.drain()
    check(result.resolved && result.rejected.isEmpty() && NativeProbe.calls == listOf("install"))
  }
  test("native queue invalidation finishes before the queued runtime destruction") {
    val context = ReactApplicationContext(); val module = RustraBridgeModule(context)
    module.invalidate()
    check(NativeProbe.calls.isEmpty()) { "invalidate ran before the JS queue" }
    context.queue.runOnQueue {
      check(NativeProbe.calls == listOf("invalidate")) { "runtime destroyed before native teardown" }
      NativeProbe.calls.add("destroy")
    }
    context.queue.drain()
    check(NativeProbe.calls == listOf("invalidate", "destroy"))
  }
  test("JS queue invalidation completes inline before runtime destruction") {
    val context = ReactApplicationContext(); val module = RustraBridgeModule(context)
    context.queue.runOnQueue {
      module.invalidate()
      check(NativeProbe.calls == listOf("invalidate")) { "JS queue teardown was deferred" }
    }
    context.queue.drain()
  }
  test("install rejects an unavailable JS queue without entering JNI") {
    val context = ReactApplicationContext(); context.jsMessageQueueThread = null
    val module = RustraBridgeModule(context); val result = Result()
    module.install(result)
    check(result.rejected == listOf("ERR_NO_RUNTIME") && NativeProbe.calls.isEmpty())
  }
  test("install rejects a missing runtime pointer on the JS queue") {
    val context = ReactApplicationContext(); context.javaScriptContextHolder.pointer = 0
    val module = RustraBridgeModule(context); val result = Result()
    module.install(result); context.queue.drain()
    check(result.rejected == listOf("ERR_NO_RUNTIME") && NativeProbe.calls.isEmpty())
  }
  println("ANDROID_LIFECYCLE_RESULT tests=5 failures=$failures")
  check(failures == 0)
}
