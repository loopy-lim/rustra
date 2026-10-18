# scriptc 실제 native consumer 취소·해제 검증

2026-10-13, 기반 HEAD `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`의 변경 중인 worktree에서 확인했다.
실제 scriptc 0.2.1 compiler/runtime를 사용하는 bounded stress를 구현하고 macOS ARM64 release 20회, 기존 calculator 통합 스모크에 연결한 추가 5회를 통과했다. 확인한 실행에서는 production callback 구현 결함을 찾지 않았다. 전체 stress의 ASan/LSan 검증은 완료하지 못했다.

| 검사                                  | 결과    | 증거 경계                                                                                                                     |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 최종 release stress 20개 새 프로세스  | PASS    | 매 프로세스 64 lifecycle cycle, bytes 복사 전달 192회, 이벤트 128회, checkpoint 전 취소 64개, 해제한 채널의 늦은 callback 0회 |
| 기존 `run.sh` 통합                    | PASS    | calculator sync 42 / events 2 / async 42 / bytes 3과 추가 stress 5개 새 프로세스                                              |
| macOS scriptc ASan 시작               | BLOCKED | 앞선 stress 버전이 15초 timeout. 별도 FFI 없는 hello도 5초 안에 main 진입하지 못함                                            |
| Linux ARM64 scriptc ASan hello        | PASS    | `--sanitize`로 생성한 실제 실행 파일이 main marker 출력, exit 0                                                               |
| Linux ARM64 scriptc→C ASan canary     | PASS    | 별도 테스트 C 함수의 의도적 heap-use-after-free를 실제 검출, exit 1                                                           |
| Linux ARM64 전체 stress ASan/RC audit | BLOCKED | hello/canary 뒤 Rust fixture 빌드가 ENOSPC(exit 101)로 실패; stress 미실행                                                    |
| 전체 native consumer 누수/LSan        | 미확인  | release 성공과 canary 검출은 장시간 무누수 증거가 아님                                                                        |

원본 receipt·로그·선택한 소스 해시는 [durable evidence](../../verification/evidence/2026-10-13-scriptc-stress/README.md)에 보존했다. 독립 20회 결과는 [20회 receipt](../../verification/evidence/2026-10-13-scriptc-stress/macos-release/receipt-20-runs.json), 통합 추가 5회 결과는 [5회 receipt](../../verification/evidence/2026-10-13-scriptc-stress/macos-release/receipt.json)로 구분한다. 앞의 20회에 해당하는 합계는 lifecycle 1,280 cycle, bytes 전달 3,840회, 이벤트 2,560회, 취소 1,280개다. 성능 수치나 장시간 안정성으로 일반화하지 않는다.

## 구현과 관찰하는 경계

[`scriptc-stress.ts`](../../../examples/calculator/apps/scriptc-stress.ts)는 generated production FFI 선언과 descriptor를 사용한다. [`stress-fixture`](../../../examples/calculator/scriptc/stress-fixture/src/lib.rs)는 실제 rustra package를 등록하고 worker gate 3개 진입만 테스트 전용으로 추가한다. 공개 rustra ABI나 production Rust 함수 본문은 이번 follow-up에서 변경하지 않았다. 기존 calculator 스모크도 계속 실행한다.

각 native 프로세스는 다음을 단정한다.

