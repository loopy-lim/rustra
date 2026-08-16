# Changelog

이 프로젝트의 주요 변경사항을 기록합니다. 세부 내역은 git history와
`docs/plans/`의 계획/결과 문서를 참고하세요.

## Unreleased

### Added

- `rustra dev` CLI — Rust 소스 감시 + dual-path codegen 자동 재실행
  (hot codegen). mtime 기반 stale 판정으로 Rust bin/TS CLI 스테이지 선택적 실행,
  `--inspect` 플래그로 devtools 안내
- `@rustra/testing` 패키지 — `createMockEngine` (계약 동일 mock 엔진,
  `.on()` 체이닝 + 호출 기록) + `assertContractCurrent` 계약 게이트
- `@rustra/devtools` 패키지 — `createInstrumentedEngine` 호출 관측성 래퍼
  (명령별 count/errors/avgMs + 슬로우 콜 타임라인)
- `windows-experiment.yml` — lynx.dll export 덤프 + MSVC 빌드 시도 CI (P1 실험)
- `fuzz.yml` + `fuzz/` — cargo-fuzz `invoke_rkyv_v2` 디코드 경로 무작위 입력
  검증 (주 1회 10분 타임박스)
- codegen `Set<T>` 타입 지원 — Rust `BTreeSet`/`HashSet` (`uniqueItems`)이
  `Set<T>`로 매핑. postcard 코덱 `set_zigzag`/`set_f64`/`set_bool` kind
  (와이어는 vec와 호환), JSON 경로 Set replacer
- `RustraCommandError.retryable` — Rust `transport.error`/`transport.timeout`
  생성 에러의 재시도 가능 여부를 TypeScript에서 조회 가능
- `createAsyncEngine` (`@rustra/react-native`) — P0-3 async offload 엔진.
  네이티브 `invokeTypedAsync` 있으면 콜백 큐 경로, 없으면 동기 폴백
- `rustra init <dir>` CLI — 프로젝트 스캐폴딩 (Cargo + echo 예제 + codegen 스크립트)
- Windows desktop 스캐폴드 — `lynx_desktop_win.cpp` + `build.rs` 플랫폼 분기
  (FML 심볼 export/오프셋 확정은 Windows 머신 전제)
- `bench.yml` — criterion 벤치마크 회귀 감지 CI
- `release.yml` — changesets npm 자동 발행 + crates.io 수동 발행 잡
- `verify:desktop`/`verify:ios`/`verify:android` 런타임 게이트 스크립트 (package.json)

## 0.1.1 (2026-08-14)

npm `@rustra/*` 7종(types/cli/node/bun/tauri/react-native/lynx)과 crates.io
`rustra`/`rustra-macros` 첫 공개 발행.

### Added

- rkyv V2 무직렬화 경로 (`invoke_rkyv_v2`) — JSON 대비 15~83× 작은 와이어포맷
- RN JSI fast path + C++ 코덱 (`--cpp-output`) 생성
- Lynx 어댑터 (`@rustra/lynx`) — QuickJS 런타임 지원
- codegen Map/Tuple 타입 지원
- runtime command registry / 동적 rkyv 경로
- invokeBatch (P0-2) 배치 호출
- runner 템플릿 — desktop(macOS Tauri×Lynx) + iOS + Android 플랫폼 셸,
  `create-runner.sh` 인스턴스에이션, capability 계층(File/Notify/Mobile 브리지)
- 크로스 플랫폼 검증: macOS 7/7 · iOS 7/7 · Android 7/7 스파이크 PASS
- 벤치마크: 어댑터/transport/온디바이스 실측 (iOS Direct C++ 0.95µs — Nitro 1.10µs 대비 우위)
- FFI trust hardening — 패닉 격리(catch_unwind), debug allocation tracker,
  null out_len 가드, contract hash 검증

### Changed

- 저장소 URL을 `loopy-lim/rustra` → `loopy-lim/hostra`로 정리

## 0.1.0 (2026-05-13)

초기 버전 — Rust macros(`#[command]`/`#[bridge_type]`/`build!`), codegen 파이프라인,
Node/Bun/Tauri/RN 어댑터.
