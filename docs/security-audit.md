# 보안 감사 (cargo audit) 상태

최종 확인: 2026-08-19 — **취약점(vulnerabilities) 0 / 4개 lockfile 전부**

## 게이트 정책

- `cargo audit`의 **취약점은 CI 게이트**로 실패 조건 (`.github/workflows/ci.yml` `rust-audit` 잡).
- **unmaintained/unsound 경고는 게이트에서 제외** — 아래 표의 경로가 전부 third-party
  transitive 이고 대체 수단이 상류 업스트림 릴리스에 의존하기 때문. 경고 목록이 바뀌면
  이 문서를 갱신한다.

## Lockfile별 상태

| Lockfile            | 취약점 | 경고                |
| ------------------- | ------ | ------------------- |
| 루트 (`Cargo.lock`) | 0      | 20 (아래 표)        |
| `fuzz/Cargo.lock`   | 0      | 1 (atomic-polyfill) |

(과거 `runner/template/backend`·`runner/template/desktop` lockfile 감사 항목은
runner/ 가 Lynx 제거로 삭제되어 제거됨 — 2026-08-20.)

## 해소 이력 (2026-08-19)

| 항목            | 이전   | 이후   | RUSTSEC                                           |
| --------------- | ------ | ------ | ------------------------------------------------- |
| rkyv            | 0.8.16 | 0.8.18 | 2026-0233, 2026-0234, 2026-0235 (메모리 안전 3건) |
| quick-xml       | 0.39.4 | 0.41.0 | 2026-0194, 2026-0195 (DoS 2건)                    |
| crossbeam-epoch | 0.9.18 | 0.9.20 | 2026-0204 (포인터 역참조)                         |
| plist           | 1.9.0  | 1.10.0 | (quick-xml 상승의 전제)                           |

rkyv 직접 의존은 `examples/calculator`(RN 네이티브 경로)뿐이며 `crates/rustra`
코어는 rkyv crate에 의존하지 않는다 (serde_json 기반 수동 rkyv V2 와이어 구현).

## 남아있는 경고 (unmaintained/unsound)와 경로

| 크레이트                                                                                    | 경고 유형            | 유입 경로                               |
| ------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------- |
| atk, atk-sys, gdk, gdk-sys, gdkwayland-sys, gdkx11, gdkx11-sys, gtk, gtk-sys 외 gtk-rs 계열 | unmaintained         | tauri → gtk-rs (Linux 전용 렌더 호스트) |
| atomic-polyfill                                                                             | unmaintained         | crossbeam 계열 경유                     |
| bincode                                                                                     | unmaintained         | tauri 코드체인지 경유                   |
| 기타 루트 lock 경고 (총 20)                                                                 | unmaintained/unsound | 주로 tauri/criterion dev 경로           |

이 경로들은 배포 아티팩트(npm/crates 패키지)의 런타임 의존에 해당하지 않는다:

- gtk-rs 계열은 `rustra-tauri-calculator` 예제가 Linux에서만 링크
- criterion 은 `crates/rustra` dev-dependencies (벤치 전용)
- tauri 자체가 examples 전용
