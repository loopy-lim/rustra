# iOS simulator evidence — rustra wasm3 spike (Task A0)

Environment: iPhone 17 simulator (iOS 26.x), UDID 99B087B5-DEF6-4CF1-9177-81A5DE564CFC,
app `org.reactjs.native.example.RustraWasmSpike` (Debug, Metro on :8082),
React Native 0.81.5 / Hermes. Captured via `xcrun simctl spawn <SIM> log stream`
(`/tmp/spike-oslog.log`, 2026-08-31 17:04:43–17:04:46).

Boot: app booted, JS bundle from Metro, native module loaded (373 m3__/spike__
symbols confirmed in RustraWasmSpike.debug.dylib; engine_v1.wasm in the app
bundle, md5 827e6d11f37e8a3032ec0d41e9126475 = artifacts/engine_v1.wasm).

## Phase 1 — v1 engine (factor=2), wasm vs native staticlib

```
17:04:43.980 [ok]   instantiated: engineVersion=2 hash=e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2 in 1.0ms
17:04:43.981 [hex]  double(21) envelope (16B): 06646f75626c65087b226e223a32317d
17:04:44.002 [hex]  double(21) wasm   (20.000ms): 01010c7b2276616c7565223a34327d00
17:04:44.002 [hex]  double(21) native (0.000ms):  01010c7b2276616c7565223a34327d00
17:04:44.002 [ok]   double(21) => BYTE-IDENTICAL
17:04:44.005 [hex]  addNumbers(40,2) envelope (26B): 0a6164644e756d626572730e7b2261223a34302c2262223a327d
17:04:44.008 [hex]  addNumbers(40,2) wasm   (2.000ms): 01010c7b2276616c7565223a34327d00
17:04:44.008 [hex]  addNumbers(40,2) native (0.000ms): 01010c7b2276616c7565223a34327d00
17:04:44.008 [ok]   addNumbers(40,2) => BYTE-IDENTICAL
```

## Phase 2 — NO-RESTART swap to v2 (factor=3), pushed like an OTA drop

engine_v2.wasm (SHA-1 ff12fbfd60b34c4edabfbe86107d28eda13f2c27 = SHA-256
3a71894a5aabadcf3b7eb7d208f9ee9f5f057ad0cfbe37786c41716b649fac8a — the repo artifact
artifacts/engine_v2.wasm) copied into the
app's Documents/ via `simctl get_app_container <SIM> data` WHILE the app kept
running; the app's poller picked it up 2 s later. Same process (pid 94484) throughout.

```
17:04:46.012 [info] swap: reloading engine_v2.wasm (factor=3) WITHOUT app restart…
17:04:46.115 [ok]   reloaded: engineVersion=3 hash=e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2 in 1.0ms — hash UNCHANGED (contract stable)
17:04:46.133 [hex]  double(21) wasm   (17.000ms): 01010c7b2276616c7565223a36337d00   <- {"value":63}
17:04:46.133 [hex]  double(21) native (0.000ms):  01010c7b2276616c7565223a34327d00   <- {"value":42}
17:04:46.133 [fail] double(21) => MISMATCH   <- EXPECTED: wasm now runs v2 (63), native baseline stays v1 (42)
17:04:46.142 [hex]  addNumbers(40,2) wasm   (2.000ms): 01010c7b2276616c7565223a34327d00
17:04:46.142 [hex]  addNumbers(40,2) native (0.000ms): 01010c7b2276616c7565223a34327d00
17:04:46.142 [ok]   addNumbers(40,2) => BYTE-IDENTICAL   (v2 leaves addNumbers untouched)
```

## Verdict: PASS

- boot ok; instantiate ok; v1 wasm == native byte-identical on both commands.
- engine swap WITHOUT app restart: engineVersion 2→3, contract hash unchanged,
  double(21) behavior 42→63 while the native staticlib baseline stayed 42 —
  exactly the "behavior swap under a frozen contract" invariant.
- Timings: instantiate 1.0 ms; per-call wasm 2–20 ms vs native <0.5 ms
  (interpreter vs native, no red flag vs the >100x gate; both are sub-20 ms).
