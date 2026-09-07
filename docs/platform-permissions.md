English | [한국어](./platform-permissions.ko.md)

# Platform Permissions Guide (for Host Apps)

## 1. Scope: what rustra-bridge does and does not do

rustra-bridge is a Rust engine plus a JS/React-Native bridge library. **It never requests operating-system permissions** (camera, microphone, location, file system, network, etc.) and ships no platform permission declarations of its own.

By design, the host application owns platform permission UX:

```txt
Rust owns durable state and heavy work.
RN owns immediate UI state.
Native bridge owns only engine lifecycle and platform permission UX.
```

(From [docs/research/rust-local-engine-vs-native-bridges.md](./research/rust-local-engine-vs-native-bridges.md).)

The library's own authorization layer is the **command-level capability system** (Runtime Authority): deny-by-default, `require_capability` at the builder, `grant_capability` at runtime. That system governs _who may call a bridge command_ — it is independent of, and does not replace, OS-level permission prompts. See the "Runtime Authority (capabilities)" section of the [Rust API Guide](./rust-api-guide.md) (Appendix: Advanced API Summary) and the `.require_capability(name, cap)` builder entry.

This guide walks host apps through the platform permission surfaces they own when embedding rustra.

---

## 2. Which layer answers which question?

| Question                                                     | OS permission (iOS/Android/Windows/macOS)       | Tauri ACL (capabilities/permissions)   | rustra capability system                         |
| ------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| May the app access hardware (camera, mic, location)?         | **Yes** — declared + runtime-prompted           | No (except via specific Tauri plugins) | No                                               |
| May this window/webview call this Tauri command/plugin?      | No                                              | **Yes**                                | Only for commands routed through `tauri_support` |
| Who may call this bridge command at runtime?                 | No                                              | No                                     | **Yes** — deny-by-default, `grant_capability`    |
| May the app load remote code / connect to arbitrary origins? | Partially (ATS, cleartext, CSP at OS/app level) | **Yes** — CSP in `tauri.conf.json`     | No                                               |

Rule of thumb: OS permissions gate **hardware and system resources**, Tauri ACL gates **which webview may invoke which Tauri plugin command**, and rustra capabilities gate **which bridge commands are callable** until granted.

---

## 3. Tauri (all desktop platforms)

### 3-1. Tauri ACL

Tauri v2 uses an Access Control List system: capabilities files (`src-tauri/capabilities/*.json`) declare which windows may use which plugin permissions. A rustra host that only dispatches through `rustra::tauri_support` (`tauri_support::register(pkg, builder)` / `register_with_events(pkg, builder)`) typically needs minimal ACL grants beyond the defaults — rustra commands ride Tauri's invoke handler, not a plugin. Consult the official Tauri "Capabilities" and "Permissions" documentation for the full model.

Note: `examples/tauri-calculator` currently has an empty `gen/schemas/capabilities.json` — the calculator commands need no extra ACL entries.

### 3-2. CSP

`tauri.conf.json > app.security.csp` controls what the webview may load. The example ships `"csp": null` (dev-friendly, not recommended for production). Hosts should set a restrictive CSP in production, especially when the frontend talks to the bridge via `invoke`.

### 3-3. rustra capability system (distinct layer)

Even inside Tauri, rustra commands guarded by `require_capability` still answer to the library's own deny-by-default check (`capability.denied` until `grant_capability`). Tauri ACL and rustra capabilities compose; neither substitutes for the other. See the [Rust API Guide](./rust-api-guide.md).

---

## 4. Windows (Tauri hosts)

