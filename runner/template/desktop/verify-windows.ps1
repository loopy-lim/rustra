# rustra runner 템플릿 - Windows 데스크톱 자동 검증 (run.sh 의 Windows 대응).
# 스파이크 examples/lynx-tauri-spike/verify-windows.ps1 에서 정제 추출.
#
# 단일 ReactLynx 번들 + 단일 rustra rkyv 백엔드가 Windows 에서 Tauri window 안에
# Lynx surface(SetParent HWND) 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제 (Windows 머신에서 수행):
#   1. Visual Studio Build Tools (MSVC) + Windows SDK 설치.
#   2. `lynx_sdk_windows_x64.zip` 해제 → LYNX_SDK_WIN 환경변수 (lynx.dll/.dll.lib/include 포함 디렉토리).
#      다운로드: gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_windows_x64.zip
#   3. rustup target add x86_64-pc-windows-msvc
#   4. 호스트 C++ 의 Windows 포팅(lynx_desktop_win.cpp) 이 완료되어야 함 —
#      핵심 크럭스: FML 메시지 루프 펌프 심볼 해석(GetProcAddress 정식 해결 시도 → PE 오프셋 fallback).
#      상세: desktop/WINDOWS.md 및 docs/plans/2026-08-12-lynx-windows-phase4.md "포인트 3".
#
# macOS 에선 실행 불가 (MSVC/PE 검증 불가) — 본 스크립트는 Windows 환경 전용.
#
# 결정적 stderr 증거(run.sh 과 동일 게이트 + Windows 전용 FML 라인):
#   1. native window handle = 0x... Lynx SetParent   — HWND 획득 + SetParent
#   2. lynx_template_init rc=0                        — Lynx env/view 빌드 성공
#   3. on_first_screen / on_load_success              — ReactLynx 렌더링
#   4. invokeRkyvV2: in=N out=M ok=1                  — rkyv V2 왕복
#   5. SUMMARY resultAcked>=1                         — 왕복 확정
#
# 사용: powershell -ExecutionPolicy Bypass -File verify-windows.ps1
[CmdletBinding()]
param(
    [string]$Bundle = "",                         # 기본: ../../app/dist/index.lynx.bundle
    [int]$RunSeconds = 12,
    [string]$LogPath = "$env:TEMP\rustra-template-windows-verify.log"
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplateRoot = Split-Path -Parent $Here
Set-Location $Here

function Check($label, $pattern, $log) {
    if ($log -match $pattern) { Write-Host "  [PASS] $label"; return 1 }
    else { Write-Host "  [FAIL] $label  (pat: $pattern)"; return 0 }
}

Write-Host "== 1/4 ReactLynx bundle (rspeedy)"
Push-Location "$TemplateRoot\app"
npm run build *> $null
Pop-Location
if (-not $Bundle) { $Bundle = Resolve-Path "$TemplateRoot\app\dist\index.lynx.bundle" }

Write-Host "== 2/4 host build (MSVC + lynx.dll.lib)"
# Rust backend staticlib (MSVC target) — 템플릿 backend 는 독립 workspace.
cargo build --release --manifest-path "$TemplateRoot\backend\Cargo.toml" --target x86_64-pc-windows-msvc *> $null
# Tauri app (.exe) — build.rs 가 lynx_desktop_win.cpp 를 lynx.dll.lib 와 링크.
cargo build --release --manifest-path "$Here\src-tauri\Cargo.toml" *> $null
$exe = "$Here\src-tauri\target\release\rustra-template-desktop.exe"
if (-not (Test-Path $exe)) {
    $exe = Get-ChildItem -Path "$Here\src-tauri\target" -Recurse -Filter "rustra-template-desktop.exe" |
           Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path $exe)) { throw "template .exe not found — Windows C++ host 포팅(lynx_desktop_win.cpp) 필요: desktop/WINDOWS.md" }

# lynx.dll 이 .exe 와 같은 디렉토리에 있어야 로드됨.
$lynxSdk = $env:LYNX_SDK_WIN
if (-not $lynxSdk) { throw "LYNX_SDK_WIN 환경변수 미설정 (lynx_sdk_windows_x64.zip 해제 경로)" }
Copy-Item "$lynxSdk\lib\lynx.dll" (Split-Path $exe) -Force -ErrorAction SilentlyContinue

Write-Host "== 3/4 run .exe (~${RunSeconds}s, capture stderr)"
$env:LYNX_BUNDLE = $Bundle
$env:LYNX_SDK = $lynxSdk
$env:LYNX_ICU = "$lynxSdk\data\icudtl.dat"
# .exe 를 백그라운드로 실행 후 타임아웃 kill. stderr 를 로그로 캡처.
$proc = Start-Process -FilePath $exe -RedirectStandardError $LogPath -PassThru -NoNewWindow
Start-Sleep -Seconds $RunSeconds
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

Write-Host "== 4/4 check success criteria"
$log = Get-Content $LogPath -Raw
$pass = 0

$pass += Check "1: window open (native handle SetParent)" 'native window handle = 0x[0-9a-f]+ .* Lynx SetParent' $log
$pass += Check "1: window open (lynx_template_init rc=0)" 'lynx_template_init rc=0' $log
$pass += Check "2: ReactLynx render (on_first_screen)" 'on_first_screen' $log
$pass += Check "2: ReactLynx render (on_load_success)" 'on_load_success' $log
$pass += Check "3: rkyv invoke ok" 'invokeRkyvV2: in=[0-9]+ out=[0-9]+ ok=1' $log
$pass += Check "3: SUMMARY resultAcked>=1" 'SUMMARY .* resultAcked=[1-9][0-9]*' $log

Write-Host ""
if ($pass -eq 6) {
    Write-Host "RESULT: Windows template PASS — ReactLynx <-> Rust rkyv roundtrip on Windows (Tauri SetParent HWND)"
    exit 0
} else {
    Write-Host "RESULT: Windows template FAIL ($pass/6) — 로그: $LogPath"
    exit 1
}
