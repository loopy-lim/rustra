#import <Foundation/Foundation.h>
#import <Lynx/LynxModule.h>

NS_ASSUME_NONNULL_BEGIN

/// rustra-bridge Lynx Native Module.
/// JS 의 NativeModules.RustraModule.invokeRkyvV2(ArrayBuffer) → Rust FFI (rkyv V2 fast-path).
@interface RustraModule : NSObject <LynxModule>

/// 바이너리 payload 를 Rust 로 전달하고 결과 바이너리를 반환한다.
/// Lynx 타입 매핑: ArrayBuffer ↔ NSData.
- (NSData *)invokeRkyvV2:(NSData *)payload;

@end

NS_ASSUME_NONNULL_END
