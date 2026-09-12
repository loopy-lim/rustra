# 감사 수정 결과 — 2026-09-12

## 현재 상태

감사 항목 F01–F24의 코드·검사·문서 변경을 구현했다. 전체 JS 통합 검사,
Rust workspace 검사, 실제 Node/Bun/Tauri 호스트 검사와 로컬 패키지 소비자 검사를
통과했다. **최종 커밋의 원격 CI와 발행은 아직 완료하지 않았다.** F20의 원격 CI,
F22의 버전 적용·발행은 아래 릴리스 대기 항목으로 남긴다.

- 작업 브랜치: `refactor/frame-naming-20260911`
- 시작 커밋: `8b826d75cb6c1d57a26461f1926e8a29f0f05047`
- 검증 대상: 위 커밋에 이번 작업의 미커밋 변경을 더한 로컬 작업 트리
- 환경: macOS arm64, Node 22.21.1, Bun 1.4.0
- [설계](../specs/2026-09-12-audit-remediation.md), [구현 계획](../plans/2026-09-12-audit-remediation.md)
- 최초부터 존재한 Tauri iOS 생성물은 변경·커밋 대상에서 제외했다.
- 7개 구현 묶음 모두 별도 검토를 받았고, 검토에서 발견한 문제도 수정 후 재검토했다.

## 항목별 수정과 확인

| ID  | 수정                                                                                                                                           | 확인 근거 / 남은 범위                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Suspense 캐시를 엔진별로 분리하고 전역 엔진 등록 세대도 구분한다. SSR은 요청별 Provider 엔진을 사용한다.                                       | 실제 React 렌더러 및 스트리밍 SSR에서 동일 입력의 서로 다른 엔진 결과가 격리된다.                                                         |
| F02 | 전역 엔진 등록에 소유 토큰을 추가했다. dispose는 자기 등록만 해제하며 반환된 Node/Bun 엔진도 종료 후 호출을 거부한다.                          | dispose 후 재생성, 초기화 중 종료, 다른 등록 보존, 전역 슬롯 해제 회귀 검사.                                                              |
| F03 | raw Frame 호출에도 상태 컨텍스트를 설치한다.                                                                                                   | raw와 일반 호출의 State 주입 통합 검사.                                                                                                   |
| F04 | 단순 postcard·direct·buffered·폴백 경로 모두 헤더를 포함한 응답 총량을 제한한다.                                                               | `response_limits.rs`에서 경계와 초과 응답을 검사한다.                                                                                     |
| F05 | JS Tauri 채널을 발급한 물리 WebView의 IPC Channel로 전달한다. 생성·drop·종료에 소유권과 자원 lease를 적용했다.                                 | native 8개 및 JS 46개 검사. 큰 메시지도 968바이트 이하 조각으로 전달한다. 실제 GUI의 탐색·창 파괴 실행 인증은 별도다.                     |
| F06 | 입력 키가 Set·Map·ArrayBuffer·뷰·bigint와 객체 구조를 구별한다. 순환·미지원 입력은 거부한다.                                                   | 실제 훅 재렌더와 입력 변경 검사.                                                                                                          |
| F07 | 초기화 종료 후 늦게 도착한 transport도 한 번 닫는다.                                                                                           | 비동기 생성과 dispose 경합 회귀 검사.                                                                                                     |
| F08 | 겹친 reload는 진행 중 Promise를 공유하고 엔진·자원을 같은 세대에 귀속한다.                                                                     | reload 경합, 이전 ready의 무효화, 최종 자원 종료 검사.                                                                                    |
| F09 | 계약 조회의 로컬 transport 참조와 원래 오류를 보존한다.                                                                                        | dispose 중 계약 실패가 TypeError로 덮이지 않는 검사.                                                                                      |
| F10 | Mutation 상태를 엔진·명령 범위별로 분리하고 완료 콜백은 호출 당시 옵션에 귀속한다.                                                             | 엔진/명령 변경·언마운트·자식 layout 호출·중단된 렌더 검사.                                                                                |
| F11 | 비동기 unsubscribe가 도착하기 전에도 비활성 이벤트 전달을 차단한다.                                                                            | 이벤트 변경·언마운트 후 전달 차단과 한 번의 정리 검사.                                                                                    |
| F12 | 빈 내부 상태도 독립 TLS 컨텍스트로 설치하고 이전 상태를 복원한다.                                                                              | 중첩 패키지 격리와 panic 후 복원 검사.                                                                                                    |
| F13 | 설정 파일 변경을 재해석하고 소스·schema·manifest 감시 범위를 다시 구성한다. 새 디렉터리도 발견한다.                                            | 설정 경로 변경, 누락/잘못된 새 schema, 새 디렉터리 검사.                                                                                  |
| F14 | 파일 감시를 100ms 폴링으로 구현하고 누락·재생성·읽기 오류에서 복구한다.                                                                        | watcher 및 CLI 전체 검사 통과. 파일 수가 큰 프로젝트의 장시간 CPU 측정은 별도다.                                                          |
| F15 | Cargo compiler-artifact와 lib target으로 실제 UniFFI 라이브러리를 선택한다. bindgen은 명시적인 host target을 사용한다.                         | 커스텀 lib명·Cargo target 회귀 검사와 실제 calculator 생성.                                                                               |
| F16 | 빈 임시 디렉터리에서 바인딩을 생성·검증하고 전용 출력 트리를 원자적으로 교체한다. `--check-bindings`는 실제 생성 결과를 비교한다.              | Swift/Kotlin/header/modulemap 실제 비교 통과. 소스·manifest·schema·TS 출력과 겹치는 경로는 생성 전에 거부한다.                            |
| F17 | 현재 TS 소스에서 선언·서명·subpath·참조 타입을 수집한다. Rust는 AST 기반 선언·trait·alias·cfg·include·모듈 경로를 추적한다.                    | 20개 변형 검사 및 실제 snapshot v3 비교 통과. Rust 의미 분석·모든 매크로 확장·ABI 인증을 대신하지 않는다.                                 |
| F18 | 세 fuzz target에 올바른 시드를 전달하고 재생 corpus를 10분 실행에도 이어 사용한다. 타깃별 corpus와 실패 산출물을 저장한다.                     | nightly ASan에서 타깃별 100개 시드 재생 통과. 이번 로컬 검증에서 10분 연속 fuzz는 실행하지 않았다.                                        |
| F19 | 프로세스 검사를 Node에서 실행하고 필요한 CLI 빌드를 선행한다. Bun 전용 코덱·성능 검사는 Bun에 유지한다.                                        | `bun run test` 전체 exit 0. CLI 345개, release-tools 29개 포함.                                                                           |
| F20 | RN 두 예제의 workspace lockfile 정보를 수정했다.                                                                                               | RN·RN bare·Tauri·NAPI frozen 설치 통과. 최종 커밋의 hosted CI는 대기 중이다.                                                              |
| F21 | EN/KO 설치 명령·호환 표를 manifest 버전과 맞췄다. 잘못된 버전·버전 없는 설치·누락된 표를 거부하는 검사를 추가했다.                             | 문서 37개 테스트, 동기화 6개 구간, mirror 64개 문서, 설치/버전 문서 6개 통과.                                                             |
| F22 | JS 9개 패키지의 changeset과 Frame·네이티브·JS·생성물의 동시 업그레이드/롤백 문서를 준비했다.                                                   | 9개 로컬 tarball 설치와 진입점 14개 import, RN packed consumer 및 구 Tauri 프로토콜 거부 검사 통과. 버전 적용·최종 CI·발행은 대기 중이다. |
| F23 | 채널 수에 JSON과 binary 채널을 모두 포함하고 0 핸들은 제외한다.                                                                                | 혼합 채널 등록·종료·수량 검사.                                                                                                            |
| F24 | 엔진별 캐시에 256개 상한·완료 후 5분 TTL·대기 30초 제한을 두었다. hot-core 누적 라이브러리 수와 파일 크기를 노출하고 32회부터 재시작을 권한다. | 캐시 제한·만료·격리 검사 및 실제 dylib load/swap 검사. `artifact_bytes`는 파일 크기 합이며 프로세스 RSS가 아니다.                         |

