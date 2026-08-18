#import "RustraModule.h"
#import <UserNotifications/UserNotifications.h>

// Rust staticlib (rustra-template-backend) FFI 심볼 — create-runner.sh 가 prefix 치환.
extern uint8_t *rustra_template_invoke_rkyv_v2(const uint8_t *payload,
                                               size_t payload_len,
                                               size_t *out_len);
extern void rustra_template_free_buffer(uint8_t *ptr, size_t len);
extern void rustra_template_init(void);

// ── MobileBridge ABI (backend/src/capabilities.rs 계약) ────────────────────
// 필드 순서 고정: read_file / notify / free.
typedef struct rustra_bridge {
  uint8_t *(*read_file)(const uint8_t *path_ptr, size_t path_len, size_t *out_len);
  int32_t (*notify)(const uint8_t *title_ptr, size_t title_len, const uint8_t *body_ptr,
                    size_t body_len);
  void (*free)(uint8_t *ptr, size_t len);
} rustra_bridge_t;
extern void rustra_template_register_mobile_registry(const rustra_bridge_t *bridge);

// ── 플랫폼 콜백 구현 (iOS) ──────────────────────────────────────────────────

// NSBundle 리소스(또는 앱 샌드박스 파일)를 읽는다. Rust 가 "config.json" 등 상대경로를
// 넘기면 [NSBundle mainBundle] 리소스에서 먼저 찾고, 실패 시 앱 도큐먼트에서 찾는다.
// 플랫폼이 malloc 하고 Rust 가 복사 후 free_cb 로 반납한다.
static uint8_t *rustra_ios_read_file(const uint8_t *path_ptr, size_t path_len,
                                     size_t *out_len) {
  NSString *path =
      [[NSString alloc] initWithBytes:path_ptr length:path_len encoding:NSUTF8StringEncoding];
  NSString *resolved = [[NSBundle mainBundle] pathForResource:path.stringByDeletingPathExtension
                                                       ofType:path.pathExtension];
  if (!resolved) {
    // 앱 도큐먼트 폴백 (NSFileManager).
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask,
                                                         YES)
                         .firstObject;
    resolved = [docs stringByAppendingPathComponent:path];
  }
  NSData *data = [NSData dataWithContentsOfFile:resolved];
  if (!data || data.length == 0) {
    NSLog(@"[template-ios] bridge read_file(%@): not found", path);
    *out_len = 0;
    return NULL;
  }
  uint8_t *buf = (uint8_t *)malloc(data.length);
  memcpy(buf, data.bytes, data.length);
  *out_len = data.length;
  NSLog(@"[template-ios] bridge read_file(%@): %lu bytes", path, (unsigned long)data.length);
  return buf;
}

// UNUserNotificationCenter 로컬 알림. 반환 0=성공.
static int32_t rustra_ios_notify(const uint8_t *title_ptr, size_t title_len,
                                 const uint8_t *body_ptr, size_t body_len) {
  NSString *title =
      [[NSString alloc] initWithBytes:title_ptr length:title_len encoding:NSUTF8StringEncoding];
  NSString *body =
      [[NSString alloc] initWithBytes:body_ptr length:body_len encoding:NSUTF8StringEncoding];
  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = title;
  content.body = body;
  UNNotificationRequest *req = [UNNotificationRequest
      requestWithIdentifier:@"rustra-template"
                    content:content
                    trigger:nil];
  [[UNUserNotificationCenter currentNotificationCenter]
      addNotificationRequest:req
       withCompletionHandler:^(NSError *_Nullable error) {
         if (error) {
           NSLog(@"[template-ios] bridge notify error: %@", error.localizedDescription);
         } else {
           NSLog(@"[template-ios] bridge notify OK: %@", title);
         }
       }];
  // 비동기 승인 — 등록 요청 자체는 즉시 반환 (권한 미승인이면 조용히 무시된다).
  return 0;
}

// 플랫폼 버퍼 해제 — iOS 콜백이 malloc 한 버퍼를 free 한다.
static void rustra_ios_free(uint8_t *ptr, size_t len) {
  (void)len;
  free(ptr);
}

static const rustra_bridge_t RUSTRA_IOS_BRIDGE = {
    .read_file = rustra_ios_read_file,
    .notify = rustra_ios_notify,
    .free = rustra_ios_free,
};

@implementation RustraModule

+ (void)load {
  // .so/.framework 로드 직후 — Apple staticlib에서도 패키지 등록을 명시적으로 수행한다.
  // __mod_init_func에 기대지 않아 iOS/ld 버전과 무관하게 invoke 대상이 준비된다.
  rustra_template_init();
  NSLog(@"[template-ios] rustra_template_init complete");

  // MobileBridge 플랫폼 콜백 주입.
  rustra_template_register_mobile_registry(&RUSTRA_IOS_BRIDGE);
  NSLog(@"[template-ios] MobileBridge registered (file+notify)");
}

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
