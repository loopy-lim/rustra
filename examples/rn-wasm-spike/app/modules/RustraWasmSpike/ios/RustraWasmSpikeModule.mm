// RustraWasmSpikeModule.mm — RN native module driving BOTH engines:
//  - wasm3 interpreting a .wasm engine (bundle or swapped file, no restart)
//  - the native staticlib rustra engine (byte-equality baseline)
//
// wasm call protocol (mirrors scripts/wasm3-smoke-main.c):
//   req_off = spike_alloc(req_len); write req; len_off = spike_alloc(4);
//   zero it; resp_off = spike_invoke(req_off, req_len, len_off);
//   re-read memory (it can grow); resp_len = u32le[len_off]; copy out; free.
#import "RustraWasmSpikeModule.h"

#include "wasm3.h"

#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

// ── staticlib C surface (same spike_* names as the wasm exports) ─────────
extern "C" {
uint8_t *spike_invoke(const uint8_t *payload, size_t payload_len, size_t *out_len);
uint8_t *spike_contract_hash(size_t *out_len);
void spike_free(uint8_t *ptr, size_t len);
}

static std::mutex g_engine_mutex;

namespace {

std::string hex_encode(const uint8_t *data, size_t len) {
  static const char *digits = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 0x0f]);
  }
  return out;
}

// postcard envelope (String, String): varint len + bytes, twice.
std::vector<uint8_t> make_envelope(const char *cmd, const char *args_json) {
  size_t cl = strlen(cmd), al = strlen(args_json);
  std::vector<uint8_t> out;
  out.push_back(static_cast<uint8_t>(cl));
  out.insert(out.end(), cmd, cmd + cl);
  size_t v = al;
  do {
    uint8_t byte = static_cast<uint8_t>(v & 0x7f);
    v >>= 7;
    if (v) byte |= 0x80;
    out.push_back(byte);
  } while (v);
  out.insert(out.end(), args_json, args_json + al);
  return out;
}

} // namespace

@implementation RustraWasmSpikeModule {
  IM3Environment _env;
  IM3Runtime _runtime;
  IM3Module _module;
  uint32_t _engineVersion;
  char _contractHash[65];
  double _instantiateMs;
}

RCT_EXPORT_MODULE();

- (instancetype)init {
  if (self = [super init]) {
    _env = nullptr;
    _runtime = nullptr;
    _module = nullptr;
    _engineVersion = 0;
    _instantiateMs = 0;
    _contractHash[0] = 0;
  }
  return self;
}

- (dispatch_queue_t)methodQueue {
  return dispatch_queue_create("dev.rustra.wasm-spike", DISPATCH_QUEUE_SERIAL);
}

- (void)teardown {
  std::lock_guard<std::mutex> lock(g_engine_mutex);
  if (_runtime) {
    m3_FreeRuntime(_runtime);
    _runtime = nullptr;
  }
  if (_env) {
    m3_FreeEnvironment(_env);
    _env = nullptr;
  }
  _module = nullptr;
}

- (void)dealloc {
  [self teardown];
}

