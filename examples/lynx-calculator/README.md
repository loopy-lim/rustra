# Lynx Calculator 예시 (iOS + Android)

단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드가 iOS 시뮬레이터와 Android
에뮬레이터에서 실제 Rust FFI 왕복(`addNumbers(20,22) → 42`)을 수행하는 것을
증명한 모바일 스파이크의 산출물입니다.

모바일 Lynx 트랙의 검증 자산이며, 이 구조를 정제한 production 버전은
`runner/template/mobile-ios/`, `runner/template/mobile-android/` 템플릿입니다.

## 구조

```
lynx-calculator/
├── src/                  ReactLynx 앱 (rspeedy 번들)
├── modules/rustra-lynx/  플랫폼 네이티브 모듈 (iOS RustraModule / Android JNI)
├── ios/                  iOS 앱 + verify-ios.sh (7패턴 게이트)
├── android/              Android 앱 + verify-android.sh (7패턴 게이트)
└── host/                 macOS headless 렌더 호스트 (libLynx CAPI 스크린샷)
```

## 검증 게이트

### iOS

```bash
bash ios/verify-ios.sh
```

시뮬레이터에서 결정적 로그 증거를 grep 합니다 — `loadTemplate bytes>0`,
`RustraModule registered`, `rkyv in bytes=4` (cmd 1 + postcard `{a:20,b:22}`),
`rkyv out bytes=9` (ok + postcard value:42), typed error/capability.denied
경로 포함. 스크린샷은 `$SHOT`(기본 `/tmp/lynx-ios-result.png`)에 저장.

### Android

```bash
bash android/verify-android.sh
```

에뮬레이터에서 `renderTemplateUrl`, `rkyv in/out bytes`, JNI_OnLoad init
등 동일 7패턴을 검증합니다. NDK는 `27.1.12297006`으로 핀됩니다.

## 관련 문서

- `docs/plans/2026-08-11-lynx-mobile-spike.md` / `-result.md` — 스파이크 계획·결과 (iOS 7/7 · Android 7/7)
- `docs/extending/lynx-setup.md` — Lynx 설정 가이드
- `runner/template/` — 이 스파이크에서 정제된 4플랫폼 러너 템플릿
