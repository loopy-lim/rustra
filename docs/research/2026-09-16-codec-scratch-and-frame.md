# 재귀 코덱의 임시 할당과 응답 버퍼 개선

발행된 0.10.2에 공개 동기 API 작업까지 반영한 소스를 기준으로 측정했다. 이 문서는 `Package::invoke_frame` 경계의 재귀 ComplexSerde 실험이다. Hermes/JSI/Nitro의 flat arena 비교와 구분하며, 새 버전의 발행 기록이 아니다.

## 결과

독립 프로세스 5회씩 비교한 결과, 8,191노드 왕복은 시간 비율 0.873(95% CI 0.828–0.920), 약 12.7% 단축됐다. 64KiB 문자열은 약 24.5%, 약 1MiB 응답은 약 26.0% 단축됐다. [전체 42항목의 단계별 통계와 소스·실행파일 hash](../benchmark-receipts/2026-09-16-codec-scratch-and-frame.json)를 보존했다. 모든 항목에 개선이 입증된 것은 아니다.

| 8,191노드 왕복    |    변경 전 | 작은 map 임시 저장 개선 | 응답 버퍼 개선 추가 |
| ----------------- | ---------: | ----------------------: | ------------------: |
| 호출당 할당 요청  |     96,944 |                  55,989 |              55,987 |
| 호출당 요청 bytes | 10,932,728 |               9,097,944 |           7,666,426 |

할당 횟수는 약 42.2%, 요청 bytes는 약 29.9% 감소했다. bytes는 alloc/alloc_zeroed/realloc이 요청한 누적 크기이며 RSS, 살아 있는 메모리, 최대 사용량이 아니다. 입력의 소유 String/Vec/BTreeMap 저장소 55,971회는 유지한다. 기존 7개 tree shape 모두 첫 단계의 감소량이 정확히 5N이었다. 전체 입력 탐색은 작은 응답 할당 1회 감소, resident 1회와 순수 DFS 0회는 그대로다.

## 구현과 보존 조건

짧은 map의 최대 2개 키·값은 소유하는 작은 저장소에 기록하고, 큰 키·값·엔트리 수는 각각 heap으로 넘어간다. 임의 serde map의 UTF8 키 정렬을 유지하며 BTreeMap이나 특정 fixture 키를 전제하지 않는다. 버퍼 확장을 위해 Serialize를 다시 실행하지 않는다. 호출자 소유 출력 슬라이스는 기존처럼 용량 초과를 보고한다.

복합 응답은 8바이트 header와 body를 같은 Vec에 기록한다. body의 코덱 제한과 header를 포함한 최종 제한은 따로 유지한다. 성공적인 직접 직렬화는 1회이며, 호환 fallback과 호출자 버퍼 overflow의 기존 Serialize 재시도 정책은 유지한다. 어느 경우에도 handler를 다시 실행하지 않는다. 다음 호출과 독립된 소유 응답을 반환한다.

큰 map에는 명시적인 비용이 있다. 64키 control은 요청 bytes 16,809→28,984(약 72.4% 증가)지만 호출 시간 비율은 0.873(CI 0.834–0.915)이었다. inline 저장소가 큰 map의 heap 엔트리에도 공간을 차지하기 때문이다. 메모리 사용이 모든 입력에서 감소한다고 주장하지 않는다.

## 측정 방법과 한계

- 기준판, 작은 map 개선판, 응답 개선판의 실행파일을 각각 보존했다. 동일 fixture와 release 설정으로 단계당 5프로세스 × 2suite를 실행하고 순서를 바꿨다. 제외한 실행은 없다.
- Criterion 0.8.2, rustc 1.98.0, macOS arm64. 항목당 warmup 0.1초, 요청 measurement 0.3초, tree 100/complex 500표본, bootstrap 1,000회다. 긴 항목은 Criterion이 실제 측정 시간을 늘릴 수 있다.
- 각 독립 프로세스의 산술평균으로 paired ratio를 만든 뒤 log 공간의 기하평균과 Student t 95% CI(df 4)를 구했다. 단일 호출 p95 latency를 측정한 표가 아니다.
- 같은 기간에 native 빌드, 기기 벤치, Miri를 실행하지 않았다. 호스트 전체를 독점하지 않았으므로 일부 짧은 항목의 CI가 넓다. 특히 1,024정수 map의 전체 개선은 불확실하며, 응답 단계만의 비교에서는 약 3.4% 느려졌다.
- Nitro 비교의 동급 기준은 별도 SPEC에 정한 ±5% CI다. 이 코어 표로 Nitro 우위를 판정하지 않는다.

## 전체 결과

ratio는 작은 map과 응답 버퍼를 개선한 H2/변경 전이며 1보다 작으면 빠르다. CI가 1을 지나는 경우 차이가 확정되지 않았다.

