#import "RustraModule.h"

// Rust staticlib (rustra-template-backend) FFI 심볼 — create-runner.sh 가 prefix 치환.
// rkyv V2 단일 디스패치: payload 바이너리 → 결과 바이너리.
extern uint8_t *rustra_template_invoke_rkyv_v2(const uint8_t *payload,
                                               size_t payload_len,
                                               size_t *out_len);
extern void rustra_template_free_buffer(uint8_t *ptr, size_t len);

@implementation RustraModule

+ (NSString *)name {
  return @"RustraModule";
}

+ (NSDictionary<NSString *, NSString *> *)methodLookup {
  return @{
    @"invokeRkyvV2" : NSStringFromSelector(@selector(invokeRkyvV2:)),
  };
}

- (NSData *)invokeRkyvV2:(NSData *)payload {
  NSLog(@"[template-ios] rkyv in bytes=%lu", (unsigned long)payload.length);
  size_t out_len = 0;
  const uint8_t *out = rustra_template_invoke_rkyv_v2(
      (const uint8_t *)payload.bytes, payload.length, &out_len);

  if (out == NULL || out_len == 0) {
    if (out != NULL) {
      rustra_template_free_buffer((uint8_t *)out, out_len);
    }
    NSLog(@"[template-ios] rkyv out NULL/empty");
    return [NSData data];
  }

  // Rust 가 할당한 버퍼를 NSData 로 복사한 뒤 Rust 측에서 해제한다.
  NSData *result = [NSData dataWithBytes:out length:out_len];
  rustra_template_free_buffer((uint8_t *)out, out_len);
  NSLog(@"[template-ios] rkyv out bytes=%lu", (unsigned long)result.length);
  return result;
}

@end
