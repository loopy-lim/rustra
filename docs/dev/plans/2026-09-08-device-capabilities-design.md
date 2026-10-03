# 디바이스 역량 계약 레이어 — 설계 (2026-09-08)

상태: 설계 확정. 리서치 근거: `docs/research/2026-09-08-device-capabilities.md`
(이하 "리서치"). 사용자 요청: "mobile과 desktop은 권한과 할 수 있는 게 많다 —
wifi, bluetooth, camera, battery 등. 인터넷 조사를 포함해 호환 지원."

## 문제

커맨드가 카메라·블루투스·위치 같은 디바이스 역량을 전제한다는 사실을 계약에
담을 표면이 없다. 오늘날 가장 가까운 것은 platform 게이팅(`platforms` 필드 +
`platform.unavailable` 스텁)이지만 축이 다르다 — 같은 OS 안에서도 역량 유무
(데스크톱에 NFC 없음)와 권한 상태(사용자 거부)가 갈린다. 호스트 앱은 "이 명령이
어떤 역량을 전제하는가"를 코드로 읽지 못하고, JS 측에서 가용성/권한을 물을
표준화된 경로도 없어 각자 ad-hoc 이중화된다.

해결 원칙(리서치 §5): **선언과 조회는 rustra 몫, OS 권한 요청은 호스트 몫.**
W3C Permissions API조차 `request()`를 표준에서 제거했다 — 요청은
point-of-use에서 호스트가 한다. rustra는 "역량 의미론"만 계약에 담아 특정
Tauri 플러그인/RN 라이브러리 생태계 변동(리서치 §2의 실제 사례들)에 흔들리지
않는다.

## 설계

### A. 카탈로그 — `DeviceCapability` (검증된 닫힌 토큰 집합)

`crates/rustra/src/device_capabilities.rs`에 카탈로그 상수와 검증을 둔다:

- 토큰은 `&'static str`, 표기는 kebab-case. W3C PermissionName 가 있는 것은
  그 표기를 따르고(`camera`, `microphone`, `geolocation`, `notifications`,
  `clipboard-read`, `clipboard-write`), 없는 것은 rustra 명명(`wifi`,
  `bluetooth`, `battery`, `nfc`, `biometric`, `haptics`, `flashlight`,
  `contacts`, `calendar`, `photo-library`, `motion`, `usb`, `serial`,
  `network-state`, `screen-brightness`).
- **카탈로그는 버전닝된 닫힌 집합** — `DeviceCapability::ALL`(pub const)과
  `DeviceCapability::is_valid(token)` 검증. 등록 시점 미지원 토큰은 패닉
  (loud-fail — 오타 방지는 타입화 에러 트랙과 같은 동기). 새 토큰 추가는
  rustra 릴리스를 수반하는 계약 진화.
- OS 세부 권한 문자열(Android `NEARBY_DEVICES` 재편, iOS plist 키,
  macOS entitlement)은 토큰 뒤에 숨긴다 — 교차표는 문서로만
  유지(platform-permissions.md, 리서치 §2 표). 스키마·코드젠·와이어는
  토큰만 안다.

### B. 선언 트랙 — `#[command(device(...))]` (platforms/errors 트랙 3복제)

```rust
#[command(device(camera, bluetooth))]
fn scan_tags(input: ScanInput) -> Result<ScanOutput> { … }

// 또는 빌더 체인:
.command_devices("scan_tags", &["camera", "bluetooth"])
```

- `CommandAttr`에 `device(...)` 목록 파싱(식별자 또는 문자열 리터럴 —
  `#[command(platform(...))]`과 동일 구조, macro_command_support.rs 관례).
- 빌더 `command_devices(name, &[&'static str])` — 패닉 조건: 미등록 명령 /
  빈 슬라이스 / 카탈로그 밖 토큰 / 중복 토큰. `devices_meta_if` Option 체인은
  errors 트랙의 `errors_meta_if`와 동일 관례로 register!/build!에 자동 연결.
- **스키마**: 명령 항목에 조건부 `devices: ["camera","bluetooth"]`(단순 문자열
  배열 — 메타데이터 없음, YAGNI. 선언 없으면 미기록 → 기존 계약 해시 불변,
  platforms 관례).
- **런타임 자동 게이팅 없음** — 선언은 계약 문서다(타입화 에러 철학 동일).
  핸들러가 역량을 실제로 쓰는지 검사하지 않는다.

### C. 코드젱 — 조건부 `devices.ts` (events.ts/errors.ts 관례)

선언 커맨드가 1건이라도 있으면 `devices.ts` 생성, 없으면 파일 미생성:

