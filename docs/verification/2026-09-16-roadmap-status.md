# Rustra 완료 기준과 후속 실행 현황

- 확인일: 2026-09-16 (KST)
- 제품 기준: [2026-09-14 로드맵 SPEC](../specs/2026-09-14-rustra-roadmap.md)
- 현재 원격 main: `1f277de2e68e2242b7a6503e6e0ab731833e60e3`
- 이번 구현: `codex/m1-registry-onboarding`, [실행 PLAN](../plans/2026-09-16-m1-registry-onboarding.md)
- 최종 목표: **검증된 Node/Bun/Tauri/RN 범위에 대한 1.0**. 현재는 M0 구현·발행 완료, M1의 Node/Bun 공개 패키지 자동 여정 구현·검증 완료이며 전체 M1·1.0은 미완료다.

## 1. 어디까지 해야 하는가

| 단계             | 현재 근거                                                                                                                    | 종료까지 필요한 일                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 기준선        | 메모리 수명 결함 수정, 같은 SHA의 안전성 발행 게이트, 0.10.1 Rust 배포, 레지스트리 출처/체크섬 감사. 코어 성능 A/B 기록 존재 | 온보딩 시간은 이번 실행으로 보강한다. 실제 사용자·실제 앱 성능 지표는 미측정으로 유지                                                          |
| M1 도입          | CLI·doctor·codegen·로컬 및 packed consumer 검사가 이미 존재. 이번 Node/Bun 공개 패키지 소비 88단계 검증 완료                 | 아래 A1–A6의 모바일/GUI·기존 앱·오류·평가자 조건을 모두 충족                                                                                   |
| M2 실사용 안정성 | 수명주기·계약·채널·취소 구현과 단위/통합 검사가 존재                                                                         | 소비자 2개, 각 4주 실제 사용과 연속 2회 배포 업그레이드, 실제 WebView 및 Android/iOS 실기기, 수명주기 100회·조합별 2시간 부하                  |
| M3 성능          | 코어 Criterion과 회귀 게이트, M0 동일 조건 A/B 기록 존재                                                                     | 실제 소비자 업무 기준선, 5회 독립 측정, 비용 비중을 근거로 개선 또는 보류 결정, 설명되지 않은 10% 초과 회귀 제거                               |
| M4 1.0 후보      | 공개 API/wire/FFI 정책과 snapshot 검사 존재                                                                                  | G0–G3 완료, 차단 결함 0개, 계약 동결 후 최소 4주·연속 후보 2회 관찰, UniFFI Phase 1 회귀, EN/KO 배포물 일치, 후보·artifact·공개 설치 증거 연결 |

문서의 16–24주는 인력·환경·외부 검증을 가정한 계획 범위이며 출시 약속이 아니다. 자동 테스트를 빨리 끝내도 4주 실사용이나 외부 평가자 성공으로 바꿔 적을 수 없다. iOS 실기기 부재는 그 인증을 미완료로 남기되 독립된 desktop/Android 작업을 막지는 않는다.

## 2. 최신 main과 공개 배포 확인

2026-09-16에 GitHub API와 공개 레지스트리를 다시 조회했다.

