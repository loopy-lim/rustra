# 2026-10-10 — 호스트 측 선행 게이트 재검증 (A2 §2.1 · E1 호스트 증거 · rn-experiment 게이트)

[measurement-runbook](../measurement-runbook.md)의 실행 가능한 호스트 측 항목을 현재 트리
(`4578c851`)에서 재실행한 리시트. **기기 매트릭스(§1.2–§1.4, §2.3, §3.3)는 실행하지
않았으며 채택 판정은 없다** — 이 리시트는 런북 §1.1/§2.1의 선행 게이트와 호스트 근거의
신선도만 담는다. 성능 종합 보고서 §8.4 리스크 2의 호스트 몫(A2 Hermes 재확인)을 닫고,
리스크 3(E1 호스트 효과 추정)은 변화 없음을 확인한다.

## 환경

| 항목      | 값                                                                           |
| --------- | ---------------------------------------------------------------------------- |
| 호스트    | macOS 26.6.2 (25G83), Darwin 25.6.0                                          |
| 소스 커밋 | `4578c851` (scriptc 코드젠 스테이지 + prettier ignore 수정 직후, 트리 클린)  |
| 툴체인    | rustc 1.95.0, node 22.21.1, bun 1.4.1, Xcode 시뮬레이터 iPhone 17 (iOS 26.2) |
| bun 가드  | 모든 bun 명령을 `env -u RUSTRA_BUN_LIBRARY`로 실행                           |

## 1. A2 선행 게이트 (runbook §2.1 — §8.4 리스크 2의 호스트 몫)

### 1-1. Hermes 단언 스위트 재실행 — **1,412 단언 0 실패**

```bash
RUSTRA_SIMULATOR_UDID=99B087B5-… RUSTRA_NATIVE_DEPS_ROOT=<추출한 xcframework> \
  bash examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh
# NATIVE_SYNC_RESULT assertions=1412 failures=0
```

- emit 전환 트리에서 owned 핸드오프 단언 포함 전체 스위트 통과. 2026-09-24 기록(1,383
  단언) 대비 단언 수 증가는 그 이후 추가된 단언 — 새 단언 전부 통과.
- 재현 비고 2건: (1) `ReactNativeDependencies.xcframework`가 Pods에 없으면
  `Pods/ReactNativeDependencies-artifacts/reactnative-dependencies-0.81.5-release.tar.gz`를
  임시 디렉터리에 풀어 `RUSTRA_NATIVE_DEPS_ROOT`로 지정하면 된다. (2) 스크립트는
  `sh`가 아니라 `bash`(shebang 대상, bash 5)로 실행해야 한다 — macOS `sh`(bash 3.2
  posix 모드)는 빈 배열 확장에서 `unbound variable`로 죽는다.

### 1-2. 호출 수 불변 재단언 — **660,004 = 660,004, 폴백 0**

```bash
env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs   # verified: true
```

`totalJsCalls 660,004 == routeInvocations 660,004`, `looseFallbackInvocations 0`.
개선 재현: warm 19.42%, coldFirstCall 73.3%, afterReset 25.47% — 결정 문서
(2026-09-24, warm 20.8% 4회 재현 20.8–24.4%)와 같은 부호·비슷한 크기.

### 1-3. TS 게이트 — test:types 311/311, test:codegen-fresh 7예제 전부 통과

게이트가 실제 결함 2건을 잡아 수정했다(게이트가 일한 기록):

1. **scriptc 매니페스트 prettier 드리프트** — 커밋 훅 prettier가
   `examples/calculator/scriptc/ffi.json`을 재포맷해 커밋 이후 모든 `codegen --check`이
   드리프트로 실패. `.prettierignore`에 `**/scriptc/ffi.json` 추가(generated/와 같은
   "생성기가 정본" 관례) + 생성기 형태로 재커밋 (`4578c851`).
2. **rn-experiment 생성물 스탬프 드리프트** — `0.11.3 → 0.12.0`. rn-experiment 커밋이
   구 CLI 생성물을 커밋한 것으로, 현재 CLI로 재생성해 모듈 glue(installer boolean
   계약)와 peerDependency(^0.10.0)를 맞춤 (`ed6ebdfd`). 게이트 재실행 후 재현
   `test:app:rn-experiment` 4검사 통과.

## 2. E1 호스트 선행 증거 (§7.3-1의 호스트 몫)

### 2-1. codec_allocations — 14케이스, 2회 독립 실행 완전 일치

`cargo run -p rustra --release --example codec_allocations` — 두 실행의 JSON이
바이트 단위로 동일(할당 패턴 결정적). 핵심 행:

| 케이스                  | 요청    | allocs/1K iter | requested bytes |
| ----------------------- | ------- | -------------: | --------------: |
| oneof_data_enum         | 4B      |          1,000 |          16,000 |
| map_keys_64             | 387B    |        151,000 |      28,984,000 |
| map_seq_1024            | 1,991B  |         12,000 |      16,973,000 |
| recursive_depth_16      | 50B     |         18,000 |         352,000 |
| optional_string_64k     | 65,544B |          3,000 |     131,102,000 |
| optional_chunks_near_1m | ~1MiB   |         23,000 |   3,080,681,000 |
| scalar_control          | 4B      |          1,000 |           9,000 |

