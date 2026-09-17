# 일반 함수 API의 예제 적용과 iOS Simulator 검증

## 결과

이전 구현은 Rust/TypeScript 통합 fixture까지 검증했고, 실행 가능한 RN 화면에는 아직 적용되지 않았다. 이번 작업에서 계산기 Rust crate와 RN `functions` 화면에 적용하고 iPhone 17 / iOS 26.2 / arm64 Simulator의 Release 앱으로 확인했다. 최종 앱의 독립 실행 3회가 각각 네이티브 검증 13개를 통과했다.

작업 위치는 `.worktrees/function-registration`, 브랜치는 `codex/function-registration`이다. 원래 작업 디렉터리와 M1 작업은 유지했다. 변경은 로컬 미커밋 상태이며 릴리스나 1.0 완료를 의미하지 않는다.

## 실제 예제

- [Rust 등록](../../examples/calculator/src/ordinary_functions.rs): `add`, `greetPerson`, `safeDivide`, `remember`, `readRemembered`, `reset`. 일반 함수와 클로저를 등록하며 기존 명령 뒤에 ID 34..39를 추가했다.
- [RN 화면](../../examples/react-native-calculator/App.tsx): 생성된 `add(42, 58)`, `remember(100)`, `reset()` 등을 직접 호출한다. 기본 벤치마크 화면은 유지하고 `functions` 모드로 선택한다.
- [네이티브 검증·측정](../../examples/react-native-calculator/src/function-demo.ts): 값, 문자열, void, Rust 상태, 도메인 오류, live schema 경로, 인코딩 바이트, 기존 command 호환을 먼저 확인한다.
- bare RN의 생성 API와 계산기의 Rust/Swift/Kotlin UniFFI 산출물도 같은 스키마로 갱신했다. bare RN 앱 자체를 실행했다는 주장은 하지 않는다.

```sh
cd examples/react-native-calculator
bun run codegen
bun run ios:functions
bun run verify:functions:ios --device booted --runs 3
```

이미 빌드된 development client에서는 `bun run demo:functions`로 화면을 선택한다. Rust 변경 후에는 네이티브 재빌드가 필요하다. 이번 검증은 Rust를 `aarch64-apple-ios-sim`으로 빌드하고 Xcode에 `ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`를 지정했다. 처음에는 arm64 archive에 x86_64 앱까지 연결하려 해 실패했으며, 실제 Simulator 대상에 맞춰 해결했다.

## 발견하고 수정한 문제

1. **위치 인자 facade 생성:** 기존 `positional: true` 옵션이 튜플 필드 번호를 매개변수 이름으로 사용해 `add(0: number, 1: number)`를 생성했다. 이미 위치 인자를 받는 일반 함수는 생성된 함수 자체를 재수출하도록 수정했다. 옵션·void·오류 경로를 유지하며 Node와 Bun 양쪽에서 컴파일된 결과를 검증한다.
2. **UniFFI 타입 추정:** 기존 renderer는 입력·출력 record를 가정했다. 일반 함수용 wrapper를 추가했고, `String`과 `SocketAddr`처럼 JSON schema가 같아도 postcard 표현이 다른 경우를 독립 검토에서 확인했다. 일반 함수 mirror는 JSON tuple → 실제 `Package::invoke_json` → JSON 결과 변환을 사용한다. 기존 command의 `invoke_typed` 경로는 유지했다. 이는 예제의 UniFFI 호환 경로이며 RN의 바이너리 호출 경로에는 영향을 주지 않는다.
3. **반복 전송 버퍼 할당:** JS `encodeInto`가 64바이트 용량의 짧은 view를 반환할 때 dispatch가 매번 정확한 길이의 `ArrayBuffer`를 새로 만들었다. 명령별 인코딩 버퍼와 전송 버퍼를 유지해 같은 길이의 요청에서는 전송 버퍼를 재사용한다. 복사는 남아 있으며 길이가 바뀌거나 같은 명령이 재진입하면 할당이 발생할 수 있다. 인코딩부터 응답 해석까지 사용 중인 버퍼를 보호해 재진입 시 덮어쓰기도 방지했다.
4. **이전 실행 결과 혼입:** 별도 [수집기](../../examples/react-native-calculator/scripts/verify-function-simulator.mjs)가 이전 프로세스를 먼저 종료하고 함수 검증 파일만 제거한 뒤 실행 시각을 기록하고 새 앱을 시작한다. 오래된 결과, 소스·계약 불일치, 실패한 검증을 거부하고 실행 ID, Simulator 식별자, 바이너리·번들 해시를 남긴다. 기존 benchmark receipt는 유지한다.

## Simulator 결과와 성능 범위

최종 빌드:

- Simulator: `99B087B5-DEF6-4CF1-9177-81A5DE564CFC`, iPhone 17, iOS 26.2, arm64
- Bundle: `com.alt-shifted.react-native-calculator`, Release, Hermes, `EXPO_PUBLIC_RUSTRA_DEMO=functions`
- Source fingerprint: `65c339a0ba66770cf2c7b57fbf31a89477776c7039c2768521295210668322f1` — [262개 입력 파일](./2026-09-16-function-simulator/source-inputs.json)
- Contract: `bb88ac05d152c16fac2fe5e194323a3222534cbdd7b1d13b5b590d120dcf8a7c`
- [최종 실행 manifest](./2026-09-16-function-simulator/final/manifest.json): PID 18632, 18679, 18742와 서로 다른 생성 시각·receipt 해시를 확인했다.

