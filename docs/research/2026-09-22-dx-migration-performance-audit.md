---
date: 2026-09-22
researcher: Codex
git_commit: c717117f
branch: dx/m1-registry-journeys-20260921
repository: rustra-bridge
topic: DX, 마이그레이션, 성능 종합 점검 및 개선
tags: [research, dx, migration, performance]
status: local_and_simulator_validation_complete
last_updated: 2026-09-22
---

# DX·마이그레이션·성능 점검

## 범위와 기준

현재 체크아웃의 CLI/init/doctor/codegen, 배포 패키지 구성, 계약 비교,
Node/Bun/Tauri/RN 어댑터, Rust 런타임, CI 및 성능 회귀 검사를 점검한다.
시작 시 작업 트리는 깨끗했다. 사용자는 실제 소비자 앱의 업그레이드·롤백도
포함하도록 범위를 넓혔고, KeyBridge·Yeoyu·Leftcar를 마지막 단계의 대상으로
지정했다. 원본 소비자 저장소와 사용자 데이터는 보존하며 별도 작업 사본에서
검증했다. 소비자 검증은 2026-09-22 14:16 KST에 확보한 작업 스냅샷 기준이다.
기존 로드맵의 4주 실사용, 외부 평가자, 실기기 인증은 로컬 검증과 구분한다.
공개 발행과 원격 병합은 수행하지 않았다.

## 발견과 실행 순서

| 우선순위 | 현재 코드에서 확인한 문제                                                         | 수정·검증 방향                                                                                          |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P1       | RN init에 어댑터 의존성과 native 초기화가 없다                                    | 생성 manifest와 Rust 진입점 수정; 실제 생성·빌드·FFI 호출                                               |
| P1       | diff가 enum/format/필드 순서/tuple/map/union 변화와 optional 추가를 놓친다        | 실제 wire 오해석을 재현하고 변경 판정을 보강                                                            |
| P1       | RN 이벤트 중 재구독이 같은 콜백을 반복 방문한다                                   | 스냅샷 전달과 해지 확인; 재진입 회귀                                                                    |
| P1       | 성능 회귀 코드 3을 성공으로 변환해 다음 baseline으로 채택한다                     | 실패 유지, 실패 artifact 분리, 명시적 bootstrap 유지                                                    |
| P1       | 복원 artifact의 옛 측정값 13개가 새 비교에 남는다                                 | 과거 new/change 제거, 실제 새 측정과 비교 결과의 일대일 대응 확인                                       |
| P1       | Yeoyu 0.8→Frame 전환에서 rkyv 생성 파일이 남는데 `--check`가 성공한다             | 이전 manifest hash로 소유권을 증명한 구형 파일만 제거; 수정·미등록·symlink·출력 밖 파일은 보존하고 오류 |
| P1       | Leftcar codegen이 앱 내부 workspace를 추가해 Expo 진단이 100→87점으로 하락한다    | 실제 상위 workspace 소속을 glob으로 확인하고 기존 루트에 등록; 제외 규칙 보존                           |
| P2       | 재귀 schema 자기 비교가 stack overflow                                            | 현재 탐색 경로의 객체 쌍으로 순환 차단                                                                  |
| P2       | RN 채널 사용자 콜백 예외가 null 중복 전달을 만든다                                | 파싱과 콜백 실행 분리                                                                                   |
| P2       | 전체 RN 예제의 Nitro Swift import가 glog namespace 모듈 오류로 빌드 실패          | 예제 Expo plugin에서 glog 0.3.5의 헤더 두 개만 textual 처리; prebuild/pod 재생성·native 빌드            |
| P2       | 성능 결과의 null을 0으로 변환해 통과, 허용치 보고서 오표시, 이전 성공 보고서 잔류 | 숫자와 CI 경계 검증, 실제 CLI 허용치 반영, 잘못된 입력에도 실패 보고서 갱신                             |
| P2       | CLI inline 인자 값의 두 번째 = 이후가 잘린다                                      | 첫 =만 분리                                                                                             |
| P2       | function_dispatch가 CI 성능 회귀 대상에서 빠졌다                                  | release 벤치 및 요약에 연결                                                                             |
| P3       | README 버전 및 마이그레이션/NDK 문서가 현재 계약과 다르다                         | EN/KO 교정 및 검증                                                                                      |

