#!/usr/bin/env bash
# iOS 실행 게이트 — 스파이크 verify-ios.sh 패턴 재사용.
#
# 단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드(staticlib) 가 iOS 시뮬레이터에서
# Lynx SDK 4.0.1 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제:
#   1. Xcode + iOS Lynx SDK(CocoaPods) 설치.
#   2. iOS 셸(modules/rustra-lynx/ + app/) 이 스파이크에서 추출되어 있어야 함 —
#      소스: examples/lynx-calculator/{ios, modules/rustra-lynx/ios/}
#      (RustraModule.m invokeRkyvV2: + build-rust-ios.sh staticlib).
#      상세: docs/plans/2026-08-11-lynx-mobile-spike-result.md
#   3. codegen 으로 app/generated/ 가 이미 생성되어 있어야 함 (create-runner.sh 단계).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
LOG=/tmp/rustra-template-ios.log

echo "[ios] 1/4 ReactLynx bundle"
( cd "$APP_ROOT/app" && npm run build >/dev/null )

echo "[ios] 2/4 Rust staticlib (aarch64-apple-ios-sim)"
# ▶ build-rust-ios.sh 를 스파이크(examples/lynx-calculator/modules/rustra-lynx/ios/build-rust-ios.sh) 에서 추출.
"$HERE/modules/rustra-lynx/build-rust-ios.sh" >/dev/null

echo "[ios] 3/4 build + boot sim + run (~20s, capture log)"
: > "$LOG"
# ▶ xcodebuild test(pod install 후) → 시뮬레이터 부팅 → XCTest 가 번들 로드 + invokeRkyvV2 왕복.
#   스파이크의 verify-ios.sh 를 추출해 여기에 붙인다.
xcodebuild test \
  -workspace "$HERE/app/RustraTemplate.xcworkspace" \
  -scheme RustraTemplate \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  >>"$LOG" 2>&1 || true

echo "[ios] 4/4 check success criteria"
pass=1
check() { if grep -Eq "$2" "$LOG"; then echo "  [PASS] $1"; else echo "  [FAIL] $1  (pat: $2)"; pass=0; fi; }

# 게이트 — 스파이크 7패턴 중 iOS 결정적 증거.
check "1: bundle loaded (renderTemplateUrl/loadTemplate)" 'renderTemplateUrl|loadTemplate'
check "2: ReactLynx render (first_screen)" 'first_screen'
check "3: rkyv invoke roundtrip" 'invokeRkyvV2.*ok|result.*Hello'

echo ""
if [[ $pass -eq 1 ]]; then
  echo "RESULT: iOS PASS — ReactLynx <-> Rust rkyv roundtrip (greet) on iOS Simulator"
  exit 0
else
  echo "RESULT: iOS FAIL — 로그: $LOG"
  exit 1
fi
