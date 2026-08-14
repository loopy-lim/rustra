package com.rustra.lynx

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Rust MobileBridge notify 콜백이 JNI 에서 호출하는 알림 헬퍼.
 *
 * JNI(C++) 에서 NotificationCompat 을 직접 쓰는 것보다 Kotlin 헬퍼 경유가
 * 안전하다 (androidx 의존성·버전 처리를 Kotlin 측에 둔다).
 * POST_NOTIFICATIONS 권한(Android 13+)은 앱이 런타임 요청해야 한다 —
 * 미승인 시 notify() 가 조용히 무시된다 (SecurityException 방지 위해 체크).
 */
object RustraBridgeHelper {
    private const val CHANNEL_ID = "rustra_template"
    private const val TAG = "template-android"

    @JvmStatic
    fun notify(context: Context, title: String, body: String) {
        val manager = NotificationManagerCompat.from(context)
        // 채널(Android 8+) 보장 — 템플릿은 단일 채널을 idempotent 생성.
        val channel =
            android.app.NotificationChannel(
                CHANNEL_ID, "rustra template", android.app.NotificationManager.IMPORTANCE_DEFAULT,
            )
        manager.createNotificationChannel(channel)

        val notification =
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .build()

        if (manager.areNotificationsEnabled()) {
            manager.notify(1001, notification)
            Log.i(TAG, "bridge notify OK: $title")
        } else {
            Log.i(TAG, "bridge notify skipped: notifications disabled")
        }
    }
}
