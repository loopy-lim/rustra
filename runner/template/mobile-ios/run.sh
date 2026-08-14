#!/usr/bin/env bash
# iOS 실행 게이트 — 스파이크 verify-ios.sh 절차를 템플릿 경로로 정제 이식.
#
# 단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드(staticlib) 가 iOS 시뮬레이터에서
# Lynx SDK 4.0.1 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제: Xcode + xcodegen + CocoaPods + iOS 시뮬레이터(부팅됨).
#
# 결정적 로그 증거([template-ios] TAG):
#   1. loadTemplate bytes>0      — ReactLynx 번들 로드
#   2. RustraModule registered   — LynxConfig 모듈 등록
#   3. rkyv in bytes=N           — greet 요청 (cmd_id + postcard {name})
#   4. rkyv out bytes=M          — greet 응답
#   5. "Rustra not configured" 없음 — configure() 성공
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
IOS_DIR="$HERE"
APP_ID="dev.rustra.template"
APP_BUNDLE="$IOS_DIR/build/Build/Products/Debug-iphonesimulator/RustraTemplate.app"
SHOT="${SHOT:-/tmp/rustra-template-ios-result.png}"
LOG=/tmp/rustra-template-ios.log
DEVICE_ID="${DEVICE_ID:-$(xcrun simctl list devices booted -j | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(v[0]["udid"] for v in d["devices"].values() for v2 in v if v2["state"]=="Booted"))')}"

echo "[ios] device: $DEVICE_ID"

# 1. JS 번들 빌드 + iOS 리소스 동기화.
echo "[ios] 1/5 ReactLynx bundle"
( cd "$APP_ROOT/app" && npm run build >/dev/null )
cp "$APP_ROOT/app/dist/index.lynx.bundle" "$IOS_DIR/app/Resources/app.lynx.js"
# capability(FileCap) 검증용 config.json — MobileBridge.read_file 이 NSBundle 에서 읽는다.
cp "$APP_ROOT/app/config.json" "$IOS_DIR/app/Resources/config.json"

# 2. Rust staticlib (aarch64-apple-ios-sim).
echo "[ios] 2/5 Rust staticlib"
"$HERE/modules/rustra-lynx/build-rust-ios.sh" >/dev/null 2>&1

# 3. Xcode 프로젝트 생성(xcodegen) + 의존성(pod install) — 산출물이 있으면 스킵.
echo "[ios] 3/5 xcodegen + pod install (없으면)"
( cd "$IOS_DIR" && [[ -d RustraTemplate.xcodeproj ]] || xcodegen >/dev/null )
( cd "$IOS_DIR" && pod install >/dev/null 2>&1 )

# 4. iOS 앱 빌드 + 설치 + 런치.
echo "[ios] 4/5 xcodebuild + install + launch"
( cd "$IOS_DIR" && xcodebuild \
    -workspace RustraTemplate.xcworkspace -scheme RustraTemplate \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$DEVICE_ID" \
    -derivedDataPath ./build build >/dev/null 2>&1 )

xcrun simctl uninstall booted "$APP_ID" 2>/dev/null || true
xcrun simctl install booted "$APP_BUNDLE"
xcrun simctl launch booted "$APP_ID" >/dev/null

# 5. rkyv 왕복이 로그에 나타날 때까지 폴링.
echo "[ios] 5/5 poll log for rkyv roundtrip"
for i in $(seq 1 45); do
  if xcrun simctl spawn booted log show --last 30s \
        --predicate 'process == "RustraTemplate"' 2>/dev/null \
        | grep -q "rkyv out"; then
    echo "    rkyv roundtrip at poll $i"
    break
  fi
  sleep 1
done

xcrun simctl io booted screenshot "$SHOT" >/dev/null 2>&1 && echo "[ios] screenshot: $SHOT"

# ── 결정적 게이트 — 로그 grep ───────────────────────────
LOGS="$(xcrun simctl spawn booted log show --last 120s \
          --predicate 'process == "RustraTemplate"' 2>/dev/null)"
pass=1
check() { if echo "$LOGS" | grep -qE "$2"; then echo "  [PASS] $1"; else echo "  [FAIL] $1  (pat: $2)"; pass=0; fi; }

check "1: bundle loaded (loadTemplate bytes>0)" 'template-ios\] loadTemplate .*bytes=[1-9]'
check "2: RustraModule registered" 'module: RustraModule registered'
check "3: rkyv in (greet req)"  'template-ios\] rkyv in bytes=[1-9]'
check "4: rkyv out (greet res)" 'template-ios\] rkyv out bytes=[1-9]'
check "5: MobileBridge registered (capability)" 'MobileBridge registered'
# FileCap 왕복: readConfig 가 NSBundle 의 config.json 을 읽으면 bytes 로그.
if echo "$LOGS" | grep -q 'bridge read_file.*bytes'; then
  echo "  [PASS] 6: FileCap roundtrip (bridge read_file bytes)"
else
  echo "  [FAIL] 6: FileCap roundtrip (bridge read_file bytes)"; pass=0
fi

if echo "$LOGS" | grep -q "Rustra not configured"; then
  echo "  [FAIL] 7: must NOT have 'Rustra not configured'"; pass=0
else
  echo "  [PASS] 7: no 'Rustra not configured' error"
fi

echo ""
if [[ $pass -eq 1 ]]; then
  echo "RESULT: iOS PASS — ReactLynx <-> Rust rkyv roundtrip (greet) on iOS Simulator"
  exit 0
else
  echo "RESULT: iOS FAIL — 최근 로그: xcrun simctl spawn booted log show --last 120s --predicate 'process == \"RustraTemplate\"'"
  exit 1
fi
