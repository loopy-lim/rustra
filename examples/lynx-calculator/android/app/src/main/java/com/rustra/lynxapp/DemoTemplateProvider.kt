package com.rustra.lynxapp

import android.content.Context
import com.lynx.tasm.provider.AbsTemplateProvider
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * Lynx 번들 프로바이더 — assets 에서 URI(main.lynx.bundle) 로 번들 바이트를 로드.
 * 공식 integrating-lynx-demo-projects KotlinEmptyProject 의 DemoTemplateProvider 와 동일.
 */
class DemoTemplateProvider(context: Context) : AbsTemplateProvider() {

    private var mContext: Context = context.applicationContext

    override fun loadTemplate(uri: String, callback: Callback) {
        Thread {
            try {
                mContext.assets.open(uri).use { inputStream ->
                    ByteArrayOutputStream().use { byteArrayOutputStream ->
                        val buffer = ByteArray(1024)
                        var length: Int
                        while ((inputStream.read(buffer).also { length = it }) != -1) {
                            byteArrayOutputStream.write(buffer, 0, length)
                        }
                        callback.onSuccess(byteArrayOutputStream.toByteArray())
                    }
                }
            } catch (e: IOException) {
                callback.onFailed(e.message)
            }
        }.start()
    }
}
