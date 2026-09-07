[English](./platform-permissions.md) | 한국어

# 플랫폼 권한 가이드 (호스트 앱 대상)

## 1. 범위: rustra-bridge가 하는 일과 하지 않는 일

rustra-bridge는 Rust 엔진과 JS/React Native 브릿지 라이브러리입니다. **운영체제 권한(카메라, 마이크, 위치, 파일 시스템, 네트워크 등)을 요청하지 않으며**, 자체적인 플랫폼 권한 선언도 포함하지 않습니다.

설계상 호스트 앱이 플랫폼 권한 UX를 소유합니다:

```txt
Rust owns durable state and heavy work.
RN owns immediate UI state.
Native bridge owns only engine lifecycle and platform permission UX.
```

(docs/research/rust-local-engine-vs-native-bridges.md 참고.)

라이브러리 자체의 인가 계층은 **명령 단위 capability 시스템**(Runtime Authority)입니다: 기본 거부(deny-by-default), 빌더에서 `require_capability`, 런타임에 `grant_capability`. 이 시스템은 *누가 브릿지 명령을 호출할 수 있는가*를 다루며, OS 수준 권한 프롬프트와는 독립적이고 이를 대체하지도 않습니다. [Rust API 가이드](./rust-api-guide.ko.md)의 "Runtime Authority (capabilities)" 부분과 빌더의 `.require_capability(name, cap)` 항목을 참고하세요.

이 가이드는 rustra를 임베딩하는 호스트 앱이 소유해야 할 플랫폼 권한 영역을 안내합니다.

---

## 2. 어떤 계층이 어떤 질문에 답하는가?

| 질문                                                    | OS 권한 (iOS/Android/Windows/macOS) | Tauri ACL (capabilities/permissions)        | rustra capability 시스템                        |
| ------------------------------------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------------------- |
| 앱이 하드웨어(카메라, 마이크, 위치)에 접근해도 되는가?  | **예** — 선언 + 런타임 프롬프트      | 아니오 (일부 Tauri 플러그인 제외)             | 아니오                                          |
| 이 윈도우/웹뷰가 이 Tauri 명령/플러그인을 호출해도 되는가? | 아니오                             | **예**                                        | `tauri_support`를 경유하는 명령에 한해서만       |
| 런타임에 누가 이 브릿지 명령을 호출할 수 있는가?        | 아니오                               | 아니오                                       | **예** — 기본 거부, `grant_capability`          |
| 앱이 원격 코드를 로드하거나 임의 origin에 연결해도 되는가? | 부분적으로 (ATS, cleartext, 앱 수준 CSP) | **예** — `tauri.conf.json`의 CSP        | 아니오                                          |

요약: OS 권한은 **하드웨어와 시스템 리소스**를, Tauri ACL은 **어떤 웹뷰가 어떤 Tauri 플러그인 명령을 호출할 수 있는지**를, rustra capability는 **부여되기 전까지 어떤 브릿지 명령도 호출 불가**임을 다룹니다.

---

## 3. Tauri (모든 데스크톱 플랫폼)

### 3-1. Tauri ACL

Tauri v2는 ACL(Access Control List) 시스템을 사용합니다: capabilities 파일(`src-tauri/capabilities/*.json`)이 어떤 윈도우가 어떤 플러그인 권한을 쓸 수 있는지 선언합니다. `rustra::tauri_support`(`tauri_support::register(app, pkg)` / `register_with_events`)로만 디스패치하는 rustra 호스트는 보통 기본값 이외의 ACL 부여가 거의 필요 없습니다 — rustra 명령은 플러그인이 아니라 Tauri의 invoke 핸들러를 탑니다. 전체 모델은 공식 Tauri "Capabilities" / "Permissions" 문서를 참고하세요.

참고: `examples/tauri-calculator`의 `gen/schemas/capabilities.json`은 비어 있습니다 — 계산기 명령에는 추가 ACL 항목이 필요 없습니다.