- (double)nowMs {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// ── wasm3 helpers ────────────────────────────────────────────────────────

- (BOOL)memPtr:(uint8_t **)mem size:(size_t *)size {
  *mem = m3_GetMemory(_module, size, 0);
  return *mem != nullptr;
}

- (BOOL)callExport:(const char *)name args:(std::vector<uint32_t>)args ret:(uint32_t *)ret {
  IM3Function fn = nullptr;
  M3Result r = m3_FindFunctionIn(&fn, _module, name);
  if (r) return NO;
  switch (args.size()) {
  case 0: r = m3_CallV(fn); break;
  case 1: r = m3_CallV(fn, args[0]); break;
  case 2: r = m3_CallV(fn, args[0], args[1]); break;
  case 3: r = m3_CallV(fn, args[0], args[1], args[2]); break;
  default: return NO;
  }
  if (r) return NO;
  if (ret) {
    uint32_t v = 0;
    r = m3_GetResultsV(fn, &v);
    if (r) return NO;
    *ret = v;
  }
  return YES;
}

- (BOOL)callAlloc:(uint32_t)len out:(uint32_t *)out {
  return [self callExport:"spike_alloc" args:{len} ret:out];
}

- (BOOL)callUnstage:(uint32_t)off len:(uint32_t)len {
  return [self callExport:"spike_unstage" args:{off, len} ret:nullptr];
}

- (BOOL)zeroMem:(uint32_t)off len:(uint32_t)len {
  uint8_t *mem = nullptr;
  size_t sz = 0;
  if (![self memPtr:&mem size:&sz]) return NO;
  if ((size_t)off + len > sz) return NO;
  memset(mem + off, 0, len);
  return YES;
}

- (BOOL)writeMem:(uint32_t)off bytes:(const uint8_t *)b len:(uint32_t)len {
  uint8_t *mem = nullptr;
  size_t sz = 0;
  if (![self memPtr:&mem size:&sz]) return NO;
  if ((size_t)off + len > sz) return NO;
  memcpy(mem + off, b, len);
  return YES;
}

- (BOOL)readMem:(uint32_t)off buf:(void *)buf len:(uint32_t)len {
  uint8_t *mem = nullptr;
  size_t sz = 0;
  if (![self memPtr:&mem size:&sz]) return NO;
  if ((size_t)off + len > sz) return NO;
  memcpy(buf, mem + off, len);
  return YES;
}

// Instantiate a .wasm from file; returns nil on success or an error message.
- (NSString *)instantiateFromFile:(NSString *)path {
  [self teardown];

  NSData *data = [NSData dataWithContentsOfFile:path];
  if (!data) return @"cannot read wasm file";

  double ms = [self nowMs];
  _env = m3_NewEnvironment();
  if (!_env) return @"m3_NewEnvironment failed";
  _runtime = m3_NewRuntime(_env, 256u * 1024 * 1024, nullptr);
  if (!_runtime) return @"m3_NewRuntime failed";

  M3Result r = m3_ParseModule(_env, &_module, static_cast<const uint8_t *>(data.bytes),
                              static_cast<uint32_t>(data.length));
  if (r) return [NSString stringWithFormat:@"parse: %s", r];
  r = m3_LoadModule(_runtime, _module);
  if (r) return [NSString stringWithFormat:@"load: %s", r];
  _instantiateMs = [self nowMs] - ms;

  uint32_t ver = 0;
  if (![self callExport:"spike_engine_version" args:{} ret:&ver])
    return @"spike_engine_version failed";
  _engineVersion = ver;

  uint32_t lenOff = 0;
  if (![self callAlloc:4 out:&lenOff]) return @"spike_alloc failed";
  [self zeroMem:lenOff len:4];
  uint32_t hashOff = 0;
  if (![self callExport:"spike_contract_hash" args:{lenOff} ret:&hashOff])
    return @"spike_contract_hash failed";
  uint32_t hashLen = 0;
  if (![self readMem:lenOff buf:&hashLen len:4]) return @"read hash len failed";
  if (hashLen != 64) return @"hash length != 64";
  if (![self readMem:hashOff buf:_contractHash len:64]) return @"read hash failed";
  _contractHash[64] = 0;
  [self callExport:"spike_free" args:{hashOff, 64u} ret:nullptr];
  [self callUnstage:lenOff len:4];

  return nil;
}

// Full wasm invoke: request bytes -> wasm3 -> response bytes.
- (BOOL)wasmInvoke:(std::vector<uint8_t>)req resp:(std::vector<uint8_t> *)resp err:(std::string *)err {
  uint32_t reqOff = 0, lenOff = 0, respOff = 0, respLen = 0;
  if (![self callAlloc:static_cast<uint32_t>(req.size()) out:&reqOff]) {
    *err = "spike_alloc(req) failed";
    return NO;
  }
  if (![self callAlloc:4 out:&lenOff]) {
    *err = "spike_alloc(4) failed";
    return NO;
  }
  [self zeroMem:lenOff len:4];
  if (![self writeMem:reqOff bytes:req.data() len:static_cast<uint32_t>(req.size())]) {
    *err = "writeMem failed";
    return NO;
  }
  if (![self callExport:"spike_invoke"
                   args:{reqOff, static_cast<uint32_t>(req.size()), lenOff}
                   ret:&respOff]) {
    *err = "spike_invoke failed (trap or missing export)";
    return NO;
  }
  if (![self readMem:lenOff buf:&respLen len:4]) {
    *err = "read resp len failed";
    return NO;
  }
  resp->assign(respLen, 0);
  if (![self readMem:respOff buf:resp->data() len:respLen]) {
    *err = "read resp bytes failed";
    return NO;
  }
  [self callExport:"spike_free" args:{respOff, respLen} ret:nullptr];
  [self callUnstage:reqOff len:static_cast<uint32_t>(req.size())];
  [self callUnstage:lenOff len:4];
  return YES;
}

// Native staticlib invoke (baseline path).
- (BOOL)nativeInvoke:(std::vector<uint8_t>)req resp:(std::vector<uint8_t> *)resp err:(std::string *)err {
  size_t respLen = 0;
  uint8_t *respOff = spike_invoke(req.data(), req.size(), &respLen);
  if (!respOff) {
    *err = "native spike_invoke returned null";
    return NO;
  }
  resp->assign(respOff, respOff + respLen);
  spike_free(respOff, respLen);
  return YES;
}

// ── JS surface ───────────────────────────────────────────────────────────

RCT_EXPORT_METHOD(loadBundledEngine:(RCTPromiseResolveBlock)resolve
                          rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *path = [NSBundle.mainBundle pathForResource:@"engine_v1" ofType:@"wasm"];
  if (!path) {
    reject(@"engine_missing", @"engine_v1.wasm not in app bundle", nil);
    return;
  }
  NSString *fail = [self instantiateFromFile:path];
  if (fail) {
    reject(@"instantiate_failed", fail, nil);
    return;
  }
  resolve(@{
    @"engineVersion" : @(_engineVersion),
    @"contractHash" : [NSString stringWithUTF8String:_contractHash],
    @"instantiateMs" : @(_instantiateMs),
    @"path" : path,
  });
}

RCT_EXPORT_METHOD(reloadWasm:(NSString *)newPath
                     resolve:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *fail = [self instantiateFromFile:newPath];
  if (fail) {
    reject(@"reload_failed", fail, nil);
    return;
  }
  resolve(@{
    @"engineVersion" : @(_engineVersion),
    @"contractHash" : [NSString stringWithUTF8String:_contractHash],
    @"instantiateMs" : @(_instantiateMs),
    @"path" : newPath,
  });
}

// Swap flow (iOS): the host copies engine_v2.wasm into the app's Documents
// dir (simctl get_app_container data); this re-instantiates from there with
// NO app restart.
RCT_EXPORT_METHOD(reloadWasmFromDocuments:(RCTPromiseResolveBlock)resolve
                                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES)
      firstObject];
  path = [path stringByAppendingPathComponent:@"engine_v2.wasm"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    reject(@"engine_v2_missing", @"Documents/engine_v2.wasm not present", nil);
    return;
  }
  NSString *fail = [self instantiateFromFile:path];
  if (fail) {
    reject(@"reload_failed", fail, nil);
    return;
  }
  resolve(@{
    @"engineVersion" : @(_engineVersion),
    @"contractHash" : [NSString stringWithUTF8String:_contractHash],
    @"instantiateMs" : @(_instantiateMs),
    @"path" : path,
  });
}

