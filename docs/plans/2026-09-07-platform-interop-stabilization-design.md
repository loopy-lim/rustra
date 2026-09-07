# 플랫폼 상호운용 안정화 — 설계 (2026-09-07)

상태: 설계 확정. 1.0 트랙 이전의 개발 전제 조건 — "모든 안정화가 끝난 뒤 개발"이라는
방침의 두 축을 담는다.

## 문제

호스트가 플랫폼 특화 기능을 브리지에 싣는 것은 오늘도 "컴파일은 되지만 계약은 깨지는"
상태다. 반대 축(RN의 C++ TurboModule 상호운용)은 진입점 자체가 없다.

### 축 1 — 플랫폼 특화 명령 (Windows/macOS 등)

핸들러는 평범한 Rust fn이므로 `#[cfg(target_os)]`로 감싸면 Win32/objc2 호출을 하는
rustra 명령을 **작성할 수는** 있다(`builder_commands.rs`의 `Fn(I) -> Result<O>` 계약).
그러나:

1. **command_id 파괴** — command_id는 등록 순서 부여(`builder_commands.rs`의
   `next_command_id += 1`). cfg로 중간 명령이 빠지면 이후 전 명령의 id가 플랫폼별로
   밀린다. rkyv V2 와이어는 id로 디스패치하므로 = 잘못된 명령 실행.
2. **스키마/계약 해시 분열** — schema.json은 등록된 명령만 열거하므로 플랫폼별로
   달라지고, contract hash도 갈라진다 → `contract.mismatch`.
3. **가용성 신호 부재** — 다른 플랫폼에서 호출하면 `command.not_found`(없는 명령)가
   되어 "이 디바이스는 미지원"과 "오타"가 구분되지 않는다.

### 축 2 — RN C++ TurboModule 값 수용 (Android/iOS)

JSI 경계의 입력 표면은 (a) ArrayBuffer/Uint8Array, (b) 스키마 정적 JS 객체(typed
fast path), (c) 문자열/핸들뿐이다. 제약:

1. **C++ 공개 진입점 없음** — typed 인코더/디코더(`encode_by_name`/`decode_by_name`)는
   `__rustraNative` HostFunction 클로저 안에 갇혀 있다. 다른 C++ TurboModule이 자신의
   `jsi::Value`/HostObject를 rustra에 넘기려면 JS를 경유해야 한다.
2. **불투명 리소스 표현은 이미 있다** — `ResourceHandle(u32)` + 프로세스 전역
   `ResourceTable`(`channels_handles.rs`, `channels_host.rs`)이 "JS는 정수 id, 실체는
   Rust 테이블" 계약을 제공한다. Win32 `HANDLE`/`NSView*`는 이 테이블의 값으로
   살면 되고, Drop 시점 해제는 `drop_resource`가 보장한다.

## 설계

### A. 플랫폼 게이트 = "전 플랫폼 등록 + 미지원 플랫폼 스텁"

핵심 결정: **플랫폼 게이트를 등록 시점의 cfg가 아니라 런타임 스텁으로 푼다.**

```rust
// 1) 전 플랫폼에서 무조건 등록 — id·스키마·해시가 플랫폼 무관하게 동일
builder.platform_command::<(), PlatformNativeInfo>(
    "platformNativeInfo",
    &[Platform::Macos, Platform::Windows],
);
// 2) 실제 구현은 지원 플랫폼에서만 주입 (cfg로 보호)
#[cfg(any(target_os = "windows", target_os = "macos"))]
let builder = builder.platform_command_impl("platformNativeInfo", platform_native_info_impl);
```

- `platform_command::<I, O>`는 `I`/`O`의 스키마로 명령을 **항상** 등록하되, 핸들러는
  `platform.unavailable` 에러를 반환하는 스텁이다(에러는 JSON/postcard/raw 전 경로에서
  기존 에러 와이어로 흐른다 — 핸들러 `Err` 정규화 경로 재사용).
- `platform_command_impl(name, handler)`는 스텁을 실제 핸들러로 교체한다. command_id·스키마는
  유지하고, `I`/`O` 타입 불일치는 빌드 시점 패닉으로 잡는다.
- **빌드 시점 정합**: 현재 플랫폼이 선언 목록에 있는데 `platform_command_impl`이 빠지면
  `build()`가 패닉한다(지원 플랫폼에서 조용히 스텁으로 남는 실수 방지). 반대로 현재
  플랫폼이 목록에 없는데 `platform_command_impl`을 호출하면 그 자리에서 패닉.
