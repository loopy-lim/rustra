# 2026-10-13 온보딩 증거와 RN 동일 연산 계측

기준 HEAD는 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`다. 이 문서는 로컬 변경과
실행 증거를 기록한다. 실제 실행 패키지와 Rust 산출물은 receipt의 SHA-256으로
식별한다. 커밋·푸시·발행은 수행하지 않았다.

## 온보딩

`scripts/quick-start.mjs`는 Bun·npm·pnpm·Yarn 선택, `--measure`, `--cold`,
`--output`을 지원한다. 실제 `init` 산출물에 현재 소스 패키지를 주입하고 선택한
패키지 매니저로 설치한다. 첫 Rust 호출, 설치된 CLI를 이용한 두 번째 start,
JS 문구 변경, Rust 구현 변경, 계약 필드 변경 후의 결과를 확인한다. 기본 사용자
scripts와 `rustra.json`은 보존한다. `--cold`는 상속된 `CARGO_TARGET_DIR`보다
우선하는 새 Cargo target을 만들지만 전역 의존성 캐시는 비우지 않는다.

`scripts/onboarding-gate.mjs`도 단계별 단조 시계 시각, 첫 호출과 계약 변경 시간,
성공·실패, 원본 로그 경로를 불변 JSON으로 남긴다. 소스 트리 전후 hash와 실제
실행하는 CLI dist 전체 hash를 분리한다. quick-start는 각 단계의 설치된 CLI·types·host
패키지 dist, lockfile, 생성 계약과 native 실행 파일 hash까지 보존한다.

모든 여정은 `source-injected`다. `packed-local`, `registry-only`와 구분하며
새 버전 발행을 증명하지 않는다. 시간은 명시 명령 실행 기준이다. watch 감지,
실제 실패 복구, SDK 다운로드, 신규 사용자 관찰은 측정하지 않아 JSON에서 null로
남긴다. 한 번의 로컬 실행은 성능 예산이나 5명 사용자 수용 결과가 아니다.

## RN 경로와 계측

기존 예제의 gzip bytes와 UUID JSON은 다른 작업이었다. 새 collector는 같은
결정적 입력으로 `gzipCompress`와 `gzipDecompress`의 JSON·bytes 경로를 비교한다.
기본 입력 크기는 1KiB·64KiB·256KiB, warmup 5회와 개별 호출 100회다. 매 호출의
출력 바이트, 입력 변조, gzip 헤더와 왕복을 확인하며 SHA 계산은 시간 구간 밖에서
수행한다. 원본 sample과 nearest-rank p50/p95를 함께 저장한다.

`apps/native-benchmark.ts`는 생성된 RN bootstrap과 실제 native module을 사용한다.
release Hermes, 설치된 contract hash와 생성 계약의 일치, buffer capability를
요구하며 JSON fallback은 사용하지 않는다. metadata에는 source·bundle·native
binary·contract SHA와 OS·device·Hermes·RN 버전을 넣는다. 호스트 앱이 SHA 함수와
빌드 metadata를 제공하고 receipt를 저장한다.

`scripts/benchmark-receipts.ts`는 최소 5개의 서로 다른 runtime/launch와 교차 순서를
요구한다. 환경·원본 sample·payload hash·압축/해제 provenance·출력 일치를 검사한다.
launch별 p50/p95와 순서별 비율을 유지하며 호출 sample을 한 분포로 합치지 않는다.
실제 OS 프로세스 재시작은 플랫폼 driver 로그로 별도 확인해야 한다. allocation과
native copy 양은 계측하지 않아 null이다. 이 작업에서는 실제 RN 5회 실행 결과를
만들지 않았으며 Bun mock 검사는 native 성능 증거가 아니다.

Node 생성 엔트리는 schema generator `generate` 대신 실제 invoke 실행 파일
`rustra-rn-experiment`를 사용하도록 생성기로 갱신했다. 신규 `src/main.rs`와
`apps/node-app.ts`가 gzip·UUID·구조화된 실패를 실제 Rust 소비 경로에서 확인한다.
RN adapter 예제의 package import도 public package로 맞춰 source/dist error class가
중복되는 문제를 없앴다. gzip 해제는 출력 한도+1까지만 읽고 초과를 구조화된 오류로
반환하여 압축 폭탄이 무제한 메모리를 요구하지 않게 한다.

## 실행 기록

검증 원본과 manifest는
[`docs/verification/evidence/2026-10-13-dx-rn/`](../../verification/evidence/2026-10-13-dx-rn/)
에 보존한다. JSON의 `/tmp` 로그 경로는 최초 실행 위치이며 동일 바이트의 로그를
이 증거 디렉터리에도 복사한다.

```bash
CARGO_NET_OFFLINE=true node scripts/quick-start.mjs --host node \
  --package-manager pnpm --measure --cold --output /tmp/pnpm-receipt.json
