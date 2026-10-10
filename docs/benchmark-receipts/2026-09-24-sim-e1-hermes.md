# 2026-09-24 — iOS 시뮬레이터 E1 owned 경로 Hermes 종단 검증 (RN 계산기 Release 스모크)

`examples/react-native-calculator`를 **Release-iphonesimulator**로 빌드해
`scripts/ci-ios-runtime-smoke.sh`가 기대하는 `RUNNER_TEMP` 경로 계약
(`$RUNNER_TEMP/rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app`)을
지키고, 부팅된 iPhone 17 시뮬레이터에 설치·실행해 **E1 owned 핸드오프 경로
(`typedInvokeTail` 분기 + `OwnedFrameGuard` free 짝)**가 실제 Hermes에서 통과함을
로그로 증명한 리시트. 앱이 출력한 소형/대형 응답 경로 참고 수치도 함께 기록한다.

- 결론: **completion check 통과.** `__RUSTRA_SMOKE_OK__ addNumbers(42,58)=100`이
  통합 로그(unified log)에서 관측됨(pid 18114). 번들은 Hermes 바이트코드이며,
  빌드된 코어가 `rustra_ffi_invoke_frame_owned` 심볼을 정의·익스포트하므로 이 실행의
  모든 typed invoke는 `typedInvokeTail`의 **E1 분기**를 통과했다(Tier-1 probe 폴백은
  도달 불가). 벤치마크 receipt(정합성 게이트 통과, `jsEngine: "hermes"`)에서
  `invokeTypedPos` 직결 레인(string/pair)이 E1 경로로 측정·통과함이 수치로 남았다.
- **아래 수치는 시뮬레이터 참고 수치이며 adoption-grade 측정이 아니다.** 채택 판정은
  실기기 A/B 측정 플랜(본 루프에서 작성 중인 E1·A2 emit 전환 런북)이 담당한다.

## 환경

| 항목        | 값                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 호스트      | macOS 26.6.2 (25G83), Xcode 26.2                                                                                                          |
| 시뮬레이터  | iPhone 17, iOS 26.2 (23C54), UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC` (기존 부팅 상태)                                                 |
| 앱          | `com.alt-shifted.react-native-calculator` (Release-iphonesimulator, arm64+x86_64 fat)                                                     |
| JS 엔진     | Hermes — `main.jsbundle` 헤더 매직 `c6 1f bc 03`(Hermes 바이트코드), receipt `jsEngine: "hermes"`                                         |
| bun 가드    | 모든 bun 명령을 `env -u RUSTRA_BUN_LIBRARY`로 실행 (codegen:check, receipt 추출)                                                          |
| 러스트 코어 | `modules/rustra-jsi/ios/build-rust-ios.sh` 기본 경로(aarch64-apple-ios-sim + x86_64-apple-ios + lipo, release)로 **현재 소스에서 재빌드** |

## 아티팩트 정체성

| 파일                                         | sha256 (앞 16)      | 비고                                                                            |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `reactnativecalculator` (앱 바이너리)        | `fb3908c4c3dd47db`  | fat: x86_64 + arm64                                                             |
| `main.jsbundle`                              | `36c32abcfa2ccdc3`  | Hermes 바이트코드, `__RUSTRA_SMOKE_OK__` 포함(기본 데모=BenchmarkApp 번들 확인) |
| `librustra_calculator_example.a` (rust 코어) | `b43a90ccc6eea89c`  | fat: x86_64 + arm64, 2026-09-24 재빌드                                          |
| `rustra-benchmark-receipt.json`              | `f49d12ed3e165ce0`  | 앱 Documents에서 추출(원문 `target/sim-e1/03-benchmark-receipt.json`)           |
| receipt `buildFingerprint`                   | `7f22ab636b83c570…` | 현재 소스 지문과 **일치**(재계산 비교) — stale 빌드 아님                        |

## 1) 빌드 — Release-iphonesimulator + RUNNER_TEMP 경로 계약

CI(`.github/workflows/ci.yml` rn-ios 잡)와 동일한 명령을 로컬 경로에 재현:

```bash
cd examples/react-native-calculator
env -u RUSTRA_BUN_LIBRARY bun run codegen:check   # ✓ 생성 코드 일치
sh modules/rustra-jsi/ios/build-rust-ios.sh       # fat(rust) release 재빌드
cd ios
env -u EXPO_PUBLIC_RUSTRA_DEMO xcodebuild \
  -workspace reactnativecalculator.xcworkspace -scheme reactnativecalculator \
  -configuration Release -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath /tmp/rustra-ios-smoke/rustra-ios-dd build