- 스키마 명령 항목에 `"platforms": ["macos","windows"]`(선언 순서 정규화)가 붙는다 —
  전 플랫폼에서 동일하므로 계약 해시도 안정.
- 새 에러 코드 `platform.unavailable`(non-retryable). `command.not_found`와 달리
  "명령은 계약에 존재하되 이 플랫폼에서는 구현이 없다"를 정확히 구분한다.

#### 왜 이 방향인가 (거절한 대안)

- **cfg로 등록 자체를 감싸기**: 구현 가능하지만 id 시프트·해시 분열을 해결 못 하고
  오히려 그 결과를 감춘다.
- **플랫폼별 schema.json + 코드젠 필터**: 스키마 파이프라인(parity-gate, schema-diff,
  C++ static registry) 전역에 플랫폼 인지를 심어야 한다 — 표면이 균일하면 전부 불필요.
- **capability로 플랫폼 게이트 흉내**(`grant_capability`를 OS별 부여): 동작은 하지만
  의미가 틀리다(capability는 "누가"지 "어디서"가 아니다) + 미부여 이유가 불분명.

### B. RN C++ 진입점 — `rustraInvokeTypedValue`

`RustraJSIBridge`의 typed invoke 본체(인코딩 → FFI → 디코딩)를 HostFunction 클로저에서
**공개 C++ 자유함수**로 추출한다:

```cpp
// JS 스레드에서만 호출 (jsi Runtime 스레드 친화성 계약 그대로)
bool rustra::invokeTypedByNameValue(jsi::Runtime& rt, const std::string& name,
                                    const jsi::Value& args, jsi::Value* out);
bool rustra::invokeTypedByIdValue(jsi::Runtime& rt, uint16_t commandId,
                                  const jsi::Value& args, jsi::Value* out);
```

- 다른 C++ TurboModule이 자기 `jsi::Value`(HostObject 포함 — 인코더는
  `getProperty` 기반이라 스키마에 부합하면 어떤 출처의 객체든 인코딩한다)를 들고
  rustra를 직접 호출할 수 있다. JS 왕복·JSON 직렬화 불필요.
- 계약: (1) JS 런타임 스레드에서만 호출(기존 EventDispatcher 스레딩 계약과 동일),
  (2) 반환 `bool`은 "정적 코덱 미보유"(JS 엔진이 by-id/JS코덱 폴백하듯 호스트가
  폴백할 수 있는 신호), (3) 에러는 예외가 아니라 기존 error wire 규칙을 따르는
  out 파라미터의 에러 Value.
- 채널/이벤트의 바이너리 페이로드(현재 JSON `const char*` 고정)와 folly::dynamic
  직접 수용은 **후속 슬라이스**로 남긴다(설계는 이 문서의 "남는 일" 참조).

### C. 불투명 플랫폼 리소스 — 기존 패턴 공식화

새 메커니즘을 만들지 않는다. `ResourceHandle`/`ResourceTable`(계산기 예제의
`resource_open/read/write/close`가 전체 수명주기를 이미 시연)의 공식 사용법을
문서화한다: Win32 `HANDLE`은 `Drop`에서 `CloseHandle`하는 래퍼를 테이블에 넣고,
JS는 u32 id만 주고받는다. 64비트 포인터를 JS에 직접 노출하지 않는다(number 정밀도
+ 위협 모델상 포인터 노출 회피).

## 남는 일 (후속 슬라이스, 이번 범위 밖)

- 채널/이벤트 바이너리 페이로드 FFI 변형 (`rustra_ffi_channel_*` bytes 계열)
- folly::dynamic → postcard 동적 인코더
- `#[command(platform = ...)]` 매크로 속성 (현재는 빌더 API)
- 다중바이트 TypedArray의 `invokeTypedBuffer` 수용
- ResourceHandle JS 자동 해제(FinalizationRegistry)·테이블 스위핑
- 실기기(iOS/Android)·실 Windows/macOS 실행 증거 (1.0 트랙)

## 하위 호환성

- `platform.unavailable`은 신규 코드·신규 스키마 필드(`platforms`) — 기존 패키지의
  해시·와이어는 불변(필드는 조건부).
- `platform_command`/`platform_command_impl`는 추가 빌더 메서드 — 기존 체인 무영향.
- C++ 자유함수 추가는 순수 신규 심볼 — 링크 호환성 무영향.
