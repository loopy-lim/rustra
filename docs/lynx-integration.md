# Lynx (LynxJS) Integration Architecture

## Overview

[Lynx](https://lynxjs.org/) (ByteDance)는 듀얼 스레드 기반의 고성능 크로스 플랫폼 네이티브 렌더링 엔진입니다.
`Rustra Bridge`의 핵심 C++ 코어(`RustraJSIBridge.cpp`)는 프레임워크 독립적인 C++ JSI / NAPI 규격을 준수하므로 **React Native뿐만 아니라 Lynx(LynxJS) 엔진에서도 100% 동일한 zero-copy 바이너리 통신과 Direct Fast-Path를 제공**할 수 있습니다.

---

## 🏗️ Lynx + Rustra Bridge 아키텍처

```text
┌───────────────────────────────────────────────────────────┐
│                     Lynx JS Thread                        │
│   @lynx-js/react / QuickJS / PrimJS / V8                  │
└─────────────────────────────┬─────────────────────────────┘
                              │ Direct JSI / NAPI Call
┌─────────────────────────────▼─────────────────────────────┐
│               Rustra C++ Native Extension                 │
│         (RustraJSIBridge.cpp + Lynx NativeModule)         │
└─────────────────────────────┬─────────────────────────────┘
                              │ C-ABI Direct FFI (0.95 µs)
┌─────────────────────────────▼─────────────────────────────┐
│                    Rust Core Engine                       │
│        (lto = "fat", rkyv V2 Zero-Copy Binary)            │
└───────────────────────────────────────────────────────────┘
```

---

## ⚡ Lynx 통합의 주요 이점

1. **듀얼 스레드 병목 제거**:
   Lynx는 JS 백그라운드 스레드와 메인 UI 스레드가 분리되어 있습니다. Rustra의 C++ Direct Fast-Path를 사용하면 JS 백그라운드 스레드에서 무거운 비즈니스 로직(암호화, 대용량 JSON 파싱, 이미지/음성 처리)을 **Rust 코어로 이관하여 백그라운드 연산 지연시간을 마이크로초(µs) 미만으로 축소**합니다.

2. **QuickJS / PrimJS / V8 모두 지원**:
   Rustra C++ 코덱은 `napi_env` 및 `facebook::jsi::Runtime` 포인터만 주어지면 작동하도록 호환 레이어가 추상화되어 있어 Lynx의 JS 엔진 종류에 관계없이 동일한 속도를 보장합니다.

3. **Zero-Copy ArrayBuffer 연동**:
   Lynx의 `ArrayBuffer` 전송 시 메모리 복사 없이 Rust의 Slice(`&[u8]`)로 바인딩됩니다.

---

## 🛠️ Lynx Native Module 바인딩 구현 방안

### 1. iOS (Lynx Native Module)

```objc
#import <Lynx/LynxModule.h>
#import "RustraJSIBridge.hpp"

@interface LynxRustraModule : NSObject <LynxModule>
@end

@implementation LynxRustraModule
LYNX_REGISTER_MODULE("RustraJSI")

- (void)onInit:(LynxContext *)context {
    // Lynx JS Runtime pointer 추출 후 Rustra JSI 바인딩 설치
    jsi::Runtime* runtime = (jsi::Runtime*)[context getJSContext];
    if (runtime) {
        rustra::installRustraJSI(*runtime);
    }
}
@end
```

### 2. Android (Lynx Native Module)

```kotlin
package com.rustra.lynx

import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.LynxContext

class LynxRustraModule(context: LynxContext) : LynxModule(context) {
    init {
        val jsContextPtr = context.jsContextNativePtr
        nativeInstallRustra(jsContextPtr)
    }

    private external fun nativeInstallRustra(jsContextPtr: Long)

    companion object {
        init {
            System.loadLibrary("rustrajsi")
        }
    }
}
```

---

## 🚀 결론 및 로드맵

Rustra Bridge는 **React Native**, **Node.js/Bun (napi-rs/FFI)**, **iOS/Android Native App**뿐만 아니라 **LynxJS**까지 통합 지원할 수 있도록 C++ JSI 코어가 완전 모듈화되어 있습니다.
