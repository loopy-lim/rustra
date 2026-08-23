# 보안 감사 (cargo audit) 상태

최종 확인: 2026-08-23 — **취약점 0 / 처리 가능한 경고 0**

## 게이트 정책

- `scripts/audit-rust.sh`는 취약점뿐 아니라 **새 unmaintained/unsound/yanked 경고도
  실패**시킨다 (`cargo audit --deny warnings`). 루트와 `fuzz/Cargo.lock`을 모두 검사한다.
- Tauri 2의 현재 Linux 런타임이 피할 수 없이 포함하는 GTK3/rust-unic 17건만 정확한
  RUSTSEC ID로 예외 처리한다. 예외 밖의 새 경고는 자동으로 통과할 수 없다.
- 이 예외는 업스트림 교체 대기 목록이다. Tauri가 GTK4/glib 0.20+ 경로를 제공하거나
  `tauri-utils`가 rust-unic을 제거하면 해당 ID를 즉시 삭제한다.

## Lockfile별 상태

| Lockfile            | 취약점 | 처리 가능한 경고 | 업스트림 예외      |
| ------------------- | ------ | ---------------- | ------------------ |
| 루트 (`Cargo.lock`) | 0      | 0                | 17 (Tauri 2, 아래) |
| `fuzz/Cargo.lock`   | 0      | 0                | 0                  |

(과거 `runner/template/backend`·`runner/template/desktop` lockfile 감사 항목은
runner/ 가 Lynx 제거로 삭제되어 제거됨 — 2026-08-20.)

## 해소 이력

| 항목            | 이전    | 이후         | RUSTSEC                                           |
| --------------- | ------- | ------------ | ------------------------------------------------- |
| rkyv            | 0.8.16  | 0.8.18       | 2026-0233, 2026-0234, 2026-0235 (메모리 안전 3건) |
| quick-xml       | 0.39.4  | 0.41.0       | 2026-0194, 2026-0195 (DoS 2건)                    |
| crossbeam-epoch | 0.9.18  | 0.9.20       | 2026-0204 (포인터 역참조)                         |
| plist           | 1.9.0   | 1.10.0       | quick-xml 상승의 전제                             |
| anyhow          | 1.0.102 | 1.0.103 이상 | 2026-0190 (downcast_mut soundness)                |
| atomic-polyfill | 포함    | 제거         | 2023-0089 (Postcard 기본 heapless-cas 비활성화)   |
| bincode         | 2.0.1   | 제거         | 2025-0141 (필요한 v2 와이어를 자체 코덱으로 보존) |

rkyv 직접 의존은 `examples/calculator`(RN 네이티브 경로)뿐이며 `crates/rustra`
코어는 rkyv crate에 의존하지 않는다 (serde_json 기반 수동 rkyv V2 와이어 구현).

## Tauri 2 업스트림 예외와 경로

| 크레이트                                                                                  | 경고 유형    | 유입 경로                                |
| ----------------------------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| atk, atk-sys, gdk, gdk-sys, gdkwayland-sys, gdkx11, gdkx11-sys, gtk, gtk-sys, gtk3-macros | unmaintained | tauri → GTK3 (Linux 렌더 호스트)         |
| proc-macro-error                                                                          | unmaintained | gtk/glib 매크로 경유                     |
| unic-char-property, unic-char-range, unic-common, unic-ucd-ident, unic-ucd-version        | unmaintained | tauri-utils 식별자 검증 경유             |
| glib 0.18.5                                                                               | unsound      | tauri → GTK3; VariantStrIter 함수군 한정 |

GTK3 경로는 Tauri Linux 호스트 런타임에 해당하므로 단순히 삭제할 수 없다. 현재 Tauri
2.11.x도 동일한 의존성을 배포하며, GTK4 전환은 Tauri/Wry 업스트림 작업이다. rust-unic
경로는 `tauri-utils`의 빌드/설정 파싱 경로다.

영향 범위:

- gtk-rs 계열은 `rustra-tauri-calculator` 예제가 Linux에서 링크
- Rustra의 기본 FFI/JSI/N-API 배포물에는 Tauri 기능이 기본 활성화되지 않음
- `glib::VariantStrIter`는 Rustra 또는 Tauri 어댑터 코드에서 직접 호출하지 않음

예외 ID는 `scripts/audit-rust.sh` 한 곳에서 관리하며, cargo-audit 게이트에서는
임의 패키지명이나 광범위한 경고 비활성화 정책으로 우회하지 않는다.
