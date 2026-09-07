# 경쟁 프로젝트 비교 분석 (2026-09-07)

상태: complete. 조사 방법 — rustra-bridge 는 로컐 저장소 문서/코드 직접 확인,
경쟁 6종(Tauri 2, flutter_rust_bridge v2, UniFFI, napi-rs, NitroModules,
wasm-bindgen)은 공식 문서/저장소 기준. 문서에 없는 사항은 "미공개(unknown)"로
명시(존재하지 않아서가 아닐 수 있음).

## 전체 비교

### DX

| 축          | rustra                                                                        | Tauri 2 (+specta)                  | flutter_rust_bridge v2       | UniFFI                               | napi-rs                          | NitroModules                                       | wasm-bindgen                    |
| ----------- | ----------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- | ------------------------------------ | -------------------------------- | -------------------------------------------------- | ------------------------------- |
| 코드젠      | schema.json 단일 소스 → TS+C++, commands+events 양방향                        | 본체 없음(수동). tauri-specta 보조 | 폴더 스캔, enum→sealed class | UDL+proc-macro → Kotlin/Swift/Python | v2부터 .d.ts+JS 자동             | TS 스펙 → Swift/Kotlin(Nitrogen), 컴파일 타임 강제 | TS 바인딩 + web-sys 전체 바인딩 |
| 에러 타입화 | 제네릭 `RustraCommandError{code,message}`                                     | `Result<T,E>` 수동 패턴            | Dart 타입화 예외             | enum → 각 언어 예외 생성             | `napi::Error` + cause 체인       | 가이드 존재(상세 미공개)                           | `catch` 속성 → `Result`         |
| 개발 도구   | dev/doctor/diff/`--check` 드리프트 게이트 + 문서 동기화 CI + 온보딩 CI 게이트 | 프론트 HMR, 코드젠 게이트 없음     | create 원라이너 + watch 옵션 | 빌드 통합                            | `napi build` CLI + GitHub Action | 라이브러리 개발 시점 생성                          | wasm-pack + wasm-bindgen-test   |
| 문서/온보딩 | 영/한 이중어 + 문서-현실 동기화 CI                                            | 방대 + 모바일 가이드               | 매우 방대                    | 가이드 존재                          | 충실                             | 충실 + 비교표                                      | 충실                            |

### 성능

| 축       | rustra                                                                                | Tauri 2                | FRB                       | UniFFI             | napi-rs                                              | Nitro                                                                                 | wasm-bindgen                              |
| -------- | ------------------------------------------------------------------------------------- | ---------------------- | ------------------------- | ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| 와이어   | rkyv V2 3티어(패스트패스→복합 바이너리→JSON) + caller-buffer                          | JSON 기본 + Raw 탈출구 | 기본 제로카피 + 멀티 코덱 | 미공개             | JS 객체 직접(N-API)                                  | JSI 객체 직접                                                                         | JsValue 직접; JSON 왕복은 ~10배 느림 보고 |
| 제로카피 | 부분(핸들·caller-buffer·`Vec<u8>` ArrayBuffer)                                        | Raw 바디               | 자동 제로카피 기본        | 미공개             | zero-copy 버퍼                                       | JSI NativeState                                                                       | `&mut [u8]` 뷰                            |
| 벤치마크 | 수령증 기반: Node 1.26µs/793k ops/s, Bun 2.27µs, RN JSI p50 2.71µs (Nitro 대비 ~1.0x) | 미제시                 | CI 벤치마크 명시          | 미공개             | 미공개                                               | NitroBenchmarks: Nitro 7.27ms vs Turbo 115.86ms vs Expo 434.85ms (10만 회 addNumbers) | 경계 비용 이슈 문서화                     |
| 비동기   | waker 실행자 + 고정 풀 + 백프레셔 + AbortSignal 의 Rust 체크포인트 전파               | async_runtime::spawn   | async/sync 4모드          | 코루틴/Swift async | libuv Task + ThreadsafeFunction(개시 후 취소 미보장) | Promise + **동기 메서드 가능**                                                        | Future                                    |

### 구조 안정성

| 축               | rustra                                                                    | Tauri 2                                                    | FRB                          | UniFFI              | napi-rs                                          | Nitro                       | wasm-bindgen         |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------- | ------------------- | ------------------------------------------------ | --------------------------- | -------------------- |
| 계약 버전 관리   | **컨트랙트 해시 + `rustra diff` CI + OTA alias 협상**                     | 없음                                                       | v1→v2 마이그레이션 가이드    | 가이드 수준         | Node-API ABI 안정                                | 미공개                      | 컴포넌트 모델 방향성 |
| 런타임 계약 검증 | **JS/native 해시 불일치 검출**                                            | 없음                                                       | 미공개                       | 미공개              | 미공개                                           | 빌드 타임 스펙 강제         | 없음                 |
| 플랫폼 매트릭스  | Node/Bun/Tauri/RN(iOS·Android) + 증거 수준 표                             | 데스크톱 3종 + 모바일(성숙도 논쟁)                         | 모바일+데스크톱+**웹(WASM)** | Kotlin/Swift/Python | 데스크톱+Android+**WASM(WASI)**, Bun best-effort | iOS/Android, 구/신 아키텍처 | 브라우저 전체        |
| 보안/권한        | 커맨드 단위 deny-by-default capability + 공개 위협 모델                   | 윈도우/플러그인 ACL(**앱 자체 커맨드는 allow-by-default**) | 미공개                       | 없음                | 미공개                                           | 미공개                      | 미공개               |
| 테스트 인프라    | mock 엔진 + 컨트랙트 게이트 + 3-OS CI + 주간 fuzz/miri + cargo audit/deny | 자체                                                       | CI 벤치마크 명시             | 픽스처 기반         | CI(Node 3버전)                                   | 미공개                      | 헤드리스 브라우저 CI |

