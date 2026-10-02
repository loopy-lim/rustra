#import <React/RCTBridgeModule.h>
#import <React/RCTBridge+Private.h>
#import <React/RCTLog.h>
#import <ReactCommon/CallInvoker.h>
#import <ReactCommon/RCTTurboModule.h>
#import <jsi/jsi.h>

#include <cstdlib>
#include <exception>

#import "RustraJSIBridge.hpp"

@interface RustraBridge : NSObject <RCTBridgeModule>
@end

@implementation RustraBridge

RCT_EXPORT_MODULE(RustraBridge)

- (dispatch_queue_t)methodQueue {
  // RCTCxxBridge waits for module invalidation on its JS thread before deleting
  // Hermes. Its RCTJSThread queue runs this module's teardown inline there;
  // enqueueing through a CallInvoker from a native queue would be too late.
  return RCTJSThread;
}

- (void)invalidate {
  // RCTBridge가 Runtime을 폐기하기 전에 JSI Function과 pending async invoke를
  // 정리한다. 늦게 도착한 Rust callback은 generation guard가 폐기한다.
  rustra::invalidateRustraJSI();
}

// RCTJSThread also marks the module synchronous in RN's legacy interop. A
// Promise export has a void native return, which that path incorrectly reads
// as an object. Export an actual object-returning JS-thread method instead;
// the generated public installer remains async on both iOS and Android.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(install) {
  RCTBridge *bridge = [RCTBridge currentBridge];
  if (!bridge) {
    @throw [NSException exceptionWithName:@"ERR_NO_BRIDGE"
                                  reason:@"[RCTBridge currentBridge] returned nil"
                                userInfo:nil];
  }

  RCTCxxBridge *cxxBridge = (RCTCxxBridge *)bridge;
  auto *runtime = static_cast<facebook::jsi::Runtime *>(cxxBridge.runtime);
  if (!runtime) {
    @throw [NSException exceptionWithName:@"ERR_NO_RUNTIME"
                                  reason:@"RustraJSI requires the current JS Runtime"
                                userInfo:nil];
  }
  std::shared_ptr<facebook::react::CallInvoker> jsCallInvoker =
      [cxxBridge jsCallInvoker];
  if (!jsCallInvoker) {
    @throw [NSException exceptionWithName:@"ERR_NO_CALL_INVOKER"
                                  reason:@"RustraJSI requires a JS CallInvoker"
                                userInfo:nil];
  }

  try {
    // The synchronous export guarantees this is the owning JS thread. Read
    // the live runtime only here; event callbacks still use its CallInvoker.
    const char *hotCoreDir = std::getenv("RUSTRA_HOT_CORE_DIR");
    if (hotCoreDir != nullptr && hotCoreDir[0] != '\0') {
      rustra::core::configureHotCore(hotCoreDir);
      rustra::core::pollHotCoreOnce();
      rustra::core::startHotCorePolling();
    }
    rustra::installRustraJSIWithInvoker(
        *runtime, std::static_pointer_cast<void>(jsCallInvoker));
    return @(YES);
  } catch (const std::exception &error) {
    NSString *message = [NSString stringWithUTF8String:error.what()];
    @throw [NSException exceptionWithName:@"ERR_INSTALL"
                                  reason:message ?: @"Unknown C++ error"
                                userInfo:nil];
  } catch (...) {
    @throw [NSException exceptionWithName:@"ERR_INSTALL"
                                  reason:@"Unknown native error"
                                userInfo:nil];
  }
}

@end
