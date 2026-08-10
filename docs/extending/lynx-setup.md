# Lynx Setup Guide

## Overview

rustra-bridge는 Lynx(ReactLynx)를 **Lynx Native Module**을 통해 지원한다. 네이티브 모듈이 Rust staticlib의 rkyv V2 FFI(`rustra_<package>_invoke_rkyv_v2`)를 호출하고, JS는 `NativeModules.RustraModule.invokeRkyvV2(ArrayBuffer)` 로 바이너리 fast-path를 탄다.

> **Status:** `@rustra/lynx` TS 어댑터는 출시됨(`createFastEngine`, `createLynxEngine`, `getRustraNative`). iOS/Android **네이티브 모듈 템플릿**은 구현 계획 [`docs/plans/2026-08-10-lynx-adapter.md`](../plans/2026-08-10-lynx-adapter.md) (Phase 2/3)에 있다. 본 가이드는 그 템플릿의 설정 절차를 다룬다.

## Architecture

```
ReactLynx 앱 (App.tsx)
  → createFastEngine(getRustraNative(), { rkyvV2Codecs })   ← @rustra/lynx
    → NativeModules.RustraModule.invokeRkyvV2(ArrayBuffer)   ← Lynx Native Module
      → Rust FFI (staticlib): rustra_<pkg>_invoke_rkyv_v2
        → Package::invoke_rkyv_v2()
```

Lynx Native Module은 byte-tunnel이다. 페이로드가 rkyv V2 바이너리이므로 네이티브 층은 JSON을 모른다.

## iOS Setup

### 1. Rust static library 빌드

Lynx 모듈 디렉토리에서 iOS 타겟으로 크로스컴파일한다 (RN의 `build-rust-ios.sh`와 동일 패턴).

```sh
RUSTRA_IOS_TARGET=aarch64-apple-ios-sim ./ios/build-rust-ios.sh
```

- crate를 `staticlib` 으로 `--lib --release` 빌드
- `lib<crate_name>.a` 를 `ios/rust/lib/` 로 복사

`Cargo.toml`:

```toml
[lib]
crate-type = ["rlib", "staticlib"]
```

### 2. Obj-C Lynx Module

Lynx SDK의 `<LynxModule>` 프로토콜로 모듈을 작성한다. `+name` / `+methodLookup` 정적 메서드로 JS에 노출할 메서드를 매핑한다.

```objc
// RustraModule.h
#import <Foundation/Foundation.h>
#import <Lynx/LynxModule.h>

NS_ASSUME_NONNULL_BEGIN
@interface RustraModule : NSObject <LynxModule>
@end
NS_ASSUME_NONNULL_END
```

```objc
// RustraModule.m
#import "RustraModule.h"

extern void *rustra_calculator_invoke_rkyv_v2(const uint8_t *payload, size_t len, size_t *out_len);
extern void rustra_calculator_free_buffer(void *ptr, size_t len);

@implementation RustraModule
+ (NSString *)name { return @"RustraModule"; }
+ (NSDictionary<NSString *, NSString *> *)methodLookup {
    return @{ @"invokeRkyvV2": NSStringFromSelector(@selector(invokeRkyvV2:)) };
}
- (NSData *)invokeRkyvV2:(NSData *)payload {
    size_t outLen = 0;
    const uint8_t *out = rustra_calculator_invoke_rkyv_v2(
        payload.bytes, payload.length, &outLen);
    NSData *result = [NSData dataWithBytes:out length:outLen];
    rustra_calculator_free_buffer((void *)out, outLen);
    return result;
}
@end
```

> **free 심볼 확인:** staticlib가 노출하는 free 심볼 이름(`rustra_calculator_free_buffer` / `rustra_<pkg>_free_string` 등)은 `nm` 로 확인한다.

### 3. 모듈 등록

`LynxEnv` 초기화 시점(`setupLynxEnv`)에 글로벌 설정으로 등록한다.

```objc
// LynxInitProcessor.m
#import "RustraModule.h"
- (void)setupLynxEnv {
  // ...
  [globalConfig register_module:RustraModule.class];
  // ...
}
```

### 4. Podfile

`.a` 를 vendored library로 링크한다 (RN podspec 패턴과 동일).

```ruby
s.vendored_libraries = 'rust/lib/librustra_calculator_example.a'
s.pod_target_xcconfig = {
  'OTHER_LDFLAGS' => '-force_load $(PODS_TARGET_SRCROOT)/rust/lib/librustra_calculator_example.a'
}
```

## Android Setup

Android는 Kotlin Lynx Module + JNI 로 동일 FFI를 호출한다. rustra-bridge에 기존 Android 레퍼런스가 없으므로 `cargo-ndk` 로 크로스컴파일한다.

```sh
# aarch64-linux-android / armv7-linux-androideabi / x86_64-linux-android
./android/build-rust-android.sh
```

```kotlin
// RustraModule.kt
import com.lynx.react.bridge.Callback

class RustraModule {
    @LynxMethod
    fun invokeRkyvV2(payload: ByteArray): ByteArray {
        return nativeInvokeRkyvV2(payload)   // JNI → rustra_calculator_invoke_rkyv_v2
    }
    private external fun nativeInvokeRkyvV2(payload: ByteArray): ByteArray
}
```

`CMakeLists.txt` 에서 `librustra_calculator_example.a` 를 링크하고, JNI 측에서 반환 버퍼를 복사한 뒤 `rustra_ffi_free` 로 해제한다.

## Usage (TypeScript)

```typescript
import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
import { rkyvV2Registry } from './generated/rkyv-registry.js';

// NativeModules.RustraModule 이 등록되어 있어야 함
configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));

// 생성된 커맨드 헬퍼는 모든 플랫폼에서 동일
const result = await addNumbers({ a: 20, b: 22 });
```

codec registry가 없는 환경의 JSON 폴백:

```typescript
import { createLynxEngine } from '@rustra/lynx';
configure(createLynxEngine(NativeModules.RustraModule)); // invoke(ArrayBuffer): ArrayBuffer
```

## type declaration

Lynx가 제공하는 `NativeModules` 글로벌에 타입을 선언한다.

```typescript
// src/typing.d.ts
declare let NativeModules: {
  RustraModule: {
    invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  };
};
```

## Troubleshooting

### "NativeModules.RustraModule not registered"

`getRustraNative()` 호출 시점에 네이티브 모듈이 아직 등록 전이다. `setupLynxEnv` 에서 `register_module:` 이 `LynxEnv` 초기화와 함께 일어나는지 확인한다.

### "library not found for -lrustra_..."

Rust 빌드 스크립트를 먼저 실행한다: `./ios/build-rust-ios.sh`.

### `invokeRkyvV2`가 동기 반환을 지원하지 않는 경우

Lynx Native Module의 콜백은 한 번만 호출 가능하다. 동기 직접 반환을 지원하지 않으면 callback → Promise 래핑으로 어댑터 팩토리를 조정한다 (구현 계획의 "미해결 리스크" 참조).

### Lynx SDK 버전

Native Module API는 Lynx 3.6 기준이다. Sparkling autolinking을 함께 쓰는 경우 모듈 등록 충돌 여부를 확인한다.
