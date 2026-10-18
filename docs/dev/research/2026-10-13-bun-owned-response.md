# Bun 큰 응답의 optional owned 경로

2026-10-13 로컬 구현·검증 기록. `packages/bun/src/bun-ffi.ts`만 런타임 동작을 변경했고 Rust 코어와 공개 TypeScript API는 변경하지 않았다. [원본 표본 및 실행 receipt](../../benchmark-receipts/2026-10-13-bun-owned-ab.json)에 10개 독립 프로세스의 표본, 실행 명령, 환경 및 생산 파일 해시를 보존했다.

## 변경한 비용과 소유권

기존 Bun 어댑터는 모든 응답에 `rustra_ffi_invoke_frame_into`를 사용했다. 응답이 재사용하는 512B 버퍼보다 크면 Rust 코어가 요청과 응답을 probe cache에 저장하고, Bun이 정확한 크기의 버퍼를 만든 뒤 동일 요청으로 다시 진입했다. 핸들러는 한 번 실행되지만 요청 전체의 복사·재비교와 재시도 호출이 필요했다.

새 어댑터는 `rustra_ffi_invoke_frame_owned`와 `rustra_ffi_free_owned_bytes`가 **둘 다** 있는 라이브러리에서 owned 경로를 사용한다. 작은 응답은 기존 512B caller buffer를 재사용한다. 큰 응답은 Rust가 반환한 프레임을 JavaScript 소유 ArrayBuffer에 한 번 복사하고, 생산 라이브러리의 `free_owned_bytes(pointer, originalLength)`로 `finally`에서 정확히 한 번 해제한다. 디코드가 호출 반환 이후에 수행되므로 이 복사는 유지한다.

옵션 심볼이 없거나 free 심볼만 없으면 기존 필수 심볼 테이블로 다시 열고 원래의 probe/retry 경로를 사용한다. schema와 contract hash의 기존 header 기반 free 짝은 바꾸지 않는다. 큰 응답의 invoke 진입 횟수는 2→1이지만 별도 owned free 호출이 있으므로 **전체 FFI 호출 수가 절반이 된 것은 아니다**. 제거한 주된 비용은 probe cache의 요청 복사·비교와 재시도 프로토콜이다.

## 검증

실제 C 공유 라이브러리 fixture를 owned/legacy/missing-free 세 종류로 빌드하여 확인했다. 총 프레임 길이 511/512/513B 및 64/256KiB에서 바이트 내용, 핸들러 1회, invoke 진입 횟수, 정확한 allocator와 길이의 free 1회, 후속 호출 이후 결과 보존을 검사한다. 해제 전 메모리 poison으로 반환 버퍼가 Rust 메모리를 빌려 쓰지 않는지도 확인한다. null+oversize 응답, 유효하지 않은 owned 길이, 디코더 예외에서 오류와 해제 동작을 검증한다.

- 기준선을 같은 테스트에 주입하면 owned 진입 카운터가 0이어서 **2 pass / 1 fail**로 RED를 재현했다.
- 후보의 전용 회귀 테스트 **3 pass / 0 fail**, Bun 패키지 전체 **68 pass / 0 fail / 10 files**, TypeScript compile **exit 0**.
- 실제 calculator cdylib에서도 두 어댑터를 각각 6개 입력 크기로 호출해 반환 바이트가 같은 것을 확인했다. 측정에서는 warmup을 포함한 **33,000개** 응답을 모두 비교했다.

```bash
env -u RUSTRA_BUN_LIBRARY bun test packages/bun/src/bun-owned-response.test.ts
env -u RUSTRA_BUN_LIBRARY bun run --cwd packages/bun test
bun run --cwd packages/bun test:compile
```

초기 루트 실행 `bun test packages/bun/src`는 인자를 파일 필터로 해석하여 `dist-ts/packages/bun/src`까지 수집했고, 그 사본의 잘못된 native 경로 때문에 16개가 실패했다. 위의 패키지 작업 디렉터리 명령으로 범위를 바로잡은 뒤 68개가 통과했다. 이 초기 실행을 성공으로 세지 않았다.

## 동일 환경 A/B

