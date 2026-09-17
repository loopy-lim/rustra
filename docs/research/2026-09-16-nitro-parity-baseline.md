# Nitro 비교 기준 측정 — 최적화 전

발행된 Rustra 0.10.2의 런타임에서 동일한 native fixture를 추가해 측정했다. 이 문서는 새 최적화의 성과가 아니라 이후 비교의 기준이다. Nitro Modules와 nitrogen은 모두 0.37.1, React Native는 0.81.5, Hermes Release다.

iOS Simulator와 Android 실기기에서 각각 독립 앱 실행 5회, 실행당 60개 항목의 정답 검증을 통과했다. 노드 수·입력 크기·batch·31회 표본·생성 계약을 원래 빌드에서 만든 manifest와 대조했다. 전체 표본과 모든 판정은 [원본 결과](../benchmark-receipts/2026-09-16-nitro-parity-baseline.json)에 있다.

## 판정과 해석

- ratio는 Rustra 시간 / Nitro 시간이다. 작을수록 Rustra가 빠르다.
- 각 실행의 산술 평균 비율을 로그 공간에서 합치고 Student-t 95% CI를 구한다. ±5% 구간 전체에 CI가 들어오면 동급이다.
- p50/p95는 batch별 호출당 평균의 분포다. 개별 호출의 지연 분포가 아니다.
- 내부 동기 진단 경로에는 호출마다 registry 조회가 포함된다. 공개 동기 API 성능을 뜻하지 않는다. 기존 공개 Promise API 비교는 별도다.
- 양쪽 모두 같은 flat arena를 사용한다. Nitro의 재귀 DTO 생성 실험은 stack overflow로 실패했으며, 이 결과로 재귀 DTO API의 동급을 주장하지 않는다.
- setup/update는 전체 트리와 dense index를 다시 만드는 따뜻한 상태의 교체다. 초기 빈 저장소의 비용은 측정하지 않았다.
- 버퍼는 외부 메모리 회계가 달랐다. Nitro는 소유 버퍼 크기를 명시적으로 신고하고 Rustra의 기존 helper에는 해당 호출이 없다. 사용 중인 Hermes revision의 [외부 버퍼 연결 구현](https://github.com/facebook/hermes/blob/e0fc67142ec0763c6b6153ca2bf96df815539782/lib/VM/JSArrayBuffer.cpp#L254-L278)은 이를 자동 신고하지 않는다. 아래 버퍼 통계의 우위 분류는 이 차이를 정규화하기 전 진단 결과이며, 확정적인 동급 이상 성과에 포함하지 않는다.

## 대표 공개 비동기 결과

| 환경           | 작업                      | Rustra p50 (µs) | Nitro p50 (µs) | 평균 비율 95% CI | 판정        |
| -------------- | ------------------------- | --------------: | -------------: | ---------------- | ----------- |
| iOS Simulator  | add                       |           2.522 |          2.429 | 1.022–1.050      | 불확실      |
| iOS Simulator  | string                    |           3.105 |          2.776 | 1.098–1.129      | Rustra 느림 |
| iOS Simulator  | pair                      |           2.689 |          2.552 | 1.048–1.061      | 불확실      |
| iOS Simulator  | buffer64                  |           3.113 |          3.182 | 0.860–0.902      | Rustra 우위 |
| iOS Simulator  | buffer65536               |           8.823 |          9.016 | 0.720–0.812      | Rustra 우위 |
| iOS Simulator  | buffer1048571             |          94.917 |         99.500 | 0.737–0.839      | Rustra 우위 |
| iOS Simulator  | balanced8191/echo         |       24506.625 |      19180.833 | 1.316–1.343      | Rustra 느림 |
| iOS Simulator  | balanced8191/input-dfs    |       12931.125 |      10409.291 | 1.233–1.257      | Rustra 느림 |
| iOS Simulator  | balanced8191/resident-dfs |          64.969 |         54.232 | 1.147–1.230      | Rustra 느림 |
| iOS Simulator  | balanced8191/indexed      |           2.974 |          2.592 | 1.115–1.154      | Rustra 느림 |
| iOS Simulator  | balanced8191/setup        |       12936.000 |       9724.917 | 1.322–1.338      | Rustra 느림 |
| iOS Simulator  | balanced8191/update       |       12838.375 |       9724.958 | 1.303–1.333      | Rustra 느림 |
| Android 실기기 | add                       |           3.489 |          3.432 | 1.012–1.042      | 동급        |
| Android 실기기 | string                    |           4.355 |          3.969 | 1.084–1.098      | Rustra 느림 |
| Android 실기기 | pair                      |           3.850 |          3.713 | 1.033–1.056      | 불확실      |
| Android 실기기 | buffer64                  |           4.517 |          5.299 | 0.757–0.806      | Rustra 우위 |
| Android 실기기 | buffer65536               |           6.478 |          6.921 | 0.653–0.802      | Rustra 우위 |
| Android 실기기 | buffer1048571             |          31.094 |         33.750 | 0.851–0.895      | Rustra 우위 |
| Android 실기기 | balanced8191/echo         |       38151.510 |      32897.604 | 1.190–1.203      | Rustra 느림 |
| Android 실기기 | balanced8191/input-dfs    |       22375.416 |      20472.500 | 1.087–1.101      | Rustra 느림 |
| Android 실기기 | balanced8191/resident-dfs |          41.058 |         46.911 | 0.859–0.895      | Rustra 우위 |
| Android 실기기 | balanced8191/indexed      |           4.476 |          3.795 | 1.171–1.203      | Rustra 느림 |
| Android 실기기 | balanced8191/setup        |       24605.156 |      19050.260 | 1.270–1.307      | Rustra 느림 |
| Android 실기기 | balanced8191/update       |       24396.094 |      19156.563 | 1.245–1.304      | Rustra 느림 |

## 후속 개선의 근거

큰 arena의 전체 왕복과 입력 변환은 두 환경에서 모두 느리다. 별도 iOS CPU sample에서는 generated C++의 속성 조회·map key 변환과 결과 객체 생성 경로를 확인했다. Rust 쪽 arena는 postcard를 사용하므로, 이전 재귀 complex SerMap의 40,955회 임시 할당을 이 측정의 원인으로 적용하지 않는다.

일부 큰 버퍼에는 긴 지연 표본이 있어 평균 비율과 중앙값 비율이 크게 다르다. 예를 들어 Android 내부 동기 1MiB 경계 버퍼의 p50은 25.36/28.49µs지만 평균 비율은 약 0.287이다. 이를 중앙값 기준 3.5배 우위로 표현하지 않는다. 메모리 압력·GC의 원인 비중은 이 시간 표만으로 확정할 수 없다. 같은 runtime을 교차 사용하므로, 어느 구현이 촉발한 GC가 앞선 다른 구현의 버퍼를 함께 회수할 가능성도 조사한다. 원본 표본이나 통계 분류는 바꾸지 않는다.

새 공개 동기 binding은 원래 async 명령을 구분하는 생산자 메타데이터와 native core 교체에 대한 안전한 호출 경계를 포함해야 한다. 검증 비용까지 포함해 다시 측정하며, 아직 해당 API의 동급 판정은 없다.

## 실행 환경과 재현

- iOS: Apple M1 Max 호스트, iPhone 17 Simulator/iOS26.2, arm64 Release. 디버그 심볼·index store 비활성화.
- Android: Lenovo TB710FU, Android16, arm64-v8a Release, AC 전원·배터리100%.
- 전용 앱 ID `com.rustra.nitroparity`; 기존 계산기 앱 데이터 보존.
- Node22.21.1, Bun1.4.1. Android 빌드는 JDK21.0.8/Gradle8.14.3/NDK27.1.12297006 사용.
- iOS collector: `examples/react-native-calculator/scripts/run-nitro-parity.ts`.
- Android collector: `examples/react-native-calculator/scripts/run-nitro-parity-android.ts`; 설치된 APK hash와 frozen manifest를 받아 검증한다.

원래 raw receipt와 binary hash는 유지했다. iOS 수집 이후 host validator를 강화했으며, 원래 source-derived manifest로 5회 결과를 재검증했을 때 60개 summary/CI가 전부 동일했다. Android는 강화된 validator와 별도 source fingerprint로 측정했다.
