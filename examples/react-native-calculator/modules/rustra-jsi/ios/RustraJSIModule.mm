#import <React/RCTBridgeModule.h>
#import <React/RCTBridge+Private.h>
#import <React/RCTLog.h>
#import <ReactCommon/CallInvoker.h>
#import <ReactCommon/RCTTurboModule.h>
#import <jsi/jsi.h>

#import "RustraJSIBridge.hpp"

@interface RustraJSI : NSObject <RCTBridgeModule>
@end

@implementation RustraJSI

RCT_EXPORT_MODULE(RustraJSI)

RCT_REMAP_METHOD(install,
                  installWithResolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    // In new arch, self.bridge may not be set.
    // Get the bridge through the RN shared infrastructure.
    RCTBridge *bridge = [RCTBridge currentBridge];
    if (!bridge) {
      reject(@"ERR_NO_BRIDGE", @"[RCTBridge currentBridge] returned nil", nil);
      return;
    }

    RCTCxxBridge *cxxBridge = (RCTCxxBridge *)bridge;
    if (!cxxBridge.runtime) {
      reject(@"ERR_NO_RUNTIME", @"CxxBridge runtime is nil", nil);
      return;
    }

    // In new arch, cxxBridge.runtime is a raw jsi::Runtime*, not shared_ptr*
    auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(cxxBridge.runtime);
    if (!runtime) {
      reject(@"ERR_NO_RUNTIME_PTR", @"Runtime pointer is null", nil);
      return;
    }

    // JS 스레드 CallInvoker — 이벤트 푸시 drain 을 JS 런타임 스레드로 마샬링.
    // RCTTurboModule 카테고리(RCTBridge (RCTTurboModule))의 jsCallInvoker 접근자는
    // RCTCxxBridge 구현이 제공한다 — shared_ptr<CallInvoker> 를 값으로 반환한다.
    std::shared_ptr<facebook::react::CallInvoker> jsCallInvoker =
        [cxxBridge jsCallInvoker];
    if (!jsCallInvoker) {
      RCTLogWarn(@"[RustraJSI] jsCallInvoker unavailable — event push falls back to JS polling (drainEvents)");
    }

    // CallInvoker 를 void shared_ptr 로 type-erase 해 전달 — RustraJSIBridge.cpp
    // 가 React-callinvoker 헤더 의존 없이 컴파일된다(iOS/Android 단일 정의).
    rustra::installRustraJSIWithInvoker(
        *runtime,
        std::static_pointer_cast<void>(jsCallInvoker));
    RCTLogInfo(@"[RustraJSI] JSI bindings installed successfully");
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"ERR_INSTALL", exception.reason ?: @"Unknown error", nil);
  }
}

@end
