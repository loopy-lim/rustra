# 디바이스 역량 계약 레이어 — 리서치 (2026-09-08)

상태: complete. 조사 방법 — rustra-bridge 저장소 코드/문서 직접 실측(`file:line`
인용은 저장소 루트 상대) + 공식 문서 웹 조사(각 주장에 URL). 웹으로 교차 검증하지
못한 셀은 "미검증"으로 명시.

## 해결하려는 요구

사용자 요청: "Tauri를 사용하는 사람이 불편함 없도록 멀티 OS 지원. mobile과
desktop은 권한과 할 수 있는 게 많다 — wifi, bluetooth, camera, battery 같은
것들. 이 나열을 포함해 인터넷에서 추가로 찾아서 그것들도 호환되도록 지원."

전제 제약: rustra는 OS 권한을 직접 요청하지 않는다(`docs/platform-permissions.md:7`).
따라서 "호환"의 의미는 _하드웨어 접근의 균일화_(불가능 — OS 몫)가 아니라
**역량 계약의 균일화** — 명령이 어떤 디바이스 역량을 요구하는지 선언하고,
호스트가 그 역량의 상태를 표준 형태로 조회·보고하고, 실패를 표준 에러 코드로
구분하는 것 — 이어야 한다. 이 경계가 철학에 맞는지는 §5.0에서 검증한다.

## 1. 요약/결론 — 권고 계약 5줄

1. **선언**: `#[command(device(camera, microphone))]` 매크로 + 빌더
   `.command_devices(name, &[DeviceCapability])` — `platform(...)`/`error(...)`
   트랙의 세 번째 복제(`crates/rustra-macros/src/macro_command_support.rs:5-14`
   파서 확장). 런타임 게이팅 없음(선언은 계약 문서 — errors 트랙과 동일,
   `crates/rustra/src/builder_errors.rs:3-6`).
2. **스키마**: 명령 항목에 조건부 `devices: ["camera", ...]` 필드 — `platforms`
   관례 그대로(`crates/rustra/src/package_schema.rs:163-169`). 선언 없는 기존
   패키지의 계약 해시는 불변.
3. **코드젠**: 조건부 `devices.ts` — 패키지가 사용한 역량 토큰의 리터럴 유니언 +
   커맨드별 요구 상수 + `require{Symbol}Devices()` 가드. `generateErrorsTs` 구조
   복제(`packages/cli/src/generate-errors.ts:19-29`의 조건부 방출 관례).
4. **호스트 표면**: `@rustra/types`에 device status provider 등록 표면
   (`registerDeviceStatusProvider` / `getDeviceStatus`) — W3C Permissions API의
   query 전용 모델(`navigator.permissions.query`)을 RN/Node/Tauri 호스트로 일반화.
   **요청(request)은 제공하지 않는다** — W3C도 `request()`를 표준에서 제거했고
   요청은 point-of-use(호스트 앱) 몫이다.
5. **에러 코드**: `device.unavailable`(역량 부재/OS 스위치 오프)와
   `device.permission_denied`(사용자·정책 거부) 2종 추가. `platform.unavailable`(
   구현 부재)·`capability.denied`(rustra 자체 호출 자격)와는 원인과 복구 경로가
   다르므로 별개 코드가 정당하다(§5.5).

## 2. 디바이스 역량 카탈로그

### 2.1 카탈로그 표

조사된 분류 체계: **Android** = `Manifest.permission` 권한(그룹/보호등급),
**iOS** = Info.plist usage description 키(+필요 시 entitlement), **Windows** =
UWP 패키지 매니페스트 capability(DeviceCapability 포함), **macOS** = App Sandbox
entitlement(+샌드박스 밖 Info.plist/TCC), **Tauri** = 공식/커뮤니티 플러그인,
**RN/Expo** · **Node** = 대표 라이브러리. "무권한" = 선언 없이 사용 가능.
셀이 비었으면 표준 경로 없음. rustra 토큰은 제안(§5.1).