CARGO_NET_OFFLINE=true node scripts/quick-start.mjs --host node \
  --package-manager yarn --measure --cold --output /tmp/yarn-receipt.json
CARGO_NET_OFFLINE=true RUSTRA_ONBOARDING_CARGO_TARGET_DIR=target/onboarding-shared \
  node scripts/onboarding-gate.mjs --output /tmp/gate-receipt.json
node --experimental-strip-types --test scripts/onboarding-gate.test.ts
bun run test:app:rn-experiment
bun run --cwd examples/rn-experiment typecheck:native
cargo test -p rustra-rn-experiment
bun run --cwd examples/rn-experiment codegen:check
```

React Doctor는 CI와 같은 `0.9.12`로 검사한다. 원래 RN generated/module 6개 unused-file
경고는 실제 Node·RN 소비 엔트리와 테스트를 연결하여 해결했다. 삭제나 규칙 무시는
추가하지 않았다. 후보 검사는 tracked 파일과 이번 신규 파일을 복사한 별도 디렉터리에서
실행하며, 기존 사용자 소유의 untracked calculator benchmark 2개와 Git이 무시하는
별도 `.worktrees`는 포함하지 않는다. 원본 workspace의 이 파일들은 수정하지 않는다.

최종 실행 결과는 [manifest](../../verification/evidence/2026-10-13-dx-rn/manifest.json)와
각 원본 로그에 기록한다.

| 검사                                    | 결과                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| 온보딩 receipt/helper                   | 25 passed                                               |
| pnpm 12.6.0·Yarn 1.22.22 Node 소비 여정 | 각각 설치·첫 호출·warm·JS·Rust 구현·계약 변경 PASS      |
| 기존 onboarding gate 실제 실행          | 10단계 PASS                                             |
| RN collector·집계·native bootstrap mock | 9 passed                                                |
| RN adapter·실제 Rust Node consumer      | adapter 4개와 gzip·UUID·오류 PASS                       |
| RN Rust 통합·codegen drift              | 6 passed·drift 0                                        |
| RN host/native TypeScript               | 모두 PASS                                               |
| 후보 lint·React Doctor 0.9.12           | PASS·588파일 100/100, 경고 0                            |
| 후보 `test:ts:node`                     | 74 passed, 0 failed, optional napi 산출물 부재로 1 skip |

최종 pnpm·Yarn·gate receipt는 모두 `sourceStable=true`, `producerStable=true`다.
이전 `pnpm-final.json`도 보존했다. 해당 실행은 병렬 개발로 전체 소스 hash가 바뀌어
`sourceStable=false`지만 실제 CLI dist와 설치된 패키지 hash는 고정돼 있었다.
이 기록을 최종 소스 전체가 고정된 측정으로 사용하지 않는다.

최종 pnpm은 새 Cargo target에서 첫 호출 9.838초, warm 0.727초, JS 변경 0.051초,
Rust 구현 변경 0.799초, 계약 변경 1.038초였다. Yarn은 각각 8.378초, 0.820초,
0.146초, 0.977초, 1.164초였다. 둘 다 Cargo offline·전역 의존성 캐시 사용이고,
일부 독립 검사와 동시에 실행했으므로 이 숫자로 매니저 속도 우열이나 성능 개선율을
판정하지 않는다. pnpm 실행에는 다른 `CARGO_TARGET_DIR`을 일부러 상속했으며
receipt와 로그에서 `--cold`의 새 target이 실제 사용됨을 확인했다.

기존 사용자 실험 파일과 ignored worktree를 포함한 원본 cwd의 lint/typecheck/Doctor
전체 성공을 주장하지 않는다. 저장한 후보 목록과 hash가 위 검증의 정확한 범위다.
