# 2026-10-13 성능 판정과 정수 시퀀스 할당 개선

기준은 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`이며, 아래 로컬 변경은 아직 커밋·배포하지 않았다.

## Benchmark 실패 원인과 판정 수정

GitHub run `38056499946`의 `criterion-results-rejected`(artifact `11671544369`)를
2026-10-13에 내려받아 두 환경 기록을 비교했다. 복원된 기준선은
`f4ed85728672ec098e4dbe9fbfce982e541be538`의 Intel Xeon 6973P-C이고, 후보는
`f1a96b94`의 AMD EPYC 7763이다. 둘 다 Linux x64, 논리 CPU 4개, 동일 커널
`6.17.0-1022-azure`, rustc/cargo 1.95.0, Bun 1.4.0, 동일 컴파일 플래그다.
메모리는 약 1 MiB, runner 이미지 patch도 다르다.

CPU가 다른 측정을 비교했으므로 59건의 10% 예산 초과를 코드 회귀로 귀속할 수 없다.
기존 gate는 이 차이를 WARN으로만 표시한 뒤 `exit 1`을 내렸다. 최소 fixture에
실제 CPU 차이와 `optional_string_64k`의 +1048.94%를 넣은 회귀 검사가 수정 전
`1 !== 2`로 실패했다.

수정 후 정책:

- CPU 모델·아키텍처·CPU 수·사용 가능한 병렬성·메모리 GiB 등급·커널 major/minor·
  OS 이미지 종류·rustc/cargo/Bun·컴파일 플래그가 다르면 **exit 2, 비교 불가**.
- runner 이미지 patch, 같은 커널 series의 patch, 같은 GiB 등급 안의 세부 메모리
  차이는 별도 자문으로 기록한다. 변화가 성능에 영향이 없다고 보장하는 것은 아니다.
- JSON 문법만 맞고 비교 필드가 없는 환경 기록도 비교 불가다.
- 기존 baseline은 유지한다. 같은 러너의 `comparison_ref` 경로로 두 소스를
  비교하는 절차와 mixed-change 방어를 유지한다.

`env -u RUSTRA_BUN_LIBRARY bun run test:bench-gate`: **39 passed / 0 failed**.
같은 러너 비교의 두 revision 사전 빌드와 baseline 설치 실패 방어도 포함한다.
실제 rejected artifact에 새 gate를 적용한 결과는 `host.cpuModels` 불일치로
**exit 2**다. 이 결과는 과거 CI를 녹색으로 바꾼 것이 아니며, 동일 환경의 원격
재측정도 아직 실행하지 않았다.

```bash
env -u RUSTRA_BUN_LIBRARY bun scripts/check-criterion-regression.mjs \
  --criterion-root /tmp/rustra-20261013-rejected \
  --report /tmp/rustra-20261013-rejected-classification.md
