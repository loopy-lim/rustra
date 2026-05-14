#import <React/RCTBridgeModule.h>
#import <React/RCTBridge+Private.h>
#import <React/RCTLog.h>
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

    rustra::installRustraJSI(*runtime);
    RCTLogInfo(@"[RustraJSI] JSI bindings installed successfully");
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"ERR_INSTALL", exception.reason ?: @"Unknown error", nil);
  }
}

@end
