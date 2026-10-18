# DX·안전성·성능 구현 결과

기준 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6` 위 로컬 변경이다. 문서 정리 후
실제 개발을 요청한 범위에서 다음 실행 경로와 안전 장치를 구현했다. 커밋·푸시·
패키지 발행은 수행하지 않았다.

추가 요청 뒤 [호스트 실행 경로의 후속 구현](2026-10-13-host-followup-implementation.md)에서
dev의 오래된 실행 파일·실패 복구 결함, Node 응답 복사, Bun 큰 응답, 실제 scriptc
수명 검사를 더 진행했다. 아래 표는 첫 구현 묶음의 기록이며 추가 변경의 최신
수치와 검증 경계는 후속 기록을 따른다.

## 실제 바뀐 동작

- **코덱:** 큰 정수 시퀀스의 최소 저장 공간을 payload 한도 안에서 예약한다.
  `map_seq_1024` 할당은 호출당 12→7, 요청 allocation bytes는 16,973→13,828이다.
  거짓 map 길이 힌트가 `usize::MAX`여도 과도 예약으로 패닉하지 않는다.
  최종 5쌍에서 지연은 +1.58%였으며 시간 개선은 입증하지 못했다. 변경하지 않은
  대조군에도 +1.64%가 관측돼 원인 귀속은 보류했다. 시간 A/B와 작은 입력 대조군은 [성능 기록](2026-10-13-performance-implementation.md)에 있다.
- **성능 판정:** CPU가 다른 기준선·후보를 회귀율로 판정하던 오류를 막았다.
  비교 필수 환경이 다르거나 비어 있으면 exit 2와 비교 불가 원인을 남기며
  기존 기준선을 유지한다. 실제 실패 artifact의 Intel/AMD 차이를 확인했다.
- **scriptc:** async JSON 완료를 retained bytes channel로 전달하고 이벤트·바이트
  채널을 생성 코드에서 제공한다. callback identity와 context로 release하며
  in-flight callback 종료를 기다린다. 취소는 기존 cooperative cancellation을
  유지한다. 기존 sync ABI와 ambient 선언을 보존하고, 콜백에는 compiler가 실제로
  처리할 수 있는 source import entry를 추가했다. [실행 예제](../../../examples/calculator/scriptc/README.md)
- **RN 예제:** 생성기로 잘못 연결되던 Node 실행 경로를 실제 Rust consumer로
  연결하고 public package 오류 타입을 일치시켰다. gzip 해제 출력에 한도를 적용해
  압축 폭탄의 무제한 확장도 막았다. 동일 gzip 연산·동일 데이터의
  JSON/bytes 수집기를 만들었다. 5개 독립 실행, 실행 순서 교대, payload·소스·번들·
  native hash와 개별 호출 p50/p95를 검사한다. 할당·복사량은 미계측 상태로 명시한다.
- **개발 반복:** pnpm/Yarn 실제 설치·첫 호출·재실행·JS/Rust/계약 변경 후 호출을
  실행하고 단계별 시간·도구 버전·실행한 package/native hash를 영수증으로 남긴다.
  [DX 실행 기록](2026-10-13-dx-rn-implementation.md)에 원본과 hash를 보존했다.
  source injection과 registry-only를 구분한다. watch 감지 시간이나 SDK 다운로드를
  측정한 것처럼 표기하지 않는다.
- **큰 데이터:** [resident tree](../../../examples/resident-tree/README.md)가 생성 TS로
  load/find/update/release/clear를 실행한다. 이전 generation·해제된 핸들을 거부하고
  ID를 재사용하지 않는다. 초기 적재 비용과 조회 손익분기점을 기록한다.
- **안전성:** FFI의 유효 포인터·소유권 전제를 ADR 0004에 명시하고 실제 debug
  오용 child process·C++ 예외 containment·큰 입력 fuzz·release sanitizer를 추가했다.
  [안전성 기록](2026-10-13-safety-implementation.md)
- **네이티브 검사:** 실행 제한 시간과 ASan canary를 추가했다. Simulator에서
  canary의 실제 use-after-free 탐지를 확인한 뒤 production C++ binder/codec을
  검사한다. 두 스레드에서 Hermes 생성·폐기를 100회 수행했다.

## 검증 근거

모든 명령의 cwd는 저장소 루트다. 아래 통과는 이번 로컬 후보의 범위다.

| 검사                                                                               | 결과와 범위                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cargo test -p rustra -p rustra-calculator-example`                                | 541 passed, 0 failed, 3 ignored; doctest 포함                                                                     |
| `cargo clippy -p rustra -p rustra-calculator-example --all-targets -- -D warnings` | 통과                                                                                                              |
| `CARGO_NET_OFFLINE=true bun run --cwd packages/cli test`                           | Node 507/507, Bun 추가 45/45                                                                                      |
| `bun run test:packages:check`                                                      | debug calculator 바이너리 빌드 후 모든 package suite 통과                                                         |
| `bun run test:release-tools`                                                       | 128/128                                                                                                           |
| `bun run test:bench-gate`                                                          | 39/39                                                                                                             |
| `bun run test:architecture`                                                        | 4/4                                                                                                               |
| `bun run test:codegen-fresh:check`                                                 | 7개 예제 freshness 통과                                                                                           |
| 후보 React Doctor 0.9.12                                                           | 100/100, 588 files, 경고 0; 원본 사용자 파일 2개 및 ignored worktree 제외                                         |
| 후보 Node TS 검사                                                                  | 74 passed, 0 failed, 1 skip(NAPI 바이너리 없음)                                                                   |
| `bun run test:api-surface`                                                         | 새 scriptc ABI를 검토·snapshot 갱신한 뒤 일치                                                                     |
| `bun run test:runtime:scriptc`                                                     | compiler 0.2.1 실제 native executable: sync 42, async 42, events 2, bytes 3                                       |
| `bun run test:app:resident-tree`                                                   | Rust lifecycle + 실제 생성 TS consumer 통과; 37,776→48 JSON 인자 bytes                                            |
| `bun run verify:consumer:react-native`                                             | packed RN adapter 설치·해석 검사 통과; 앱 실행 증거 아님                                                          |
| Linux ARM64 ASan+LSan                                                              | lib 227, FFI debug 42, release 41; 안전성 기록의 원본 로그·hash 참고                                              |
| 큰 입력 fuzz                                                                       | 601초, 1,736,052회, crash 0, 최대 RSS 395MiB                                                                      |
| iOS Simulator ASan/Hermes                                                          | 1,412 assertion, 실패 0, runtime 재생성 100회; [receipt](../../verification/evidence/2026-10-13-native-asan.json) |