1. 같은 named closure로 bytes channel을 두 번 등록하고 최신 handle부터 짝 release한다. 해제한 채널의 새 send는 거부되며 이전 등록은 계속 동작한다.
2. borrowed bytes를 foreign trampoline에 전달한 뒤 원본을 변경하고 native 등록을 모두 해제한다. script loop가 배수한 192개 payload는 원본과 독립적이며, 이후 전달이 끝나도 저장한 복사본은 유지된다.
3. 이벤트 owner 교체·옛 owner release·현재 owner release를 64회 반복한다. 이미 큐에 들어간 old/new 이벤트 128개는 도착하고, 해제 뒤의 새 이벤트는 전달되지 않는다. inactive consumer는 큐에서 늦게 도착한 이벤트로 상태 효과를 적용하지 않는다.
4. 두 worker가 실제 대기 gate에 도착한 것을 확인한 뒤 64개 요청을 제출·취소한다. 모두 cancellation status 2가 관찰되고, handler 진입 전 checkpoint에서 취소된다. 완료 전달 뒤 ID는 status 0이며 재취소도 실패한다.
5. 별도 채널에 요청을 제출한 뒤 worker를 풀기 전에 채널을 해제한다. handler는 실제로 실행되지만 완료 callback은 받지 않는다. 닫힌 채널의 새 async invoke는 ID 0을 반환한다.
6. 정상·취소 완료 66개를 받은 script closure가 자기 등록을 release한다. 모든 Rust 완료를 관찰한 뒤 script loop를 50ms 더 유지하고 늦은 callback 0과 저장한 payload 불변식을 다시 검사한다.

gate 도착 대기는 5초, gate 자체는 10초, 각 프로세스는 15초 한도다. worker 진입 전 취소를 결정적으로 검사하는 것이며, 이미 실행 중인 handler의 강제 중단을 보장하지 않는다. 반복 lifecycle은 같은 프로세스 내 callback 등록/해제와 새 프로세스 실행을 뜻하며, 한 프로세스의 전체 패키지 재초기화를 의미하지 않는다.

## native release와 script queue의 차이

실제 scriptc runtime는 native trampoline 안에서 bytes/string을 복사해 자체 큐에 넣는다. native release는 새 native 호출을 막고 실행 중인 trampoline의 종료까지 기다리지만, **이미 큐에 들어간 script closure 호출은 release 후에도 실행된다.** scriptc 0.2.1 설치 소스 `runtime-sources/src/scr_ffi_queue.c`의 `scr_ffi_release_foreign`(155행), queued pin 지연 해제(163행), `scr_ffi_dispatch`(286행)와 실제 스트레스 결과가 이 동작을 뒷받침한다. 해당 소스 SHA-256은 `57d5ed9e10abade6f3e04604e079cea546c6292bfb12b4b485fa0e7be51c5ab4`다.

따라서 consumer의 UI/state 효과 취소에는 active/generation 확인이 별도로 필요하다. 이를 [안전 계약 S6](../../safety-contract.ko.md)과 [ADR 0004](../../adr/0004-ffi-safety-preconditions.ko.md)에 명시했다. native callback 내부의 동기 self-release 금지는 유지한다. native trampoline 반환 후 script queue에서 실행하는 closure의 release와 구분한다.

## 재실행과 소스 식별

```bash
# 기존 calculator 스모크 + 5회 stress
bash examples/calculator/scriptc/run.sh

# 독립 release 반복
node examples/calculator/scriptc/run-stress.mjs --runs=20

# 실제 ASan 시작/오류 검출 canary를 먼저 통과해야 stress로 진행
node examples/calculator/scriptc/run-stress.mjs --sanitize --runs=5

cargo clippy --locked \
  --manifest-path examples/calculator/scriptc/stress-fixture/Cargo.toml \
  --target-dir target/scriptc-stress -- -D warnings
node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck \
  examples/calculator/apps/scriptc-stress.ts
node --check examples/calculator/scriptc/run-stress.mjs
bash -n examples/calculator/scriptc/run.sh
```

clippy, 제한한 TS typecheck, JS/shell 구문 검사는 통과했다. macOS는 rustc 1.95.0/aarch64-apple-darwin, scriptc 0.2.1을 Node 26.8.2로 실행했다. runner 자체의 Node는 22.21.1이다. Linux는 rustc 1.95.0/aarch64-unknown-linux-gnu, Node 26.8.2, scriptc 0.2.1, clang 19.1.7이었다.