- [PR #72](https://github.com/loopy-lim/rustra/pull/72)는 위 main SHA에 병합됐다.
- 같은 SHA의 [기본 CI](https://github.com/loopy-lim/rustra/actions/runs/34832062630), [Benchmark](https://github.com/loopy-lim/rustra/actions/runs/34832062645), [안전성 포함 Release](https://github.com/loopy-lim/rustra/actions/runs/34833773252), [수동 Rust Release](https://github.com/loopy-lim/rustra/actions/runs/34835140983)가 성공 상태다.
- 공개 Rust `rustra`, `rustra-macros`, `rustra-naming`은 `0.10.1`, yank=false, archive checksum 일치, VCS SHA는 위 main과 일치한다.
- npm `cli/types/node/bun=0.10.0`, `tauri/react-native=0.9.0`, `react=0.8.0`, `testing/devtools=0.7.0`. 각 정확한 버전이 latest와 일치한다. npm 소스 SHA는 이전 `30c73bd66159f4c777054527236573559c106c98`이며 독립 버전 정책에 따른 별도 출처다.
- [이번 레지스트리 스냅샷](evidence/2026-09-16-registry-snapshot.json)은 오류 0개다. npm 출처가 이전 커밋이라는 사실을 현재 main 수정의 npm 발행 완료로 해석하지 않는다.

[이전 M0 검증 문서](2026-09-14-m0-safety-release.md)의 ‘새 Actions 실행·발행 미수행’ 문장은 당시 로컬 검증 시점의 기록이다. 이후 병합·발행 상태는 위 조회가 보완한다. 이번 M1 작업 디렉터리의 미커밋 수정은 위 원격 CI에 포함되지 않는다.

공개 npm CLI와 현재 main을 비교하면 `cli-generate.ts`의 watch 재구독 제거 수정이 아직 `@rustra/cli@0.10.0`에 포함되지 않았다. 조회한 원격 main의 changeset은 비어 있었다. 이번 로컬 후보에는 정확한 의존성 핀/독립 호스트 버전 수정과 이 watch 수정의 CLI patch changeset을 준비했다. 아직 발행하지 않았으며, 이번 registry 기본 핀 검증을 최신 main 전체 발행 증거로 사용하지 않는다.

## 3. 이번에 구현·검증한 M1 자동 검증

[실행 방법과 범위](../registry-onboarding.ko.md)

- 별도 임시 소비자에서 발행된 CLI를 설치해 scaffold → doctor → build → codegen → 호출 → 생성물 검사 → 필드 변경 → 재생성 → 재빌드 → 변경한 필드 반환을 확인한다.
- 정확한 Cargo/npm 버전과 공개 registry 출처를 매 단계 확인하며 로컬 source 주입을 거부한다.
- Rust 패치 `0.10.0 → 0.10.1 → 0.10.0`을 실제 빌드·호출하고 rollback 결과를 확인한다.
- Node stdio와 Bun FFI는 실제 실행 경로를 구분한다. 단순히 Bun으로 TypeScript를 실행한 결과를 FFI라고 세지 않는다.
- 첫 실패에서 중단하고 단계별 시간, 로그, 정확한 버전, 생성물/native hash를 보존한다.
- 기존 source onboarding gate에서 준비 실패·runner 예외·빈 실패 출력을 놓치지 않도록 회귀를 보강한다.
- CLI가 정확한 호환 버전을 거부하던 문제를 고치고 Node/Bun/Tauri 범위를 CLI 자체 버전과 분리한다. 버전 준비 시 범위 동기화·검사를 추가하고 CLI patch changeset을 준비한다. `InitHosts.nodeRange`는 선택 속성으로 추가하며 기존 호출 형태를 유지한다.
- offline regression은 기존 CI에 연결한다. 공개 레지스트리 전체 여정은 별도 수동 macOS workflow로 남긴다.

npm manifest에는 공개 CLI가 지원하는 caret 표기를 유지하되 정확한 설치 입력·frozen lock·실제 설치 버전·registry 출처를 대조한다. 더 새 패치가 해석되어도 실패한다. 확장 fixture의 오류 전달 검사와 선언형 도메인 에러/이벤트 수락을 구분한다. 최종 로컬 검증 결과는 6절에 기록한다.

## 4. 미완료 요구사항과 다음 실행 순서

### M1: 다음 배포 전 도입 검증

1. **A1 지원 조합:** 정확한 공개 버전과 환경을 담은 영수증을 Node/macOS, Bun/macOS, Tauri/macOS 실제 WebView, RN/Android, RN/iOS별로 연결한다. simulator와 physical 구분을 유지한다.
2. **A2 첫 호출:** 현재 자동 도구의 결과를 확정하고, Tauri와 RN에서도 레지스트리만 쓰는 설치·생성·실행 영수증을 확보한다.
3. **A3 변경·오류·이벤트:** 필드 변경 후 재호출, 선언한 도메인 에러 처리, 이벤트 수신·unsubscribe를 각 경로에서 확인한다. fixture에서 성공한 부분과 기존 앱의 성공을 구분한다.
4. **A4 진단:** SDK 누락, 버전 불일치, stale 생성물, native 모듈 누락, 계약 불일치의 원인·대상·다음 조치가 사용자에게 보이는지 실제 실패 입력으로 검사한다. 기존 doctor 검사와 진단 구현을 먼저 재사용한다.
5. **A5 업그레이드:** 현재 Rust 패치 왕복에 이어 Tauri 기존 앱 1개와 RN 기존 앱 1개에서 JS·crate·생성물·native artifact를 묶어 업그레이드/한 단계 rollback한다. 소비자 저장소가 정해진 뒤 해당 저장소 범위에서 수행한다.
6. **A6 외부 평가:** Rustra 개발에 참여하지 않은 평가자 5명에게 같은 문서 경로를 제공한다. Tauri·RN Android·RN iOS 각 최소 1명을 포함하고, 첫 호출 성공 4명 이상, 개입 단계·해결·준비된 환경 시간·전체 시간을 기록한다. 모집/연락 채널은 사용자가 정하고 연락 권한을 부여해야 한다.

평가 기록의 최소 열: 익명 평가자 ID, Rustra 참여 여부, 호스트/OS/도구 버전, 정확한 package 조합, 시작/첫 성공 시각, SDK 다운로드 시간, 성공 여부, 막힌 단계, 도움 요청, 제공한 개입, 원본 로그. 평가자 관측 없이 성공률이나 첫 성공 시간을 추정하지 않는다.

### M2: 실제 소비자 2개를 선정한 뒤

- 목적·사용 흐름이 다른 비계산기 앱 2개를 정한다. 최소 한 앱은 동일 Rust 계약을 기존 호스트 2개에서 쓴다.
- 현재 정상 버전과 복원 경로를 먼저 보존하고 각 앱의 명령·이벤트·실패·취소·종료 업무 흐름을 명시한다.
- Tauri 실제 창 생성/탐색/닫기와 RN Android/iOS 실기기의 전경/배경/reload/종료를 100회 반복한다. 중복 전달·종료 후 반영·unhandled 오류 0개를 요구한다.
- 조합별로 실제 2시간 부하를 실행한다. warm-up 구간, RSS 시계열, pending/channel/subscription 기준값·정리 후 값, 예상 취소·timeout을 분리 기록한다.
- 각 소비자의 4주 사용 기록과 연속 2회 배포 업그레이드를 쌓는다. 날짜 경과만으로 완료하지 않는다.

사용 기록 최소 열: 소비자/commit/package/artifact 식별자, 날짜·실행 시간, 주요 업무 횟수, 호스트·기기·OS, 기대/실제 결과, 실패와 재현 절차, 수정 버전, 업그레이드 전후/rollback 결과. 관찰 기간의 시작은 실제 검증 실행일로 한다.

### M3: 실제 비용을 측정한 뒤

같은 기기·OS·profile·입력으로 작은 scalar, 중첩 데이터, 64 KiB/1 MiB bytes, 이벤트, 동시 호출·취소를 측정한다. cold/warm을 나누고 빌드별 독립 프로세스 최소 5회, p95 사용 시 warm-up 후 실행당 기본 1,000개 관측을 남긴다. 실제 업무에서 브릿지 비중이 큰 병목만 개선한다. 목표는 선택한 runtime p95/CPU 20% 또는 개발 루프 중앙값 30% 개선이며, 이득이 노이즈이면 보류한다. 코어 A/B를 실제 앱 개선으로 발표하지 않는다.

### M4: 후보를 동결한 뒤

G0–G3와 차단 결함 0개를 확인하고 공개 계약/API snapshot을 동결한다. 최소 4주·연속 두 후보의 실제 소비자 검증을 수행하며 계약 파손 시 영향 범위 관찰을 다시 시작한다. 지원/미인증 조합을 공개하고 UniFFI Phase 1 회귀·EN/KO 도입/업그레이드/rollback 문서·같은 SHA의 발행 게이트·배포 후 registry 소비를 끝낸 후 1.0을 판단한다.

## 5. 의존성 PR과 범위

2026-09-16 조회에서 열린 issue는 없고 Dependabot PR 네 개가 남아 있다.

| PR                                                                    | 조회 결과                                       | 후속 처리                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [#65 quote 1.0.47](https://github.com/loopy-lim/rustra/pull/65)       | 표시된 checks 성공                              | 최신 main 기준 변경 영향·CI 확인 후 별도 병합 판단                                                      |
| [#66 syn 3.0.5](https://github.com/loopy-lim/rustra/pull/66)          | 표시된 checks 성공                              | 매크로/API 영향 확인 후 별도 병합 판단                                                                  |
| [#67 serde_json 1.0.151](https://github.com/loopy-lim/rustra/pull/67) | 표시된 checks 성공                              | wire/직렬화 회귀와 최신 CI 확인 후 별도 병합 판단                                                       |
| [#68 Tauri 2.11.5](https://github.com/loopy-lim/rustra/pull/68)       | TypeScript 실패, consumer-smoke skip, gate 실패 | watch 파일시스템 변경 미수신 테스트를 최신 main 기준으로 다시 확인. Tauri 런타임 결함으로 단정하지 않음 |

#68의 실패는 [TypeScript job](https://github.com/loopy-lim/rustra/actions/runs/34683289667/job/103527075778)의 `watch.test.js`에서 `expected filesystem change was not delivered`였다. 이 실패만으로 Tauri 의존성 업데이트가 원인이라는 결론을 내릴 수 없다. 현재 main 기준으로 `node --test packages/cli/dist-test/watch.test.js`를 실행해 6개가 통과했다. 기존 PR의 원격 실패 상태를 이 로컬 결과로 바꾸지는 않는다.

이번 작업은 Rustra 검증/문서/CI 준비 범위다. 소비자 프로젝트 선정·변경, 실제 기기 설치와 장시간 테스트, 외부 연락, 공유 main 병합·발행은 각각 구체적 대상과 권한을 확인한 뒤 실행한다. 기존 미추적 Tauri 생성물과 `.zcode`는 원래 체크아웃에 보존한다.

## 6. 검증 기록

현재까지 이 작업 디렉터리에서 실행한 결과:

| 검사                                       | 결과                               | 범위                                                                |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------- |
| `bun run build`                            | 9개 package build 통과             | TypeScript 빌드                                                     |
| source onboarding 전체 cycle               | 10개 보고 단계 통과                | 현재 소스 주입, 계약 변경 후 재호출 포함; 공개 registry 증거와 별개 |
| 기존 release tool suite                    | 77/77 통과                         | release gate/audit/API/package 도구 회귀                            |
| 문서 도구 회귀                             | 37/37 통과                         | 문서 gate와 release 문서 검사                                       |
| `docs-gate.mjs` / `check-release-docs.mjs` | 통과                               | 70개 EN/KO 문서, 6개 synced region, 6개 설치/조합 문서              |
| CLI 전체 회귀                              | Node 328/328, Bun 27/27 통과       | 정확한 핀 보존과 독립 호스트 버전 포함                              |
| 신규 registry gate 회귀                    | 19/19 통과                         | 출처·오염·정확한 해석·실패 기록                                     |
| source onboarding 회귀                     | 20/20 통과                         | 숨은 준비 실패·빈 예외·runner 실패 중단                             |
| 버전/호환성 도구 추가 검증                 | 10/10 통과, release coherence 통과 | 각 호스트 범위 동기화·검증                                          |
| API snapshot                               | 통과                               | 선택 속성 `InitHosts.nodeRange` 추가만 의도적으로 반영              |
| codegen freshness                          | 6개 예제 통과, 도구 회귀 12/12     | CI와 같은 예제 의존성 설치 후 기존 생성물과 일치                    |
| architecture gate                          | 4/4 통과                           | 기존 모듈 경계                                                      |
| 현재 watch 테스트                          | 6/6 통과                           | 로컬 현재 main 기반; PR #68 원격 CI는 별도                          |

원본 로그는 `/tmp/rustra-m1-review/`에 보존한다. 공개 registry 첫 실행은 gate의 Cargo `[[bin]] path` 오탐으로 중단됐고, `/tmp/rustra-m1-live-20260916/receipt.json`에 실패가 기록됐다. 성공 영수증으로 덮어쓰지 않는다. 최종 registry 검증은 아래에 별도로 기록한다.

### CLI 도입 결함 수정의 직접 확인

공개 CLI `0.10.0`으로 실패했던 v2 소비자는 `@rustra/types`, `@rustra/node`, `@rustra/cli`의 정확한 `0.10.0` manifest를 유지했다. 수정한 로컬 CLI로 같은 소비자의 `codegen`, `codegen --check`, 기존 demo 호출(`hello from TypeScript`)이 모두 통과했다. 로그는 `exact-pin-candidate-codegen.log`, `exact-pin-candidate-check.log`, `exact-pin-candidate-call.log`다. 이 결과는 **로컬 CLI 수정 검증**이며, 아직 발행하지 않은 CLI 패치의 공개 설치 증거가 아니다.

codegen freshness의 최초 podspec 드리프트는 격리 작업 디렉터리에 예제별 의존성을 설치하지 않아 다른 위치의 어댑터를 찾은 환경 차이였다. 두 RN 예제의 frozen lock으로 의존성을 설치한 뒤 6개 검사 모두 통과했으며 추적된 생성물을 변경하지 않았다.

### 공개 패키지 전체 cycle: 통과

- [최종 v6 영수증](evidence/2026-09-16-registry-consumer.json): **88/88 단계 성공**, `ok=true`, 자동 실행 19.767초. Node/Bun/Rust SDK가 이미 준비된 이 macOS 환경의 자동 실행 시간이며 외부 평가자 온보딩 시간으로 일반화하지 않는다.
- macOS 26.6.2 arm64, Node 22.21.1, npm 11.18.0, Bun 1.4.1, Rust/Cargo 1.98.0에서 실행했다. 원격 수동 workflow의 Rust 1.95/Bun 1.4.0 환경은 아직 실행하지 않았다.
- 원래 Node scaffold 실행 후 별도 fixture를 확장했다. Node는 실제 Node 프로세스의 stdio 어댑터, Bun은 실제 cdylib FFI 호출이며 생성된 strict 계약 진입점을 사용했다.
- npm `cli/types/node/bun`은 매 단계 정확한 `0.10.0`과 공개 npm 출처·integrity를 확인했다. Rust 세 crate는 baseline `0.10.0`, candidate `0.10.1`, rollback `0.10.0`과 crates.io source/checksum을 확인했다.
- 변경한 `repeat=3`이 양쪽 호스트에서 반환됐다. rollback의 계약 hash `81e5f194f9fcb2113f8f21f92e463a53d9f49a8b60384e554dd877b22ce64c13`과 호출 결과가 변경 후 baseline과 일치했다.
- 오류 전달은 관측했지만 Node scaffold는 `transport.error` 안에 Rust 오류 문자열을 담고 Bun은 `command.invalid_args`를 반환했다. 따라서 두 경로의 선언형 도메인 에러 타입/코드 일치 수락으로 해석하지 않는다. 이벤트 구독·해제는 제외했다.
- 실행기 6개 파일의 hash가 최종 작업 소스와 일치하고, 세 phase의 보존된 lock/생성물 snapshot hash를 모두 다시 대조했다. 성공 소비자의 node_modules·Cargo cache/target·native binary는 정리됐고, native hash와 출력 디렉터리의 lock/생성물/실행기 snapshot·로그는 남았다.
- [실패 시도 기록](evidence/2026-09-16-registry-attempts.json)은 v1/v3의 검증기 경로 오탐, v2 공개 CLI 핀 결함, v4 FFI 등록 누락과 v5 fixture 치환 결함을 구분한다. 각각의 원래 실패 영수증을 성공으로 덮어쓰지 않았다. v4/v5는 Bun 어댑터 결함으로 기록하지 않는다.

전체 원본은 `/tmp/rustra-m1-live-20260916-v6/`에 있다. 저장소에 복사한 최종 JSON에도 원본 절대 경로를 유지했으며, 임시 디렉터리가 정리되면 그 경로의 raw log/snapshot은 사라질 수 있다. source/native/lock/생성물 hash와 관측 결과는 위 JSON에 남는다.

### 독립 검토

[최종 검토 기록](evidence/2026-09-16-m1-review.md)에서 요구사항·도구 품질·통합·CLI 수정 네 항목 모두 통과했다. 발견한 빈 예외의 실패 누락은 수정 후 별도 검증됐다. 리뷰어가 v6 영수증, 실행기 6개 소스 hash, phase snapshot 39개 파일 hash와 저장소 영수증 사본을 대조했으며 남은 조치 가능한 결함은 없었다. GUI/실기기·외부 평가·발행 수락을 포함하는 검토 결과는 아니다.

### 다음 실행 대상

이번 후보의 자동 도구·CLI 수정·문서·회귀 검증은 로컬에서 완료했다. 다음 저장소 내 단계는 이 변경과 CLI patch changeset을 리뷰 가능한 PR로 올리고 해당 SHA의 필수 CI를 거친 뒤 발행·공개 패치 재검증으로 연결하는 일이다. 현재 작업은 미커밋 `codex/m1-registry-onboarding`에 있으며 원격 push/PR/merge/publish를 수행하지 않았다.

병행할 제품 단계는 A1/A3/A4의 Tauri·RN 실제 실행과 오류/이벤트/진단 경로 보강이다. 소비자 앱 2개와 사용 가능한 Android/iOS 실기기 대상은 사용자 확인을 기다리고 있다. 해당 대상이 정해지면 4절의 순서로 실사용 검증을 진행한다. 다섯 평가자 관찰과 4주·장시간 기준은 실제 실행으로만 채운다.