```ts
import type { DeviceStatusProvider } from '@rustra/types';

/** 이 패키지가 선언에 사용한 디바이스 역량 토큰 (Rust 카탈로그 기준). */
export type RustraDeviceCapability = 'camera' | 'bluetooth';

/** scanTags 가 전제하는 디바이스 역량 (Rust 선언 기준). */
export const SCAN_TAGS_DEVICES: readonly RustraDeviceCapability[] = ['camera', 'bluetooth'];
```

- 커맨드당 `{FN}_DEVICES` 상수 + 패키지 레벨 토큰 유니언. 토큰→심볼 매핑
  충돌은 코드젠 loud-fail(errors 트랙의 PascalCase 충돌 판정과 동일).
- commands.ts/types.ts/errors.ts 출력은 바이트 불변(선언 없는 패키지).

### D. 호스트 조회 표면 — `@rustra/types` provider 등록 (W3C query 모델)

```ts
export type DeviceAvailability = 'available' | 'unavailable' | 'unknown';
export type DevicePermission = 'granted' | 'denied' | 'prompt' | 'unknown';
export type DeviceStatus = { availability: DeviceAvailability; permission: DevicePermission };

export function registerDeviceStatusProvider(provider: DeviceStatusProvider): void;
export type DeviceStatusProvider = (capability: string) => DeviceStatus | Promise<DeviceStatus>;
export function getDeviceStatus(capability: string): Promise<DeviceStatus>;
```

- 전역 1-provider 등록(`configure()` 관례 준용, packages/types 신규
  `device-status.ts`). **요청 API는 없다**(설계 원칙).
- **미등록 provider는 fail-open**: `{availability:'unknown', permission:'unknown'}`
  반환 + debug 경고 1회(조회가 부수효과를 만들지 않게). 호스트가 등록하지
  않아도 앱은 깨지지 않고, 안내만 된다.
- 파생 provider 팩토리(Tauri 플러그인/RN 라이브러리 매핑 구현체)는 후속
  트랙 — 코어는 의미론 계약만(리서치 §6 오픈 질문 4 종결).

### E. 에러 코드 2종 (additive)

- `device.unavailable` — 역량 부재/OS 스위치 off. `platform.unavailable`(그
  플랫폼용 구현 자체가 없음)·`capability.denied`(호출 자격 미부여)와는 원인·
  복구 경로가 다른 독립 축(리서치 §5-3).
- `device.permission_denied` — 사용자·정책 거부. retryable 아님.
- 발급 주체는 **호스트 앱/파생 provider** — rustra 코어는 게이팅을 하지
  않으므로 코어가 이 코드를 반환하는 경로는 없다. 코드 체계에만 등록.

### F. 하지 않을 것 (YAGNI)

- OS 권한 요청 API·선언적 manifest 생성 — 호스트 소관(철학).
- 자동 게이팅(선언된 역량 미충족 시 invoke 차단) — 계약 문서 원칙 위반,
  폐쇄 검사가 개방 런타임을 거짓으로 막는다.
- 토큰에 메타데이터(description/OS 권한 매핑) 실기 — 필요 증빙 후.
- 파생 provider 구현체 패키지(Tauri/RN별) — 후속 트랙.
- doctor의 디바이스 ACL 진단 — 후속.

## 슬라이스 1 (오늘 밤 착지 범위)

1. Rust 카탈로그 + 빌더/매크로/스키마(A/B절) + 테스트 — crates/**.
2. `@rustra/types` provider 표면 + 에러 코드 2종(D/E절) + 테스트.
3. CLI `devices.ts` 렌더러(C절) + 테스트 — packages/cli(진행 중인 DX 작업과
   파일 충돌 방지를 위해 DX 완료 후 착수).
4. 계산기 예제: `device_demo` 커맨드(선언만 — 하드웨어 미사용, 모의 provider로
   JS 조회 e2e) + 재생성 + api-surface.
5. 문서: platform-permissions.md/.ko.md에 "디바이스 역량 계약" 절(카탈로그 표 +
   조회 표면 + 호스트 매핑 안내는 리서치 §2 표로 연결) — en/ko.

## 하위 호환성

- `devices` 조건부 스키마 필드 — 선언 없는 패키지의 schema.json·계약 해시·생성물
  바이트 불변. 구 CLI는 미지 필드 무시(포워드 호환 자동).
- `DeviceStatusProvider`·에러 코드 2종은 additive. `registerDeviceStatusProvider`
  미호출 시 동작 변화 없음(fail-open 조회만 추가).