`rustra diff` 수정은 API/wire 자체를 바꾸지 않고 잘못된 호환 판정을
보수적으로 고친다. Frame은 위치 기반 인코딩이므로 JSON의 기본값 처리와
동일하게 취급할 수 없다. 일반 설명용 title/description/default 변화는
파괴 변경으로 분류하지 않는다. 단, oneOf의 실제 discriminator fallback으로
쓰이는 title 변경은 wire 계약의 변경으로 취급한다.

성능 혼합 결과는 환경 차이의 단서일 뿐 증명이 아니다. 같은 실행에서
일부 경로가 개선됐다는 이유로 다른 경로의 회귀를 통과시키지 않는다.

## 로컬 검증 기록

환경은 macOS arm64, Node 22.21.1, Bun 1.4.1, Rust/Cargo 1.98.0이다.
수정 전 실패를 재현한 뒤 수정 후 통과를 확인했고, 최종 전체 검사를 별도로 실행했다.

| 검사                              | 결과와 근거 범위                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --locked` | 575 passed, 5 ignored, 0 failed. 이번 세션에서 Rust 구현은 변경하지 않음                                                                                             |
| `bun run test:local`              | 첫 개선 묶음 exit 0. 9개 패키지 build, lint 경고 0, format, 의존성 audit, 타입·회귀·실행·문서 포함. 이후 소비자에서 찾은 CLI 추가 수정은 아래 별도 재검증            |
| CLI 전체 회귀                     | 추가 수정 후 Node 380/380, Bun 36/36. 계약 diff 43개 및 init 20개 포함                                                                                               |
| 소비자 발견 후 추가 수정          | CLI build, lint, format, 의존성 audit 162개·취약점 0, API, architecture, codegen freshness, 문서 통과. 마지막 경로 경계 보정 후 cleanup 7/7·build·lint·format 재확인 |
| RN init 실제 생성물               | 생성 Rust 라이브러리 빌드 후 `rustra_mobile_init()` 두 번과 FFI 명령 호출 통과. 모바일 링크/실기기 증거는 아님                                                       |
| RN 전달과 CLI 인자 직접 회귀      | 수정 전 4개 실패 → 수정 후 79/79 성공. RN 별도 테스트 타입 컴파일도 통과                                                                                             |
| 성능 검사 도구 회귀               | 최초 17/17, 후속 추가 수정 뒤 23/23. gate exit 0/1/2/3 보존, 벤치 누락, 오래된 측정 제거, 새 경로 baseline 부재 포함                                                 |
| API/codegen/architecture          | API snapshot, codegen 예제 6개, bindings 1개, architecture 4/4 통과                                                                                                  |
| 릴리스/소비자 검사 도구           | release tools 79/79, registry consumer 도구 39/39. 실제 외부 앱 검증과 구분                                                                                          |
| Node/Bun 실제 실행                | release Rust 빌드와 Node stdio/Bun FFI 예제 호출 통과                                                                                                                |
| RN packed package                 | `verify:package:react-native`, `verify:consumer:react-native` 통과. 로컬 수정 tarball이며 공개 0.9.2의 변경 증거가 아님                                              |
| 신규 source 소비자                | init → doctor → build → codegen → demo → check → 계약 변경 → regen → rebuild → verify 통과                                                                           |
| 문서                              | 도구 37/37, synced region 6개, EN/KO 문서 78개, 버전 문서 6개 통과                                                                                                   |

전체 검사 첫 재실행에서 새 테스트의 TypeScript narrowing 오류가 발생했다.
이를 수정한 두 번째 실행 `/tmp/rustra-audit-final-local-v2.log`가 전체 묶음 성공 근거다.
이후 소비자에서 발견한 cleanup/workspace 수정의 전체 CLI 결과는
`/tmp/rustra-audit-cli-final-v4.log`에 남겼다. packed CLI 설치의 파일 전수 비교와
실제 소비자 재생성도 통과했다. 새 의존성 picomatch는 workspace의 brace,
extglob, 문자 클래스 및 제외 패턴을 직접 축약 구현하지 않기 위해 사용했다.
회귀·검토에서 드러난 oneOf title key와 command-level ref 제거의 누락도
추가 실패 테스트로 확인하고 고쳤다. 마지막 독립 재검토에 새 차단 결함은 없었다.

기존 Miri 풀 종료 결함은 현재 소유형 풀의 drop/join 구현과 테스트가
존재하므로 과거 결함을 현재 미수선 결함으로 재사용하지 않았다.

## 공개 배포와 원격 검사

2026-09-22 조회한 원격 main은 `4b736f84dc0124b16284e178403a2712947c90ea`다.
같은 SHA의 [기본 CI](https://github.com/loopy-lim/rustra/actions/runs/35586476014),
[Sanitizer](https://github.com/loopy-lim/rustra/actions/runs/35544752191),
[Miri](https://github.com/loopy-lim/rustra/actions/runs/35542294531),
[registry consumer](https://github.com/loopy-lim/rustra/actions/runs/35538228207),
[Release](https://github.com/loopy-lim/rustra/actions/runs/35536921112)는 성공했다.
이는 이번 미커밋 후보를 원격에서 검사한 결과가 아니다.

[레지스트리 감사 영수증](../verification/evidence/2026-09-22-registry-dx-audit.json)은
npm 9개와 crates.io 3개의 정확한 버전·출처를 기록하며 조회 오류는 0개다.
Rust 0.11.0의 archive checksum도 일치한다. npm은 독립 버전이며 공개 소스
SHA가 서로 다르다. CLI 0.11.3/RN 0.9.2와 로컬 수정본의 버전 문자열이
같아도 같은 배포물이라는 뜻이 아니다. 두 패키지의 patch changeset을 추가했다.

## 원격 성능 실패와 측정 신뢰성

[Benchmark 35535838697](https://github.com/loopy-lim/rustra/actions/runs/35535838697)은
실패했다. 복원한 마지막 성공 기준선은
[35516522592](https://github.com/loopy-lim/rustra/actions/runs/35516522592)의
`7d5516f69af0029f1507add0aa06c4fba3ca9522`다.
현재 53개 경로가 악화됐고, 삭제된 rkyv 경로 13개의 과거 변화율이 그대로
남아 있었다. 예를 들어 `invoke_rkyv_v2/frozen`의 -45.10%와
`static_tier1_postcard`의 -40.34%가 새 실행에서도 반복됐다.

두 원격 실행의 runner image는 `20260907.300.1`, Rust는 1.95로 같지만
CPU 모델 증거는 없다. 기준선→main의 변경은 채널 진단과 hot-core watcher에
한정되며 해당 코덱/벤치/Cargo 입력은 바뀌지 않았다. 이것만으로 환경 탓이라고
확정하거나 Linux 실패를 통과로 바꿀 수 없다.

수정한 workflow는 비교 전 과거 `new`/`change`를 제거하고 `base`를 보존한다.
새 측정과 비교 파일이 모두 대응해야 하며, 회귀·비교 불가·벤치 자체 실패는
`-rejected` artifact로 남긴다. 새로 추가한 `function_dispatch`는 기준선이 없으므로
처음에는 **명시적인 bootstrap 실행**이 필요하다. 자동 통과 예외를 추가하지 않았다.

후속 검사에서 `point_estimate: null`과 `lower_bound: null`이 `Number(null) === 0`
때문에 exit 0으로 통과하는 것을 실제 CLI로 재현했다. 유한한 JSON 숫자와
올바른 confidence interval 순서만 허용하도록 수정했고 두 입력 모두 exit 2가
된다. `--max-regression .20`인데 보고서에 10%로 표시되던 오류도 수정했다.
소수 퍼센트도 보존한다. 잘못된 Criterion JSON이 들어오면 이전 성공 보고서를
남기지 않고 실패 보고서로 갱신한다.

복원 실패 시 남아 있던 cache의 기준선을 대신 사용하지 않도록 복원 전
`target/criterion`만 초기화한다. 이후 CPU 모델·코어 수·커널·Rust/Cargo/Bun·공개
CI 식별자를 `runner-environment.json`에 수집하고, 복원된 환경 정보는 별도로
보존한다. 전체 환경 변수나 컴파일 flag 원문은 기록하지 않는다. 옛 artifact에
정보가 없으면 모름으로 남긴다. 혼합 성능 변화의 안내도 환경 차이로 단정하거나
baseline 교체를 유도하지 않고, 기존 기준선을 보존한 동일 환경 비교를 요구한다.

[후속 검증 영수증](../verification/evidence/2026-09-22-benchmark-gate-followup.json)에
수정 전 실패·잘못된 통과, 실제 CLI 재실행, 23개 검사 결과와 소스 hash를 기록했다.
새 수집기의 로컬 실행에서 Apple M1 Max/논리 CPU 10개를 확인했지만 이는 이전 GitHub
runner의 누락된 CPU 근거를 채우지 않는다. 후속 독립 읽기 검토에서 새 차단 결함은 없었다. 원격 실행이나 baseline 교체는
하지 않았고, 53개 성능 실패의 원인도 아직 확정하지 않았다.

같은 머신의 이전 기준선/현재 코어 5개 경로를 각각 5회 독립 프로세스로
교대로 실행했다. 원시 추정값·소스/바이너리 hash·실행 인자는
[A/B 영수증](../benchmark-receipts/2026-09-22-dx-audit-ab.json)에 저장했다.
두 입력의 Cargo manifest/lock과 측정 harness hash는 같고, 각 실행 전후
바이너리 hash도 일치한다. 다른 빌드/검사와 동시에 측정하지 않았다.

| 경로                   | 기준선 5회 mean의 중앙값 | 후보 5회 mean의 중앙값 | 후보 변화 |
| ---------------------- | -----------------------: | ---------------------: | --------: |
| optional string 64 KiB |                 5.277 µs |               5.306 µs |    +0.55% |
| scalar control         |                61.157 ns |              55.359 ns |    -9.48% |
| tree DFS 8191          |                20.305 µs |              20.757 µs |    +2.22% |
| tree echo 8191         |                 8.427 ms |               8.729 ms |    +3.58% |
| tree resident 8191     |                20.125 µs |              20.840 µs |    +3.55% |

중앙값에서는 원격의 큰 악화를 재현하지 못했다. 다만 후보 3회차의 scalar는
159.876 ns, optional string은 30.408 µs로 크게 튀었고 다른 경로에도 편차가
있다. 모든 측정값을 보존했으며 이를 안정적인 속도 개선이나 회귀 부재의
확정 근거로 쓰지 않는다. 당시 로컬 CPU 모델 조회는 sandbox가 거부했으므로
영수증에 미확인으로 남겼다. 이 macOS 코어 진단은 Linux CI 회귀 통과나
실제 앱/모바일/p95 성능의 증거가 아니다.

## 근거의 한계

RN 재구독의 무한 반복은 현재 TypeScript 소스로 재현했다. 과거 공개
어댑터 0.9.2/Android 이벤트 교착 3회의 직접 원인으로 확정한 것은 아니다.
iOS의 제한된 runtime reload 실행 근거는 아래에 추가했다. Android scheduler와
실기기 수명 문제까지 해결했다고 확대하지 않는다.
기존 benchmark 영수증은 당시 입력·바이너리의 결과이며 이번 후보의
속도 향상이나 실제 앱 p95 향상으로 재사용하지 않는다.

## 추가 네이티브 검사

C++ codec·wire 교차 검사와 sync core 검사를 통과했다. 기존 Hermes 검사 도구는
Pods framework 경로 한 가지를 가정해 `folly/dynamic.h` 누락으로 빌드가 중단됐다.
의존성 경로를 지정할 수 있게 하고 사전 진단을 추가했으며, simulator 외에
macOS Catalyst 프로세스로 실행하는 선택지를 마련했다.

수정한 동일 스크립트로 Catalyst 실행과 iOS Simulator 실행 각각 **1,375 assertions,
0 failures**를 확인했다. 잘못된 플랫폼과 누락된 framework 입력도 exit 2 및
다음 조치를 출력했다. 소스·바이너리·framework hash와 출력은
[네이티브 검사 영수증](../verification/evidence/2026-09-22-native-hermes-audit.json)에 있다.
실제 Hermes와 제품 binder/codec이지만 C ABI 상대는 테스트 구현이다.
소비자 Rust FFI, RN scheduler, Android 이벤트 교착의 해결 근거로 확대하지 않는다.

사용자는 후속 실행을 **시뮬레이터로만** 진행하도록 지정했다. 원본 앱과 다른
작업이 사용하는 Android 기기를 보존하며, 별도 ID `dev.rustra.audit20260922`의
RN Release 앱을 다섯 개의 새 프로세스로 실행했다. 매 실행에서 이벤트 3개,
구독 해제 후 추가 전달 0개, 콜백 내부 재구독 1회, 구독/해지 100회,
JSON·바이너리 채널 각 3개, 중복 close, 정리 후 Rust 호출을 모두 통과했다.
[시뮬레이터 영수증](../verification/evidence/2026-09-22-ios-simulator-events-audit.json)에
5,000개 원시 측정값, 프로세스별 로그 hash, 앱 바이너리·JS bundle hash,
재현용 fixture/실행기, Rust·JS·native 소스 및 manifest 394개 파일의 동일성 검사를 남겼다.

생성된 `add(1,2)`를 await하는 왕복 호출은 프로세스당 warmup 100회 후
1,000회 측정했다. 각 실행 p95는 12.67/13.29/25.46/13.96/14.71 µs이며
p95 중앙값은 13.96 µs다. 세 번째 실행이 느렸고 호스트에서 다른 작업이
진행 중이므로 안정적 성능이나 회귀 부재를 주장하지 않는다. baseline과의
A/B도 아니며 시뮬레이터 측정은 실기기·소비자 앱의 p95가 아니다.

첫 결과 수집은 `--info` 누락과 긴 로그 잘림 때문에 실패했다. 해당 프로세스의
정보 로그를 다시 읽어 앱 자체의 성공을 확인했고, 수집 수준과 출력 청크를
고친 뒤 다섯 실행 전체를 다시 검증했다. 실패 시도도 영수증에 보존했다.
이벤트 검증 앱은 관련 없는 native 비교 모듈을 제외한 격리본이며,
원래 예제 전체 구성의 빌드 검증은 아래와 구분한다. 검증 전용 앱은 제거했고
이번에 부팅한 시뮬레이터는 시작 상태인 Shutdown으로 복원했다.

원래 예제 전체 구성의 Release 빌드에서 Nitro 0.37.1의 Swift 공개 C++ 헤더가
RN 0.81.5의 glog 모듈을 읽으며 `import ... appears within namespace google`로
실패했다. glog 0.3.5의 `log_severity.h`와 `vlog_is_on.h` 두 헤더만
textual include로 처리한 격리 실험에서 전체 Release 빌드가 통과했다.
다른 pod의 모듈 설정을 바꾸지 않는 Expo plugin과 버전 한정 pod hook으로
재현 가능한 수정에 반영했다. 최종 Expo prebuild → pod install → 전체 Debug·Release 빌드가 모두 exit 0으로
통과했다. 원래 비교 모듈 3개와 Nitro 0.37.1을 포함한 상태이며 결과는
[예제 iOS 빌드 영수증](../verification/evidence/2026-09-22-ios-example-build-audit.json)에
실패 로그 hash, 최종 hook·modulemap, 잠금 파일, 빌드 명령과 결과물 hash로 기록했다.
Pods 다운로드는 기존 cache를 재사용했고 modulemap 생성부터 다시 확인했다. Nitro 버전별 A/B는 하지 않았으므로 특정 버전 회귀로 확정하지 않는다.
설정·스크립트 독립 읽기 검토에 새 차단 결함은 없었고, hook/doctor 검사 9개와
React Doctor 변경 범위 검사 100/100이 통과했다. 최초 React Doctor 실행은
sandbox 밖 npm cache에 쓸 수 없어 실패했고 전용 임시 cache로 재실행했다.

## iOS JavaScript runtime 재로드 검사

앞선 다섯 번의 앱 실행과 별도로, 같은 Debug 네이티브 프로세스에서 JavaScript
runtime을 **30회 재로드**했다. 각 runtime은 동기 호출 결과 100, Rust 소유
64 KiB ArrayBuffer의 양 끝 바이트, 비동기 호출 시작을 확인한다. 총 31개
runtime token이 각각 BUFFER_READY/READY/PENDING을 모두 냈고, 마지막 runtime의
지연 호출만 `emitted=301`로 완료했다. 이전 runtime의 완료·거부 출력은 없었으며
지연 완료 후에도 같은 프로세스가 살아 있었다.

원래 fixture의 호출 6,000 tick을 격리 사본에서만 300 tick × 10 ms로 줄여
제한된 실행 안에서 늦게 끝나는 호출도 관측했다. 사용자 개발 서버와 겹치지 않는
18081 포트를 썼고, 검증 실행기에만 해당 JS 위치와 PID 출력을 추가했다. main의
원래 fixture·실행기·제품 소스는 수정하지 않았다. [재로드 영수증](../verification/evidence/2026-09-22-ios-reload-audit.json)에
실제 fixture/실행기, 프로세스 로그, 앞선 Debug 빌드와 같은 네이티브 hash,
394개 제품 입력의 동일성 검사를 남겼다.

처음에는 CI 모드가 reload를 끄는 설정 문제와 sandbox에서 파일 감시가 실패하는
문제가 있었다. 해당 서버와 의존 검사를 종료한 뒤, 같은 전용 사본·포트에서
기존 Watchman에 접근 가능한 서버로 검증했다. Watchman을 새로 설치하거나
전역 설정을 바꾸지 않았다. 검증 앱·서버·전용 감시 경로를 정리하고 시뮬레이터를
원래 종료 상태로 돌렸다.

이 결과는 iOS Simulator의 제한된 JS runtime 교체 검사다. Rust 동적 라이브러리의
hot-core swap, 메모리 누수 부재, Android 동작, 실기기 100회·2시간 부하 검증이나
장기 실사용 수용으로 대체하지 않는다.

## iOS Rust 코어 교체와 원복

같은 전체 예제 Debug 앱에서 기존 `HotCoreApp`과 iOS smoke 도구를 실행했다.
정적 코어의 `addNumbers(2,3)=5`를 확인한 뒤, 동작만 +100으로 바꾼 Rust
라이브러리를 임시 파일 기록 후 rename으로 전달했다. 같은 PID에서 결과가
105로 바뀌었고, 기본 동적 라이브러리를 다시 전달하자 5로 돌아왔다.
READY 로그는 한 번이며 JavaScript 재로드나 앱 재시작은 관측되지 않았다.
원복 뒤에도 같은 프로세스가 살아 있었고 실패 로그는 없었다.

[핫 코어 영수증](../verification/evidence/2026-09-22-ios-hot-core-audit.json)에
두 라이브러리와 원복 후 live 파일의 hash, 원시 로그, 실행기, 앞선 Debug
바이너리 동일성 및 제품 입력 394개와 추가 fixture 5개의 동일성을 기록했다.
격리 실행기에만 전용 Metro 주소와 PID 출력을 추가했고 제품 소스는 수정하지
않았다. 검증 앱·개발 서버·전용 감시 경로를 정리하고 시뮬레이터를 종료했다.

한 번의 동작 변경과 원복 검사이며 schema/signature 변경, 설치 앱의 저장
데이터 downgrade, 실기기·Android 동작이나 장기 안정성 검사로 확대하지 않는다.
관측 지연 1,013 ms에는 앱의 1초 조회 주기가 포함되므로 교체 비용의 성능
수치로 사용하지 않는다.

## 실제 소비자 업그레이드·복원 결과

작업 디렉터리는 `/tmp/rustra-consumers-20260922`이며 앱별 `seed`, `baseline`,
`candidate`, `rollback` 사본을 사용했다. 기존 dirty 작업과 비무시 untracked
파일을 포함한 소스 hash를 기록했다. Rust는 로컬 후보 소스, JS는 실제 packed
tarball을 연결했고, Yeoyu는 원래 사용하던 vendor 구조를 유지했다.
CLI의 마지막 두 수정은 별도 v2 tarball로 다시 설치·재생성했다.

[소비자 검증 영수증](../verification/evidence/2026-09-22-consumer-migration-audit.json)에
명령·종료 코드·실패 시도·로그 hash·정확한 tarball hash·생성물·잠금 파일·
Kotlin XML 결과·호스트 dylib hash를 기록했다. 원본 저장소와 설치 앱에는 쓰지 않았다.

| 앱        | 기준 → 후보 → 복원 검증                                                                                                      | 주의할 경계                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| KeyBridge | Rust 0.10→0.11; Android Rust 81개, Kotlin 46개, desktop Rust 29개 각 단계 통과. UniFFI bindings, desktop 타입·번들 검사 통과 | Kotlin은 macOS host dylib를 실제 호출. Android APK/기기와 desktop GUI 실행은 하지 않음                                      |
| Yeoyu     | Rust/CLI 0.8→0.11 계열; Rust 66개, JS 516개, 타입·생성물 검사 각 단계 통과. 구형 rkyv 파일 2개 안전 제거                     | 원래 vendor의 ignored dist를 빌드해야 baseline 타입 검사가 가능했음. RN C++/JNI 링크·앱 호출은 미검증                       |
| Leftcar   | Rust Git 0.10.2→0.11; Rust 36개, TS contract 4개, 타입·생성물 검사 통과. React Doctor baseline 100→첫 후보 87→최종 100       | 아래 fixture 보정 후 결과이며 전체 원본 앱의 green 판정은 아님. Rustra addNumbers 경로만 포함; 영상 스트리밍 성능 증거 아님 |

세 앱의 schema diff는 breaking 0개다. Frame codec 전환은 이 API 비교만으로
완료되지 않으므로 Rust/native/generated/JS를 같은 후보 묶음으로 검사했다.
복원은 버전 문자열만 내린 것이 아니라 시작 시점 소스·lock·생성물 묶음을
복원한 별도 사본에서 다시 빌드한 결과다. 설치 앱의 데이터 downgrade는 수행하지 않았다.

Leftcar 시작 스냅샷의 `CatalogView` 테스트 literal 세 곳에 신규 optional 필드가
빠져 Rust 검사가 컴파일되지 않았다. 세 사본 모두 같은 두 `None` 필드를 추가한
검증 fixture로 정규화했고 원본은 수정하지 않았다. 보정 diff를 영수증에 포함했다.
`StreamPointerDiagnostics.kt`의 `org.json.JSONObject` import는 baseline과 후보에서
동일한 architecture 위반 1개를 냈다. 이 기존 앱 문제를 이번 SDK 변경이 해결했다고
표시하지 않는다.

KeyBridge·Yeoyu 복원 사본은 시작 소스 hash와 전부 같고 Leftcar는 위 fixture만
다르다. 생성 manifest가 소유한 파일은 세 앱 모두 baseline과 rollback이 같다.
최종 원본 재조회에서는 **세 앱 모두 다른 작업이 계속 진행 중인 변화**가 확인됐다
(Yeoyu는 HEAD도 변경). 이를 되돌리거나 후보 사본을 덮어쓰지 않았으며, 이 검증을
해당 최신 작업까지 통과한 결과로 확대하지 않는다. 상세 경로는 영수증에 남겼다.

## 남은 실행 경계

- 로컬 수정은 미발행 상태이며 공개 CLI 0.11.3의 동작으로 안내하지 않는다.
- 새로운 function_dispatch 비교 기준선은 원격의 명시적 bootstrap이 필요하다.
  이번 로컬 A/B는 Linux 성능 실패를 해소했다는 증거가 아니다.
- iOS 격리 앱의 이벤트/해지, JS runtime 재로드 30회, Rust hot-core 교체·원복은 검증했다. Android 이벤트 멈춤,
  Android/iOS 실기기, 설치 앱 데이터 upgrade/downgrade, 장기 실사용과 실제 앱 p95는
  추가 실행이 필요하다. 이번에는 원본 앱과 실기기 상태를 보존했다.
- 세 소비자의 계속 진행 중인 최신 작업에 실제 적용하려면 해당 시점 스냅샷을 다시
  확보해야 한다. 이번 결과는 기록된 시작 입력과 로컬 후보에 한정된다.

## 관련 문서

- [로드맵 SPEC](../specs/2026-09-14-rustra-roadmap.md)
- [도입 검증 현황](../verification/2026-09-16-roadmap-status.md)
- [마이그레이션 안내](../migration-guide.ko.md)

## 커밋 구성

사용자의 마무리 요청에 따라 변경사항을 다음 네 묶음으로 정리한다.
아래 범위는 로컬 커밋이며 원격 push·발행·병합은 포함하지 않는다.

### `fix(dx): 코드 생성과 계약 비교 및 RN 이벤트 오류 수정` (22 files)

- `.changeset/safe-migration-and-rn-onboarding.md`
- `bun.lock`
- `packages/cli/package.json`
- `packages/cli/src/cli-arg-parser.test.ts`
- `packages/cli/src/cli-arg-parser.ts`
- `packages/cli/src/cli-codegen-json.test.ts`
- `packages/cli/src/cli-codegen.ts`
- `packages/cli/src/cli-generate-files.ts`
- `packages/cli/src/cli-init.test.ts`
- `packages/cli/src/cli-json-format.ts`
- `packages/cli/src/dependencies.test.ts`
- `packages/cli/src/dependencies.ts`
- `packages/cli/src/dev.ts`
- `packages/cli/src/generate.test.ts`
- `packages/cli/src/generated-cleanup.ts`
- `packages/cli/src/init-template.ts`
- `packages/cli/src/schema-diff-helpers.ts`
- `packages/cli/src/schema-diff-traverse.ts`
- `packages/cli/src/schema-diff.test.ts`
- `packages/cli/src/workspace-owner.ts`
- `packages/react-native/src/index.test.ts`
- `packages/react-native/src/react-native-events.ts`

### `fix(ios): 예제 빌드와 Hermes 검사 환경 복구` (5 files)

- `examples/react-native-calculator/app.json`
- `examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh`
- `examples/react-native-calculator/plugins/with-glog-textual-headers.cjs`
- `examples/react-native-calculator/scripts/fix-glog-modulemap.rb`
- `examples/react-native-calculator/scripts/glog-modulemap.test.mjs`

### `ci(perf): 성능 회귀 실패와 기준선 오염 차단` (9 files)

- `.github/workflows/bench.yml`
- `docs/benchmark-receipts/2026-09-22-dx-audit-ab.json`
- `docs/benchmark-receipts/2026-09-22-function-dispatch-smoke.json`
- `package.json`
- `scripts/benchmark-environment.mjs`
- `scripts/benchmark-environment.test.mjs`
- `scripts/benchmark-workflow.test.mjs`
- `scripts/check-criterion-regression.mjs`
- `scripts/check-criterion-regression.test.ts`

### `docs(audit): 마이그레이션 가이드와 소비자 검증 결과 정리` (17 files)

- `README.ko.md`
- `README.md`
- `docs/development-hurdles.ko.md`
- `docs/development-hurdles.md`
- `docs/function-registration.ko.md`
- `docs/function-registration.md`
- `docs/migration-guide.ko.md`
- `docs/migration-guide.md`
- `docs/research/2026-09-22-dx-migration-performance-audit.md`
- `docs/verification/evidence/2026-09-22-benchmark-gate-followup.json`
- `docs/verification/evidence/2026-09-22-consumer-migration-audit.json`
- `docs/verification/evidence/2026-09-22-ios-example-build-audit.json`
- `docs/verification/evidence/2026-09-22-ios-hot-core-audit.json`
- `docs/verification/evidence/2026-09-22-ios-reload-audit.json`
- `docs/verification/evidence/2026-09-22-ios-simulator-events-audit.json`
- `docs/verification/evidence/2026-09-22-native-hermes-audit.json`
- `docs/verification/evidence/2026-09-22-registry-dx-audit.json`