RCT_EXPORT_METHOD(evalCommandWasm:(NSArray *)bytes
                          resolve:(RCTPromiseResolveBlock)resolve
                         rejecter:(RCTPromiseRejectBlock)reject) {
  std::vector<uint8_t> req;
  for (id v in bytes) req.push_back(static_cast<uint8_t>([v unsignedIntValue]));
  std::vector<uint8_t> resp;
  std::string err;
  double t0 = [self nowMs];
  if (![self wasmInvoke:req resp:&resp err:&err]) {
    reject(@"wasm_invoke_failed", [NSString stringWithUTF8String:err.c_str()], nil);
    return;
  }
  resolve(@{
    @"hex" : [NSString stringWithUTF8String:hex_encode(resp.data(), resp.size()).c_str()],
    @"ms" : @([self nowMs] - t0),
  });
}

RCT_EXPORT_METHOD(evalCommandNative:(NSArray *)bytes
                            resolve:(RCTPromiseResolveBlock)resolve
                           rejecter:(RCTPromiseRejectBlock)reject) {
  std::vector<uint8_t> req;
  for (id v in bytes) req.push_back(static_cast<uint8_t>([v unsignedIntValue]));
  std::vector<uint8_t> resp;
  std::string err;
  double t0 = [self nowMs];
  if (![self nativeInvoke:req resp:&resp err:&err]) {
    reject(@"native_invoke_failed", [NSString stringWithUTF8String:err.c_str()], nil);
    return;
  }
  resolve(@{
    @"hex" : [NSString stringWithUTF8String:hex_encode(resp.data(), resp.size()).c_str()],
    @"ms" : @([self nowMs] - t0),
  });
}

// Helper for JS: build the postcard envelope for a command (keeps App.tsx
// simple and the byte construction identical for both engine paths).
RCT_EXPORT_METHOD(makeEnvelope:(NSString *)command
                      argsJson:(NSString *)argsJson
                       resolve:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject) {
  std::vector<uint8_t> env = make_envelope(command.UTF8String, argsJson.UTF8String);
  NSMutableArray *bytes = [NSMutableArray arrayWithCapacity:env.size()];
  for (uint8_t b : env) [bytes addObject:@(b)];
  resolve(@{
    @"hex" : [NSString stringWithUTF8String:hex_encode(env.data(), env.size()).c_str()],
    @"bytes" : bytes,
  });
}

@end
