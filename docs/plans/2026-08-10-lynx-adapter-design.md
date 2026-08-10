# Lynx Host Adapter Design (`@rustra/lynx`)

## Goal

rustra의 지원 host에 **Lynx**(ReactLynx)를 추가한다. 접근법 **B — rkyv V2 바이너리 fast-path를 처음부터 내장**하여 JSON stringify 오버헤드 없이 최고 성능 경로를 제공한다. iOS + Android 모바일을 타겟팅한다.

## Constraints

- **Rust FFI는 재사용한다**: 이미 존재하는 `rustra_calculator_invoke_rkyv_v2(ptr, len, out_len) → *mut u8` 심볼을 그대로 호출. Rust 코어/코드젠은 변경하지 않는다.
- **`createRkyvV2Engine`은 이미 host-neutral**: `@rustra/types`가 제공. Lynx 네이티브 모듈이 `invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer`만 노출하면 TS 어댑터는 RN 어댑터와 사실상 동일하다.
- **호스트 독립성 계약 유지**: 어댑터는 다른 host 패키지를 import하지 않는다(계약 불변량 #2, #3). `@rustra/lynx`는 `@rustra/types`와 Lynx 런타임 글로벌(`NativeModules`)에만 의존한다.
- **iOS 우선, Android 후속** — 단계적 검증.
- **데스크탑(Lynxtron)은 제외**: Lynxtron이 "Coming soon"이므로 이번 범위에서 빼고, 정식 출시 후 별도 확장.
- 생성된 TypeScript(`generated/commands.ts`, `types.ts`)는 host-neutral을 유지한다. Lynx 전용 코드는 어댑터 패키지와 네이티브 모듈에만 존재한다.

## Architecture

```
ReactLynx 앱 (src/App.tsx)
  addNumbers({ a, b })                       ← generated/commands.ts (host-neutral, 그대로 import)
        │ engine.invoke / 글로벌 invoke()
        ▼
createRkyvV2Engine(native, rkyvV2Codecs)     ← @rustra/types (재사용, RN과 동일)
        │ args → rkyv V2 인코딩 → ArrayBuffer
        ▼
NativeModules.RustraModule.invokeRkyvV2(buf) ← Lynx Native Module (새로 작성)
        │
   ┌────┴────────────────────────────┐
   ▼ iOS                             ▼ Android
Obj-C RustraModule <LynxModule>      Kotlin RustraModule (@LynxMethod)
  NSData* → C FFI                    ByteArray → JNI
        │                                  │
        ▼ (공통)                            ▼
rustra_calculator_invoke_rkyv_v2(ptr, len, &out_len) → *mut u8   ← Rust staticlib (재사용)
        │
        ▼
Package::invoke_rkyv_v2() → 결과 바이너리 → rkyv V2 디코딩 → 반환
```

Lynx Native Module은 RN의 JSI HostObject와 달리 **Lynx Module API**(`<LynxModule>` 프로토콜 / `@LynxMethod`)를 사용하지만, byte-tunnel 역할은 동일하다. 페이로드가 rkyv V2 바이너리이므로 네이티브 층은 JSON을 모른다.

## Components

### 1. Rust FFI (재사용 — 변경 없음)

`examples/calculator/src/lib.rs:972`의 `rustra_calculator_invoke_rkyv_v2`:

```rust
#[no_mangle]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8
```

- `Package::invoke_rkyv_v2()`로 라우팅 (command_id 기반 단일 디스패치).
- 호출자가 `rustra_ffi_free`로 반환 버퍼 해제.
- iOS/Android 크로스컴파일 스크립트만 추가(Rust 코드 수정 없음).

### 2. TS 어댑터 — `packages/lynx/` (RN 어댑터 구조 복사)

```
packages/lynx/
├── src/
│   ├── index.ts        ← createLynxEngine / createFastEngine / getRustraNative + @rustra/types re-export
│   └── index.test.ts   ← 모킹 invokeRkyvV2 단위 테스트 (RN 테스트 복사)
├── package.json        ← @rustra/lynx, @rustra/types 의존
├── tsconfig.json
└── README.md
```

- `createFastEngine(native, { rkyvV2Codecs })` → `createRkyvV2Engine(native, rkyvV2Codecs)` 래핑 (RN의 `createFastEngine`과 동일).
- `getRustraNative()` — RN은 `globalThis.__rustraNative`, **Lynx는 `NativeModules.RustraModule`** 글로벌에서 획득. Lynx가 제공하는 `NativeModules` 객체에서 읽는 점만 다르다.
- `createLynxEngine(native)` — JSON 폴백 경로(옵션). fast-path가 주 경로.

핵심 인터페이스(`@rustra/types`에 이미 정의):

```ts
export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};
```

### 3. iOS 네이티브 모듈 — Lynx Module API

```
examples/lynx-calculator/modules/rustra-lynx/ios/
├── RustraModule.h          ← @interface RustraModule : NSObject <LynxModule>
├── RustraModule.m          ← +name, +methodLookup, -invokeRkyvV2:
├── build-rust-ios.sh       ← RN의 스크립트 재사용 (aarch64-apple-ios-sim 등)
└── RustraLynx.podspec      ← vendored_libraries = rust/lib/librustra_calculator_example.a
```

```objc
// RustraModule.m
#import <Lynx/LynxModule.h>

@interface RustraModule : NSObject <LynxModule>
@end

@implementation RustraModule
+ (NSString *)name { return @"RustraModule"; }
+ (NSDictionary<NSString *, NSString *> *)methodLookup {
    return @{ @"invokeRkyvV2": NSStringFromSelector(@selector(invokeRkyvV2:)) };
}
- (NSData *)invokeRkyvV2:(NSData *)payload {
    NSUInteger outLen = 0;
    const uint8_t *out = rustra_calculator_invoke_rkyv_v2(
        payload.bytes, payload.length, &outLen);
    NSData *result = [NSData dataWithBytes:out length:outLen];
    rustra_ffi_free(out, outLen);            // 또는 전용 free 심볼
    return result;
}
@end
```

등록: `[globalConfig register_module:RustraModule.class]` (`setupLynxEnv`).

### 4. Android 네이티브 모듈 — Kotlin + JNI

```
examples/lynx-calculator/modules/rustra-lynx/android/
├── src/main/java/.../RustraModule.kt   ← @LynxMethod fun invokeRkyvV2(payload: ByteArray): ByteArray
├── src/main/cpp/rustra_jni.cpp          ← JNI → rustra_calculator_invoke_rkyv_v2
├── CMakeLists.txt                       ← librustra_calculator_example.a 링크
└── build-rust-android.sh                ← cargo-ndk (aarch64/armv7/x86_64)
```

RN은 아직 Android 미구현이라 rustra-bridge에 Android JNI 레퍼런스가 없다. `cargo-ndk` + `.a` 링크 경로를 새로 잡는다. `com.lynx.react.bridge` 패키지의 `@LynxMethod` / `ByteArray` 매핑을 사용한다(Lynx 타입 테이블: `ArrayBuffer ↔ byte[]`).

### 5. 예시 앱 — `examples/lynx-calculator/`

ReactLynx(rspeedy) 기반. Lynx Explorer로 preview.

```tsx
// src/App.tsx
import { addNumbers } from '../calculator/generated/commands.js';
import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
import { rkyvV2Registry } from '../calculator/generated/rkyv-registry.js';

configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
const result = await addNumbers({ a: 20, b: 22 });
```

## Lynx ↔ RN 차이점

| 측면        | RN                                    | Lynx                                                          |
| ----------- | ------------------------------------- | ------------------------------------------------------------- |
| 모듈 시스템 | Expo Module / JSI HostObject          | Lynx Module (`<LynxModule>` / `@LynxMethod`)                  |
| 등록        | Expo autolinking / JSI install        | `[globalConfig register_module:]` (iOS) / Lynx 설정 (Android) |
| JS 글로벌   | `globalThis.__rustraNative`           | `NativeModules.RustraModule`                                  |
| 동기 호출   | JSI sync call (Promise 오버헤드 없음) | **검증 필요** — 동기 반환 미지원 시 callback→Promise 래핑     |
| 바이너리    | `ArrayBuffer` ↔ JSI                   | `ArrayBuffer` ↔ `NSData` / `byte[]` (Lynx 타입 테이블 지원)   |
| Android     | 미구현                                | 신규 JNI 구축 필요                                            |

## 작업 순서

1. **TS 어댑터** `packages/lynx/` — RN 어댑터 복사 + `NativeModules` 적용 + 모킹 단위 테스트. (가장 빠르고 독립적, 초록 신호)
2. **iOS**: `build-rust-ios.sh` 재사용 → Obj-C `RustraModule` + podspec → Lynx Explorer에서 `addNumbers` 호출 확인.
3. **Android**: `build-rust-android.sh` 신규 + Kotlin `RustraModule` + JNI → 기기/에뮬레이터 확인.
4. **예시 앱** `examples/lynx-calculator/` + npm test 스크립트(`adding-host.md` 패턴).
5. **문서**: README 어댑터 표/섹션, `docs/extending/lynx-setup.md`(RN setup 가이드와 대칭), `adding-host.md` 결정 트리에 Lynx 분기 추가.

## 미해결 리스크 (구현 계획 단계에서 검증)

- **Lynx Native Module 동기 반환 지원 여부** — fast-path(sync)의 핵심. Lynx 콜백은 "한 번만 호출 가능"(이슈 #1972). 동기 직접 반환을 지원하는지 확인하고, 미지원 시 callback 기반 엔진으로 fallback.
- **Android JNI 빌드** — rustra-bridge에 Android 크로스컴파일 레퍼런스가 없음. `cargo-ndk` + `.a` 링크 + ABI(aarch64/armv7/x86_64)를 새로 잡아야 함.
- **Lynx 버전** — Native Module API가 3.6 기준. Sparkling autolinking과 충돌 여부 확인.
- **Rust FFI free 심볼** — `rustra_ffi_free`가 각 예시 staticlib에 노출되어 있는지 확인(RN은 `rustra_calculator_free_string` 사용).

## 테스트 전략

- **TS 단위**: `packages/lynx/src/index.test.ts` — RN 테스트 복사. 모킹 `invokeRkyvV2`로 엔진 로직 검증. `npm run test:types` 체인.
- **E2E**: `examples/lynx-calculator/`에서 실제 Rust staticlib 호출. `addNumbers({a:20,b:22})` → 42.
- **npm 스크립트**: `test:adapter:lynx`, `test:runtime:lynx`, `test:compat` 체인에 추가.