- **WebView2 runtime**: Tauri on Windows renders in Microsoft Edge WebView2. Most Windows 10/11 installs already include it; if absent, the bootstrapper/installed runtime must be provisioned (Tauri's bundler can download a fixed WebView2 runtime for distribution). This is an environment requirement, not a permission.
- **MSIX / package identity**: Certain Windows capabilities (e.g., some device access, broad file-system access) are only meaningful when the app has package identity — i.e., it is packaged as MSIX or signed appropriately. An unpackaged, unsigned executable has fewer capability options but also fewer restrictions on ordinary file/network access. Decide based on your distribution model (MSIX, signed MSI/NSIS installer, or portable EXE).
- **Typical permissions a host may need**: none for pure compute bridges (the calculator example bundles nothing and requests nothing). Hosts whose bridge commands touch files, camera, or microphone should declare the corresponding Windows capabilities in their packaging manifest and/or handle Windows privacy settings prompts.
- **SmartScreen**: unsigned installers/EXEs trigger SmartScreen warnings; code-signing (and ideally EV certificates) is a distribution concern, not a rustra one.

---

## 5. macOS (Tauri hosts)

- **entitlements.plist**: hosts going to the Mac App Store or using sandboxing must declare entitlements (`com.apple.security.app-sandbox`, app-category, and resource entitlements such as camera/microphone/files). Tauri apps distributed outside the App Store can run without the sandbox entitlement, but then App Store submission is not possible.
- **Info.plist usage descriptions**: if your bridge commands reach protected resources, add the matching usage-description keys to the app's `Info.plist` (e.g., `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`) — macOS prompts on first access when sandboxed.
- **Notarization**: distributing outside the App Store requires Developer ID signing plus notarization (Apple's automated scan). This is the host's release pipeline responsibility.
- **Hardened runtime**: required for notarization; enable it in your signing settings.

---

## 6. iOS (React Native hosts)

iOS gates hardware behind Info.plist usage descriptions plus a runtime prompt. Add keys only for what your bridge commands actually touch. Common entries:

| Key                                   | Resource              | When a rustra host needs it               |
| ------------------------------------- | --------------------- | ----------------------------------------- |
| `NSCameraUsageDescription`            | Camera                | Bridge commands that capture photos/video |
| `NSMicrophoneUsageDescription`        | Microphone            | Bridge commands that record audio         |
| `NSPhotoLibraryUsageDescription`      | Photo library read    | Bridge commands that read user photos     |
| `NSPhotoLibraryAddUsageDescription`   | Photo library write   | Bridge commands that save images          |
| `NSLocationWhenInUseUsageDescription` | Location (foreground) | Bridge commands that read location        |

Notes:

- **ATS (App Transport Security)**: local compute bridges need no exceptions. The RN example ships `NSAppTransportSecurity` with `NSAllowsArbitraryLoads: false` and `NSAllowsLocalNetworking: true` (Metro dev-server traffic only). Keep ATS strict in production.
- Missing usage descriptions crash the app at the moment the protected API is first used — declare everything your feature set touches.

---

## 7. Android (React Native hosts)

Declare what the app needs in `AndroidManifest.xml`; dangerous permissions additionally require a runtime prompt, which the **host** must implement (e.g., `PermissionsAndroid` in RN).

Common entries:

| Permission                                | Protection level | Purpose                                          |
| ----------------------------------------- | ---------------- | ------------------------------------------------ |
| `android.permission.INTERNET`             | normal           | Network access; dev-server / remote code loading |
| `android.permission.CAMERA`               | dangerous        | Camera capture (runtime prompt)                  |
| `android.permission.RECORD_AUDIO`         | dangerous        | Microphone (runtime prompt)                      |
| `android.permission.READ_MEDIA_IMAGES`    | dangerous        | Photo library read (API 33+)                     |
| `android.permission.ACCESS_FINE_LOCATION` | dangerous        | Location (runtime prompt)                        |

- `INTERNET` is the baseline for any app loading bundles from a dev server or fetching remote resources.
- Cleartext traffic is controlled separately (`android:usesCleartextTraffic`); the RN wasm spike templates this per build type.
- Runtime prompting order: declare in manifest → request at runtime → only then call the bridge command that uses the resource. rustra's capability `grant_capability` is a natural place to also confirm the OS grant before enabling the command.

---

## 8. The device capability contract (rustra side)

OS permissions stay with the host — but rustra gives commands a way to *declare* which
device capabilities they assume, and JS a standard way to *query* status, so the
ad-hoc per-app wiring doesn't fork across hosts.

**Declare (Rust)** — the requirement becomes part of schema.json and codegen output:

```rust
#[command(device(camera, bluetooth))]
fn scan_tags(input: ScanInput) -> Result<ScanOutput> { /* … */ }
```

Tokens come from a versioned catalog (`DeviceCapability::ALL`): `camera`,
`microphone`, `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`,
`wifi`, `bluetooth`, `battery`, `nfc`, `biometric`, `haptics`, `flashlight`,
`contacts`, `calendar`, `photo-library`, `motion`, `usb`, `serial`,
`network-state`, `screen-brightness`. W3C PermissionName spelling is kept where one
exists. OS-specific permission strings (Android `NEARBY_DEVICES`, iOS `NSCameraUsageDescription`,
macOS entitlements) are intentionally hidden behind the token — the cross-reference
for each OS/plugin/library lives in
[docs/research/2026-09-08-device-capabilities.md](./research/2026-09-08-device-capabilities.md).

A declaration is a contract document, not runtime gating: rustra never blocks the
invoke and never prompts. Declaring `devices` changes schema.json (and therefore the
contract hash) — intended evolution, caught by `rustra diff`.

**Query (TypeScript)** — one registered provider answers for the whole app:

```ts
import { registerDeviceStatusProvider, getDeviceStatus } from '@rustra/types';

registerDeviceStatusProvider(async (capability) => {
  if (capability === 'camera') return { availability: 'available', permission: 'granted' };
  return { availability: 'unknown', permission: 'unknown' };
});

const status = await getDeviceStatus('camera');
// → { availability: 'available' | 'unavailable' | 'unknown',
//     permission:   'granted' | 'denied' | 'prompt' | 'unknown' }
```

Without a registered provider the query fails open (`unknown`/`unknown`) with a
one-time debug note — the host app decides what to do. Hosts raise
`device.unavailable` / `device.permission_denied` themselves when they choose to
enforce; rustra's core never emits these codes.

**How the layers compose**: the OS gates hardware (declare + runtime prompt), the
Tauri ACL gates which webview may invoke plugins, rustra capabilities gate who may
call a bridge command, and the device declaration documents *why* a command needs
the hardware — see §2.

## 9. Current state of the examples

| Example                            | Platform | Permission declarations                                                 | Why                                                                   |
| ---------------------------------- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `examples/tauri-calculator`        | Tauri    | None (empty `capabilities.json`, `"csp": null`, bundling inactive)      | Pure compute commands; dev-only configuration                         |
| `examples/react-native-calculator` | iOS (RN) | No `NS*UsageDescription` entries; ATS strict with local networking only | The calculator needs no protected resources — absence here is correct |
| `examples/rn-wasm-spike`           | Android  | `INTERNET` only (plus templated `usesCleartextTraffic`)                 | Spikes load the engine over the dev server; no hardware access        |

If a future example gains camera/audio features, its manifests and this table should be updated together.
