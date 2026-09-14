# Rustra M0 안전성·릴리스 구현 검증

- 기준: `b1ed9aa422fb4e627131f02f67de9f50bdbfedf7` 위 `codex/m0-safety-release-gates` 작업 트리
- SPEC: [로드맵 M0 실행 계약](../specs/2026-09-14-rustra-roadmap.md)
- PLAN: [M0 실행 계획](../plans/2026-09-14-m0-safety-release.md), [G0 성능 기준선 계획](../plans/2026-09-14-g0-performance-baseline.md)
- 상태: M0-1~M0-5 구현, 최신 후보 로컬 안전성 검증과 코어 성능 A/B 완료. 새 GitHub Actions 실행·발행은 미수행.

## 원인과 수정

| 항목             | 수정 전 근거                                                                                                                                            | 구현                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miri 종료        | 기존 a08 단일 테스트는 통과한 뒤 `the main thread terminated without waiting for all remaining threads`로 exit 1. 기존 원격 run 34787154794와 같은 증상 | `AsyncPool`이 sender/worker handle을 소유한다. 테스트는 실제 풀을 소유하고 Drop에서 disconnect → 큐 배출 → join한다. 운영 전역 풀은 프로세스 수명 유지. 빠른 worker가 제출 계측보다 먼저 완료해 inflight가 underflow하던 경합도 예약 후 제출로 수정 |
| ASan/LSan        | 기존 lib 172개 통과 후 exit 1. 보존한 보고서는 **2,946 bytes / 54 allocations**. 심볼화한 경로는 재귀 complex schema compile/codec 테스트               | `Arc<IrNode> → Ref → Arc<OnceLock<Arc<IrNode>>> → ancestor` 순환을 `Weak` 역참조로 변경. self/mutual/shared/컴파일 실패 소유권 해제 회귀 추가                                                                                                       |
| 가려진 Miri 누수 | 풀만 수정한 중간 상태는 스레드 종료 오류가 사라진 뒤 **54개 메모리 누수**를 보고                                                                        | codec 소유권 수정이 Miri와 ASan 모두에 필요함을 확인. ASan도 워커 때문이라는 최초 가설은 폐기                                                                                                                                                       |
| 로그 부재        | 기존 workflow는 crate working directory의 상대 `asan.<pid>`를 놓쳤으며 target 경로도 `-gnu`가 빠짐                                                      | 절대 `target/safety/asan` 경로, stdout/stderr와 exit-code 기록, SHA/toolchain 기록, always 업로드. Miri suite는 하나가 실패해도 나머지를 실행하며 전체 실패는 유지                                                                                  |
| 발행 게이트      | 기본 CI 성공만으로 npm 자동 경로가 진행하고 수동 cargo도 CI만 확인                                                                                      | 두 경로 모두 고정 후보 SHA의 CI 및 새 Miri/Sanitizer/Fuzz 성공에 의존. CI는 발행 직전 재확인. schedule 부분 CI와 최신 실패·취소·대기 결과를 성공으로 간주하지 않음                                                                                  |
| 배포 출처        | 버전 표만으로 gitHead/crate source를 재조회할 수 없음                                                                                                   | 읽기 전용 JSON/Markdown 감사. 9 npm/3 crate exact/latest와 출처, archive checksum, 로컬 생성/native hash를 구분                                                                                                                                     |

원본 재현 로그는 `/tmp/rustra-m0/miri-before.log`,
`/tmp/rustra-m0/asan-before/asan.2477`이다. ASan 보고서의 주소를 같은 바이너리의
`addr2line`으로 심볼화해 `complex_schema_ir_compile.rs`와 재귀 codec 테스트로
연결했다. 원격 ASan 보고서 자체는 기존 upload 누락으로 남아 있지 않으므로,
원격 exit 1의 상세 원인은 이 로컬 재현과 구분한다.

## 계약과 비용

