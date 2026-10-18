# Rustra DX와 안전성 및 성능 현황과 후속 작업

2026-10-13 기준으로 다음 순서는 **전체 CI 복구 → 비교 가능한 성능 기준선 확보 → 배포물 DX와 네이티브 수명 검증 → 병목별 최적화**다. DX 자동화와 여러 최적화는 이미 구현돼 있다. 지금 가장 먼저 해결할 것은 전체 CI의 React Doctor 실패와 Benchmark의 비교 환경 차이다. RN 실기기 성능, 네이티브 sanitizer, 장시간 안정성은 별도 완료 조건으로 유지한다.

기준 소스는 로컬 HEAD와 GitHub main이 일치하는 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`이다. 아래 원격 상태와 npm 메타데이터는 2026-10-13에 조회했다. 과거 측정값에는 당시 날짜와 범위를 붙였다. 후속 작업의 우선순위는 제안이며, 체크박스는 실제 완료 증거를 확보한 뒤 갱신한다.

## 실제 개발 후 갱신

후속 요청에 따라 코드 구현까지 진행했다. 현재 변경과 실제 검증 결과는
[구현 결과](2026-10-13-dx-safety-performance-implementation.md)에 모았다.
아래 원격 상태는 **개발 시작 시점의 감사**다. 로컬 검사를 새 원격 CI나 공개
배포물의 성공으로 바꾸어 표기하지 않는다. 체크된 항목만 이번 검증으로 닫았다.

## 개발 시작 시점 상태

| 영역          | 확인한 상태                                                                             | 다음 판단에 필요한 것                                                     |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| DX            | Node/Bun 초기 생성·첫 호출·변경 후 재생성 경로, RN 준비 명령, 기존 Tauri 명령 합성 구현 | 최신 소스가 담긴 공개 패키지로 동일 여정 검증, 실제 모바일 준비 경로 확인 |
| 전체 CI       | 10월 10일 push 실행 실패. `ts-checks`와 집계 `gate` 실패, `consumer-smoke` 생략         | React Doctor 원인 해결 후 전체 필수 작업 성공                             |
| Rust 안전성   | 동일 SHA의 Miri, ASan+LSan, Fuzz 검사 성공                                              | FFI 통합·RN native·장시간 실행 범위 확대                                  |
| 성능 회귀     | Benchmark 측정 6단계 성공, 10% 회귀 예산 검사 실패                                      | 기준선과 후보를 같은 환경에서 재측정하여 코드와 환경 영향을 분리          |
| 모바일 성능   | E1/A2 구현과 호스트 검증 기록 존재                                                      | iOS/Android 실행 행렬과 채택·기각 판정                                    |
| 실사용 안정성 | 호스트별 수명 회귀 테스트와 smoke 존재                                                  | 100회 수명주기, 조합별 2시간 부하, 실제 소비자 장기 사용                  |

### 원격 검사와 배포 출처

| 검사      | 실행 기록                                                                          | 해석                                                                                                      |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 전체 CI   | [10월 10일 push](https://github.com/loopy-lim/rustra/actions/runs/38056499939)     | React Doctor 92/100, `deslop/unused-file` 경고 6개로 실패                                                 |
| 예약 CI   | [10월 12일 schedule](https://github.com/loopy-lim/rustra/actions/runs/38247198205) | `rust-audit`만 성공. 나머지 작업은 생략됐으므로 전체 CI 성공 증거가 아니다                                |
| Miri      | [검사 성공](https://github.com/loopy-lim/rustra/actions/runs/38185899042)          | lib, frame wire, field order 검사 단계 성공                                                               |
| Sanitizer | [검사 성공](https://github.com/loopy-lim/rustra/actions/runs/38189058035)          | Linux의 `rustra --lib`, ASan+LSan 범위                                                                    |
| Fuzz      | [3개 타깃 성공](https://github.com/loopy-lim/rustra/actions/runs/38092426635)      | 시드 재생과 타깃별 600초, 최대 입력 1,024바이트                                                           |
| Benchmark | [회귀 예산 실패](https://github.com/loopy-lim/rustra/actions/runs/38056499946)     | 59개 항목이 10% 예산 초과. `host` provenance 차이 경고도 발생. 결과는 `criterion-results-rejected`로 보존 |

표의 모든 실행은 기준 SHA와 일치한다. Benchmark의 `optional_string_64k`는 평균 변화 +1048.94%로 보고됐다. 다른 항목도 광범위하게 느려졌지만, 이 결과만으로 코드 회귀나 환경 문제 중 하나를 확정할 수 없다. 기존 기준선을 유지하고 동일 러너의 두 리비전 비교로 판정해야 한다.

공개 npm의 `@rustra/cli@0.12.0`과 `@rustra/types@0.12.1`은 조회 시점에 모두 `gitHead=162c0002d55001ad1dd4fa48dcbb8866e994fe4f`였다. 최신 main과 출처가 다르므로 10월 3일 이후 소스의 개선을 현재 설치 제품의 기능으로 묶어 설명하면 안 된다. 이번 출처 조회는 이 두 패키지의 메타데이터 범위이며 전체 npm·crates 배포 감사는 D2에서 수행한다.

## 이미 반영된 개선과 성능 근거

### DX와 수명 관리

- `init --setup`, `setup --run`, `try:node`, `try:bun`으로 생성·설치·빌드·첫 호출을 연결했다. 실패 단계에서 재시도할 수 있고 기존 사용자 설정과 스크립트를 보존한다. [첫 호출 개선 기록](2026-10-03-easy-onboarding.md)
- `rustra dev`는 Rust 입력 지문으로 불필요한 Cargo 실행을 줄이고, 불확실한 입력은 다시 빌드한다. 생성물 소유권, workspace/path dependency, 종료 후 발행 방지까지 다룬다. [런타임 감사](2026-10-02-dx-runtime-audit.md)
- Node 실행 경로·오류, Bun 이벤트 sink 소유권, RN bootstrap/async/channel 해제, Tauri 계약 검증·명령 합성을 보강했다. 준비 상태·취소·오류가 호출자에게 전달되는 경로가 검증 대상이다. [개발 흐름 개선](2026-10-03-dx-workflow-improvements.md)
- 소유형 async pool의 drain/join은 구현돼 있다. 운영 전역 풀의 프로세스 수명은 기존 설계다. 과거 Miri의 남은 스레드 실패를 현재 미해결 결함으로 다시 등록하지 않는다. [풀 구현](../../../crates/rustra/src/ffi_pool.rs)

### 실행 속도와 할당

2026-10-02의 Node/Bun 기록은 당시 미커밋 변경을 포함한 로컬 소스에서 경로별 다수의 개별 호출을 측정하고, 이를 세 차례 반복한 결과다. 소스와 native artifact 해시는 영수증에 기록돼 있다. 평균은 5% trimmed mean이다. 최신 HEAD의 재측정이나 모든 기기의 성능을 뜻하지 않는다. [측정 근거](2026-10-02-dx-runtime-audit.md#현재-후보-성능)

| 호출 경로               |         평균 |          p95 |
| ----------------------- | -----------: | -----------: |
| Node generated one-shot | 3,152.324 µs | 3,745.542 µs |
| Node persistent JSON    |    29.642 µs |   103.750 µs |
| Node persistent binary  |    26.955 µs |    89.375 µs |
| Node NAPI               |     2.812 µs |     5.958 µs |
| Bun generated FFI       |     6.213 µs |    16.042 µs |

이 비교에서 반복 호출의 프로세스 시작 비용이 크게 드러난다. NAPI·FFI·persistent는 배포 방식과 상태 수명도 다르므로 지연만으로 기본 transport를 일괄 변경하지 않는다.

Tauri는 같은 날 실제 macOS WebView에서 30,000회 호출, 평균 368.679 µs를 기록했다. p95 442 µs는 **1,000회 묶음의 호출당 평균 분포**이므로 위 표의 개별 호출 p95와 직접 비교하지 않는다. 측정 전후 native/frontend artifact 해시는 같지만 병렬 CLI 편집으로 전체 source hash는 달랐다. RN의 당시 Hermes 측정은 controlled C ABI peer를 사용한 호스트 검사이며 실제 Rust 코어의 모바일 성능 A/B가 아니다.

| 개선                  | 구현과 확인된 효과                                                                                               | 남은 경계                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| E1 큰 응답 owned 경로 | 512B 초과 응답에서 두 번째 FFI 호출과 임시 복사 경로를 줄이는 구현 존재                                          | 설치 교대·정확한 free 페어링·실기기 성능 채택 판정                            |
| A2 1필드 함수 경로    | 생성 함수의 라우트 캐시·fallback 구현. 10월 10일 호스트 기록은 호출 660,004회와 route 660,004회 일치, fallback 0 | Hermes 모바일 레인별 A/B. 호스트 개선율을 모바일 개선율로 일반화하지 않음     |
| 맵 인코더 spill       | 64항목 임시 저장소 할당 5회에서 1회로 감소. 회귀 테스트 존재                                                     | 시간 변화 −2.1%는 대조군 ±3~6% 변동 안이므로 확정 속도 개선으로 표현하지 않음 |
| resident 라우트       | 큰 구조를 Rust에 두고 참조로 접근하는 가이드 존재                                                                | `todo!()` 없는 실행 예제, 초기 적재·수명·손익분기점 검증                      |
| 측정 하네스           | 출처 기록 누락 시 비교 불가 판정, dev 전용 벤치의 release 실행 가드 구현                                         | 환경 차이는 현재 경고이므로 동일 환경 비교를 통한 실제 판정 필요              |

근거: [성능 종합 평가](../../performance-evaluation.ko.md), [10월 10일 호스트 기록](../../benchmark-receipts/2026-10-10-host-gates-reverify.md), [맵 저장소 구현](../../../crates/rustra/src/complex_serde_map_scratch.rs), [측정 판정기](../../../scripts/check-criterion-regression.mjs).

10월 10일 호스트 기록의 소스는 `4578c851`이며 Hermes 1,412 assertion, 실패 0이다. 현재 HEAD 재실행 증거와 구분한다. oneOf의 변종 순차 탐색 제거와 맵 디코더의 키 임시 벡터 제거는 이미 계측으로 기각된 가설이므로 신규 작업에 넣지 않는다.

## 먼저 해결할 작업

### D1 전체 CI와 소비자 검사 복구

- [ ] **P0** React Doctor가 보고한 RN 실험 생성물 6개의 실제 사용 경로와 검사 진입점을 확인한다. 생성물 전체 제외나 경고 무시로 통과시키지 않고, 쓰는 파일은 진입점에 연결하고 불필요한 출력이면 생성기에서 바로잡는다.
- 대상: `examples/rn-experiment/generated/{contract,frame-codecs,frame-registry,node,react-native}.ts`, `examples/rn-experiment/modules/rustra-bridge/src/index.ts`.
- 완료: CI와 동일한 React Doctor 0.9.12 검사에서 100/100·경고 0, 필요한 생성물 freshness 통과, 수정 SHA의 `ts-checks`·`consumer-smoke`·집계 `gate` 실제 성공. 기존 ESLint 경고 7개는 별도 정리 대상으로 추적한다.

### P1 Benchmark 실패 원인과 기준선 확정

- [ ] **P0** 실패 실행의 기준선 SHA·CPU·OS·툴체인·프로파일과 현재 기록을 대조하고, 기존 `comparison_ref` 경로로 두 리비전을 동일 러너에서 비교한다. 측정 중 빌드와 다른 벤치를 겹치지 않는다.
- 대상: [.github/workflows/bench.yml](../../../.github/workflows/bench.yml), [비교 실행기](../../../scripts/benchmark-comparison.mjs). `optional_string_64k` 같은 큰 차이는 전체 환경 요인을 분리한 뒤 개별 계측한다.
- 완료: 비교 가능한 출처 쌍, 원본 측정값, 전체 10% 예산 판정, 원인과 채택 여부를 남긴다. 기준선 덮어쓰기나 임계값 완화만으로 종료하지 않는다. 환경 때문에 비교할 수 없으면 그 상태를 명시한다.

### S1 FFI 안전 계약과 호출자 의무 정합성

- [x] **P0** [안전 계약](../../safety-contract.ko.md)의 총괄 보장과 S3를 일치시킨다. 총괄은 악의적인 계약 위반도 UB가 없어야 한다고 쓰지만 S3와 실제 release free는 유효한 포인터·정확한 소유권·한 번의 해제를 호출자에게 요구한다.
- 실제 [release free](../../../crates/rustra/src/ffi_lifecycle_entries.rs)는 debug live 추적기 없이 헤더를 읽는다. 잘못되거나 이미 해제된 포인터의 헤더 읽기 자체를 안전 보장으로 설명할 수 없다.
- 완료: 악성 **바이트 입력**의 검증과 unsafe **포인터 전제**를 구분하고, 필요 방어 범위와 비용을 결정한다. 의미가 바뀌는 계약은 기존 규칙에 따라 ADR을 추가하고 EN/KO·주석·테스트를 맞춘다. 외래 C++ 예외의 ABI별 동작도 같은 검토에 포함한다.

### P2 성능 문서와 측정 설계 정리

- [x] **P0** 성능 평가의 중복 맵 설명, 기각된 병목 가설, A2 Hermes의 오래된 미실행 상태를 최신 기록과 연결한다. 호스트 통과와 기기 대기는 분리한다.
- [x] [측정 런북](../../measurement-runbook.ko.md)에서 Simulator 기본 절차와 physical iPhone 절차를 구분하고, Hermes 스크립트의 `sh` 실행을 실제 shebang에 맞는 `bash`로 고친다.
- [x] rn-experiment의 **gzip과 uuidV7 지연 비교로 bytes 우위를 채택하는 기준**을 바꾼다. 서로 다른 연산은 transport 차이를 분리할 수 없다. 동일 gzip 연산·동일 입력의 JSON/bytes 경로를 비교하고 uuid는 별도 실행 대조군으로 둔다.
- 완료: EN/KO가 같은 판정 규칙을 설명하고 `bun run test:docs` 통과. 과거 측정값을 새 실행 결과로 바꾸지 않는다.

## DX와 개발 속도 후속 작업

### D2 공개 배포물의 생성부터 변경까지 검증

- [ ] **P1 · D1 이후** 후보 소스·changeset·패키지 내용을 맞추고, npm/crates 출처와 tarball의 native 자산·생성 entry를 확인한다. 실제 발행은 별도 릴리스 단계로 수행한다.
- Node/Bun: 공개 패키지만으로 `init → doctor → 첫 호출 → Rust 계약 변경 → stale 실패 → 재생성 → 재빌드 → 변경된 호출 → 버전 롤백`을 확인한다.
- RN/Tauri: 기존 앱의 명령·플러그인·상태를 보존하면서 연결하고, SDK 준비·native 재빌드·앱 실행까지 기록한다. MockRuntime이나 JS 어댑터 테스트로 앱 실행을 대체하지 않는다.
- 완료: 정확한 버전·registry URL·integrity/체크섬·소스 SHA와 호스트별 호출 결과. 로컬 path/override 주입 여부도 식별한다.

### D3 첫 성공과 수정 반복 시간 계측

후속 구현에서 [실제 watch·컴파일 실패·정확한 원상 복구](2026-10-13-watch-runtime-recovery.md)를
Node/Bun으로 실행했다. 이 과정에서 오래된 실행 파일 사용과 실패 뒤 지문 캐시 결함을
수정했다. 아래 전체 항목은 SDK·외부 관찰 조건이 남아 있어 계속 미완료다.

- [ ] **P1** 준비된 환경에서 첫 Rust 호출까지 걸린 시간, 실패 후 복구 시간, 변경 감지부터 재호출까지의 시간을 기록한다. SDK 다운로드, cold build, warm build, 순수 JS 변경, Rust 구현 변경, 계약 변경을 나눈다.
- `pnpm`/`yarn`은 선택 로직뿐 아니라 실제 설치·재실행을 확인한다. 문서에 남아 있는 Node/Bun 15분, RN/Tauri 30분 목표는 관측 실적으로 바꾸어 쓰지 않는다.
- 완료: 반복 측정과 단계별 로그, 설정 보존, stale artifact 오사용 없음. 외부 평가자 5명 관찰은 자동화 실행 시간과 별도로 진행한다. [기존 도입 기준](../../specs/2026-09-14-rustra-roadmap.md)

### D4 큰 데이터의 실행 가능한 resident 예제

- [x] **P2** [현재 가이드](../../rust-api-guide.ko.md)의 `loadTree`를 실제 구현한 예제로 확장한다. load/find/update/release, 잘못된 핸들, 종료 시 해제, 갱신 후 캐시 무효화를 포함한다.
- 완료: 생성 TS로 실행되고 전체 왕복과 resident 경로가 같은 결과를 반환한다. 초기 적재 비용을 포함한 반복 조회 손익분기점을 제시한다. 코드젠 안내는 검토 후 추가하며 기존의 큰 배율을 모든 데이터에 적용하지 않는다.

### D5 scriptc 비동기 표면

후속 [실제 compiler 스트레스](../../../examples/calculator/scriptc/README.md)에서
큐 복사·해제·취소·늦은 완료를 추가 검증했다. 해제 전에 이미 큐에 들어간 closure의
배수와 새 native delivery 차단은 다른 계약이다. 전체 sanitizer/장기 조건과 구분한다.

- [ ] **P2 · S1 이후** [기존 조사](2026-10-10-scriptc-async-callback-format25.md)를 바탕으로 완료 콜백의 소유→차용, C ABI, 취소 토큰 반환 계약을 확정한다. 현재 async/event/channel 제외는 구현 완료로 표시하지 않는다.
- 순서: 최소 Rust shim → 코드젠 descriptor → 실제 async 완료 → 이벤트 → 채널. 핀된 compiler와 기존 sync 경로는 유지한다.
- 완료: 실제 compiler/runtime의 취소·해제·종료 후 늦은 callback 검사, 누수 없음, 생성물 일치. 새 ABI는 API/안전 계약 검토를 거친다.

## 안전성과 실사용 안정성 후속 작업

### S2 Rust sanitizer와 fuzz 범위 확대

- [x] **P1 · S1 이후** ASan+LSan에 기존 `trust_baseline_ffi`, `payload_robustness` 통합 검사와 release 소유권 경로를 추가한다. 일반 debug/release CI는 이미 있으므로 sanitizer 범위를 정확히 확장한다.
- [x] **P2** fuzz의 큰 유효 입력·재귀 깊이·1MiB 경계 검사를 보완한다. 현재 1KiB 캠페인은 유지하고 큰 입력 캠페인의 시간·메모리 예산을 별도로 정한다.
- 완료: candidate SHA·툴체인·대상·제외 항목·원본 로그·종료 코드, 실패 입력의 보존과 재생. 런타임 한도를 끄거나 sanitizer 오류를 숨기지 않는다.

### S3 RN native sanitizer 실행 환경 확보

- [x] **P1** [10월 2일 기록](2026-10-02-dx-runtime-audit.md#증거의-경계)의 macCatalyst ASan 시작 전 정지를 최소 probe로 다시 분류한다. Linux Rust ASan 성공은 이 검사를 대체하지 않는다.
- 완료: empty-main이 시작·종료되는 계측 환경에서 production binder/codec, callback, dispose/invalidate, 큰 응답 free를 실행한다. 환경 실패와 코드 결함을 나누고 바이너리·SDK·Hermes·로그를 식별한다.

### S4 실제 앱의 반복 수명과 장시간 부하

- [ ] **P1** Tauri/macOS의 실제 창 생성·탐색·종료와 RN Android/iOS 실기기의 전경·배경 전환을 포함한다. 구독 직후 이벤트, callback 내부 해제, 초기화 중 dispose, 재연결, 취소, reload, 앱 종료를 조합한다.
- 완료: 기존 로드맵의 수명주기 100회에서 중복 전달·종료 후 호출 반영·unhandled 오류 0, 예상된 취소·타임아웃 별도 집계. 조합별 2시간 부하에서 구독·channel·pending의 기준값 복귀와 설명되지 않는 warm-up 이후 RSS 증가 없음을 확인한다. hot-core는 버전당 라이브러리 매핑 유지라는 의도된 비용과 비정상 누적을 구분한다.
- 서로 다른 소비자 2개의 4주 사용과 업그레이드 2회는 장기 기준으로 남긴다. 실행 빈도·주요 작업·문제를 기록하고 2시간 부하로 장기 사용을 대체하지 않는다. 실기기가 없는 조합은 미완료로 표시한다. [검증 체크리스트](../../verification-checklist.md)

### S5 외래 예외와 오용의 프로세스 경계 검증

- [x] **P2 · S1 이후** C/C++ 자식 프로세스 harness에서 외래 예외, 잘못된 allocator, 길이 불일치, 중복 free를 확정한 계약에 맞춰 검사한다.
- 완료: 실제 종료 코드와 진단, 정상 경로 무회귀. Rust panic 테스트나 free 판정기의 단위 테스트만으로 C++ 예외·실제 abort를 입증했다고 쓰지 않는다. 아직 구현되지 않은 harness의 명령을 완료 절차처럼 제시하지 않는다.

## 실행 성능 후속 작업

### P3 E1과 A2 모바일 A/B

- [ ] **P1 · P1과 P2의 측정 기준 확정 이후** 기존 [런북](../../measurement-runbook.ko.md)의 iOS/Android 행렬을 실행한다. E1은 Rust+C++ 조합을 함께 고정하고, A2는 native SHA를 유지한 채 JS 번들만 교대한다.
- E1 완료: handler 1회, 해제 페어링, 큰 응답 이득, 작은 응답 무회귀, 독립 실행의 원본 표본과 신뢰구간.
- A2 완료: indexed 8개·string 2개 레인, generation/reset·fallback 정확성, 동일 native SHA·서로 다른 bundle SHA, 성능과 무회귀 판정.
- 호스트 또는 Simulator 결과와 실기기 결과를 각각 기록한다. 채택 근거가 없으면 구현 존재와 성능 미판정을 함께 유지한다.

### P4 rn-experiment 수집기와 동일 연산 비교

- [ ] **P1 · P2 이후** 수정된 동일 gzip JSON/bytes 비교를 실제 RN 수집기에 구현한다. iOS/Android 플랫폼별 독립 5회와 실행 순서 교대를 기록한다.
- 완료: payload SHA, 압축·복원 일치, p50/p95, 할당/복사량, 실행 순서별 결과, 원본 receipt. uuid의 속도를 gzip transport 우위의 채택 기준으로 사용하지 않는다.

### P5 남은 비용을 분해한 뒤 최적화

추가 [호스트 구현](2026-10-13-host-followup-implementation.md)에서 Node 분할 프레임의
반복 복사를 제거하고 Bun 큰 응답의 probe/retry 비용을 줄였다. 독립 5쌍과 raw 표본을
남겼으며, Node 중간 응답의 비용 증가와 Bun 작은 응답의 불확실성도 함께 기록했다.

- [ ] **P2 · P1 이후** `map_seq_1024`, `optional_chunks_near_1m`, 작은 호출의 encode/dispatch/transport/decode 비용을 분리한다. 맵 디코더의 소비자 타입 할당을 코덱 고정 비용으로 잘못 분류하지 않는다.
- Node의 one-shot/persistent/NAPI, Bun FFI, Tauri, RN을 동일 작업·동일 payload로 측정하되 의미가 다른 분포를 섞지 않는다. 개발 루프 시간은 D3에서 별도로 관리한다.
- 완료: 대조군 포함 A/B, 출처와 native artifact 해시, 처리량·개별 호출 p50/p95·할당·RSS, 소형/대형 무회귀. 안전 계약·새 응답 객체·재진입·취소 동작을 유지한다.

## 실행과 완료 판정

우선 묶음은 D1·P1·S1·P2다. 이후 D2/D3, S2/S3/S4, P3/P4를 필요한 환경에 맞춰 진행하고 D4/D5/S5/P5로 이어간다. 외부 평가·실기기·장기 사용을 기다리는 동안 가능한 호스트 작업은 계속 진행할 수 있다.

저장소 루트에 정의된 주요 명령은 아래와 같다. 이 문서 작성에서 새 벤치나 전체 테스트를 실행한 결과로 표시하지 않는다.

```bash
# 문서·측정 도구·생성물 검사
bun run test:docs
env -u RUSTRA_BUN_LIBRARY bun run test:bench-gate
bun run test:codegen-fresh
bun run test:release-tools