## 주요 동작 변경

Tauri 일반 JS 채널과 신뢰된 Rust 호스트의 브로드캐스트 헬퍼를 구분한다.
JS 채널의 `ipc-channel-chunks-v1` 프로토콜은 네이티브와 JS를 함께 갱신해야 한다.
네이티브 한도는 min(런타임 한도, 16 MiB)이며 코어 기본 한도는 1 MiB이다.
JS 재조립은 16 MiB·30초를 한도로 한다. 콜백은 실패와 close에서 해제한다.
직접 전달 경계를 검증한 Tauri `=2.11.1`에 고정했으므로 다른 정확한 Tauri 버전을
요구하는 앱은 호환성을 별도로 해결해야 한다.

UniFFI 출력은 바인딩 전용 디렉터리여야 한다. 성공 시 전체 트리를 교체하므로
소스 루트·schema·manifest·다른 생성 출력과 겹치면 사전에 실패한다.
새 임시 디렉터리와 바인딩 출력은 dev 감시에서 제외해 자기 재빌드 순환을 막는다.

React 완료 콜백은 요청 시점에 귀속된다. 엔진·명령을 교체하면 이전 요청이 새 화면의
상태를 덮지 않지만, 이전 요청 자체와 그 요청의 완료 콜백은 계속될 수 있다.
Suspense 대기 제한도 실제 엔진 호출의 취소를 의미하지 않는다.

## 최종 검증 기록

숫자는 각 명령의 결과이다. 서로 겹치는 테스트를 합산해 총 검사 수로 제시하지 않는다.