공개 Rust/FFI/TS API, wire 형식, worker 2개/queue 256개, 독립 버전 정책은 유지한다.
재귀 스키마는 안전한 Value 경로를 사용하므로 중간 Value 트리 할당이 생긴다.
release A/B 5회 중앙값에서 depth 1은 213.78ns→831.30ns(3.89x), depth 8은
1.472µs→4.602µs(3.13x)였다. 비재귀 direct 경로에서 발견한 호출당 IR 재검사는
빌드 시점 판정을 재사용하도록 제거했고, oneOf -0.50%, map +1.93%로 10% 회귀
예산 안이다. 전체 arena 재설계나 unsafe 수명 연장은 도입하지 않았다.

소유 풀의 Drop은 수락된 작업과 callback 종료까지 기다린다. 완료되지 않는 host
callback을 강제 종료하는 API는 아니다. 전역 풀 unload/shutdown 계약이나 실기기
수명주기 안전성을 이번 테스트로 인증하지 않는다.

## 검증 환경과 결과

- macOS ARM64: rustc/cargo 1.98.0, fnm Node 22.21.1.
- Linux ARM64 Docker: `rust:1.95-slim`에서 nightly 1.100.0-nightly
  (`4b6d04e706108ccfeafe2547fbe857dfe8972bad`, LLVM 23.1.1), cargo-fuzz 0.13.2.
- 원본 Linux 이미지 digest: `sha256:e14e87345b4d5964ddcc3491d27ee046a0f23820f340c3c1e24da6880141f7c0`.
- ASan/LSan은 leak 검사를 켰다. Miri는 isolation만 비활성화하고 thread/leak 검사는 유지했다.

| 검사                                      | 결과                                                         | 원본                                                        |
| ----------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| 소유 풀 회귀                              | 3 passed: drain/join, 반복 생성, 포화 거절, 완료 계측        | `/tmp/rustra-m0/pool-green.log`                             |
| Rust workspace 전체 + doctest             | 최신 후보 483 passed, 0 failed, doctest 5 ignored            | `cargo test --workspace`                                    |
| cargo fmt / scoped all-target clippy      | 통과                                                         | `/tmp/rustra-m0/clippy.log`                                 |
| Linux ASan+LSan lib                       | 최신 후보 178 passed, exit 0, leak report 없음               | `target/safety/asan-latest/`                                |
| Linux Miri lib                            | 최신 후보 178 passed, exit 0                                 | `target/safety/miri-latest/`                                |
| Linux Miri frame_wire / field_order_drift | 최신 후보 31 / 4 passed, 각각 exit 0                         | `target/safety/miri-latest/`                                |
| Fuzz 3 target                             | 최신 후보 seed 및 각 601초 통과, 종료 코드 모두 0            | `target/safety/fuzz-latest/`                                |
| 릴리스 도구 전체                          | 최신 후보 77 passed, 0 failed                                | `bun run test:release-tools`                                |
| EN/KO 문서 검사                           | 37 passed, mirror 68개 및 설치/버전 문서 6개 통과            | `/tmp/rustra-m0/docs-check.log`                             |
| actionlint                                | 변경 workflow 5개 통과                                       | Bench/Miri/Sanitizer/Fuzz/Release                           |
| 독립 안전성·릴리스 코드 리뷰              | 차단 결함 없음                                               | `/tmp/rustra-m0/review-safety-release.md`                   |
| complex route release A/B                 | 기준/후보 각 5개 독립 프로세스, 비재귀 control 10% 예산 이내 | `../benchmark-receipts/2026-09-14-m0-complex-route-ab.json` |

API snapshot은 private import/IR variant/opaque pool struct/Drop 선언도 추적한다.
내부 선언 변경만 확인한 후 갱신했으며 공개 함수 변경을 허용하기 위해 검사를
약화하지 않았다.

커밋 훅이 검증 뒤 `ffi_pool.rs`를 rustfmt로 정리했다. Linux 안전성 실행에 사용한
파일 hash는 `92907d…bf741`, 커밋된 파일 hash는 `689454…da47`이다. 포맷된 최종
소스에서 `cargo fmt --all -- --check`와 rustra lib 178개 테스트를 다시 통과했다.
최종 커밋 SHA 자체에 대한 Miri/Sanitizer/Fuzz 증거는 변경 workflow의 원격 실행이
끝나야 생긴다.