최종 release receipt는 선택한 입력 15개 SHA-256을 담고 검사 전후 변경 0개를 확인한다. durable 복사 시점에도 같은 15개가 일치했다. 이는 모든 전이 의존성을 포함한 전체 source archive 검사가 아니다. 20회와 통합 5회의 native 바이너리 SHA-256은 모두 `d6405d6f40a669ec2455a2c0ae3642c7d231d1909b765801163faa48f87873d3`, fixture archive는 `7b6e1691e541e1bb810b48c63390d2e52b83f3401c521f88c1abc74b2efee6f1`다.

`--sanitize`의 범위는 scriptc 생성 코드/runtime의 ASan/RC audit다. 연결한 Rust staticlib은 release 빌드이므로 Rust 전체 ASan 계측을 뜻하지 않는다. 의도적 오류가 들어간 [`asan-canary.c`](../../../examples/calculator/scriptc/stress-fixture/asan-canary.c)는 별도 canary 실행 파일에만 연결하며 stress/배포 바이너리에 포함하지 않는다.

## 미완료 상태와 자원 정리

macOS ASan 실패 receipt는 50ms 관찰 단계와 최종 runner 개선 전 버전이다. 최종 버전의 실패라고 다시 이름 붙이지 않았다. FFI 없는 hello의 마지막 출력은 `AddressSanitizer: libc interceptors initialized`였다. 원인 해결이나 leak-free 판정은 하지 않았다.

Linux 작업 전용 container에서는 hello와 UAF canary를 통과했다. 이후 [fixture-build.log](../../verification/evidence/2026-10-13-scriptc-stress/linux-sanitize/fixture-build.log)의 `No space left on device (os error 28)`로 빌드가 중단됐다. [receipt](../../verification/evidence/2026-10-13-scriptc-stress/linux-sanitize/receipt.json)는 실패를 보존하며, 요청한 5회 stress는 한 번도 시작하지 않았다. canary의 symbolizer 경고는 남았지만 실제 UAF 검출·allocation/free 주소·비정상 종료는 확인했다.

추가 빌드는 중지했다. 이 작업이 생성한 옛 `target/scriptc-stress/debug`, 옛 `target/scriptc-stress/release/{deps,build,.fingerprint,incremental}`, `target/safety/foreign-exception/debug/{deps,build,.fingerprint,incremental}`만 추적 파일·symlink가 없음을 확인하고 정리했다. 제거 대상 allocated blocks 합은 694.8 MiB이며, hardlink와 다른 작업의 동시 정리가 있어 실제 파일시스템 회수량으로 단정하지 않는다. 당시 Data volume 여유 공간은 1.4 GiB로 관찰됐다. 소스·로그·receipt·archive·최종 바이너리와 정적 라이브러리는 보존했다.

정리 대기 중인 owned container는 `rustra-scriptc-asan-oct13` / `cf967b973317d243ed6a0244fe8bcb7907168e505f65e89ce4a1f389359acd32`다. 마지막 확인에서 Docker socket `/Users/loopy/.orbstack/run/docker.sock`가 없어 상태 조회와 제거가 불가능했다. daemon 재시작이나 기존 `risuai-nodeonly` container 변경은 하지 않았다. daemon 복귀 시 이 ID만 종료·제거해야 한다. 충분한 자원에서 전체 `--sanitize` stress와 누수 검사를 다시 통과하기 전까지 D5의 native sanitizer/LSan 완료로 표시하지 않는다.

daemon 복귀 뒤 사용할 scoped 정리 명령은 다음과 같다. 삭제 전에 첫 명령의 이름이 `/rustra-scriptc-asan-oct13`인지 확인한다.

```bash
docker inspect --format '{{.Id}} {{.Name}} {{.State.Status}}' cf967b973317d243ed6a0244fe8bcb7907168e505f65e89ce4a1f389359acd32
docker stop cf967b973317d243ed6a0244fe8bcb7907168e505f65e89ce4a1f389359acd32
docker rm cf967b973317d243ed6a0244fe8bcb7907168e505f65e89ce4a1f389359acd32
```
