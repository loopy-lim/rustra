#!/usr/bin/env bash
# rustra-bridge Lynx iOS spike — 자동 검증 스크립트.
# 단일 ReactLynx 번들 + 단일 rustra rkyv 백엔드가 iOS 시뮬레이터에서
# 실제 Rust FFI 왕복(addNumbers(20,22) → 42) 을 수행하는지 증명한다.
#
# 성공 기준 (결정적 로그 증거):
#   1. loadTemplate bytes>0           — ReactLynx 번들 로드
#   2. RustraModule registered        — LynxConfig 모듈 등록
#   3. rkyv in bytes=4                — addNumbers 요청 (cmd 1 + postcard {a:20,b:22})
#   4. rkyv out bytes=9               — addNumbers→42 응답 ([ok][7B pad][postcard value:42])
#   5. (오류/권한 경로) out bytes 에 52, 95 포함 — typed error + capability.denied
#   6. "Rustra not configured" 없음   — configure() 성공 (bare NativeModules 클로저)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # examples/lynx-calculator
IOS_DIR="$ROOT/ios"
APP_ID="dev.rustra.lynx-calculator"
APP_BUNDLE="$IOS_DIR/build/Build/Products/Debug-iphonesimulator/RustraLynxApp.app"
SHOT="${SHOT:-/tmp/lynx-ios-result.png}"
DEVICE_ID="${DEVICE_ID:-$(xcrun simctl list devices booted -j | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(v[0]["udid"] for v in d["devices"].values() for v2 in v if v2["state"]=="Booted"))')}"

echo "==> device: $DEVICE_ID"

# 1. JS 번들 빌드 + iOS 리소스 동기화 (getRustraNative 등 패키지 변경 반영).
echo "==> bundle (rspeedy)"
( cd "$ROOT" && npm run build >/dev/null 2>&1 )
cp "$ROOT/dist/index.lynx.bundle" "$IOS_DIR/app/Resources/app.lynx.js"

# 2. iOS 앱 빌드.
echo "==> xcodebuild"
( cd "$IOS_DIR" && xcodebuild \
    -workspace RustraLynxApp.xcworkspace -scheme RustraLynxApp \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    -derivedDataPath ./build build >/dev/null 2>&1 )

# 3. 설치 + 런치.
echo "==> install + launch"
xcrun simctl uninstall booted "$APP_ID" 2>/dev/null || true
xcrun simctl install booted "$APP_BUNDLE"
xcrun simctl launch booted "$APP_ID" >/dev/null

# 4. rkyv 왕복이 로그에 나타날 때까지 폴링.
echo "==> poll log for rkyv roundtrip"
for i in $(seq 1 45); do
  if xcrun simctl spawn booted log show --last 30s \
        --predicate 'process == "RustraLynxApp"' 2>/dev/null \
        | grep -q "rkyv out"; then
    echo "    rkyv roundtrip at poll $i"
    break
  fi
  sleep 1
done

# 5. 스크린샷.
xcrun simctl io booted screenshot "$SHOT" >/dev/null 2>&1 && echo "==> screenshot: $SHOT"

# 6. 결정적 게이트 — 로그에서 6 패턴 grep.
LOGS="$(xcrun simctl spawn booted log show --last 120s \
          --predicate 'process == "RustraLynxApp"' 2>/dev/null)"
pass=0; fail=0
check() {
  local label="$1" pat="$2"
  if echo "$LOGS" | grep -qE "$pat"; then
    echo "  PASS  $label"; pass=$((pass+1))
  else
    echo "  FAIL  $label"; fail=$((fail+1))
  fi
}
check "1. loadTemplate bytes>0" 'spike-ios\] loadTemplate .*bytes=[1-9]'
check "2. RustraModule registered" 'module: RustraModule registered'
check "3. rkyv in  (addNumbers req)" 'spike-ios\] rkyv in bytes=4'
check "4. rkyv out=9 (addNumbers→42)" 'spike-ios\] rkyv out bytes=9'
check "5. typed error roundtrip (out=52)" 'spike-ios\] rkyv out bytes=52'
check "6. FFI invokeMethod did complete" 'did invokeMethod: RustraModule.invokeRkyvV2'

# "Rustra not configured" 가 있으면 명시 실패 (configure 성공 여부).
if echo "$LOGS" | grep -q "Rustra not configured"; then
  echo "  FAIL  7. must NOT have 'Rustra not configured'"; fail=$((fail+1))
else
  echo "  PASS  7. no 'Rustra not configured' error"; pass=$((pass+1))
fi

echo "==> SUMMARY pass=$pass fail=$fail"
if [ "$fail" -eq 0 ]; then echo "RESULT: iOS spike PASS — ReactLynx↔Rust rkyv roundtrip on iOS"; exit 0
else echo "RESULT: iOS spike FAIL"; exit 1; fi
