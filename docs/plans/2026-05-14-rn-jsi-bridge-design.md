# RN JSI Direct Bridge Design

## Goal

Replace Expo Module bridge with raw JSI HostObject to reduce React Native invocation latency from ~52.5µs to ~8-12µs.

## Constraints

- iOS first, Android later
- Remove Expo Module dependency entirely
- Rust remains source of truth (codegen from Rust)
- Byte buffer abstraction for future binary protocol migration
- JSON protocol for now, swappable without touching C++ layer

## Architecture

```
JS (rustra engine)
  ↓ invoke(command, args)
  ↓ TextEncoder → Uint8Array (phase 1: JSON bytes)
JSI HostObject
  ↓ jsi::ArrayBuffer
C++ JSI Bridge (byte tunnel, protocol-agnostic)
  ↓ raw bytes + length
Rust extern "C" (byte buffer FFI)
  ↓ currently: serde_json / future: bincode
Rust Package.invoke_json()
```

The C++ layer is a thin byte tunnel. It does not know or care whether the payload is JSON, MessagePack, or bincode. This allows the JS and Rust layers to swap serialization independently.

## Components

### 1. Rust: Byte Buffer FFI Entry Point

New generic FFI function alongside existing per-package functions:

```rust
#[no_mangle]
pub extern "C" fn rustra_invoke(
    package_id: *const c_char,
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8
```

- Currently wraps `serde_json` internally
- Future: swap to `bincode` or other binary format without changing signature
- Caller must call `rustra_free_buffer` to deallocate returned buffer

### 2. C++ JSI Bridge (~100-150 lines)

Single `RustraHostObject` class implementing `jsi::HostObject`:

- Exposes `invoke(packageId: string, payload: ArrayBuffer): ArrayBuffer` to JS
- Passes raw bytes through to Rust FFI
- Returns raw bytes back to JS as ArrayBuffer
- No JSON parsing, no type awareness, pure byte tunnel
- Registered as a TurboModule via CocoaPod

### 3. JS Package (packages/react-native)

```typescript
export function createReactNativeEngine(nativeModule: RustraJSIModule): ReactNativeEngineClient {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const json = JSON.stringify({ command, args });
      const payload = encoder.encode(json);
      const resultBytes = nativeModule.invoke(packageId, payload);
      const resultJson = decoder.decode(resultBytes);
      return Promise.resolve(JSON.parse(resultJson) as T);
    },
  };
}
```

Phase 1: `JSON.stringify` / `JSON.parse` with TextEncoder/Decoder wrapping bytes.
Phase 2: Swap to `msgpack.encode` / `bincode::deserialize` — C++ unchanged.

### 4. Build Integration

- Rust static library via `cargo-lipo` (iOS universal binary)
- C++ bridge file compiled via CocoaPod
- podspec links Rust `.a` + C++ bridge together
- JSI headers from React Native framework

### 5. Expo Module Removal

- Delete `modules/rustra-calculator/` Expo module from example
- Remove `expo-modules-core` dependency from RN package
- Remove `rustra-calculator` Expo module dependency from example app
- Update `packages/react-native/src/index.ts` to use JSI engine only

## Expected Performance

| Segment | Current (Expo) | JSI Direct |
|---------|---------------|------------|
| JS → Native | ~40µs | ~1-2µs |
| JSON serialization | ~2.9µs | ~2.9µs |
| FFI layer | ~3.5µs (Swift) | ~0.5µs (C++) |
| Rust execution | ~0.2µs | ~0.2µs |
| **Total** | **~52.5µs** | **~8-12µs** |

## Binary Migration Path (Future)

1. JS: Replace `JSON.stringify` + `TextEncoder` with `msgpack.encode` (returns Uint8Array)
2. Rust: Replace `serde_json::from_slice` with `bincode::deserialize`
3. C++: Zero changes — still passes raw bytes
4. FFI signature: Zero changes — still `*const u8` + length

## Scope

- Phase 1 (this implementation): iOS JSI bridge with JSON-over-bytes
- Phase 2 (future): Android JSI bridge
- Phase 3 (future): Binary protocol swap (JS + Rust only)