### 3-2. CSP

`tauri.conf.json > app.security.csp`는 웹뷰가 로드할 수 있는 것을 제어합니다. 예제는 `"csp": null`로 배포됩니다(개발 편의용, 프로덕션 비권장). 특히 프론트엔드가 `invoke`로 브릿지와 통신한다면 프로덕션에서는 제한적인 CSP를 설정하세요.

### 3-3. rustra capability 시스템 (별개의 계층)

Tauri 안에서도 `require_capability`로 보호된 rustra 명령은 라이브러리 자체의 기본 거부 검사를 따릅니다(`grant_capability` 전까지 `capability.denied`). Tauri ACL과 rustra capability는 조합되며 서로를 대체하지 않습니다. [Rust API 가이드](./rust-api-guide.ko.md) 참고.

---

## 4. Windows (Tauri 호스트)

- **WebView2 런타임**: Windows의 Tauri는 Microsoft Edge WebView2에서 렌더링됩니다. 대부분의 Windows 10/11에는 이미 포함되어 있고, 없다면 부트스트래퍼/런타임 설치가 필요합니다(Tauri 번들러는 고정 WebView2 런타임 다운로드를 지원). 권한이 아니라 환경 요구사항입니다.
- **MSIX / 패키지 아이덴티티**: 일부 Windows capability(일부 디바이스 접근, 광범위 파일 시스템 접근 등)는 앱에 패키지 아이덴티티가 있을 때(MSIX 패키징 또는 적절한 서명)만 의미가 있습니다. 서명되지 않은 실행 파일은 capability 선택지는 적지만 일반적인 파일/네트워크 접근의 제약은 더 적습니다. 배포 모델(MSIX, 서명된 MSI/NSIS 인스톨러, 포터블 EXE)에 따라 결정하세요.
- **호스트가 필요할 수 있는 전형적 권한**: 순수 계산 브릿지에는 아무것도 필요 없습니다(계산기 예제는 아무것도 요청하지 않음). 브릿지 명령이 파일·카메라·마이크를 다룬다면 패키징 매니페스트에 해당 Windows capability를 선언하거나 Windows 프라이버시 설정 프롬프트를 처리해야 합니다.
- **SmartScreen**: 서명되지 않은 인스톨러/EXE는 SmartScreen 경고를 유발합니다. 코드 서명(EV 인증서 포함)은 rustra가 아닌 배포 측 관심사입니다.

---

## 5. macOS (Tauri 호스트)

- **entitlements.plist**: Mac App Store 배포 또는 샌드박스 사용 시 entitlement를 선언해야 합니다(`com.apple.security.app-sandbox`, 앱 카테고리, 카메라/마이크/파일 등 리소스 entitlement). App Store 밖에서 배포하는 Tauri 앱은 샌드박스 entitlement 없이 동작할 수 있지만, 이 경우 App Store 제출은 불가능합니다.
- **Info.plist 사용 설명**: 브릿지 명령이 보호 리소스에 접근한다면 앱의 `Info.plist`에 해당 usage-description 키(`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription` 등)를 추가하세요 — 샌드박스 앱은 최초 접근 시 macOS 프롬프트를 띄웁니다.
- **공증(notarization)**: App Store 밖 배포에는 Developer ID 서명과 공증(Apple 자동 검사)이 필요합니다. 호스트의 릴리스 파이프라인 책임입니다.
- **Hardened runtime**: 공증에 필요하며, 서명 설정에서 활성화하세요.

---

## 6. iOS (React Native 호스트)

iOS는 Info.plist 사용 설명과 런타임 프롬프트로 하드웨어를 보호합니다. 브릿지 명령이 실제로 다루는 것에 대해서만 키를 추가하세요. 자주 쓰는 항목:

| 키                                     | 리소스            | rustra 호스트가 필요한 시점                  |
| -------------------------------------- | ----------------- | --------------------------------------------- |
| `NSCameraUsageDescription`             | 카메라            | 사진/동영상 촬영 브릿지 명령                   |
| `NSMicrophoneUsageDescription`         | 마이크            | 오디오 녹음 브릿지 명령                        |
| `NSPhotoLibraryUsageDescription`       | 사진 라이브러리 읽기 | 사용자 사진을 읽는 브릿지 명령              |
| `NSPhotoLibraryAddUsageDescription`    | 사진 라이브러리 쓰기 | 이미지를 저장하는 브릿지 명령                |
| `NSLocationWhenInUseUsageDescription`  | 위치 (포그라운드) | 위치를 읽는 브릿지 명령                        |

참고:

- **ATS (App Transport Security)**: 로컬 계산 브릿지에는 예외가 필요 없습니다. RN 예제는 `NSAppTransportSecurity`를 `NSAllowsArbitraryLoads: false`, `NSAllowsLocalNetworking: true`로 제공합니다(Metro 개발 서버 트래픽 전용). 프로덕션에서는 ATS를 엄격하게 유지하세요.
- 사용 설명이 없으면 보호 API 최초 사용 시점에 앱이 크래시합니다 — 기능이 다루는 모든 것을 선언하세요.

---

## 7. Android (React Native 호스트)

필요한 권한을 `AndroidManifest.xml`에 선언하고, dangerous 권한은 추가로 런타임 프롬프트가 필요하며 이는 **호스트**가 구현합니다(RN의 `PermissionsAndroid` 등).

자주 쓰는 항목:

| 권한                                     | 보호 수준  | 용도                                        |
| ---------------------------------------- | ---------- | ------------------------------------------- |
| `android.permission.INTERNET`            | normal     | 네트워크 접근; 개발 서버 / 원격 코드 로딩    |
| `android.permission.CAMERA`              | dangerous  | 카메라 캡처 (런타임 프롬프트)                |
| `android.permission.RECORD_AUDIO`        | dangerous  | 마이크 (런타임 프롬프트)                     |
| `android.permission.READ_MEDIA_IMAGES`   | dangerous  | 사진 라이브러리 읽기 (API 33+)               |
| `android.permission.ACCESS_FINE_LOCATION`| dangerous  | 위치 (런타임 프롬프트)                       |

- `INTERNET`은 개발 서버에서 번들을 로드하거나 원격 리소스를 가져오는 모든 앱의 기본선입니다.
- Cleartext 트래픽은 별도로 제어됩니다(`android:usesCleartextTraffic`); RN wasm 스파이크는 빌드 타입별로 템플릿화합니다.
- 런타임 프롬프트 순서: 매니페스트 선언 → 런타임 요청 → 그 후에야 해당 리소스를 쓰는 브릿지 명령 호출. rustra의 `grant_capability`는 OS 승인을 확인한 뒤 명령을 활성화하는 자연스러운 지점입니다.

---

## 8. 현재 예제들의 상태

| 예제                                          | 플랫폼   | 권한 선언                                                                      | 이유                                                                    |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `examples/tauri-calculator`                   | Tauri    | 없음 (빈 `capabilities.json`, `"csp": null`, 번들링 비활성)                    | 순수 계산 명령; 개발 전용 구성                                           |
| `examples/react-native-calculator`            | iOS (RN) | `NS*UsageDescription` 항목 없음; ATS는 로컬 네트워킹만 허용                     | 계산기는 보호 리소스가 필요 없음 — 없는 것이 정상                          |
| `examples/rn-wasm-spike`                      | Android  | `INTERNET`만 (템플릿화된 `usesCleartextTraffic` 포함)                          | 스파이크는 개발 서버에서 엔진을 로드; 하드웨어 접근 없음                   |

향후 예제에 카메라/오디오 기능이 추가되면, 해당 매니페스트와 이 표를 함께 업데이트해야 합니다.