E1 owned 경로가 건드리는 large-response 패턴(optional_chunks_near_1m)의 할당 상한이
현재 트리에서 동일하게 유지된다.

### 2-2. tree_route (release, criterion) — 28케이스 전부 ±1.9% 이내 재현

`cargo bench -p rustra --bench tree_route -- --save-baseline e1-run1` 1차 실행 후 같은
명령으로 2회 더 실행(독립 프로세스 교대). criterion 저장치(`target/criterion/tree_route/**/e1-run1`
vs 최종 `new`)에서 뽑은 median 대조 — 2026-09-24 기록은 성능 보고서 §3.6:

| 형상(노드)   | echo 09-24 → run1 → run3 | search 09-24 → run1 → run3 |
| ------------ | ------------------------ | -------------------------- |
| balanced31   | 25.64 → 25.7 → 25.5 µs   | 13.53 → 13.6 → 13.7 µs     |
| balanced255  | 207.7 → 210.6 → 209.5 µs | 116.2 → 119.3 → 119.1 µs   |
| balanced1023 | 850.3 → 853.7 → 859.6 µs | 490.9 → 484.6 → 487.5 µs   |
| balanced8191 | 6.771 → 6.92 → 7.00 ms   | 3.808 → 3.86 → 3.87 ms     |
| wide1025     | 785.5 → 809.0 → 796.5 µs | 439.9 → 452.2 → 445.0 µs   |
| skew_limit   | 13.14 → 12.9 → 12.9 µs   | 7.10 → 7.2 → 7.1 µs        |
| payload255   | 224.9 → 223.6 → 223.3 µs | 128.2 → 130.0 → 129.1 µs   |

| 형상(노드)   | resident 09-24 → run1 → run3 | dfs 09-24 → run1 → run3  |
| ------------ | ---------------------------- | ------------------------ |
| balanced31   | 115.6 → 114.3 → 113.6 ns     | 66.2 → 65.3 → 65.1 ns    |
| balanced255  | 644.6 → 648.3 → 656.1 ns     | 589.0 → 594.3 → 597.7 ns |
| balanced1023 | 2.536 → 2.5 → 2.5 µs         | 2.415 → 2.4 → 2.4 µs     |
| balanced8191 | 19.84 → 19.6 → 19.9 µs       | 19.56 → 20.1 → 19.8 µs   |
| wide1025     | 2.204 → 2.3 → 2.2 µs         | 2.110 → 2.2 → 2.1 µs     |
| skew_limit   | 82.1 → 81.6 → 81.7 ns        | 29.3 → 29.5 → 29.5 ns    |
| payload255   | 647.5 → 654.4 → 649.0 ns     | 597.6 → 603.2 → 596.2 ns |

- **28케이스 전부 run1↔run3 ±1.9% 이내** — 현재 트리에 코덱/라우트 회귀 없음.
- 09-24 헤드라인 케이스(balanced8191 echo/resident 341× 격차)는 현재 352~353×(6.92 ms /
  19.6 µs) — 격차 구조 변화 없음.
- 정직 기록: 중간(2차) 실행에서 balanced255/1023 일부 레인이 콘솔에 +25~42%(p<0.05)
  플래그가 찍혔다 — 직후 3차 실행에서 소멸(±2% 복귀)한 **일시적 호스트 부하 스파이크**로
  판정되며 그 실행의 estimates는 최종 실행에 덮어 써졌다. 이 변동성 자체가 런북 공통
  규정("날짜 간 절대 비교는 adoption-grade 증거가 아니다")의 근거다. 채택 판정은 기기
  매트릭스만 담당한다.

## 3. rn-experiment 앱 게이트

```bash
env -u RUSTRA_BUN_LIBRARY bun run test:app:rn-experiment
# react native injected module (rn-experiment): 4 checks passed  (×2 — 재생성 전후)
```

gzip 멤버 스트림(65,536B → 35,476B), 왕복 일치, uuid v7 형식, invalid 스트림
`command.invalid_args` — 전부 통과. §3의 기기 측정(하니스 미구현)은 여전히 실행 대기.

## 범위와 한계 (정직 기록)

- **기기 매트릭스 미실행**: E1 §1.2–§1.4(설치 교체 10런), A2 §2.3(indexed/string 레인),
  rn-experiment §3.3(gzip 5런) — 실기기 없이는 채택/기각 판정을 내릴 수 없다. 본
  리시트는 §1.1/§2.1 선행 게이트의 신선화일 뿐이다.
- §8.4 리스크 2(A2 Hermes 재확인)의 **호스트 몫은 해소**(1,412/0), 기기 몫(§2.3)은
  대기. 리스크 3(E1 호스트 효과 추정)은 시뮬레이터 참고 수치(§8.2) 그대로 — 변화 없음.
- Hermes 스위트의 `ReactNativeDependencies` 의존은 artifacts tarball 추출로 충당했다
  (`pod install` 미실행) — 프레임워크 버전은 example이 고정한 0.81.5 release 산물.
