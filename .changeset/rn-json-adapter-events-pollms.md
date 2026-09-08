---
'@rustra/react-native': minor
---

RN JSON adapter (`createReactNativeEngine`) now has a complete event surface.
The C++ dispatcher (`RustraJSIBridge.cpp`) already queues `emit`s on
CallInvoker-less hosts and waits for JS to call `drainEvents()` — but the TS
wrapper never polled, so those queues were never consumed. `subscribeEvent`
gains a `pollMs` option that runs a JS polling-drain loop (one per native
instance, stopped by the last unsubscribe); it is harmless alongside the
`onEvent` push path (an empty drain returns 0) and is silently ignored on
natives that don't expose `drainEvents`. `RustraEventNative` now declares the
optional `drainEvents()` method matching the existing C++/JNI host function.