| 검사                                               | 결과                                              | 로그                                                                      |
| -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `cargo test --workspace --locked`                  | 62 suites, 471 pass, 0 fail, 5 ignored            | `/tmp/rustra-final-cargo-tests.log`                                       |
| workspace 전체 clippy, `-D warnings`               | 통과                                              | `/tmp/rustra-final-clippy.log`                                            |
| Tauri 고정 후 `cargo check --workspace --locked`   | 통과                                              | `/tmp/rustra-final-locked-check.log`                                      |
| `bun run test`                                     | 전체 exit 0                                       | `/tmp/rustra-final-js-tests-complete.log`                                 |
| `bun run build`                                    | JS 9개 패키지 통과                                | `/tmp/rustra-final-build.log`                                             |
| lint / format / Rust fmt                           | 오류·경고 없음, 통과                              | `/tmp/rustra-final-lint.log`, `/tmp/rustra-final-format-check.log`        |
| 실제 API snapshot gate / 변형 테스트               | 통과 / 20개 통과                                  | `/tmp/rustra-final-api-gate.log`, `/tmp/rustra-final-api-tests.log`       |
| 별도 Rust API parser fmt / clippy                  | 통과                                              | `/tmp/rustra-final-api-clippy.log`                                        |
| architecture                                       | 4개 통과                                          | `/tmp/rustra-final-architecture.log`                                      |
| Node cross-wire                                    | 69개 통과                                         | `/tmp/rustra-final-node-crosswire.log`                                    |
| Node 실제 subprocess / Bun 실제 FFI                | 각각 결과 42                                      | `/tmp/rustra-final-runtime-node.log`, `/tmp/rustra-final-runtime-bun.log` |
| Tauri release build / static probe / 실제 hot-core | build·결과 42·실제 dylib load와 watch thread 통과 | `/tmp/rustra-final-tauri-runtime.log`                                     |
| RN injected adapter / 예제 typecheck               | 결과 42 / 통과                                    | `/tmp/rustra-final-adapters.log`                                          |
| 9개 로컬 tarball 소비자                            | 14개 공개 진입점 import·CLI 실행 통과             | `/tmp/rustra-final-all-packed-consumer.log`                               |
| RN native 패키지 / packed consumer                 | native 파일 5개·소비자 경로 확인 통과             | `/tmp/rustra-final-rn-package.log`, `/tmp/rustra-final-rn-consumer.log`   |
| RN·RN bare·Tauri·NAPI frozen 설치                  | 4개 통과 (`--ignore-scripts`)                     | `/tmp/rustra-final-{rn,rn-bare,tauri,napi}-frozen.log`                    |
| 문서 / release coherence                           | 통과                                              | `/tmp/rustra-final-docs.log`, `/tmp/rustra-final-release-coherence.log`   |
| `test:codegen-fresh` / `test:bindings-fresh`       | 12개 테스트·예제 6개 / 실제 UniFFI 예제 1개 통과  | 구현·검토 기록에 명령과 결과 보관                                         |
| ASan seed replay                                   | 타깃 3개, 각 100개 시드 통과                      | `/tmp/rustra-audit-fuzz-{frame,value,serde}.log`                          |

위 `/tmp` 로그는 현재 로컬 세션의 증거이며 저장소에 포함하지 않는다. CI에서는 최종
커밋으로 같은 검사들을 다시 실행해 장기 보관 가능한 실행 기록을 확보해야 한다.

## 릴리스 대기 항목

1. **대상 식별**: 사용자가 언급한 열린 “0.9.0” 항목의 링크·이름이 필요하다.
   조회한 현재 브랜치에는 PR이 없고, 관련 열린 기능 PR은
   [#69](https://github.com/loopy-lim/rustra/pull/69)이며 다른 브랜치를 가리킨다.
   이 PR에 현재 변경을 덮어쓰거나 임의로 병합하지 않았다.
2. **기존 버전 보존**: 2026-09-10에 Rust와 types/node/bun/cli의 0.9.0이 이미 발행됐다.
   현재 manifest를 유지하며 버전을 재사용하지 않는다. changeset은 다음 버전의 제안이다.
   types/node/bun/cli 0.10.0, tauri/react-native 0.9.0, react 0.8.0,
   testing/devtools 0.7.0이며 Rust는 0.10.0을 제안한다.
3. **커밋·CI·발행**: 변경을 목적별로 검토 가능한 커밋으로 만들고, 확정한 릴리스 대상에
   맞춰 버전과 의존 범위·생성 manifest·설치 문서를 갱신한다. 같은 커밋의 필수 CI와
   소비자 검증을 확보한 뒤 발행하고 실제 레지스트리 산출물을 확인한다.

이번 실행은 Windows/Linux GUI, 실제 iOS/Android 기기, GUI 탐색·창 종료,
장시간 동시 부하·RSS 측정, 모든 Cargo feature 조합을 인증하지 않는다.
빌드·Mock IPC·injected adapter·실제 호스트 검사는 각각 위에 표시한 범위의 근거다.