# → ** BUILD SUCCEEDED ** (target/sim-e1/01-xcodebuild-release.log)
```

- `EXPO_PUBLIC_RUSTRA_DEMO`를 명시적으로 해제(`env -u`)해 빌드 — 기본 데모
  BenchmarkApp이 번들되어야 스모크 마커가 존재한다.
- 사전 준비 상태 문제(정직 기록): 재빌드 전 코어 정적 라이브러리(9/18 빌드)가 현재
  E1 소스(`crates/rustra/src/ffi_typed_buffer.rs` 등 미커밋 변경 포함)보다 stale했으므로
  재빌드는 필수였다. 첫 xcodebuild 시도는 `RUSTRA_IOS_TARGET=aarch64-apple-ios-sim`
  단일 슬라이스로 스테이징한 탓에 x86_64 링크 단계에서 실패(exit 65) — 스크립트 기본
  경로(듀얼 타깃 + lipo)로 재빌드해 해결. 빌드 로그 전문 보존.

## 2) completion check — 시뮬레이터 런타임 스모크

```bash
RUNNER_TEMP=/tmp/rustra-ios-smoke bash scripts/ci-ios-runtime-smoke.sh
```

실행 결과(`target/sim-e1/02-ios-smoke.log`, exit 0):

```
smoke: booting simulator 99B087B5-DEF6-4CF1-9177-81A5DE564CFC
smoke: installing com.alt-shifted.react-native-calculator
smoke: launching com.alt-shifted.react-native-calculator
com.alt-shifted.react-native-calculator: 18114
smoke OK: pid=18114, __RUSTRA_SMOKE_OK__ observed (99B087B5-DEF6-4CF1-9177-81A5DE564CFC)
```

통합 로그 원문(`02b-smoke-console-log.txt` 192행, 스모크 PID/시작 시각으로 범위 제한):

```
2026-09-24 17:41:18.325 I  reactnativecalculator[18114:7b9273] \
  [com.facebook.react.log:javascript] __RUSTRA_SMOKE_OK__ addNumbers(42,58)=100
