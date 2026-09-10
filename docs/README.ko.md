[English](./README.md)

# rustra 문서

rustra는 Rust 패키지를 한 번 정의하면 host-neutral TypeScript 클라이언트를 자동 생성하는 브릿지 프레임워크다.

## 읽기 경로

### 라이브러리 사용자

1. [시작하기](getting-started.md) — 설치 및 첫 패키지 만들기
2. [아키텍처 개요](architecture.md) — 전체 구조와 핵심 개념 파악
3. [이벤트·채널](events-and-channels.md) — Rust → JS 푸시: `subscribeEvent`, `createChannel`
4. [개발 허들 가이드](development-hurdles.md) — doctor, 통합 codegen, drift, native 경계, mock 엔진
5. [Rust API 가이드](rust-api-guide.md) — 매크로/Builder 전체 레퍼런스
6. [React Native 셋업](extending/react-native-setup.md) — JSI 네이티브 모듈 연결 (iOS/Android)
7. [Tauri 셋업](extending/tauri-setup.md) — 기존 Tauri 앱에 rustra 얹기
8. [Transport 교체 가이드](extending/transport-guide.md) — Bun FFI, Node napi-rs 등 transport 교체
9. [새 Host 추가 가이드](extending/adding-host.md) — Electron, Deno 등 새 host adapter 추가
10. [동적 개발 티어](dev-tier.ko.md) — loose invoke 프로토타이핑, 디바이스 토큰 실험, `test:fast`

### 프로젝트 기여자

1. [아키텍처 개요](architecture.md) — 전체 구조와 핵심 개념 파악
2. [Crate 및 Package 구조](internal/crate-structure.md) — 각 crate/package의 책임과 의존성
3. [TypeScript 코드 생성](internal/codegen.md) — schema → TS 타입 매핑, command 이름 변환
4. [테스트 구조](internal/testing.md) — 테스트 계층, 파일별 역할, 실행 명령어

## 전체 문서 목록

| 문서                                                                               | 대상   | 내용                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [아키텍처 개요](architecture.md)                                                   | 전체   | 데이터 흐름, EngineClient 계약, transport 분리 원칙                                                                                                |
| [시작하기](getting-started.md)                                                     | 사용자 | 설치, 최소 예제, TS 통합, 에러 처리, adapter 선택, 실행                                                                                            |
| [이벤트·채널](events-and-channels.md)                                              | 사용자 | `.event::<T>` 선언, 생성 `events.ts`, 호스트별 `subscribeEvent`/`createChannel`                                                                    |
| [개발 허들 가이드](development-hurdles.md)                                         | 사용자 | doctor, 통합 codegen/dev, drift 게이트, native/prebuilt 경계, mock 엔진, CLI 형태                                                                  |
| [Transport 교체 가이드](extending/transport-guide.md)                              | 사용자 | Bun FFI, Node napi-rs 교체, 선택 기준                                                                                                              |
| [React Native 셋업](extending/react-native-setup.md)                               | 사용자 | JSI 네이티브 모듈, iOS/Android 빌드, BenchmarkApp                                                                                                  |
| [Tauri 셋업](extending/tauri-setup.md)                                             | 사용자 | 기존 Tauri 앱에 rustra 얹기 — 변경 5개 파일을 순서대로                                                                                             |
| [새 Host 추가 가이드](extending/adding-host.md)                                    | 사용자 | adapter 만들기, Rust 진입점 선택, 테스트 추가                                                                                                      |
| [동적 개발 티어](dev-tier.ko.md) ([English](dev-tier.md))                          | 사용자 | `invokeLoose` 프로토타이핑, 카탈로그 밖 토큰 실험, 게이트 프로파일                                                                                 |
| [Crate 및 Package 구조](internal/crate-structure.md)                               | 기여자 | 각 crate/package 책임, 빌드 의존성                                                                                                                 |
| [TypeScript 코드 생성](internal/codegen.md)                                        | 기여자 | codegen 파이프라인, 타입 매핑, 제한사항                                                                                                            |
| [테스트 구조](internal/testing.md)                                                 | 기여자 | 테스트 계층, 스크립트 체인, host별 상태                                                                                                            |
| [호환성 계약](compatibility-contract.ko.md) ([English](compatibility-contract.md)) | 기여자 | EngineClient 안정 계약, runtime acceptance gates                                                                                                   |
| [호환성 매트릭스](compatibility-matrix.md)                                         | 사용자 | 기능(signal/취소/배치/이벤트) × 어댑터 지원 표                                                                                                     |
| [와이어 포맷](wire-format.ko.md)                                                   | 전체   | "rkyv V2/postcard"의 실체, 티어별 바이트, 수치 인용 규칙                                                                                           |
| [검증 체크리스트](verification-checklist.ko.md)                                    | 기여자 | 증거 수준 표를 뒷받침하는 호스트별 수동 검증 기록 양식                                                                                             |
| [계약 마이그레이션 가이드](migration-guide.md)                                     | 전체   | 스키마 breaking change 검출(rustra diff)·해결 레시피·롤아웃 순서                                                                                   |
| [마이그레이션 노트](migrations/0.3-to-0.4.md), [0.5→0.6](migrations/0.5-to-0.6.md) | 사용자 | rustra 마이너 버전을 건너뛸 때의 단계별 노트                                                                                                       |
| [Rust API 가이드](rust-api-guide.md)                                               | 사용자 | `#[command]`/`#[bridge_type]`/`build!` 매크로, Package/Builder API                                                                                 |
| [벤치마크](benchmarks.md)                                                          | 전체   | 어댑터별 성능 비교, 오버헤드 분석, 페이로드 확장성                                                                                                 |
| [복잡 데이터 codec](complex-codecs.md)                                             | 사용자 | recursive map/enum/Option wire, limits, RN 경계                                                                                                    |
| [플랫폼 권한 가이드](platform-permissions.md)                                      | 사용자 | 플랫폼별 OS 권한 소관(iOS/Android/Windows/macOS), Tauri ACL vs rustra capability, 디바이스 역량 계약(`#[command(device(...))]`, `getDeviceStatus`) |
| [위협 모델](threat-model.md)                                                       | 기여자 | STRIDE 분석, 신뢰 경계, 코드 기반 완화 매핑, 미해결 간극                                                                                           |
| [보안 감사](security-audit.md)                                                     | 기여자 | lockfile 취약점/경고 상태, 해소 이력                                                                                                               |
| [릴리즈 절차](release-procedure.md)                                                | 기여자 | changeset 발행 절차, 버전 관리                                                                                                                     |
| [버전 정책](versioning-policy.md)                                                  | 전체   | 표면별 호환성 보장, 폐기 절차, MSRV, 실험 표면                                                                                                     |
| [보안 정책](../.github/SECURITY.md)                                                | 전체   | 취약점 신고 채널, 지원 버전, 스코프                                                                                                                |
| [기여 가이드](../CONTRIBUTING.md)                                                  | 기여자 | 개발 환경, 커밋 규칙, 디버깅, 릴리즈                                                                                                               |