## 격차 Top 10 (가치순)

1. **웹/WASM 호스트 부재** — 가장 큰 시장 공백(FRB·napi-rs·wasm-bindgen 대비).
2. **커맨드별 타입화 에러 코드젠** — 경쟁 대부분이 에러를 타입으로 노출, rustra 는 제네릭 `{code,message}` → string 비교 분기. 구현 비용 대비 가치 최고.
3. **동기 호출 경로** — Nitro 는 동기 반환 지원. rustra 는 모든 invoke 가 Promise → **RN `invokeTypedSync` 로 부분 해소(2026-09-07 착지)**.
4. **역방향 콜백 인터페이스(반환값 있는 JS 함수)** — UniFFI callback_interface/Nitro 반환값 있는 콜백 대비, rustra 채널은 유니캐스트 응답뿐.
5. **메서드·프로퍼티 객체 핸들** — FRB RustAutoOpaque/Nitro HybridObject/UniFFI Object 대비, Resource 는 read/write/close 프리미티브만.
6. **생태계 검증** — napi-rs(Rolldown/SWC 채택)·Nitro(mmkv 등)·Tauri(플러그인 시장) 대비 초기. npm 어드바이저리 게이트 부재는 위협 모델 공개 결함.
7. **int64/BigInt 기본 정확성** — Nitro 전용 타입·napi-rs BigInt 지원 대비 `number` 기본 매핑(2^53 조건부).
8. **CI 연속 벤치마크 게이트** — FRB "benchmarked on CI"/Nitro 공개 벤치마크 저장소 대비 재현 스크립트만 존재.
9. **경계 디버깅 심도** — napi-rs 스택 보존/비동기 트레이스 대비 역추적 의도적 미탑재(위협 모델), devtools 실험 단계.
10. **다언어 바인딩** — UniFFI 퍼스트파티 Kotlin/Swift/Python 대비 TS 단일.

## rustra 가 앞선 부분

1. 컨트랙트 해시 + `rustra diff` + 드리프트 게이트 — **런타임 계약 검증을 문서화한 경쟁자는 없음**.
2. OTA 협상(`alias_command_id`, `schema_version`, `onContractMismatch`).
3. 커맨드 단위 deny-by-default capability(Tauri 는 앱 커맨드 allow-by-default).
4. 단일 Rust 코어 × 4호스트 동일 계약(napi-rs Bun best-effort, Nitro RN 전용과 대조).
5. 3티어 자동 와이어 라우팅 + 호스트별 검증 게이트(PINNED hex wire).
6. 취소 의미론 — AbortSignal 의 Rust 체크포인트 전파(napi-rs "개시 후 취소 미보장", Tauri 미문서화와 대조).
7. 정직한 증거 기반 벤치마크(수령증·trimmed mean·증거 수준 표) — 마케팅 벤치마크와 대조.
8. 공개 위협 모델 + 버전닝 정책 + 실험 표면 표.
9. 문서-현실 동기화 CI 게이트 + 온보딩 게이트 + doctor — 어느 경쟁자에도 없는 관행.
10. 디코더 대상 주간 fuzz + miri.

## 종합

차별점은 "RPC 표면 전체(정의→코드젠→와이어→검증)를 단일 계약으로 소유"하는 수직
통합. 시급 격차는 (1) WASM, (2) 타입화 에러, (3) 동기 경로*, (4) 역방향 콜백 —
이 중 3번은 RN 표면으로 부분 착지. 다음 안정화 트랙 후보로 **타입화 에러**(성비
최고)와 **역방향 콜백**(채널 인프라 재사용 가능)을 권장.

주요 출처: [Tauri calling-rust](https://v2.tauri.app/develop/calling-rust/),
[Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[tauri-specta](https://github.com/specta-rs/tauri-specta),
[FRB 문서](https://cjycode.com/flutter_rust_bridge/),
[FRB zero-copy](https://cjycode.com/flutter_rust_bridge/guides/types/translatable/zero-copy),
[UniFFI 가이드](https://mozilla.github.io/uniffi-rs/latest/),
[napi.rs](https://napi.rs/),
[napi-rs error-handling](https://napi.rs/docs/concepts/error-handling),
[Nitro 비교](https://nitro.margelo.com/docs/resources/comparison),
[serde-wasm-bindgen](https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/),
[wasm-bindgen](https://rustwasm.github.io/docs/wasm-bindgen/introduction.html).