기준선은 HEAD `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`의 Bun 어댑터를 `target/bun-owned-ab/baseline/src`에 복사한 것이다. 기준선 `bun-ffi.ts` SHA-256은 `e280a689d17f25e1910f07368a4923ee8678619a5a682179daa4c39915f316a8`로 HEAD 파일과 일치한다. 두 arm은 동일한 calculator cdylib(`8bb0f6c17b5a17f7cae0cc13a52621df387028feee13498ce53cbb717223ee69`), generated codec, shared types를 사용했다. 모든 프로세스의 실행 전·후 producer 해시가 같았으며 두 어댑터 간 차이는 `bun-ffi.ts` 한 파일이었다.

Apple M1 Max / macOS Darwin 25.6.0 / arm64 / 64GiB / Bun 1.4.3. 다른 작업자의 빌드·검사·측정을 중단한 슬롯에서 `B C / C B / B C / C B / B C` 순서로 5쌍을 실행했다. 매 프로세스는 입력 크기별 warmup 50회 이후 500회를 기록한다. 실제 `engine.invoke('benchEchoBytes', { data })`의 encode, native call, decode, Promise를 포함하고 모든 응답 byte 검사는 타이머 밖에서 수행한다. 데이터 제거·정규화는 없다.

아래 시간은 **각 arm의 5개 프로세스 p50의 중앙값**이다. 비율과 신뢰구간은 **각 쌍의 p50 log-ratio**에서 구한 기하평균과 t(4) nominal 95% CI이므로 표의 시간끼리 나눈 비율과 다를 수 있다. 다중 비교 보정은 하지 않았다.

|       입력 bytes | 기준선 µs | 후보 µs | paired 후보/기준선 | nominal 95% CI |
| ---------------: | --------: | ------: | -----------------: | -------------: |
|               64 |    10.292 |  10.250 |             0.9880 |  0.9604–1.0164 |
| 501 (511B frame) |    11.250 |  11.500 |             1.0358 |  0.9545–1.1240 |
| 502 (512B frame) |     9.125 |   9.542 |             1.0308 |  0.9705–1.0948 |
| 503 (513B frame) |     9.667 |   9.417 |             0.9352 |  0.8583–1.0190 |
|           65,536 |    26.291 |  23.709 |             0.8817 |  0.8410–0.9244 |
|          262,144 |    68.458 |  59.833 |             0.8781 |  0.8688–0.8875 |

이 짧은 로컬 순차 echo 측정에서 64KiB와 256KiB 입력의 paired p50은 각각 **11.8%, 12.2% 감소**했다. 작은 응답과 512B 경계의 구간은 1을 포함하므로 개선이나 무회귀를 확정하지 않는다. 이 기록은 sustained load, concurrent 호출, 애플리케이션 전체 지연, Linux 및 다른 Bun 버전의 증거가 아니며 Node/Tauri/React Native에 일반화하지 않는다. 메모리 할당량은 별도로 계측하지 않았다.

## 재실행

전용 수집기는 어댑터 경로와 동일 native 라이브러리를 명시적으로 받는다. 기존 출력 파일은 덮어쓰지 않는다. 기준선 소스는 변경 적용 전에 보존하고 같은 의존성을 연결해야 한다. 이번 실행의 정확한 명령과 원본 표본은 receipt의 `launches`에 있다.

```bash
env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-bun-owned.mjs \
  target/bun-owned-ab/baseline/src/bun-ffi.ts \
  target/bun-owned-ab/librustra_calculator_baseline.dylib \
  /tmp/bun-owned-baseline-new.json baseline
env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-bun-owned.mjs \
  packages/bun/src/bun-ffi.ts \
  target/bun-owned-ab/librustra_calculator_baseline.dylib \
  /tmp/bun-owned-candidate-new.json candidate
```

5쌍을 독립 프로세스로 수집한 뒤 각 인접 쌍에서 `candidate.p50 / baseline.p50`를 구한다. 다섯 log-ratio의 평균을 `m`, 표본 표준편차를 `s`라 하면 기하평균은 `exp(m)`, 구간은 `exp(m ± 2.7764451052 × s / sqrt(5))`다. 원격 benchmark 판정 회복, 다른 host의 전체 측정 행렬, 실기기 A/B는 이 변경으로 완료되지 않았다.