최신 Fuzz 실행 수는 invoke_frame 53,964,068회, invoke_complex_value 9,817,508회,
invoke_complex_serde 16,309,069회다. 모두 seed 100개를 먼저 재생하고 601초 구간을
완료했다. 최신 evolved corpus는 `/tmp/rustra-m0/latest-fuzz-corpus.tar.gz`에 보존한다.

일반 Rust release 모드도 295 passed, 0 failed, 기존 doctest 2 ignored로
통과했다(`/tmp/rustra-m0/rust-release.log`). 릴리스 도구 전체 최신 실행은 77 passed,
0 failed이며 구조 경계 검사도 4/4 통과했다.

릴리스 도구의 최신 실행 선택은 원래 생성 시각만 보지 않는다. 오래된 run을
새로 재실행한 실패·대기 상태가 최근 생성된 과거 성공을 덮도록 최신 attempt의
활동 시각을 사용한다. registry 검증은 malformed 응답, 잘못된 SHA, dirty crate,
yanked 버전, 손상 archive, 전체 SemVer/prerelease 순서를 fixture로 확인했다.
독립 리뷰에서 지적한 malformed metadata와 SemVer 문제는 수정 후 재승인됐다.

## 배포 감사와 증거 경계

[배포 조합표](../release-matrix.ko.md)와 보존한
[JSON 영수증](evidence/2026-09-14-registry-audit.json) /
[생성 표](evidence/2026-09-14-registry-audit.md)의 실제 2026-09-14 조회에서 공개 12개 모두
`30c73bd66159f4c777054527236573559c106c98`를 가리켰다. crate 3개 archive SHA-256도
sparse index와 일치했다. 현재 후보에는 그 이후 변경과 이번 uncommitted 수정이
있으므로 공개본에 이 수정이 들어갔다고 볼 수 없다.

기존 원격 후보의 읽기 전용 게이트 감사는 CI/Fuzz 성공과 Miri/Sanitizer 실패를
구분해 전체 exit 1로 차단했다. 이는 **감사기의 차단 동작 증거**이며 새 workflow가
Actions에서 실제로 실행됐다는 증거가 아니다.

남은 경계:

- 변경된 workflow의 원격 실행, Actions x86_64 대상 안전성 결과, merge·발행.
- Linux 실제 Tauri WebView·수명주기·패키지 설치. 이 증거 전까지 Linux는 Alpha다.
- G0의 온보딩·실제 사용자·host/실기기 성능 기준선과 CPU·RSS·에너지 측정.
- G1~G4의 실기기·장시간·외부 도입 및 실제 소비자 성능 증거.

로컬/컨테이너 검사 성공을 위 미검증 항목의 완료로 사용하지 않는다.

## 실행 영수증

[검증 JSON](evidence/2026-09-14-m0-validation.json)은 최신 변경 소스 SHA-256,
각 Miri/Fuzz 종료 코드·실행 수·시간과 원본 로그 hash를 보존한다. Linux 검사는
현재 작업 트리를 컨테이너에 bind mount해 실행했다. 원본 상세 로그는
`target/safety/*-latest/`와 `/tmp/rustra-m0/latest-safety-logs.tar.gz`에 남긴다. 원격 기존 실패를 확인한 [게이트 JSON](evidence/2026-09-14-baseline-release-gates.json)도
별도로 보존해 현재 수정본의 로컬 결과와 혼동하지 않는다.

최신 Miri 결과: lib 178개(156.11초), frame_wire 31개(650.67초),
field_order_drift 4개(1.36초), 모두 종료 코드 0. 큰 payload 테스트도 제외하지 않았다.

코어 성능 원본 영수증은 [release A/B JSON](../benchmark-receipts/2026-09-14-m0-complex-route-ab.json)에
환경, 기준 SHA, dirty 후보 source hash, 벤치 바이너리 hash, case별 5회 분포를
보존한다. Criterion median을 사용했으므로 p95로 표현하지 않는다.

최신 상세 실행 로그 묶음: [latest-safety-logs.tar.gz](/tmp/rustra-m0/latest-safety-logs.tar.gz). 이번 검증 전용 Docker 컨테이너는 최신 corpus를 보존한 뒤 정리한다.
