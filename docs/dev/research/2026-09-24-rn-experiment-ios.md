---
date: 2026-09-24
researcher: loop-worker (rn-experiment-ios)
git_commit: 58e1835e
topic: 'rn-experiment iOS 시뮬레이터(aarch64-apple-ios-sim) 크로스컴파일 및 모듈 빌드 스크립트·podspec 계약 대조'
status: build-verified
---

# rn-experiment iOS 시뮬레이터 타깃 크로스컴파일 실측

**결론: `rustra-rn-experiment` 가 `aarch64-apple-ios-sim` Release 정적 라이브러리로 깨끗하게 링크된다(20MB, arm64 슬라이스, `rustra_mobile_init` 심볼 Export 확인, `vtool` 로 `platform IOSSIMULATOR` minos 14.0 확인). 생성물 [build-rust-ios.sh](../../examples/rn-experiment/modules/rustra-bridge/ios/build-rust-ios.sh) 와 [RustraBridge.podspec](../../examples/rn-experiment/modules/rustra-bridge/RustraBridge.podspec) 의 타깃·라이브러리 이름 계약을 대조한 결과 불일치 0건 — 수정 불요. 스크립트를 실제로 end-to-end 실행해 podspec 이 소비하는 경로에 fat 아카이브(x86_64 + arm64-sim) 40MB 가 생성됨까지 재현했다.** 이 문서는 시뮬레이터 **빌드 링크 검증**까지다. 시뮬레이터 상에서의 Hermes 런타임 A/B 실측은 후속 런북 문서에서 다룬다.

## 환경

- 툴체인: rustc/cargo 1.95.0 ([rust-toolchain.toml](../../rust-toolchain.toml) 핀, profile=minimal)
- rustup 타깃: `aarch64-apple-ios-sim` **사전 설치 상태였음** — 이번 작업에서 추가 설치 없음(같은 머신에 `x86_64-apple-ios` 도 설치되어 있어 스크립트 기본 경로의 lipo 도 무설치로 통과)
- Xcode: `/Applications/Xcode.app` (vtool — `IOSSIMULATOR` 플랫폼 판독에 사용)

## 직접 크로스컴파일 (completion check)

```sh
cargo build -p rustra-rn-experiment --target aarch64-apple-ios-sim --release
```

- 결과: `Finished \`release\` profile [optimized] target(s) in 8.01s` — 에러/경고 없음.
- 산출물: `target/aarch64-apple-ios-sim/release/librustra_rn_experiment.a` — **20MB**, `lipo -info` → **arm64** (non-fat).
- 심볼: `nm -gU` 로 `_rustra_mobile_init` Export 확인 — `native_entry!` 가 설치하는 Apple 로드 시점 진입 심볼이 정적 아카이브에 살아 있음.
- 플랫폼 슬라이스 검증: arm64 thin 추출 후 `vtool -show-build` → `LC_BUILD_VERSION platform IOSSIMULATOR, minos 14.0`. podspec 의 `s.platforms = { :ios => '15.1' }` 이 deployment target 하한이므로(minos ≤ deployment target) 정적 링크 계약과 무충돌.

## 생성물 계약 대조 (스크립트 · podspec)

| 대조 항목       | build-rust-ios.sh                                                                   | RustraBridge.podspec                                                                      | 판정                                                          |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 크레이트/패키지 | `PACKAGE='rustra-rn-experiment'`, `-p` 로 빌드                                      | — (아카이브만 소비)                                                                       | 일치                                                          |
| 라이브러리 이름 | `LIBRARY='rustra_rn_experiment'` → `librustra_rn_experiment.a`                      | `vendored_libraries` = `ios/rust/lib/librustra_rn_experiment.a` + `-force_load` 동일 경로 | 일치 (staticlib 명명 규칙 `lib<crate-name>.a` 와 정확히 일치) |
| 시뮬레이터 타깃 | 기본 경로: `aarch64-apple-ios-sim` + `x86_64-apple-ios` 각각 빌드 후 `lipo -create` | 타깃을 직접 명명하지 않고 슬라이스 소비 (arm64 시뮬레이터 = Apple Silicon 실측 경로)      | 일치                                                          |
| 빌드 트리거     | `prepare_command = 'sh ios/build-rust-ios.sh'` 로 pod install 시 실행               | 동일                                                                                      | 일치                                                          |
| 프로필          | `RUSTRA_PROFILE` (기본 release)                                                     | —                                                                                         | 일치                                                          |

- 단일 타깃 오버라이드: `RUSTRA_IOS_TARGET=aarch64-apple-ios` 로 실기기(아이폰 본체) 단일 슬라이스 빌드 경로도 스크립트가 이미 갖고 있다 — 실기기 A/B 런북에서 그대로 사용 가능.
- **불일치 0건** — 두 생성물 모두 `DO NOT EDIT`(codegen 산출)이므로 수정 없이 계약 유지가 정답.

## 스크립트 end-to-end 재현

```sh
cd examples/rn-experiment/modules/rustra-bridge && sh ios/build-rust-ios.sh
```

- `modules/rustra-bridge/build/target` 에 양 타깃 신규 빌드(rustra 의존 포함, 각 ~7s) 후 lipo 성공.
- 산출물: `ios/rust/lib/librustra_rn_experiment.a` — **40MB**, `lipo -info` → `x86_64 arm64` (fat).
- `ios/rust/lib/` 는 gitignore 대상(빌드 산출물) — podspec 이 `pod install` 마다 `prepare_command` 로 재생성하므로 커밋 불요.

## 결론 및 후속

- 시뮬레이터 정적 링크 계약(타깃·라이브러리 이름·아카이브 경로)은 코드젠 생성물 수준에서 이미 정합 — rn-experiment 의 모바일(iOS 시뮬레이터) 진입 빌드 단계는 검증 완료.
- 남은 것: (1) 시뮬레이터에서의 실제 RN 앱 빌드·Hermes 런타임 A/B 실측, (2) 실기기(`aarch64-apple-ios`)는 `RUSTRA_IOS_TARGET` 오버라이드로 동일 스크립트 재사용 — 런북 문서에서 실행 절차로 문서화.
