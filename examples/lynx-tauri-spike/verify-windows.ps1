# rustra-bridge x Lynx x Tauri Windows spike - 자동 검증 (verify.sh 의 Windows 대응).
#
# 단일 ReactLynx 번들 + 단일 rustra rkyv 백엔드가 Windows 에서 Tauri window 안에
# Lynx surface(SetParent HWND) 로 렌더링 + addNumbers rkyv 왕복(결과 42) 을 증명한다.
#
# ⚠️ 전제 (Windows 머신에서 수행):
#   1. Visual Studio Build Tools (MSVC) + Windows SDK 설치.
#   2. `lynx_sdk_windows_x64.zip` 해제 → LYNX_SDK_WIN 환경변수 (lynx.dll/.dll.lib/include 포함 디렉토리).
#      다운로드: gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_windows_x64.zip
#   3. rustup target add x86_64-pc-windows-msvc
#   4. 호스트 C++ 의 Windows 포팅(lynx_desktop_win.cpp) 이 완료되어야 함 —
#      핵심 크럭스: FML 메시지 루프 펌프 심볼 해석(GetProcAddress 정식 해결 시도 → PE 오프셋 fallback).
#      상세: docs/plans/2026-08-12-lynx-windows-phase4.md "포인트 3".
#
# macOS 에선 실행 불가 (MSVC/PE 검증 불가) — 본 스크립트는 Windows 환경 전용.
#
# 결정적 stderr 증거(verify.sh 과 동일 게이트):
#   1. native window handle = 0x... Lynx SetParent   — HWND 획득 + SetParent
#   2. lynx_spike_init rc=0                          — Lynx env/view 빌드 성공
#   3. on_first_screen / on_load_success             — ReactLynx 렌더링
#   4. invokeRkyvV2: in=4 out=9 ok=1                 — rkyv V2 왕복
#   5. ackResult val=42                              — JS→host ack
#   6. SUMMARY resultAcked=1 val=42                  — 왕복 확정
#
# 사용: powershell -ExecutionPolicy Bypass -File verify-windows.ps1
[CmdletBinding()]
param(
    [string]$Bundle = "",                         # 기본: ../dist/index.lynx.bundle
    [int]$RunSeconds = 12,
    [string]$LogPath = "$env:TEMP\rustra-spike-windows-verify.log"
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

function Check($label, $pattern, $log) {
    if ($log -match $pattern) { Write-Host "  [PASS] $label"; return 1 }
    else { Write-Host "  [FAIL] $label  (pat: $pattern)"; return 0 }
}

Write-Host "== 1/4 ReactLynx bundle (rspeedy)"
npm run build *> $null
if (-not $Bundle) { $Bundle = Resolve-Path "$Here\..\dist\index.lynx.bundle" }

Write-Host "== 2/4 host build (MSVC + lynx.dll.lib)"
# Rust staticlib (MSVC target)
cargo build -p rustra-calculator-example --release --target x86_64-pc-windows-msvc *> $null
# Tauri app (.exe) — build.rs 가 lynx_desktop_win.cpp 를 lynx.dll.lib 와 링크.
cargo build --release --manifest-path "$Here\src-tauri\Cargo.toml" *> $null
$exe = "$Here\src-tauri\target\x86_64-pc-windows-msvc\release\rustra-lynx-tauri-spike.exe"
if (-not (Test-Path $exe)) {
    $exe = Get-ChildItem -Path "$Here\src-tauri\target" -Recurse -Filter "rustra-lynx-tauri-spike.exe" |
           Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path $exe)) { throw "spike .exe not found — Windows C++ host 포팅(lynx_desktop_win.cpp) 필요" }

# lynx.dll 이 .exe 와 같은 디렉토리에 있어야 로드됨.
$lynxSdk = $env:LYNX_SDK_WIN
if (-not $lynxSdk) { throw "LYNX_SDK_WIN 환경변수 미설정 (lynx_sdk_windows_x64.zip 해제 경로)" }
Copy-Item "$lynxSdk\lib\lynx.dll" (Split-Path $exe) -Force -ErrorAction SilentlyContinue

Write-Host "== 3/4 run .exe (~${RunSeconds}s, capture stderr)"
$env:LYNX_BUNDLE = $Bundle
$env:LYNX_SDK = $lynxSdk
$env:LYNX_ICU = "$lynxSdk\data\icudtl.dat"
$env:RUST_LOG = "info"
# .exe 를 백그라운드로 실행 후 타임아웃 kill. stderr 를 로그로 캡처.
$proc = Start-Process -FilePath $exe -RedirectStandardError $LogPath -PassThru -NoNewWindow
Start-Sleep -Seconds $RunSeconds
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

Write-Host "== 4/4 check success criteria"
$log = Get-Content $LogPath -Raw
$pass = 0

$pass += Check "1: window open (native handle SetParent)" 'native window handle = 0x[0-9a-f]+ .* Lynx SetParent' $log
$pass += Check "1: window open (lynx_spike_init rc=0)" 'lynx_spike_init rc=0' $log
$pass += Check "2: ReactLynx render (on_first_screen)" 'on_first_screen' $log
$pass += Check "2: ReactLynx render (on_load_success)" 'on_load_success' $log
$pass += Check "3: rkyv invoke ok" 'invokeRkyvV2: in=[0-9]+ out=[0-9]+ ok=1' $log
$pass += Check "3: rkyv result acked 42" 'ackResult val=42' $log
$pass += Check "3: SUMMARY resultAcked=1 val=42" 'SUMMARY .* resultAcked=1 val=42' $log

Write-Host ""
if ($pass -eq 7) {
    Write-Host "RESULT: Windows spike PASS — ReactLynx <-> Rust rkyv roundtrip on Windows (Tauri SetParent HWND)"
    exit 0
} else {
    Write-Host "RESULT: Windows spike FAIL ($pass/7) — 로그: $LogPath"
    exit 1
}
