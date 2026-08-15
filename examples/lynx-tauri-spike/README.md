# Tauri × Lynx 데스크톱 스파이크 (macOS)

Tauri 2 윈도우 안에 Lynx 뷰를 임베딩하고(NSView `SetParent`), Rust rkyv
왕복을 수행하는지 증명한 데스크톱 스파이크입니다. macOS 7/7 PASS.

`runner/template/desktop/` 템플릿의 원형이 된 검증 자산입니다.

## 구조

```
lynx-tauri-spike/
├── src/                  ReactLynx 앱 (rspeedy 번들)
├── src-tauri/            Tauri 2 크레이트 — NSView/HWND 핸들 추출 + Lynx 호스트
├── build-lynx-host.sh    backend staticlib + src-tauri 빌드 + SpikeApp.app 조립
├── verify.sh             macOS 7패턴 자동 검증 게이트
└── verify-windows.ps1    Windows 게이트 (lynx_desktop_win.cpp 전제 — 미작성)
```

## 검증

```bash
bash verify.sh
```

전제: `LYNX_SDK`(기본 `/tmp/lynx-prebuilt/macsdk`).

결정적 증거 3그룹을 grep 합니다:

1. **윈도우 오픈** — `SetParent` + `init rc=0`
2. **ReactLynx 렌더링** — `on_first_screen` + `on_load_success`
3. **rkyv 왕복** — `invokeRkyvV2 ok=1` + `ackResult val=42` + `SUMMARY resultAcked=1`

시각 증거 대신 로그 기반 게이트라 디스플레이 캡처 권한에 의존하지 않습니다.

## Windows

`verify-windows.ps1`은 6패턴 게이트가 준비돼 있으나 실행 전제인
`lynx_desktop_win.cpp` 포팅이 남아 있습니다 — 크럭스는 FML 메시지 루프 펌프
심볼의 PE 해석입니다. `docs/plans/2026-08-12-lynx-windows-phase4.md`와
`runner/template/desktop/WINDOWS.md`를 참고하세요.

## 관련 문서

- `docs/plans/2026-08-11-tauri-lynx-desktop-spike.md` / `-result.md` — 스파이크 계획·결과
- `runner/template/desktop/` — 이 스파이크에서 정제된 데스크톱 셸 템플릿