```

## 정수 시퀀스 임시 버퍼

맵 값의 정수 시퀀스는 원소 수를 이미 알고 있지만 48바이트 임시 버퍼가 넘치면
배증을 반복했다. 각 정수가 최소 1바이트라는 스키마 계약을 사용해 최소 필요량을
한 번 예약한다. 예약량은 남은 payload 한도를 넘지 않고, 호출자 버퍼는 늘리지
않으며, 직렬화·핸들러를 재실행하지 않는다. 실제 기록 길이·와이어·오류 검사는
기존 경로를 따른다. 48바이트 inline 값보다 작은 시퀀스는 예약 검사 자체를
생략해 작은 맵의 경로를 유지한다.

맵의 `Serialize::serialize_map(Some(len))` 힌트도 최대 64항목으로 제한했다.
사용자 정의 Serialize가 `usize::MAX` 힌트와 실제 3항목을 제공하면 기존 코드는
`capacity overflow`로 패닉했고, 새 코드는 동일한 정렬 와이어를 반환한다.
64키의 한 번 예약은 유지하며 더 큰 맵은 실제 항목 삽입에 따라 성장한다.
전체 collection 한도는 계속 검사한다. 기존 코드에서 실패하는 회귀 실행은
`/tmp/rustra-20261013-perf-evidence/map-hint-red.log`에 남겼다.

HEAD를 `/tmp/rustra-20261013-perf-source`에 `git archive`로 고정했다. 기준선과
후보를 같은 위치·Cargo target에서 순차 빌드한 뒤 실행 파일을 각각 보존했다.
후보는 코덱 파일 변경만 추가하여 다른 동시 작업이 A/B에 섞이지 않게 했다.

`codec_allocations`의 1,000회 계량:

| 케이스                  | 기준선 할당/호출 | 후보 할당/호출 | 기준선 요청 bytes/호출 | 후보 요청 bytes/호출 |
| ----------------------- | ---------------: | -------------: | ---------------------: | -------------------: |
| map_seq_1024            |               12 |              7 |                 16,973 |               13,828 |
| optional_string_64k     |                3 |              3 |                131,102 |              131,102 |
| optional_chunks_near_1m |               23 |             23 |              3,080,681 |            3,080,681 |

나머지 11개 케이스도 할당 수와 요청 바이트가 동일하다. map_seq_1024의 할당 호출은
41.7%, 누적 요청 바이트는 18.5% 감소했다. 요청 바이트는 RSS나 최대 메모리가 아니다.

검증: `cargo test -p rustra complex_`는 단위 78건과 통합 2건 통과,
`cargo test -p rustra --release --lib complex_`는 77건 통과,
`cargo clippy -p rustra --all-targets -- -D warnings`는 종료 코드 0이다.
추가 검사는 postcard 와이어 일치, scratch 할당 2회, caller-buffer 무할당,
큰 길이 힌트의 payload 제한, 고정 버퍼 overflow, 거대한 map hint와 실제
collection 한도를 다룬다.

## 시간 측정과 채택 경계

빌드·다른 에이전트의 CPU 작업과 Docker fuzz를 모두 끝낸 뒤 5쌍을 측정했다.
같은 호스트에서 B C / C B / B C / C B / B C 순서의 독립 프로세스 10개,
원래 complex_route 14개 fixture를 모두 실행했다. Criterion은 각 항목 500표본,
warmup 0.2초·측정 0.5초·resample 1,000이다. 전체 실행은 약 118초이며 전부 exit 0이다.
런치별 median의 후보/기준선 로그비율로 쌍 t(4) 명목 95% CI를 계산했다.
14개 비교에 다중 검정 보정은 없고, 이 짧은 로컬 측정은 기기 채택 증거가 아니다.

| 항목                    | 기준선 런치 median 중앙값 | 후보 런치 median 중앙값 | 쌍 기하평균 변화 | 후보/기준선 95% CI |
| ----------------------- | ------------------------: | ----------------------: | ---------------: | ------------------ |
| map_seq_1024            |                 15.097 µs |               15.319 µs |           +1.58% | [1.0129, 1.0187]   |
| map_keys_64             |                 15.107 µs |               15.165 µs |           +0.45% | [0.9884, 1.0209]   |
| optional_string_64k     |                  4.954 µs |                4.956 µs |           +0.18% | [0.9907, 1.0130]   |
| optional_chunks_near_1m |                 79.479 µs |               79.619 µs |           +1.66% | [0.9940, 1.0397]   |
| wide_struct_32 (대조)   |                  1.455 µs |                1.480 µs |           +1.64% | [1.0106, 1.0223]   |
| scalar_control (대조)   |                  54.02 ns |                53.67 ns |           −0.62% | [0.9911, 0.9966]   |

**할당 감소는 확인됐지만 시간 개선은 입증하지 못했다.** 대상 map_seq_1024에는 작은
지연 증가가 관측됐다. 바뀌지 않은 대조군도 양방향으로 움직였지만 이를 근거로 대상의
증가를 숨기거나 "무회귀"로 바꾸지 않는다. 10% 예산 초과는 없으나 시간 개선 채택은
보류한다. 현재 구현은 할당 호출·요청 바이트를 줄이는 대신 이 로컬 측정의 작은 지연
비용을 갖는 변경으로 취급한다. 추가 최적화는 새 후보와 독립 A/B가 필요하다.

첫 탐색 후보(작은 시퀀스의 예약 검사 생략 전)는 별도
`/tmp/rustra-20261013-perf-evidence/ab-receipt.json`에 남겼다. map_keys_64의 작은
증가를 보고 inline 크기 이하를 기존 경로로 유지하도록 바꾼 뒤 위 최종 측정을 했다.
탐색 결과와 최종 결과를 섞지 않는다.

최종 기준선 바이너리 SHA-256:
`aecf5e8ddd52285b62b02e8593137daefa05eb939e1d5f9fd52b7318025f1475`.
최종 후보 바이너리 SHA-256:
`700cb18febffc1537d3b1f0ae445d207f454d7fe7ab0969e21ef88f8581e2f45`.

[보존 receipt](../../benchmark-receipts/2026-10-13-codec-allocation-ab.json)에
개별 런치 추정치·환경·바이너리 및 후보 파일 해시·통계·전체 할당 결과를 담았다.
Criterion 원본과 바이너리·계량/검증 로그는
`/tmp/rustra-20261013-perf-final-evidence/`에 있다. 재현 시 같은 HEAD snapshot에
네 코덱 파일만 적용하고, 아래 실행 스크립트의 설정과 순서를 유지한다:

```bash
python3 /tmp/rustra-20261013-perf-final-evidence/run-ab.py
python3 /tmp/rustra-20261013-perf-final-evidence/analyze-ab.py
```

원격 같은 러너 Benchmark 재측정, 실제 RN 앱의 독립 5회 gzip 비교, E1/A2 실기기
A/B는 별도 미완료 항목이다. 새 원격 CI 성공이나 배포 완료를 주장하지 않는다.