native 검사는 실제 Hermes와 production binder/codec을 쓰지만 Rust C ABI peer는
controlled fixture다. prebuilt Hermes/RNDependencies 자체를 ASan으로 다시 빌드한
검사나 실기기 앱 검증은 아니다. 바이너리와 관련 소스 SHA를 receipt에 보존했다.

새 API·소유권·코덱·resident·수집기 경계는 별도 작업자의 독립 코드 리뷰를 받았다.
resident runner가 사용자 `CARGO_TARGET_DIR`를 무시할 수 있다는 지적을 수정해
Cargo metadata가 반환한 정확한 바이너리 경로를 schema와 client 양쪽에 전달한다.
`CARGO_TARGET_DIR=target/resident-tree-isolated node examples/resident-tree/run.mjs`도
새 target에서 직접 빌드·실행해 통과했다.

전체 작업 폴더의 lint/typecheck는 기존 미추적 파일에서 실패했다:
`examples/calculator/apps/scriptc-bench.ts`의 triple-slash 규칙 위반과
`bun-ffi-bench.ts:70`의 `number | bigint` 타입 오류다. 두 사용자 파일을 변경하지
않았다. scoped lint는 오류 0, 기존 경고 7개다. 후보 snapshot 검사 결과는 별도 DX
[DX 검증 기록](2026-10-13-dx-rn-implementation.md)에 보존했다.

## 남아 있는 검증

원래 [후속 목록](2026-10-13-dx-safety-performance-next.md)의 완료 조건을 낮추지 않았다.

| 항목  | 남은 범위                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| D1/P1 | 새 SHA의 GitHub 전체 CI와 동일 러너 benchmark 재실행. 로컬 수정으로 과거 원격 실패가 사라진 것은 아님      |
| D2    | 후보 발행 및 공개 registry만 사용하는 모든 호스트의 업그레이드·롤백 여정                                   |
| D3    | watch 감지·컴파일 실패·정확한 원상 복구는 후속 구현에서 검증. SDK 설치 시간과 외부 신규 사용자 관찰은 남음 |
| D5    | 실제 scriptc 취소·해제·queued/late 전달은 후속 스트레스에서 검증. 장시간 및 전체 sanitizer 판정은 별도     |
| S4    | RN 실기기/실제 Tauri 앱 조합별 2시간 soak, 두 소비자 4주 사용                                              |
| P3/P4 | E1/A2와 gzip 수집기의 iOS/Android 실기기 5회 행렬 및 할당/복사량 계측                                      |
| P5    | 모든 host의 동일 연산 종합 성능 수집. 이번 채택 범위는 코덱 할당 개선이며 앱 속도 개선율로 확대하지 않음   |

완료 평가는 **로컬 구현·연결·회귀 검사 PASS, 외부 검증 BLOCKED**다. 원격 배포,
실기기, 장기 사용 조건까지 모두 완료했다는 판정은 아니다. 검증과 구현 기록을
분리해 남겼으며 추가 승인 없이 수행할 수 있는 호스트 개발과 검사를 실행했다.

현재 연결된 Android 기기는 없다. 앱의 시각적 UI 변경은 없으므로 UI 디자인 검토는
해당하지 않는다. 실기기·장기간·배포 이후의 검증을 수행한 것으로 표시하지 않았다.