각 실행은 예열 2회 이후 20개 batch 평균을 수집했다. 함수 호출은 batch당 1,000회, 인코딩은 5,000회이며 실행 순서를 번갈아 측정했다. 아래 값은 **독립 실행 3회에서 얻은 p50의 중앙값**이다. p50은 개별 호출 지연의 중앙값이 아니라 batch 평균들의 중앙값이다.

| 측정 범위                                 |   개선 전 |      최종 |
| ----------------------------------------- | --------: | --------: |
| 생성된 `add` 호출 + await + 네이티브 왕복 | 15.061 μs | 14.859 μs |
| 기존 `addNumbers` 호출                    |  4.949 μs |  4.966 μs |
| 생성된 요청 인코딩 `encode`               |  2,102 ns |  2,111 ns |
| 재사용 인코딩 `encodeInto`                |    644 ns |    635 ns |

함수 호출은 약 1.3% 낮게 측정됐지만 실행 간 변동과 겹친다. 두 빌드 사이에는 예제 메타데이터와 UniFFI 호환 수정도 포함되어 있으므로, 이를 버퍼 변경의 유의미한 지연 개선으로 단정하지 않는다. 이번 최적화에서 테스트로 확인한 이득은 **같은 길이 요청의 반복 전송 ArrayBuffer 할당 제거**이다.

최종 `encodeInto`는 `encode`보다 약 3.3배 빨랐다. 이 비교는 인코딩만 측정하며 네이티브 호출과 정확한 전송 버퍼로의 복사를 제외한다. 전체 브리지 호출이 3.3배 빨라졌다는 뜻은 아니다. 기존 command는 native fast path와 i64 입출력 record 및 결과 정규화를 사용하므로 새 i32 함수와 동등한 wire workload가 아니다. 일반 함수의 native capability는 0이며 검증된 JS 바이너리 codec 경로를 사용한다.

[개선 전 원본 기록](./2026-09-16-function-simulator/baseline/manifest.json)과 [최종 원본 기록](./2026-09-16-function-simulator/final/manifest.json)을 보존했다. 기준 측정도 각 이전 실행의 검증 파일 생성이 완료된 뒤 다음 실행을 시작했으며, 동일한 receipt를 복사해 반복으로 세지 않았다. CPU를 사용하는 별도 빌드·테스트를 측정 중에 실행하지 않았다. 이 결과는 Simulator 기준이며 실제 iPhone/Android 기기 성능을 입증하지 않는다.

## 화면 확인

최종 앱에서 접근성 상태로 다음 결과를 확인했다. 앞선 동일 화면의 목적을 제한한 시각 검사에서도 버튼과 텍스트 배치를 확인했다.

- 시작: `준비 완료 · Rust에 저장된 값: 0`, `네이티브 검증 13개 통과`
- 더하고 저장: `42 + 58 = 100 · Rust에 저장된 값: 100`
- 오류 확인: `Cannot divide by zero`
- 초기화: `reset() 완료 · Rust에 저장된 값: 0`

## 검증

- Rust 계산기 lib 52개 + 일반 함수 통합 1개 통과. lib에는 UniFFI renderer 28개가 포함된다.
- types 전체 276개, 버퍼 경계 독립 검토 11개 통과.
- CLI 전체 Node 319개 + Bun 34개 통과. 새 facade 테스트는 생성 TS를 JS로 컴파일한 뒤 실제 import한다.
- 일반 함수 통합: 실제 Rust와 Rust/CLI 생성 wrapper, static/live/JSON 경로에서 18개 명령·308개 확인 통과. 이번 실행의 별도 C++ shim 옵션은 꺼져 있었으며, RN C++ codec harness와 실제 Simulator 결과를 별도로 확인했다.
- 계산기 TS 컴파일 및 114개 테스트 통과, 기존 환경 제한에 따른 6개 skip 유지.
- RN TS 검사, 15개 테스트, C++ codec harness 통과. 화면 코드 React Doctor 100/100.
- 6개 예제 codegen freshness 통과. 현재 UniFFI feature cdylib 빌드와 실제 Swift/Kotlin bindgen 완료.
- 계산기 all-targets + UniFFI Clippy, Rust formatting, architecture, API snapshot, 문서 동기화·한영 쌍·릴리스 버전 문서 검사 통과. 예제 스키마 변경으로 달라진 6개 문서 코드 영역도 갱신했다.
- source `git diff --check` 통과. upstream UniFFI bindgen이 생성한 header/Kotlin의 공백 줄은 원본 생성 결과를 유지하므로 전체 diff의 trailing-whitespace 경고는 남는다.

검증 로그의 해시와 현재 source/실행 기록은 [verification.json](./2026-09-16-function-simulator/verification.json)에 정리한다. 기존 core API 검증은 [이전 보고서](./2026-09-16-function-registration-verification.md)의 범위를 유지하고, 이번 보고서가 실행 가능한 예제와 Simulator 증거를 추가한다.

독립 검토에서 구현·품질·최종 성능/출처 주장 모두 PASS, 남은 지적 0건을 확인했다. 현재 소스 262개와 별도 변경 소스 13개, 로그 15개, manifest 2개와 실행 receipt 6개의 해시 및 수치 계산을 대조했다.
