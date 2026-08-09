# RN 검증 체크리스트 — Dynamic rkyv V2 (Tier 3) 엔드투엔드

> 날짜: 2026-07-05
> 목표: iOS 시뮬레이터에서 동적 명령(런타임 register)이 단일 rkyvV2 엔진의 Tier 3 fallback 으로
> 다양한 타입(String/Vec/Map/Nested)과 함께 동작함을 확인한다.
> 실행 환경: macOS + Xcode + iOS 시뮬레이터(iPhone 17 권장). debug Rust 라이브러리 필요(release=frozen).

---

## 0. 사전 조건

- [ ] Rust nightly/stable toolchain 설치, `aarch64-apple-ios-sim` 타겟 추가됨.
- [ ] CocoaPods 설치됨(RN iOS 의존성).
- [ ] 시뮬레이터 부팅됨: `xcrun simctl boot "iPhone 17"` (또는 Xcode → Open Simulator).

## 1. debug Rust 라이브러리 빌드 (release=frozen 이므로 **반드시 debug**)

```bash
cd examples/react-native-calculator/modules/rustra-jsi/ios
RUSTRA_PROFILE=debug ./build-rust-ios.sh
```

- [ ] `target/aarch64-apple-ios-sim/debug/librustra_calculator_example.a` 생성됨.
- [ ] `modules/rustra-jsi/ios/rust/lib/librustra_calculator_example.a` 로 복사됨.

> release 로 빌드하면 패키지가 frozen 이 되어 `register` 가 막힌다 → 동적 명령 데모가
> `registry.frozen` 에러를 낸다. 반드시 `RUSTRA_PROFILE=debug`.

## 2. DynamicRegistryApp 을 런치 앱으로 설정

`DynamicRegistryApp.tsx` 가 런치되도록 `App.tsx` 를 교체(기존 벤치마크 앱 패턴과 동일).

```bash
cd examples/react-native-calculator
cp App.tsx App.tsx.bak                       # 백업
echo 'export { default } from "./DynamicRegistryApp";' > App.tsx
```

- [ ] `App.tsx` 가 `DynamicRegistryApp` 을 default export.

## 3. iOS 앱 빌드 + 시뮬레이터 실행

```bash
cd examples/react-native-calculator
pod install --project-directory=ios   # 처음 한 번 또는 의존성 변경 시
npx expo run:ios                      # 또는: npx react-native run-ios
```

- [ ] 빌드 성공(에러 시 `modules/rustra-jsi/src/index.ts` 의 `getSchema?` 타입 확인).
- [ ] 시뮬레이터에 앱 설치되어 실행됨.

## 4. 화면 검증 — "Single rkyvV2 engine + live schema (Tier 3)" 섹션

앱 실행 후 스크롤하여 아래 섹션이 다음과 같이 표시되는지 확인:

```
╔══════════════════════════════════════════════╗
║  Single rkyvV2 engine + live schema (Tier 3) ║
╚══════════════════════════════════════════════╝
[Vec]   live schema 'average' commandId=<N>
  engine.invoke('average') → avg=25 count=4
[String] live schema 'greetDyn' commandId=<N>
  engine.invoke('greetDyn') → hello rust 🦀
[Map]   live schema 'scoreMap' commandId=<N>
  engine.invoke('scoreMap') → total=42 keys=2
[Nested] live schema 'nestedEcho' commandId=<N>
  engine.invoke('nestedEcho') → count=3 sumX=111
✅ 4 dynamic command types (Vec/String/Map/Nested) via single rkyvV2 engine (Tier 3)
```

- [ ] `[Vec]` `average` commandId 가 숫자로 표시(동적 명령 = codegen codec 없음에도 id 할당).
- [ ] `avg=25 count=4` (10+20+30+40 평균=25, 개수=4).
- [ ] `[String]` `greetDyn` 결과에 이모지 🦀 포함 정상 표시.
- [ ] `[Map]` `scoreMap` total=42 keys=2 (a=10, b=32).
- [ ] `[Nested]` `nestedEcho` count=3 sumX=111 (p.x=1 + 10 + 100).
- [ ] 각 commandId 가 서로 다름(단조 증가).
- [ ] 에러 줄 없음(FAIL/undefined 미표시).

## 5. 추가 확인 (선택)

- [ ] live schema 가 동적 명령 등록 전엔 해당 명령이 없고, 등록 후에만 나타남을 확인하려면
      `registerX` 호출 전후로 `getLiveSchema` 출력을 로그에 추가해 본다.
- [ ] release 빌드(`RUSTRA_PROFILE=release`)로 바꾸면 `register` 단계에서
      `registry.frozen` 에러가 나는지 확인(prod 안전성 검증).

## 6. 마무리

```bash
# App.tsx 복원
mv App.tsx.bak App.tsx
```

- [ ] 원래 App.tsx 복원.

---

## 결과 기록

실행 후 이 파일에 실제 commandId 값과 스크린샷 경로를 기록한다(선택):

- average commandId: ___
- greetDyn commandId: ___
- scoreMap commandId: ___
- nestedEcho commandId: ___
- 스크린샷: ___
