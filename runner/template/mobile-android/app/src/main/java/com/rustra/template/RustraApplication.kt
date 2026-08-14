package com.rustra.template

import android.app.Application
import com.lynx.tasm.LynxEnv

/**
 * Lynx 글로벌 초기화. renderTemplateUrl(loadTemplate) 이전에 LynxEnv.init 이 필수.
 * 공식 KotlinEmptyProject 의 YourApplication.initLynxEnv() 패턴(최소 버전).
 * 스파이크 examples/lynx-calculator/android/.../RustraApplication.kt 에서 정제 추출.
 *
 * iOS 등가: LynxEnv sharedInstance (AppDelegate).
 * RustraModule 등록은 per-view(LynxViewBuilder.registerModule) 로 충분.
 */
class RustraApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        LynxEnv.inst().init(this, null, null, null)
    }
}