```

이 마커는 "JS 번들 로드 + 첫 엔진 호출 성공"(BenchmarkApp `runBenchmarks`의 A6
런타임 스모크 계약)을 의미한다.

## 3) E1 owned 경로 증명 체인

### 3-1. 바이너리: E1 진입 심볼 존재 → 분기 활성 보장

앱 바이너리 arm64 슬라이스에서 두 심볼이 모두 **정의**(T)되어 있다:

```
$ nm -gU -arch arm64 reactnativecalculator.app/reactnativecalculator
0000000100596ca8 T _rustra_ffi_free_owned_bytes
0000000100597af0 T _rustra_ffi_invoke_frame_owned
```

`RustraJSIBridge.cpp`의 코어 테이블 바인딩에서 `invoke_frame_owned`는
`RUSTRA_BIND_OPTIONAL`(심볼 부재 시에만 null)로 바인딩되며, 이 빌드에는 심볼이
존재하므로 `core->invoke_frame_owned != nullptr`이 **항상 참** — 즉 이 실행의 모든
`typedInvokeTail` 호출은 E1 분기(`invoke_frame_owned` 1회 FFI로 dispatch 종결)를
통과했고, Tier-1 caller-buffer/probe 폴백(`invoke_frame_into` 경로)은 도달 불가한
죽은 코드였다. 런타임 토글은 존재하지 않는다.

### 3-2. 런타임: 실제 Hermes에서의 typed 호출 통과

- `typedInvokeTail` 진입(`invokeTyped` / `invokeTypedById` / `invokeTypedPos` /
  `invokeTypedBatch` / native-sync 바인딩) 중 이 실행이 사용한 경로:
  - **스모크 마커 `addNumbers(42,58)=100`** — cmd_id 1. 생성 코덱에 positional
    진입이 존재하고(`encode_pos_addNumbers`), 프레임 엔진의 생성 라우트는
    raw 부재/폴백 시 `invokeTypedPos`→`invokeTypedById` 순으로 typed 진입을
    사용한다(`packages/types/src/frame-engine-routes.ts`). 어느 티어를 탔든
    pos/byId 진입은 `typedInvokeTail`의 E1 분기로 귀결된다.
  - **receipt의 route diagnostics(string/pair 레인)** — `BenchmarkApp`이
    `native.invokeTypedPos(benchEchoStringId, …)`,
    `native.invokeTypedPos(benchEchoPairId, …)`를 **직접** 호출해 측정했다
    (10,500회 워밍업 포함). 아래 수치가 기록됐다는 것 자체가 E1 분기 호출이
    예외 없이 완료됐다는 증거다.
- Hermes 확인: `main.jsbundle`이 Hermes 바이트코드(매직 `c61fbc03`)이고 receipt
  `jsEngine: "hermes"`, `platform: "ios 26.2"`, `buildMode: "release"`.
- 정합성 게이트: receipt `correctness: { equivalentOutputs: true,
checkedBeforeTiming: true }` — Nitro/rustra/FFI 동등 출력 검증이 타이밍 **전에**
  통과했다(추출 스크립트의 스키마 검증도 통과: `ffi.available: true`, 6개 op
  paired CI95 유효).

### 3-3. free 짝 가드

- **`OwnedFrameGuard`**(E1 전용): 이 실행의 모든 typed 호출에서 RAII 수명 주기
  (생성→소멸)를 통과했다. 응답이 512B 스택 버퍼에 들어가는 동안엔 `adopt`가
  일어나지 않는다(owned=null 반환, 해제 없음 — 이 계약대로 동작).
- **overflow 서브브랜치(512B 초과 → non-null 반환 → `adopt` →
  `free_owned_bytes` 정확히 1회)**: 스톡 BenchmarkApp의 대형 페이로드 레인
  (64KiB/1MiB)은 `invokeTypedBuffer`→`invokeBufferOnCore` 버퍼 라우트를 쓰므로,
  이 실행에서 typed tail의 overflow 핸드오프는 **직접 관측되지 않았다**(아래 한계 참조).
- **인접 증거(같은 free 심볼, 대형 페이로드)**: 64KiB/1MiB 레인은
  `RustOwnedMutableBuffer` 소멸자가 **같은 `rustra_ffi_free_owned_bytes`를 정확한
  (ptr, len)으로 1회** 호출하는 버퍼 라우트다. 500/200회 반복 + GC 생존 + 정합성
  검증 통과로, Hermes 런타임에서 이 free 짝이 대형 응답 규모에서 붕괴하지 않음을
  확인했다.

## 4) 참고 수치 (시뮬레이터 · non-adoption-grade)

receipt: `target/sim-e1/03-benchmark-receipt.json` (schemaVersion 5, 10,000 iter /
워밍업 500, 교대 순환 측정, paired-batch-log-ratio-t 95% CI).

소형 응답(typed/코덱 경로, 응답 수십 바이트):

| 연산         | Nitro avg | rustra avg | rustra/Nitro | 95% CI         |
| ------------ | --------- | ---------- | ------------ | -------------- |
| add (f64×2)  | 2.44 µs   | 2.75 µs    | 1.128x       | [1.098, 1.158] |
| string echo  | 2.51 µs   | 2.78 µs    | 1.111x       | [1.089, 1.133] |
| bytes64 echo | 3.23 µs   | 3.36 µs    | 1.041x       | [1.001, 1.082] |
| pair echo    | 2.59 µs   | 3.02 µs    | 1.167x       | [1.147, 1.188] |

대형 응답(버퍼 라우트 — `invokeTypedBuffer` + `RustOwnedMutableBuffer` free 짝):

| 연산          | 크기        | Nitro avg | rustra avg | rustra/Nitro | 95% CI         |
| ------------- | ----------- | --------- | ---------- | ------------ | -------------- |
| bytes64KiB    | 65,536 B    | 8.04 µs   | 10.90 µs   | 1.357x       | [1.229, 1.498] |
| bytes1MiBWire | 1,048,571 B | 70.51 µs  | 95.30 µs   | 1.352x       | [1.212, 1.508] |

라우트 진단(receipt `rawLowerBound.generatedRoutes` — generated 헬퍼 대비 네이티브
직결 진입의 진단 lower bound):

| op      | 직결 진입             | native avg | generated avg | gen/native |
| ------- | --------------------- | ---------- | ------------- | ---------- |
| add     | `invokeTypedRaw`      | 2.34 µs    | 2.71 µs       | 1.16x      |
| string  | `invokeTypedPos` (E1) | 2.43 µs    | 2.84 µs       | 1.17x      |
| bytes64 | `invokeTypedBuffer`   | 2.74 µs    | 3.29 µs       | 1.20x      |
| pair    | `invokeTypedPos` (E1) | 2.57 µs    | 2.97 µs       | 1.16x      |

Swift FFI 레인(참고 — iOS 전용 비교 모듈): add 28.41 µs / string 28.04 µs /
bytes64 36.17 µs / pair 29.08 µs (Nitro 기준 각 2.87/3.07/18.94/3.02 µs).

**위 수치는 시뮬레이터(JIT가 없는 Hermes AOT 번들이지만 호스트 CPU·시뮬레이션
스케줄링 환경)에서의 참고치다. adoption-grade 판정(임계치·회귀 게이트)은 실기기
A/B 측정 플랜이 담당한다.**

## 관측 한계 (정직 기록)

1. **E1 overflow 서브브랜치 직접 관측 부재** — `typedInvokeTail`의 E1 분기 자체는
   이 실행의 모든 typed 호출에서 통과했지만, 512B 스택 버퍼를 넘는 응답을 반환하는
   typed 호출(`invoke_frame_owned` non-null 반환 → `OwnedFrameGuard.adopt` →
   `free_owned_bytes` 1회)은 스톡 BenchmarkApp에 존재하지 않는다(대형 레인은 버퍼
   라우트). 해당 서브브랜치의 검증은 호스트 유닛 테스트와 실기기 플랜의 A/B
   (E1 on/off) 항목으로 보완해야 한다.
2. **프로세스 내부 카운터 부재** — E1 분기 진입/owned 핸드오프 횟수를 앱이 로그로
   출력하지 않는다. 증명은 "심볼 존재 + 무조건 바인딩 + typed 호출 성공"의 추론
   체인이며, 분기 도달을 직접 세는 계측은 없다.
3. **스모크 마커의 티어 특정** — `addNumbers`가 raw/pos/byId 중 어느 진입을
   사용했는지는 capability 비트(`getCodecCapabilities`) 런타임 값으로 확정하지
   않았다. 다만 세 진입 중 raw를 제외한 두 경로 모두 `typedInvokeTail`이며,
   route diagnostics의 `invokeTypedPos` 직결 레인이 E1 통과를 독립적으로 증명한다.
4. 시뮬레이터 성능 특성(특히 µs 단위 마이크로벤치)은 실기기와 다르다 — 위 표는
   경로 정상 동작의 부수 관측치일 뿐이다.

## 증거 파일

| 파일                                                              | 내용                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `target/sim-e1/00-build-rust-ios.log`                             | rust 코어 재빌드(arm64-only 시도, 20.01s)             |
| `target/sim-e1/00-build-rust-ios-fat.log`                         | rust 코어 fat 재빌드(듀얼 타깃 + lipo)                |
| `target/sim-e1/01-xcodebuild-release.log`                         | Release-iphonesimulator 빌드(`** BUILD SUCCEEDED **`) |
| `target/sim-e1/02-ios-smoke.log`                                  | completion check 전문(exit 0)                         |
| `target/sim-e1/02b-smoke-console-log.txt`                         | 통합 로그 원문(마커 192행, PID 18114 범위)            |
| `target/sim-e1/03-benchmark-receipt.json`                         | 벤치마크 receipt 원문(앱 Documents에서 추출)          |
| `target/sim-e1/03-benchmark-receipt.log`                          | receipt 추출 실행 로그(검증 통과)                     |
| `/tmp/rustra-ios-smoke/rustra-ios-dd/…/reactnativecalculator.app` | 스모크가 설치한 빌드 산출물                           |

## 재현 런북

```bash
# 0) 사전: iPhone 17 시뮬레이터 부팅(iOS 26.2), Xcode 26.2
# 1) 생성 코드 일치 확인(bun 가드 필수)
cd examples/react-native-calculator
env -u RUSTRA_BUN_LIBRARY bun run codegen:check
# 2) rust 코어 fat 빌드(현재 소스 기준 — stale 코어면 E1 검증이 무의미해짐)
sh modules/rustra-jsi/ios/build-rust-ios.sh
# 3) 앱 Release 빌드(RUNNER_TEMP 경로 계약 + 데모 선택 해제)
cd ios && env -u EXPO_PUBLIC_RUSTRA_DEMO xcodebuild \
  -workspace reactnativecalculator.xcworkspace -scheme reactnativecalculator \
  -configuration Release -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath /tmp/rustra-ios-smoke/rustra-ios-dd build
# 4) E1 심볼 확인(분기 활성의 바이너리 근거)
nm -gU -arch arm64 /tmp/rustra-ios-smoke/rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app/reactnativecalculator \
  | grep rustra_ffi_invoke_frame_owned
# 5) completion check — 설치·실행·마커 단언
cd ../../ && RUNNER_TEMP=/tmp/rustra-ios-smoke bash scripts/ci-ios-runtime-smoke.sh
# 6) 참고 수치 추출(앱 재실행 → receipt 대기·검증)
cd examples/react-native-calculator && env -u RUSTRA_BUN_LIBRARY \
  bun scripts/extract-benchmark-receipt.mjs --timeout-ms 1200000 \
  --output ../../target/sim-e1/03-benchmark-receipt.json
```
