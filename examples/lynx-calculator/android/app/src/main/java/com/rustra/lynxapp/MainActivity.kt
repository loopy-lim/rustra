package com.rustra.lynxapp

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.rustra.lynx.RustraModule

private const val TAG = "spike-android"

/**
 * rustra-bridge Lynx Android spike host Activity.
 *
 * 단일 ReactLynx 번들(assets/main.lynx.bundle) 을 LynxView 로 렌더링하고,
 * RustraModule(Kotlin @LynxMethod) 을 등록해 JS 의 NativeModules.RustraModule
 * .invokeRkyvV2 가 Rust staticlib rkyv V2 fast-path 로 라우팅되도록 한다.
 *
 * iOS 등가: LynxViewBuilder.config(LynxConfig + registerModule:[RustraModule class]).
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val lynxView: LynxView = buildLynxView()
        setContentView(lynxView)

        Log.i(TAG, "renderTemplateUrl main.lynx.bundle")
        lynxView.renderTemplateUrl("main.lynx.bundle", "")
    }

    private fun buildLynxView(): LynxView {
        val viewBuilder = LynxViewBuilder()

        // RustraModule 등록 — build() 이전에 호출(빌더 모듈 테이블을 build 시점 스냅샷).
        // JS: NativeModules.RustraModule.invokeRkyvV2(payload) → @LynxMethod reflection.
        viewBuilder.registerModule("RustraModule", RustraModule::class.java)

        // 번들 로드 프로바이더(assets/main.lynx.bundle). 공식 KotlinEmptyProject 패턴.
        viewBuilder.setTemplateProvider(DemoTemplateProvider(this))

        return viewBuilder.build(this)
    }
}