# CI와 동일한 React Doctor 버전과 검사 범위
bunx --bun react-doctor@0.9.12 . --yes --scope full --verbose --blocking warning

# Rust FFI 일반 검사. sanitizer 검사는 Linux nightly 설정이 별도로 필요하다.
cargo test -p rustra --test trust_baseline_ffi --test payload_robustness
cargo test -p rustra --release --test trust_baseline_ffi --test payload_robustness

# 실행 비용 수집. GUI가 필요한 Tauri 포함 여부와 출력 파일을 명시한다.
env -u RUSTRA_BUN_LIBRARY bun scripts/host-bench.mjs --skip-tauri --output /tmp/rustra-host-next.json
```

성능 측정은 기준선과 후보의 소스·툴체인·프로파일·입력·호스트 상태를 고정하고 순차 실행한다. CI와 Benchmark를 각각 확인하며, 소스 테스트·패키지 설치·앱 실행·실기기 승인·장기 검증을 별도 완료 상태로 기록한다.

## 최초 감사의 범위

현재 소스, 저장된 실행 기록, 원격 job/step 및 실패 로그, npm 메타데이터를 대조했다. 이 절은 최초 감사 범위다. 이후 실제 구현과 검증은 위 구현 결과에 기록했으며, 완료 조건을 충족한 항목만 체크했다. 기존 미추적 `bun-ffi-bench.ts`와 `scriptc-bench.ts`는 작성 중인 파일로 보존했고 새 성능 근거에 포함하지 않았다. 커밋·푸시·이슈 등록·패키지 발행은 이 문서 작성에 포함하지 않았다.