## 예제 갤러리

실행 가능한 예제 10개가 [`examples/`](../examples/)에 있다 — 각자 README(en/ko)에
전제 조건과 실행 명령이 있다.

| 예제                                                                        | 무엇을 배우는지                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`calculator`](../examples/calculator/)                                     | 기준선: 명령, 계약 프로브, stdio/FFI 바이너리, 전체 생성 엔트리                 |
| [`crud`](../examples/crud/)                                                 | 리소스 패턴: 하나의 스키마로 create/get/list/update/delete                      |
| [`streaming`](../examples/streaming/)                                       | Rust → JS 이벤트: `.event::<T>()` + `Package::emit` + 호스트별 `subscribeEvent` |
| [`auth`](../examples/auth/)                                                 | deny-by-default capability 게이트(`require_capability` + 런타임 부여)           |
| [`tauri-calculator`](../examples/tauri-calculator/)                         | 실제 Tauri WebView 빌드 — IPC, 푸시 이벤트, 성능 영수증                         |
| [`react-native-calculator`](../examples/react-native-calculator/)           | autolinked JSI 패키지의 Expo development build (iOS/Android)                    |
| [`react-native-bare-calculator`](../examples/react-native-bare-calculator/) | Expo 없는 bare React Native — Expo 예제와 동일한 앱 코드                        |
| [`calculator-napi`](../examples/calculator-napi/)                           | transport를 napi-rs로 교체(release transport 벤치마크의 소스)                   |
| [`benchmark`](../examples/benchmark/)                                       | 페이로드 확장·처리량 측정 하니스                                                |
| [`reference-app`](../examples/reference-app/)                               | 실제 앱에서 `@rustra/react` 훅: useCommand/useMutation/useEvent                 |

`examples/rn-wasm-spike/`는 실험적 wasm32-in-wasm3 스파이크다 — 증거와 범위 주의는
[호환성 매트릭스](compatibility-matrix.ko.md)에 있고 지원 경로가 아니다.

## 연구 배경

[docs/research/](research/)에는 초기 iOS PoC에서 나온 bridge/benchmark/transport 연구 문서가 있다. 현재 구현과 crate명이 다를 수 있지만, 설계 판단 근거로 보존한다.

## 계획/계약/보고 기록

- [docs/specs/](specs/) — 기능별 설계 사양(spec)
- [docs/plans/](plans/) — 구현 계획 및 스파이크 기록 (역사 문서 포함)
- [docs/prs/](prs/) — 병합된 트랙의 PR 보고서