| rustra 토큰                  | Android                                                                                  | iOS                                                                                            | Windows                                                              | macOS                                                                                              | Tauri v2                                                                   | RN/Expo                                                                             | Node                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `camera`                     | `CAMERA`(dangerous)                                                                      | `NSCameraUsageDescription`                                                                     | `webcam`(DeviceCapability); Win32는 무권한+개인정보 토글             | `com.apple.security.device.camera` + `NSCameraUsageDescription`                                    | 공식 barcode-scanner(모바일 전용·스캔 한정); 커뮤니티 CrabCamera(데스크톱) | vision-camera, expo-camera                                                          | 표준 라이브러리 없음                   |
| `microphone`                 | `RECORD_AUDIO`(dangerous)                                                                | `NSMicrophoneUsageDescription`                                                                 | `microphone`                                                         | `com.apple.security.device.audio-input`                                                            | 공식 없음                                                                  | vision-camera(오디오), expo-audio                                                   | 없음                                   |
| `location`                   | `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`(dangerous)                               | `NSLocationWhenInUseUsageDescription`(백그라운드 별도 키)                                      | `location`(DeviceCapability)                                         | `com.apple.security.personal-information.location`                                                 | **geolocation 공식 플러그인은 iOS/Android만**(데스크톱 스텁, 이슈 #2074)   | @react-native-community/geolocation, expo-location                                  | 없음                                   |
| `bluetooth`                  | `BLUETOOTH_SCAN/CONNECT/ADVERTISE`(API 31+, NEARBY_DEVICES 그룹)                         | `NSBluetoothAlwaysUsageDescription`(iOS 13+)                                                   | `bluetooth`(GATT/RFCOMM)                                             | `com.apple.security.device.bluetooth`                                                              | 커뮤니티 tauri-plugin-bluetooth(BLE)                                       | react-native-ble-plx(BLE 중심)                                                      | @stoprocent/noble(BLE 센트럴)          |
| `wifi`                       | `ACCESS_WIFI_STATE`(normal); 스캔에 위치 권한, 조인 `CHANGE_WIFI_STATE`                  | `NSLocalNetworkUsageDescription` + Hotspot Configuration entitlement(프로그래밍 조인은 제한적) | `wiFiControl`(2024 가을 이후 동작 변경 예고)                         | CoreWLAN — 샌드박스 하 제약(상세 미검증)                                                           | 공식 없음                                                                  | react-native-wifi-reborn                                                            | wifi-control 등(신뢰도 낮음, 미검증)   |
| `network`                    | `ACCESS_NETWORK_STATE`(normal)                                                           | 키 불필요(NWPathMonitor)                                                                       | `internetClient`(AppContainer 앱만)                                  | `com.apple.security.network.client`(샌드박스)                                                      | 커뮤니티 device-info                                                       | @react-native-community/netinfo                                                     | `node:os`(networkInterfaces)           |
| `battery`                    | `BATTERY_STATS`는 signature\|privileged(일반 앱 불가); BatteryManager 조회 자체는 무권한 | 키 불필요(UIDevice)                                                                            | 무권한(GetSystemPowerStatus)                                         | 무권한(IOPowerSources)                                                                             | 커뮤니티 device-info                                                       | react-native-device-info(getBatteryLevel), expo-battery, react-native-nitro-battery | `battery` npm(pmset/upower/Win32 래핑) |
| `notifications`              | `POST_NOTIFICATIONS`(API 33+, dangerous)                                                 | plist 키 불필요, 런타임 프롬프트                                                               | 무권한(토스트; `userNotificationListener`는 별도)                    | 무권한                                                                                             | **notification(전 플랫폼, 공식)**                                          | expo-notifications — **notifee는 아카이브됨**                                       | node-notifier                          |
| `flashlight`                 | 무권한(CameraManager.setTorchMode, API 23+; `FLASHLIGHT`는 deprecated)                   | AVCaptureDevice torch(프롬프트 없음 — 세부 미검증)                                             | 없음                                                                 | 없음                                                                                               | 없음                                                                       | react-native-torch(커뮤니티)                                                        | 없음                                   |
| `nfc`                        | `NFC`(normal)                                                                            | `NFCReaderUsageDescription` + "Near Field Communication Tag Reading" capability                | `proximity`                                                          | (Mac은 앱용 NFC API 없음)                                                                          | **nfc(모바일, 공식)**                                                      | react-native-nfc-manager                                                            | 없음                                   |
| `biometrics`                 | `USE_BIOMETRIC`(normal)+BiometricPrompt                                                  | `NSFaceIDUsageDescription`                                                                     | Windows Hello(무권한)                                                | LocalAuthentication(무권한, 미검증)                                                                | **biometric(모바일, 공식)**                                                | expo-local-authentication, react-native-biometrics                                  | 없음                                   |
| `motion`(가속/자이로)        | SensorManager 무권한; `ACTIVITY_RECOGNITION`(API 29+, dangerous)은 걸음수 등             | `NSMotionUsageDescription`                                                                     | `activity`(DeviceCapability)                                         | CoreMotion(무권한, 미검증)                                                                         | 없음                                                                       | **expo-sensors 권장** — react-native-sensors는 유지보수 중단                        | 없음                                   |
| `clipboard`                  | 무권한(백그라운드 접근 제한 API 26+)                                                     | UIPasteboard 무권한(iOS 16+ 시스템 확인 UI)                                                    | 무권한                                                               | 무권한                                                                                             | **clipboard-manager(전 플랫폼, 공식)**                                     | @react-native-community/clipboard, expo-clipboard                                   | clipboardy                             |
| `filesystem`                 | Scoped Storage; `READ_MEDIA_*`(API 33+), `MANAGE_EXTERNAL_STORAGE`(특별 승인)            | 샌드박스 내 무키 — 문서 피커로 확장                                                            | `broadFileSystemAccess`(restricted)/`picturesLibrary` 등             | `com.apple.security.files.user-selected.read-write` 등                                             | **fs(전 플랫폼, 공식)**                                                    | expo-file-system, react-native-fs                                                   | **`node:fs`(내장)**                    |
| `contacts`                   | `READ_CONTACTS`/`WRITE_CONTACTS`(dangerous)                                              | `NSContactsUsageDescription`                                                                   | `contacts`                                                           | `com.apple.security.personal-information.addressbook`(미검증 — 문서상 `.addressbook` 키 존재 언급) | 없음                                                                       | react-native-contacts, expo-contacts                                                | 없음                                   |
| `calendar`                   | `READ_CALENDAR`/`WRITE_CALENDAR`(dangerous)                                              | `NSCalendarsUsageDescription`                                                                  | `appointments`                                                       | `com.apple.security.personal-information.calendars`                                                | 없음                                                                       | expo-calendar, react-native-calendar-events                                         | 없음                                   |
| `media_library`(사진/미디어) | `READ_MEDIA_IMAGES/VIDEO/AUDIO`(API 33+)                                                 | `NSPhotoLibraryUsageDescription` / `NSPhotoLibraryAddUsageDescription`                         | `picturesLibrary`/`videosLibrary`/`musicLibrary`                     | `com.apple.security.assets.pictures.read-write` 등                                                 | 없음(dialog+fs 조합 패턴)                                                  | expo-media-library, react-native-image-picker                                       | 없음                                   |
| `brightness`                 | `WRITE_SETTINGS`(특별 승인 액세스)                                                       | UIScreen(무권한)                                                                               | 무권한                                                               | 무권한                                                                                             | 없음                                                                       | expo-brightness                                                                     | 없음                                   |
| `vibration`                  | `VIBRATE`(normal)                                                                        | UIFeedbackGenerator/CoreHaptics(무권한)                                                        | 무권한                                                               | 무권한                                                                                             | **haptics(모바일, 공식)**                                                  | RN 코어 `Vibration`, expo-haptics                                                   | 없음                                   |
| `printer`                    | PrintManager(무권한)                                                                     | UIPrintInteractionController(무권한)                                                           | 무권한                                                               | 무권한                                                                                             | 없음                                                                       | expo-print, react-native-print                                                      | 없음                                   |
| `usb_serial`                 | USB Host API — 무권한+사용자 승인 다이얼로그                                             | ExternalAccessory(MFi 제한 — 사실상 폐쇄)                                                      | `usb`/`serialcommunication`/`humaninterfacedevice`(DeviceCapability) | `com.apple.security.device.usb`                                                                    | 없음                                                                       | react-native-serialport 등 커뮤니티(저신뢰)                                         | **serialport(사실상 표준), node-usb**  |
| `audio_playback`             | 무권한(백그라운드 재생은 별도)                                                           | 무권한(백그라운드 `UIBackgroundModes: audio`)                                                  | 무권한                                                               | 무권한                                                                                             | 없음(웹뷰 오디오+asset 프로토콜)                                           | expo-audio                                                                          | 네이티브 모듈(speaker 등)              |
| `audio_recording`            | `microphone` 행 참조(RECORD_AUDIO)                                                       | `microphone` 행 참조                                                                           | `microphone`                                                         | `microphone` 행 참조                                                                               | 없음                                                                       | `microphone` 행 참조                                                                | 없음                                   |

출처(표 전체):
[Android Manifest.permission](https://developer.android.com/reference/android/Manifest.permission),
[iOS usage 키 목록](https://www.iosdev.recipes/info-plist/permissions/) +
[NSCameraUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription),
[Windows app capability declarations](https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations),
[Apple security entitlements](https://developer.apple.com/documentation/bundleresources/security-entitlements)
([camera](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.camera),
[audio-input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input),
[bluetooth](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.bluetooth),
[calendars](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars),
[assets.pictures](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.assets.pictures.read-only),
[Enabling App Sandbox(아카이브)](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)).

### 2.2 카탈로그에서 나온 구조적 관찰

1. **역량별 게이트 수가 다르다.** camera/location/contacts/calendar은
   "선언+런타임 프롬프트"(dangerous), battery/clipboard/network는 무선언,
   NFC(iOS)·wifi(iOS)는 entitlement까지 요구, Windows는 MSIX 패키지 신분이
   있어야 capability가 의미를 갖는다(저장소 문서 "Which kinds of apps" 절,
   [URL](https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations)).
   → 단일 이분법(granted/denied) 계약은 거짓을 낳는다. 조회 결과는
   "가용성"과 "권한 상태" 최소 2축이어야 한다(§5.4).
2. **API 레벨 드리프트가 크다.** Android는 API 29(ACTIVITY_RECOGNITION),
   31(BLUETOOTH_* 재편), 33(READ_MEDIA_*, POST_NOTIFICATIONS)에서 권한 체계
   자체가 바뀌었다([Manifest.permission](https://developer.android.com/reference/android/Manifest.permission)).
   → rustra 카탈로그는 OS 세부 권한 문자열을 정규화된 토큰 뒤에 숨기고,
   교차표는 문서로만 유지해야 OS 업데이트마다 계약이 흔들리지 않는다.
3. **데스크톱과 모바일의 "가능한 것"이 다르게 부재한다.** NFC/플래시라이트/
   바이오메트릭은 데스크톱에 없고(또는 전혀 다른 형태), USB/시리얼은
   모바일(iOS)에서 사실상 폐쇄다. Tauri 공식 geolocation 플러그인조차
   iOS/Android만 지원하고 데스크톱은 스텁이다([plugins-workspace #2074](https://github.com/tauri-apps/plugins-workspace/issues/2074)).
   → "역량이 이 기기에 존재하는가"(`device.unavailable`)는 "이 플랫폼에 구현이
   있는가"(`platform.unavailable`)와 독립적인 상태로 필요하다(§5.5).
4. **RN 생태계 유지보수 편차가 크다.** notifee(아카이브,
   [GitHub](https://github.com/invertase/notifee)), react-native-sensors(4년
   무업데이트, [npm](https://www.npmjs.com/package/react-native-sensors))처럼
   명성 있는 라이브러리가 죽고 expo-*로 대체되는 중. rustra 카탈로그가
   특정 RN 라이브러리를 계약에 박는 순간 같은 운명을 공유하게 된다.
   → 카탈로그는 **구현이 아니라 역량 의미론**만 담는다(§5.1).

## 3. 호스트별 실현 매핑

### 3.1 Tauri v2

- **공식 플러그인**([v2.tauri.app/plugin/](https://v2.tauri.app/plugin/)):
  디바이스 관련 공식 범위는 생각보다 좁다 — 모바일 전용: barcode-scanner,
  biometric, nfc, haptics, geolocation(iOS/Android만); 전 플랫폼: notification,
  clipboard-manager, fs, http(+upload/websocket), os, deep-link, dialog.
  **camera(일반 촬영)·battery·wifi·bluetooth·sensors 공식 플러그인은 없다.**
- **커뮤니티**: [tauri-plugin-device-info](https://crates.io/crates/tauri-plugin-device-info)(battery/network/storage/display),
  [tauri-plugin-bluetooth](https://lib.rs/crates/tauri-plugin-bluetooth)(BLE),
  CrabCamera(데스크톱 카메라) 등 — [awesome-tauri](https://github.com/tauri-apps/awesome-tauri)
  목록 기준. 공식이 아닌 이상 rustra가 의존하면 안 된다.
- **ACL 권한 식별자**([security/capabilities](https://v2.tauri.app/security/capabilities/)):
  플러그인은 2세그먼트 `plugin:permission` — `fs:default`,
  `barcode-scanner:allow-scan`, `nfc:allow-scan`, `biometric:allow-authenticate`.
  코어는 3세그먼트 `core:window:allow-set-title` 형태. `allow-<command>`가
  명령 단위 매핑이다. 이 식별자 체계는 **호스트 앱 설정(src-tauri/capabilities/
  \*.json)의 몫**이고 rustra 계약과 직접 맞물리지 않는다 — 단, rustra의
  `devices` 선언은 호스트가 어떤 플러그인/capability를 켜야 하는지 안내하는
  단서가 된다.
- **모바일 권한 주입**: Tauri 모바일 플러그인은 AndroidManifest.xml 권한을
  빌드 시 자동 추가하고(geolocation 문서), iOS Info.plist는 `bundle > iOS >
infoPlist` 설정으로 확장한다([CLI v2.9.0](https://v2.tauri.app/release/@tauri-apps/cli/v2.9.0/)).
  즉 Tauri 생태계에서조차 "권한 선언은 플러그인/호스트 빌드 설정 소관"이다.
  rustra가 OS 권한을 요청하지 않는 철학과 정합.

### 3.2 React Native / Expo

- 코어: `PermissionsAndroid`(Android 런타임 프롬프트), `Vibration`,
  `Clipboard`(deprecated → 커뮤니티). 대부분의 역량은 커뮤니티/Expo 모듈:
  [vision-camera](https://github.com/margelo/react-native-vision-camera)(camera,
  Nitro 기반), [ble-plx](https://github.com/dotintent/react-native-ble-plx)(BLE,
  RxJS), [wifi-reborn](https://www.npmjs.com/package/react-native-wifi-reborn)(wifi
  관리 — iOS 제약), netinfo(네트워크 상태), device-info(battery/isHeadphones),
  expo-battery/expo-sensors/expo-brightness/expo-local-authentication/
  expo-notifications/expo-print/expo-media-library 등(Expo SDK — 가장 안정적으로
  유지보수됨).
- **react-native-permissions**([zoontek](https://github.com/zoontek/react-native-permissions)):
  iOS/Android/Windows 권한의 통합 조회·요청 라이브러리. `PERMISSIONS.IOS.CAMERA`,
  `PERMISSIONS.ANDROID.BLUETOOTH_SCAN`류 상수 + `check`/`request` 메서드 + 상태
  5종(§4.2). iOS는 Podfile `setup_permissions([...])`로 **컴파일되는 권한을
  옵트인**한다 — "쓰는 것만 선언"이 링크 단위 강제다. rustra `devices` 선언과
  정확히 같은 문제를 다른 층(빌드 vs 계약)에서 푼다.
- Info.plist 키/Android manifest 권한은 §2.1 표의 값 그대로(플랫폼 소관).

### 3.3 Node/Bun (데스크톱 서버 호스트)

- 내장: `node:fs`(filesystem), `node:os`(network 인터페이스 목록 — 상태
  모니터링에는 부족), 오디오/카메라/블루투스 내장 API 없음.
- 배터리: **내장 API 없음**. `battery` npm이 OS 명령(`pmset -g batt` /
  `upower` / Win32 `GetSystemPowerStatus`)을 래핑([npm](https://www.npmjs.com/package/battery),
  [battery-level](https://www.npmjs.com/package/battery-level)) — 근본적으로
  셸아웃이라 신뢰도가 OS별로 다르다.
- 하드웨어 I/O: [serialport](https://serialport.io/docs/)(사실상 표준, Node/Electron
  3-OS), [node-usb](https://github.com/node-usb/node-usb)(USB 직접,
  Windows는 드라이버 이슈), [@stoprocent/noble](https://www.npmjs.com/package/@stoprocent/noble)(BLE
  센트럴, 활성 포크).
- 실용적 하위집합 결론: Node 호스트에서 rustra가 의미 있게 다룰 수 있는 역량은
  `filesystem`, `network`, `battery`(베스트포트), `usb_serial`, `bluetooth`
  5종이 상한. camera/microphone/location 등은 Node 호스트에서
  `device.unavailable`이 정직한 답이다.

## 4. 선행 사례 계약 분석

### 4.1 W3C Permissions API — "조회는 표준, 요청은 각 API"

- 모델: `navigator.permissions.query({name})` → `PermissionStatus.state ∈
{granted, denied, prompt}` + `onchange` 이벤트. 이름 레지스트리(PermissionName):
  `geolocation`, `notifications`, `camera`, `microphone`, `clipboard-read/write`,
  `accelerometer`, `gyroscope`, `magnetometer`, `bluetooth`, `midi`,
  `screen-wake-lock`, `local-fonts` 등([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)).
- **핵심: `request()`가 없다.** 요청은 각 기능 API의 호출 시점(getUserMedia,
  Notification.requestPermission)에서 일어나고, Permissions API는 상태 조회만
  표준화했다. `revoke()`도 제거되었다. 쿼리는 Permissions-Policy/보안 컨텍스트
  등 모든 제약을 aggregation해 `denied`로 보고한다.
- **rustra에 주는 교훈**: "선언·조회는 플랫폼(브리지)이, 요청은 point-of-use(호스트
  앱)이"라는 분업이 W3C에서 10년 이상 검증된 설계다. rustra가 device provider를
  조회 전용으로 설계하는 것은 소심함이 아니라 표준과 같은 자리다.

### 4.2 react-native-permissions — 5상태 모델

- `RESULTS = {UNAVAILABLE, DENIED, BLOCKED, GRANTED, LIMITED}`
  ([GitHub](https://github.com/zoontek/react-native-permissions)). UNAVAILABLE=
  "이 기기/컨텍스트에 없음"(§5.5 `device.unavailable`과 동일 개념), DENIED=
  아직 물어보지 않았거나 거부되었으나 재요청 가능, BLOCKED= 거부+재요청 불가(설정
  이동 필요), LIMITED= iOS 부분 승인(연락처/사진 선택).
- **rustra에 주는 교훈**: 상태 조회는 이 정도 세분화가 실용적 상한이나,
  **에러 코드는 UNAVAILABLE 계열과 DENIED/BLOCKED 계열로 묶어도** 앱의 복구
  분기(다른 기능 제안 vs 설정 안내)는 보존된다. `device.permission_denied`
  하나에 DENIED/BLOCKED/LIMITED를 메시지로 구분하는 것이 rustra 와이어
  (`{code, message}` 평면성, error.rs:36-42)와 맞다.

### 4.3 Expo — 모듈별 PermissionResponse와 규격화된 상태

- `PermissionResponse = {status: granted|denied|undetermined, granted,
canAskAgain, expires}` — `expo-camera.requestCameraPermissionsAsync()` 등
  모듈별 메서드로 흩어져 있으나 응답 형태는 전 모듈 동일
  ([expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)).
  통합 `expo-permissions`는 SDK 41/43부터 deprecated(모듈별 메서드로 이관).
- **rustra에 주는 교훈**: (1) 상태 3종(granted/denied/undetermined)은 W3C
  prompt↔undetermined 대응으로 **3종이 업계 최소 공통**이다. (2) `canAskAgain`은
  BLOCKED 감지의 Expo식 이름 — rustra v1 상태에 넣지 않아도 된다(§5.4).
  (3) "중앙 모듈 → 모듈별 분산"의 역사는 rustra가 provider를 중앙 레지스트리가
  아니라 **표준 응답 형태 + 커맨드별 선언**으로 잡는 방향과 부합한다.

### 4.4 Capacitor — 플러그인 + 웹 폴백

- JS 대면 API + 플랫폼별 구현(Swift/Kotlin) + 선택적 웹 구현. 브리지가
  클라이언트 훅을 자동 생성하고, 네이티브가 없으면 웹 폴백으로 우선순위
  하강([capacitorjs.com/docs/plugins](https://capacitorjs.com/docs/plugins)).
- **rustra에 주는 교훈**: "같은 명령 이름, 플랫폼별 구현 차이"는 rustra의
  `platform_command` 전 플랫폼 등록+스텁 전략(builder_platform.rs:4-7)과 이미
  같은 뼈다. Capacitor가 추가로 보여주는 것은 **역량 단위 폴백 사다리**가
  아니라 그냥 구현 단위 사다리라는 점 — 역량 상태 조회는 플러그인 각자의
  몫으로 남는다(카메라 플러그인이 자기 권한을 검사). rustra는 이를 계약
  표면(provider)으로 끌어올리는 셈이다.

### 4.5 Tauri — ACL과 플러그인의 층 분리

- Tauri는 "어떤 창이 어떤 플러그인 명령을 부를 수 있는가"(ACL,
  `nfc:allow-scan`)와 "OS가 이 하드웨어를 허용하는가"(manifest/Info.plist)를
  **별도 파일·별개 체계**로 유지한다(§3.1). 앱 자체 명령은 allow-by-default라는
  경쟁 분석의 지적(docs/research/2026-09-07-competitive-landscape.md:35)처럼
  rustra의 deny-by-default capability와 대비된다.
- **rustra에 주는 교훈**: rustra 계층 문서(docs/platform-permissions.md:27-34)의
  3층(OS / Tauri ACL / rustra capability) 표에 "디바이스 역량 상태" 행을
  추가해도 층은 섞이지 않는다 — device 상태는 OS 층의 **조회 프록시**이지
  새로운 권한 층이 아니다(§5.0).

## 5. rustra 계약 설계 제안

### 5.0 철학 검증 — "요청은 호스트 몫, 선언·조회·게이팅은 rustra 몫"인가

- **선언(몫)**: 명령이 카메라를 요구한다는 것은 계약의 일부다 — schema.json과
  코드젠이 이미 담당하는 종류의 정보(§5.1-5.3).
- **조회(몫)**: "이 기기에서 카메라가 쓸 수 있는가"를 표준화된 형태로 묻는
  표면은 브리지가 제공하는 것이 맞다 — 단 **구현은 호스트가 등록**한다.
  W3C가 브라우저에 대해 하듯, rustra는 호스트에 대해 query 표준을 제공한다(§5.4).
- **게이팅(부분 몫)**: 자동 차단은 하지 않는다. errors 트랙의 선례 — "선언은
  계약 문서이고 드리프트 검출은 `rustra diff`/contract 게이트 몫"
  (builder_errors.rs:3-6) — 와 동일하게, device 선언도 문서+코드젠으로 소비되고
  런타임 검증은 계약 게이트 몫이다. 대신 **가드 헬퍼**로 수동 게이팅을
  원가 거의 0으로 만든다(§5.3).
- **요청(호스트 몫)**: OS 프롬프트 UX는 존재하지도 않는 층(브라우저와 달리
  RN/Node/Tauri에 표준 프롬프트 API가 없다)이고, platform-permissions.md:109는
  이미 "grant_capability 시점에 OS 승인을 함께 확인"하는 조합법을 안내한다.
  결론: **경계는 철학에 정합하며, 오히려 W3C 선례가 이 경계를 정당화한다.**

### 5.1 (a) 명령별 디바이스 요구 선언 — 토큰 타입 설계

**결정 제안**: `Platform` enum이 아니라 **검증된 문자열 토큰 + 표준 상수**로
`DeviceCapability`를 만든다(`CommandErrorVariant` 코드와 동일 설계,
error.rs:203-257).

```rust
// crates/rustra/src/device.rs (제안)
pub struct DeviceCapability(&'static str);
impl DeviceCapability {
    pub const CAMERA: Self = Self::new("camera");
    pub const MICROPHONE: Self = Self::new("microphone");
    pub const LOCATION: Self = Self::new("location");
    // ... §2.1 카탈로그의 rustra 토큰 열
    pub const fn new(token: &'static str) -> Self { /* 패턴 검증은 빌더 시점 */ }
}
```

빌더/매크로 표면(`platforms`/`errors` 트랙의 3복제):

- `PackageBuilder::command_devices(name, &[DeviceCapability])` — 등록된 명령에
  부여, 미등록/빈 슬라이스/중복/패턴 위반 패닉(command_errors와 동일,
  builder_errors.rs:19-41).
- `devices_meta_if(name, Option<&'static [DeviceCapability]>)` — register!/build!
  체인 연결(platform_meta_if 관례, builder_platform.rs:139-153).
- `#[command(device(camera, microphone))]` — 매크로 파서에 `device` 키 추가
  (macro_command_support.rs CommandAttr에 `devices: Option<Vec<String>>`).
  심볼 상수 `__RUstra_devices_*` → 체인.

**근거**: (1) enum은 카탈로그 성장마다 rustra 릴리스를 강제하지만 문자열은
호스트·서드파티 패키지가 커스텀 역량을 선언할 수 있게 열려 있다 — Tauri ACL도
식별자가 문자열이고(§3.1) W3C PermissionName도 구현별 확장이 있다. (2) 패턴
`^[a-z][a-z0-9_.]*$`는 error.rs:263-269 검증기와 토큰 집합을 공유해 TS 코드젠
검증(generate-errors.ts:17의 ERROR_CODE_PATTERN)도 재사용한다. (3) 표준 상수
제공으로 타이포는 컴파일 타임에 잡히는 실용적 안전성을 유지한다. **반론 검토**:
`Platform`은 enum으로 충분했는데 왜 다른가 — Platform은 5개로 닫혀 있고 OS
개수는 rustra가 통제하지만, 디바이스 카탈로그는 생태계가 통제한다(§2.2 관찰 4).

### 5.2 (b) 스키마 조건부 필드

**결정 제안**: `command_schema_entry`에 `devices: Vec<&str>` 조건부 삽입 —
`platforms`(package_schema.rs:163-169)와 동일 관례. 키 이름은 `devices`를
권장(`platforms`와 대칭, 짧고 선언 순 정렬·중복 제거는 빌더가 수행).
대안 `deviceRequirements`는 필드가 객체 배열(`{capability, optional?}`)로 자라날
때의 이름으로 남겨둔다 — v1은 문자열 배열이면 충분하다(errors의 코드 문자열
목록이 그랬듯, macro 속성도 문자열 목록만 받는다).

```jsonc
// schema.json 명령 항목 (선언 있을 때만)
{ "name": "scanBarcode", "commandId": 12, /* ... */,
  "platforms": ["android", "ios"],
  "devices": ["camera"] }
```

**정합**: (1) 조건부라 선언 없는 기존 패키지의 계약 해시·핫리로드 와이어 서명
불변(와이어 서명은 스키마 항목 원본 바이트의 SHA-256, package_schema.rs:209-216 —
단, 선언 추가 시에는 platforms/errors와 동일한 의도된 계약 진화, `rustra diff`가
검출). (2) 구 CLI는 알 수 없는 필드를 무시
(schema-validation.ts가 `return value as PackageSchema`로 통과 —
docs/research/2026-09-07-typed-error-codesgen.md §4) — 포워드 호환 확보.

### 5.3 (c) TS 코드젠

**결정 제안**: 신규 렌더러 `generateDevicesTs(schema)` → 조건부 `devices.ts`
(cli-generate-files.ts:97-100의 events/errors 방출 지점에 3행 추가). 내용:

```ts
// devices.ts (생성 예시 — scanBarcode가 camera를 선언한 경우)
export type RustraDeviceId = 'camera' | 'microphone'; // 패키지가 사용한 토큰만
export const ScanBarcodeDevices = ['camera'] as const satisfies readonly RustraDeviceId[];
/** 요구 역량의 상태를 조회해 미충족이면 RustraCommandError를 던진다. */
export async function requireScanBarcodeDevices(): Promise<void> {
  /* getDeviceStatus 루프 */
}
```

- 리터럴 유니언은 **패키지가 실제 사용한 토큰만** — 개방 계약(임의 문자열)과
  폐쇄 타입(코드젠 시점 유니언)의 간극을 errors.ts와 같은 방식으로 메운다
  (generate-errors.ts:82-88의 가드 주석 철학).
- `require{Symbol}Devices()` 가드는 `@rustra/types`의 `getDeviceStatus`를
  소비 — 생성 파일이 `@rustra/types`를 이미 import하므로(generate-errors.ts:23)
  의존성 새로 없음. 가드가 던지는 에러는 §5.5 코드.
- 선언 0건이면 파일 미생성 — 기존 프로젝트 재생성 유발 없음(events.ts 관례,
  cli-generate-files.ts:101-102의 주석).

### 5.4 (d) 호스트 어댑터 등록 표면 — device status provider

**결정 제안**: `@rustra/types`에 전역 provider 표면(global-config.ts의
configure 옆, packages/types/src/ 신규 파일) 추가:

```ts
export type DevicePermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';
export type DeviceStatus = {
  /** 하드웨어/OS 스위치/플랫폼 지원 여부 — 'unknown'은 provider 부재·미지원 */
  available: boolean | 'unknown';
  permission: DevicePermissionState;
  detail?: string;
};
export type DeviceStatusProvider = (capability: string) => DeviceStatus | Promise<DeviceStatus>;
export function registerDeviceStatusProvider(provider: DeviceStatusProvider): void;
export function getDeviceStatus(capability: string): Promise<DeviceStatus>;
```

- **상태 3+3**: available(true/false/unknown) × permission(granted/denied/prompt/
  unknown)은 W3C(query 3상태)와 react-native-permissions(UNAVAILABLE 분리,
  §4.2)의 최소 공통. BLOCKED/LIMITED는 `permission: 'denied'` + detail로
  접는다(와이어 평면성, §4.2 교훈).
- provider 미등록 시 `getDeviceStatus`는 `{available: 'unknown', permission:
'unknown'}`을 반환 — 조회는 실종되지 않고, **가드는 unknown을 거부하지
  않는다**(fail-open) — rustra가 자동 게이팅을 하지 않는 이상 unknown에서
  명령을 막는 것은 호스트의 결정을 대신하는 것이다. fail-closed를 원하는
  호스트는 provider에서 unknown을 명시적으로 정규화하면 된다.
- **Rust 측 표면은 v1에 없다**: Rust는 디바이스 상태로 게이팅하지 않으므로(§5.0)
  상태를 FFI로 밀어넣을 이유가 없다. 이것이 표면을 JS 전역(global-fields.ts와
  같은 모듈 수명)에 두는 근거다.
- **호스트 파생 provider는 별도 슬라이스**: `@rustra/react-native`가
  react-native-permissions 기반 provider 팩토리를 내보내는 것(예:
  `makeRnDeviceStatusProvider()`)은 네이티브 peer 의존을 끌어들이므로 v1
  이후 선택 슬라이스로 분리한다(§7).

### 5.5 (e) 신규 에러 코드와 기존 코드와의 구분

**결정 제안**: 2종 추가.

| 코드                       | 의미                                                                                                   | retryable                     | 대비                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.unavailable`       | 요구 역량이 이 기기/OS 설정에서 사용 불가(하드웨어 부재, OS 스위치 off, 플랫폼이 그 역량을 지원 안 함) | 아니요                        | `platform.unavailable`은 **명령 구현**의 부재(builder_platform.rs:58-60 스텁). 같은 명령이 windows에선 platform.unavailable, 노트북에서 device.unavailable(웹캠 없음)일 수 있다 — 원인·복구 경로(다른 OS vs 장치 연결/설정)가 다르다. |
| `device.permission_denied` | OS 권한이 사용자/정책에 의해 거부됨                                                                    | 아니요(재요청은 호스트 UX 몫) | `capability.denied`는 rustra 자체 런타임 권한(누가 이 브리지 명령을 부를 수 있는가, builder_capabilities.rs:2-6). OS 권한 거부는 rustra가 알 수 없는 층이다 — 호스트 가드/provider가 보고한 상태의 정규화 결과다.                     |

- 구분 정당화 요약: 4코드는 각각 **호출 자격(capability.denied) / 구현 존재
  (platform.unavailable) / 자원 존재(device.unavailable) / 사용자 승인
  (device.permission_denied)**이라는 독립 축이며, 실제 디버깅 분기(스택홀더가
  뭘 확인해야 하는지)가 다르다. docs/platform-permissions.md:27-34의 층 표에
  "디바이스 역량 상태는 누가 답하나" 행으로 이 구분을 문서화한다.
- 등록처: `packages/types/src/errors.ts`의 `RustraErrorCode` 레지스트리
  (errors.ts:138-205) + Rust `error.rs` 팩토리 `device_unavailable`/
  `device_permission_denied` 양쪽 — JS 가드가 던지고(errors.ts의 JS 전용 코드
  선례 `sync.unavailable`), 네이티브 핸들러도 반환할 수 있게 한다. 도메인 점
  표기·패턴은 기존과 동일(error.rs:79).

### 5.6 기존 트랙과의 정합 요약

| 트랙       | device 트랙이 복제하는 것                                                                                  | 차이                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| platforms  | 전 플랫폼 등록+조건부 필드+`_meta_if`+build() 정합                                                         | 스텁/구현 교체 없음 — 런타임 게이팅 자체가 없다         |
| errors     | 검증된 문자열 토큰+조건부 필드+조건부 TS 파일+폐쇄 유니언                                                  | 카탈로그 상수(`DeviceCapability::CAMERA`)가 추가로 존재 |
| capability | none — `require_capability`와 `devices`는 독립 직교(조합 안내는 문서 몫, platform-permissions.md:109 확장) |                                                         |

## 6. 오픈 질문

1. **토큰 네이밍**: `location` vs W3C `geolocation` 정렬. W3C 이름을 따면 웹
   호스트(미래 wasm 트랙)와 직접 대응되지만 Android/iOS/Expo 어디에서도
   `location`이 우세하다. 권고: `location`(제안 유지), wasm 트랙에서 교차표로
   대응.
2. **`DeviceStatus.available`의 3치**: `boolean | 'unknown'` 대신 상태 enum
   (`'available' | 'unavailable' | 'unknown'`)이 TS 가독성이 나은지 — 구현
   슬라이스에서 확정.
3. **fail-open 기본값**: provider 미등록·unknown 상태에서 가드 통과(§5.4 제안)가
   맞는가? 보수적 대안은 unknown 즉시 거부 — 그러나 이는 "조회만으로 게이팅"을
   사실상 자동화해 철학(§5.0)과 어긋난다. 문서로 명시할 것.
4. **RN/Tauri 파생 provider 패키지**: `@rustra/react-native`·`@rustra/tauri`가
   표준 provider 구현(react-native-permissions / Tauri plugin 감지)을 내보낼
   것인가 — 네이티브 peer 의존 정책 결정 필요.
5. **카탈로그의 공식 문서 거처**: 카탈로그 상수 목록 + OS 교차표(§2.1)는
   `docs/platform-permissions.md` 확장인가 별도 문서인가. 교차표는 OS 업데이트
   (Android API 레벨 등)마다 갱신 대상이라 문서 동기화 게이트 범위 확인 필요.
6. **Tauri ACL 연동 깊이**: `devices` 선언 → 필요한 Tauri 플러그인/ACL 권한
   식별자 안내(`rustra doctor` 진단 등)를 만들 것인가 — 매력적이나 플러그인
   생태계 변동을 rustra가 추적해야 한다(§2.2 관찰 4와 같은 이유로 보수적).

## 7. 구현 슬라이스 제안

각 슬라이스는 platforms/errors 트랙의 대응 슬라이스 구조를 그대로 따른다.

1. **Rust 선언 표면**(§5.1): `device.rs`(DeviceCapability + 카탈로그 상수) →
   `builder_devices.rs`(command_devices/devices_meta_if + 검증) → command_types.rs
   `devices` 필드 → 매크로 `device(...)` 파서+체인 → package_schema.rs 조건부
   필드. 테스트는 builder_platform_tests.rs/builder_errors_tests.rs 대응.
   게이트: `cargo test/clippy/fmt`, api-surface 스냅샷 갱신.
2. **CLI 코드젠**(§5.2-5.3): schema.ts에 `devices?: string[]` +
   `generateDevicesTs` + 조건부 방출 + 지문. 게이트: `bun run test:packages`,
   `--check` 드리프트.
3. **@rustra/types provider + 에러**(§5.4-5.5): device-status 표면
   (register/get) + `device.unavailable`/`device.permission_denied` 상수·가드 +
   Rust error.rs 팩토리 양측 등록(레지스트리 주석 "Rust error.rs 대응 여부"
   관례 유지).
4. **문서**: platform-permissions.md(§2 층 표에 device 행, §6-7 권한 키 교차표
   연결), rust-api-guide/getting-started 가드 사용 예 — `.ko.md` 쌍 + docs:sync
   게이트.
5. **(선택) 표준 provider 팩토리**: @rustra/react-native(react-native-permissions
   래핑), @rustra/tauri(플러그인 존재 감지) — 오픈 질문 4 해소 후.

## 주요 출처 요약

- Tauri: [플러그인 목록](https://v2.tauri.app/plugin/),
  [capabilities/ACL](https://v2.tauri.app/security/capabilities/),
  [geolocation](https://v2.tauri.app/plugin/geolocation/) +
  [#2074](https://github.com/tauri-apps/plugins-workspace/issues/2074),
  [awesome-tauri](https://github.com/tauri-apps/awesome-tauri),
  [tauri-plugin-device-info](https://crates.io/crates/tauri-plugin-device-info),
  [tauri-plugin-bluetooth](https://lib.rs/crates/tauri-plugin-bluetooth)
- W3C/웹: [Permissions API(MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)
- RN/Expo: [react-native-permissions](https://github.com/zoontek/react-native-permissions),
  [vision-camera](https://github.com/margelo/react-native-vision-camera),
  [ble-plx](https://github.com/dotintent/react-native-ble-plx),
  [wifi-reborn](https://www.npmjs.com/package/react-native-wifi-reborn),
  [expo-battery](https://docs.expo.dev/versions/latest/sdk/battery/),
  [expo-local-authentication](https://docs.expo.dev/versions/latest/sdk/local-authentication/),
  [expo-brightness](https://docs.expo.dev/versions/latest/sdk/brightness/),
  [expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications/),
  [notifee(아카이브)](https://github.com/invertase/notifee),
  [react-native-sensors](https://www.npmjs.com/package/react-native-sensors),
  [react-native-nfc-manager](https://www.npmjs.com/package/react-native-nfc-manager),
  [react-native-contacts](https://github.com/morenoh149/react-native-contacts)
- OS 분류: [Android Manifest.permission](https://developer.android.com/reference/android/Manifest.permission),
  [iOS plist 키](https://www.iosdev.recipes/info-plist/permissions/),
  [Apple entitlements](https://developer.apple.com/documentation/bundleresources/security-entitlements),
  [Windows capabilities](https://learn.microsoft.com/en-us/windows/uwp/packaging/app-capability-declarations)
- Node: [serialport](https://serialport.io/docs/),
  [node-usb](https://github.com/node-usb/node-usb),
  [@stoprocent/noble](https://www.npmjs.com/package/@stoprocent/noble),
  [battery](https://www.npmjs.com/package/battery)
- Capacitor: [plugins](https://capacitorjs.com/docs/plugins)