| 항목                              | 시간ratio |      95% CI |   변화 |
| --------------------------------- | --------: | ----------: | -----: |
| `complex/map_keys_2`              |     0.879 | 0.865–0.892 | -12.1% |
| `complex/map_keys_64`             |     0.873 | 0.834–0.915 | -12.7% |
| `complex/map_of_seqs`             |     0.819 | 0.684–0.981 | -18.1% |
| `complex/map_seq_1024`            |     0.936 | 0.748–1.172 |  -6.4% |
| `complex/oneof_data_enum`         |     0.794 | 0.589–1.072 | -20.6% |
| `complex/optional_chunks_near_1m` |     0.740 | 0.726–0.753 | -26.0% |
| `complex/optional_none`           |     0.838 | 0.795–0.883 | -16.2% |
| `complex/optional_string_64`      |     0.897 | 0.865–0.930 | -10.3% |
| `complex/optional_string_64k`     |     0.755 | 0.721–0.791 | -24.5% |
| `complex/recursive_depth_1`       |     0.868 | 0.736–1.023 | -13.2% |
| `complex/recursive_depth_16`      |     0.942 | 0.921–0.962 |  -5.8% |
| `complex/recursive_depth_8`       |     0.873 | 0.753–1.013 | -12.7% |
| `complex/scalar_control`          |     0.993 | 0.969–1.017 |  -0.7% |
| `complex/wide_struct_32`          |     0.983 | 0.940–1.029 |  -1.7% |
| `tree/dfs/balanced1023`           |     0.993 | 0.979–1.007 |  -0.7% |
| `tree/dfs/balanced255`            |     0.988 | 0.964–1.012 |  -1.2% |
| `tree/dfs/balanced31`             |     0.998 | 0.978–1.019 |  -0.2% |
| `tree/dfs/balanced8191`           |     0.996 | 0.987–1.005 |  -0.4% |
| `tree/dfs/payload255`             |     0.984 | 0.965–1.002 |  -1.6% |
| `tree/dfs/skew_limit`             |     0.985 | 0.950–1.022 |  -1.5% |
| `tree/dfs/wide1025`               |     0.998 | 0.981–1.015 |  -0.2% |
| `tree/echo/balanced1023`          |     0.910 | 0.886–0.935 |  -9.0% |
| `tree/echo/balanced255`           |     0.910 | 0.886–0.934 |  -9.0% |
| `tree/echo/balanced31`            |     0.931 | 0.909–0.954 |  -6.9% |
| `tree/echo/balanced8191`          |     0.873 | 0.828–0.920 | -12.7% |
| `tree/echo/payload255`            |     0.889 | 0.860–0.918 | -11.1% |
| `tree/echo/skew_limit`            |     0.915 | 0.897–0.934 |  -8.5% |
| `tree/echo/wide1025`              |     0.890 | 0.873–0.907 | -11.0% |
| `tree/resident/balanced1023`      |     1.048 | 0.874–1.256 |  +4.8% |
| `tree/resident/balanced255`       |     0.994 | 0.965–1.025 |  -0.6% |
| `tree/resident/balanced31`        |     0.998 | 0.920–1.083 |  -0.2% |
| `tree/resident/balanced8191`      |     0.990 | 0.959–1.022 |  -1.0% |
| `tree/resident/payload255`        |     0.987 | 0.975–0.999 |  -1.3% |
| `tree/resident/skew_limit`        |     0.984 | 0.948–1.021 |  -1.6% |
| `tree/resident/wide1025`          |     0.994 | 0.978–1.010 |  -0.6% |
| `tree/search/balanced1023`        |     0.971 | 0.959–0.983 |  -2.9% |
| `tree/search/balanced255`         |     0.996 | 0.985–1.008 |  -0.4% |
| `tree/search/balanced31`          |     1.009 | 0.997–1.021 |  +0.9% |
| `tree/search/balanced8191`        |     0.975 | 0.939–1.012 |  -2.5% |
| `tree/search/payload255`          |     0.991 | 0.977–1.005 |  -0.9% |
| `tree/search/skew_limit`          |     0.993 | 0.969–1.017 |  -0.7% |
| `tree/search/wide1025`            |     0.988 | 0.944–1.034 |  -1.2% |

## 검증

Rust lib 216개와 header 포함 응답 제한 검사 1개가 통과했다. 이후 인라이닝 조사에 추가한 호환성 검사 2개를 포함해 AddressSanitizer 218개와 Miri 68개 코덱 검사를 통과했다. 작은 map의 임시 할당 5→0, 작은 복합 응답 할당 2→1은 변경 전 실패와 변경 후 통과로 확인했다. 잘못된 입력, 깊이·길이·숫자 범위, 정렬, 호환 fallback, handler 단일 실행, 소유 응답을 검사한다.

ASan은 macOS에서 실행했고 LeakSanitizer는 활성화하지 않았다. 이전 릴리스의 Linux 안전 검사를 이번 후보의 증거로 대체하지 않는다. 새 JSI 코덱의 Hermes 안전 검사와 실제 iOS/Android 성능 비교는 별도 기록한다.

후속 [정수 배열 반복 분기 개선](2026-09-16-integer-sequence-optimization.md)은 동일 H2와 별도로 비교했으며, 채택하지 않은 인라이닝 실험도 기록했다.
