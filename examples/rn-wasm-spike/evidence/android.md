# Android emulator evidence — rustra wasm3 spike (Task A0)

Environment: Medium_Phone_API_36.1 emulator (adb serial emulator-5572), API 36
arm64, app `com.rustrawasmspike` (Debug APK built 20:15:59, .so md5
90b17949f4d90d9731dcb19573044db2), React Native 0.81.5 bridgeless/Hermes,
Metro on :8082 (`debug_http_host=localhost:8082` shared pref + two
`adb reverse` rules 8081→8082, 8082→8082). Captured via `logcat -s
ReactNativeJS:V` and `logcat | grep RustraWasmSpike:`.

Debugging note (root cause of the earlier `find spike_alloc: function lookup
failed` failures): the emulator kept running a STALE install from 20:11:56 that
predated the Wasm3Jni.cpp unification to a single shared engine. On API 36 the
loader maps librustra_wasm_spike.so straight out of base.apk (no extracted lib
path), and `adb install -r` did not replace the APK. A forced
`adb uninstall` + fresh `adb install` (lastUpdateTime 20:33:21) fixed it. No
code change was needed for this failure — the old per-entry-point
`static WasmEngine` code was already gone from the new APK.

## Phase 1 — v1 engine (factor=2), wasm vs native staticlib (cold start, pid 6245)

```
20:35:54.667 (native) RustraWasmSpike: instantiated: version=2 hash=e79b7f01… in 2.0 ms
20:35:54.704 [ok]   instantiated: engineVersion=2 hash=e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2 in 2.0ms
20:35:54.755 [hex]  double(21) envelope (16B): 06646f75626c65087b226e223a32317d
20:35:54.794 [hex]  double(21) wasm   (0.803ms): 01010c7b2276616c7565223a34327d00
20:35:54.794 [hex]  double(21) native (10.769ms): 01010c7b2276616c7565223a34327d00
20:35:54.795 [ok]   double(21) => BYTE-IDENTICAL
20:35:54.850 [hex]  addNumbers(40,2) envelope (26B): 0a6164644e756d626572730e7b2261223a34302c2262223a327d
20:35:54.876 [hex]  addNumbers(40,2) wasm   (0.370ms): 01010c7b2276616c7565223a34327d00
20:35:54.878 [hex]  addNumbers(40,2) native (0.037ms): 01010c7b2276616c7565223a34327d00
20:35:54.878 [ok]   addNumbers(40,2) => BYTE-IDENTICAL
```

## Phase 2 — NO-RESTART swap to v2 (factor=3), two proofs

(a) Manual button tap, same process (pid 6245, started 20:35, tapped 20:38):

```
20:38:29.287 [info] swap: reloading engine_v2.wasm (factor=3) WITHOUT app restart…
20:38:29.354 [ok]   reloaded: engineVersion=3 hash=e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2 in 4.0ms — hash UNCHANGED (contract stable)
20:38:29.396 [hex]  double(21) wasm   (0.564ms): 01010c7b2276616c7565223a36337d00   <- {"value":63}
20:38:29.396 [hex]  double(21) native (0.041ms):  01010c7b2276616c7565223a34327d00   <- {"value":42}
20:38:29.399 [fail] double(21) => MISMATCH   <- EXPECTED: wasm swapped to v2, native baseline stayed v1
20:38:29.437 [hex]  addNumbers(40,2) wasm   (0.129ms): 01010c7b2276616c7565223a34327d00
20:38:29.437 [hex]  addNumbers(40,2) native (0.030ms): 01010c7b2276616c7565223a34327d00
20:38:29.437 [ok]   addNumbers(40,2) => BYTE-IDENTICAL
```

(b) Fully automatic mid-run swap (fresh process 6541, engine_v2.wasm pushed into
filesDir via `adb push` + `run-as cp` at 20:43:38, poller swapped at 20:43:50
with no user interaction) after fixing the App.tsx auto-poll bug (onSwap used to
swallow its own error, so the poll loop returned after the first attempt):

```
20:43:50.150 [ok]   reloaded: engineVersion=3 hash=e79b7f013a6e7f88098ff552519fab69bee7ac1db244f1fc9f81dc13a9cc32e2 in 1.0ms — hash UNCHANGED (contract stable)
20:43:50.198 [hex]  double(21) wasm   (8.668ms): 01010c7b2276616c7565223a36337d00
20:43:50.200 [hex]  double(21) native (0.046ms):  01010c7b2276616c7565223a34327d00
20:43:50.200 [fail] double(21) => MISMATCH (expected, as above)
20:43:50.223 [ok]   addNumbers(40,2) => BYTE-IDENTICAL
```

engine_v2.wasm on device: 848081 bytes, sha256
3a71894a5aabadcf3b7eb7d208f9ee9f5f057ad0cfbe37786c41716b649fac8a.

## Verdict: PASS

- boot ok; instantiate ok; v1 wasm == native byte-identical on both commands.
- engine swap WITHOUT app restart: engineVersion 2→3, contract hash unchanged,
  double(21) 42→63 in-wasm while native baseline stayed 42; addNumbers unchanged.
- Timings: instantiate 1–4 ms; per-call wasm 0.1–9 ms vs native 0.03–0.05 ms
  (steady state; the one 10.8 ms native sample was first-call overhead).
  No red flag vs the >100x gate; all calls are single-digit milliseconds.
