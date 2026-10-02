package com.facebook.react.bridge

import android.content.pm.ApplicationInfo
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import java.io.File
import java.util.ArrayDeque

interface Promise {
  fun resolve(value: Any?)
  fun reject(code: String, message: String)
}
annotation class ReactMethod
class JavaScriptContextHolder(var pointer: Long = 42) { fun get() = pointer }

class MessageQueueThread {
  private val pending = ArrayDeque<Runnable>()
  private var onThread = false
  fun isOnThread() = onThread
  fun runOnQueue(action: Runnable): Boolean { pending.add(action); return true }
  fun drain() {
    onThread = true
    try { while (pending.isNotEmpty()) pending.removeFirst().run() }
    finally { onThread = false }
  }
}
class ReactApplicationContext {
  val queue = MessageQueueThread()
  var jsMessageQueueThread: MessageQueueThread? = queue
  val isOnJSQueueThread: Boolean get() = queue.isOnThread()
  fun runOnJSQueueThread(action: Runnable) = jsMessageQueueThread?.runOnQueue(action) ?: false
  val javaScriptContextHolder = JavaScriptContextHolder()
  val jsCallInvokerHolder: CallInvokerHolder? = null
  val applicationInfo = ApplicationInfo()
  val filesDir = File(".")
}
open class ReactContextBaseJavaModule(val reactApplicationContext: ReactApplicationContext) {
  open fun getName() = "test"
  open fun invalidate() {}
}
