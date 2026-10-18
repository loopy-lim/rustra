# 실기기 A/B 측정 런북 — E1 owned 핸드오프 · A2 emit 전환 · rn-experiment 버퍼

남은 세 항목의 기기 측정 절차다. E1/A2는 행렬 프로토콜, gzip은 §3의 동일 연산 수집기를
사용한다. 이름 재사용
채택 선례([프로토콜](dev/research/2026-09-16-nitro-call-profile.md),
[수화물](benchmark-receipts/2026-09-18-nitro-name-reuse-ab.json), 계약
`rustra-name-reuse-ab/v1` 형식)와 [performance-evaluation.md §7.3/§7.6](performance-evaluation.md)의
플랜의 현재 정정을 반영한다.

- **채택 판정은 이 런북의 실행으로만 내린다.** 시뮬레이터 수치
  ([sim-hotswap](benchmark-receipts/2026-09-24-sim-hotswap.md),
  [sim-e1](benchmark-receipts/2026-09-24-sim-e1-hermes.md), 요약은
  [performance-evaluation.md §8](performance-evaluation.md))은 참고용이다 — 경로가 종단에서
  동작함을 증명할 뿐, 채택을 결정하지 않는다.
- 모든 `bun` 명령은 `env -u RUSTRA_BUN_LIBRARY …` 로 실행한다(루프 데몬 dylib 오염 방지 —
  2026-09-24 전체 리시트와 동일 규칙).

## 0. 공통 프로토콜 (세 항목 공통)

이름 재사용 선례에서 고정한 규칙이다 — 항목별로 재협상하지 않는다:

1. **소스를 먼저 고정한다.** 서식 보정된 새 소스를 커밋(또는 고정 트리 상태로 stash)한 뒤
   빌드한다. 후보 arm과 기존 arm은 해당 항목의 diff만 다르다(§1.1, §2.2, §3.2).
2. **계측 없는 Release 빌드.** 프로파일러 부착 없음, GC 강제 없음, 느린 표본 제외 없음.
   실패·중단된 실행은 통째로 버리거나 설치부터 재실행한다.
3. **E1/A2 독립 실행, 실행마다 설치 교체.** 한 번에 정확히 하나의 arm만 설치한다. 전용 앱 id
   `com.rustra.nitroparity` 는
   `examples/react-native-calculator/scripts/parity-app-policy.ts`(`requireDedicatedApp`)가
   강제한다.
4. **E1/A2 실행마다 receipt 검증.** 모든 행렬 런치는 v2 전체 행렬 receipt 검증(90개 항목 = 30 id × 3
   레인, 케이스당 31라운드)을 호스트 매니페스트 대상으로 통과해야 하고, 실행 후 바이너리
   SHA-256을 재확인한다. `run-nitro-parity-once.ts` 가 둘 다 수행하며 위반 시 프로토콜을
   중단한다.
5. **통계.** 런치 쌍의 로그비율, t(4) 명목 95% 구간, 다중 비교 보정 없음. 후보/기존 비율의
   레인별·전체 지오메단. CI가 1을 포함하는 watch 항목은 유의하지 않음으로 보고하지,
   승리로 계산하지 않는다.
6. **E1/A2 receipt.** 실행된 각 행렬 항목은 `rustra-name-reuse-ab/v1` 형태의
   `docs/benchmark-receipts/<date>-<item>-ab.json` 을 남긴다: `contract`, `status`
   (adopted/rejected), `date`, `sourceCommit`, `candidateBaseline`, `decision`,
   `environment`(device, runtime, udid, jsEngine), `methodology`(protocol, runs,
   launchesPerArm, suite, validation, statistics), `arms`(arm별 description, runs,
   `binarySha256`, `bundleSha256`, `fingerprint`, launches), analysis. 원시 로그는
   `target/<item>-ab/` 에 보존한다.
7. **호스트 Criterion은 비교 가능한 환경만 판정한다.** 측정 세션마다
   `env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-environment.mjs target/criterion`을
   실행한다. 두 번째 호출부터 직전 환경이 기준선 기록으로 짝지어진다. 기록이 없거나
   불완전하면 exit 2다. CPU 모델·아키텍처·CPU 수·가용 병렬성·메모리 GiB 등급·
   커널 major/minor·OS 이미지 종류·툴체인·컴파일 플래그가 달라도 타이밍 판정을
   중단한다. 이미지/커널 patch와 같은 GiB 등급의 세부 메모리 차이는 자문이다.
   기준선을 유지하고 같은 러너의 `comparison_ref`로 재측정한다. 로컬 판정 수정은
   원격 Benchmark 판정 회복이나 새 원격 측정 성공을 뜻하지 않는다.

### 0.1 수집기·집계기 재사용 (이미 저장소에 있다)

```bash
cd examples/react-native-calculator

# 설치된 arm 1회 실행: receipt를 호스트 매니페스트 대상으로 검증, 바이너리 SHA 재확인,
# /tmp/parity-ab/run-<N>/receipt.json 기록(래퍼: label, binarySha256, bundleSha256,
# fingerprint, launch pid, receipt)
env -u RUSTRA_BUN_LIBRARY bun scripts/run-nitro-parity-once.ts \
  --device $UDID --output /tmp/parity-ab/run-1 --label C   # 또는 --label L

# 10회 완료 후: 케이스별 비율, 레인별/전체 지오메단, 쌍별 t(4) 카운트
env -u RUSTRA_BUN_LIBRARY bun scripts/aggregate-parity-ab.ts
# → /tmp/parity-ab/aggregate-raw.json, /tmp/parity-ab/paired-cases.json
```

`aggregate-parity-ab.ts` 는 선례의 구현값을 하드코딩한다: 후보 런 `C_RUNS = [1,4,5,8,10]`,
기존 런 `L_RUNS = [2,3,6,7,9]`, 페어 `(C1,L2)(C4,L3)(C5,L6)(C8,L7)(C10,L9)`. **항목마다 한
가지 적응이 필요하다:** `manifestFor(arm)` 이
`modules/rustra-jsi/generated/rustra-generated-codecs.hpp` 를 패치(이름 재사용 define 토글)해
arm별 빌드 지문을 재현하는 부분이다. `aggregate()` 는 receipt를 **라이브 트리** 지문 대상으로
검증하므로, 새 항목에서는 이 토글을 해당 항목의 arm 차이(E1: 브리지/코어 E1 diff §1.1, A2:
생성 `commands.ts` 변형 §2.2)로 교체해야 한다 — 나머지는 그대로다.

### 0.2 기기

| 레인                   | 기기                                                                                             | 비고                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS 참고 실행          | iPhone 17 시뮬레이터, iOS 26.2 (2026-09-24 리시트의 UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC`) | 역사적 시뮬레이터 비교용이며 실기기 효과를 입증하지 않음                                                                                         |
| iOS 채택 실행 (실기기) | 실물 iPhone, `aarch64-apple-ios`                                                                 | `RUSTRA_IOS_TARGET=aarch64-apple-ios` 로 빌드, 설치·실행·인출은 `xcrun devicectl` — 저장소에서 아직 검증된 적 없는 경로라 미검증 플럼빙으로 취급 |
| Android 실행           | 실기기                                                                                           | v2 선례; 고정 후보 5회 실행이며 보존된 구집단과의 차이를 인과 A/B로 표현하지 **않는다**                                                          |

### 0.3 호스트 A/B 영수증 생산자 (CI 게이트 아님)

2026-10-13 호스트 성능 영수증은 일회성 하네스 3개와 호스트 마이크로벤치 앱 2개가 만들었다.
이들은 예제가 아니라 측정 생산자다 — 커밋된 영수증이 문서화된 대로 재현 가능하려면 실행
가능 상태를 유지한다. 각 영수증은 정확한 `command` 호출과 소스·아티팩트 해시를 기록하므로
`bun run build:cli` 뒤에 보존된 베이스라인 트리로 재실행하면 비교 형태가 재현된다:

- `env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-bun-owned.mjs <bun-ffi.ts> <dylib> <receipt.json> <label>`
  — Bun FFI owned 응답 A/B
  ([영수증](benchmark-receipts/2026-10-13-bun-owned-ab.json),
  [여정](dev/research/2026-10-13-bun-owned-response.md)).
- `node scripts/node-framing-bench.mjs <built-module> <receipt.json>` — 바이너리 프레임
  파편화 복사 횟수 A/B
  ([영수증](benchmark-receipts/2026-10-13-node-framing-ab.json), 대체된 `-initial`·
  `-fastpath` 후보도 증거로 보존).
- `node scripts/node-native-echo-bench.mjs <adapter-entry> <frame-registry> <runtime-binary> <receipt.json>`
  — 같은 런타임 바이너리로 파편화 프레임 end-to-end echo.
- `env -u RUSTRA_BUN_LIBRARY bun examples/calculator/apps/bun-ffi-bench.ts` 와
  `env -u RUSTRA_BUN_LIBRARY bun examples/calculator/apps/scriptc-bench.ts` — Bun FFI와
  scriptc 표면의 warm 호스트 디스패치 마이크로벤치(3형상 arm 보고; arm 구성은 2026-10-13
  리서치 로그 참조).

## 1. E1 — 큰 응답 owned 핸드오프 (probe 캐시 2-FFI 왕복 제거)

### 1.1 전제 (기기/빌드)

- 호스트 선행 게이트는 이미 녹색이다(performance-evaluation.md §7.2): Rust 워크스페이스, TS
  릴리스 게이트, C++ codec 스위트, Hermes 단언 스위트(1,383 단언), ASan, `tree_route` 교대
  호스트 A/B. 정확성을 기기에서 다시 따지지 않는다 — 실행마다의 90항목 검증이 기기 정확성
  게이트다.
- **런타임 토글은 존재하지 않는다**(sim-e1 리시트 §3-1): 심볼이 존재하면
  `invoke_frame_owned` 가 무조건 바인딩된다. 따라서 arm은 설치 단위 빌드 두 개다:
  - **후보 (C)** = 현재 main. arm 바이너리당 1회 사전 확인:
    `nm -gU -arch arm64 <앱 바이너리> | grep rustra_ffi_invoke_frame_owned` 가 심볼(T)을
    나열해야 한다 — E1 분기 활성, probe 폴백은 도달 불가한 죽은 코드.
  - **기존 (L)** = E1 revert 빌드: `crates/rustra/src/ffi_typed_buffer.rs` **와**
    `packages/react-native/native/cpp/RustraJSIBridge.{hpp,cpp}` 의 E1 diff를 함께 제거한
    하나의 트리로 빌드한다. "신형 셸 + 구형 정적 코어" 링크 조합은 지원되지 않는다(Apple
    링커가 unresolved weak 참조를 거부 — performance-evaluation.md §7.5 리스크 1). probe
    경로 arm은 E1 이전의 일관된 소스 상태에서 나와야 한다.
- 빌드: `bash modules/rustra-jsi/ios/build-rust-ios.sh`(fat release 코어) → sim-e1 리시트의
  재현 런북과 동일한 `xcodebuild -configuration Release -sdk iphonesimulator`
  (`env -u EXPO_PUBLIC_RUSTRA_DEMO` 포함) → `xcrun simctl install $UDID <앱>`. arm별
  `binarySha256`/`bundleSha256` 를 기록한다(수집기가 모든 실행 래퍼에 기록한다).

### 1.2 표본 설계와 명령

- **iOS: 5쌍, 실행마다 설치 교체, 총 10회.** 실행 순서 `C L L C C L L C L C` — 후보가 런
  {1,4,5,8,10}을 점유한다(§0.1 집계기 상수와 9/18 실행 프로토콜 "AB BA AB BA AB"와
  일치). 각 실행은 `run-nitro-parity-once.ts` 로 v2 전체 90항목 행렬(§0.1).
- **해석 레인:** 응답 크기로 나눈다 — 대형 응답 레인(sync-public/async-public의
  `balanced8191/echo`, `balanced8191/setup`, `balanced8191/update`, `wide1025/echo`)이 목표
  레인이고, 소형 응답 레인(`add`, `string`, `pair`, `*/indexed`, `*/resident-dfs`)은
  무회귀 레인이다.
- **Android: 고정 후보, 원래 v2 5회** —
  `env -u RUSTRA_BUN_LIBRARY bun scripts/run-nitro-parity-android.ts --device <serial>
--apk <candidate.apk> --manifest <manifest.json> --output <dir>` (도구는 설치하지 않는다 —
  arm APK를 먼저 `adb install`; 매니페스트 JSON은 `scripts/parity-manifest.ts` 의
  `createExperimentManifest(fingerprint)` 로 내보낸다). 보존된 pre-E1 집단과의 차이는 집단
  델타로 보고하며 인과 A/B로 쓰지 않는다.

### 1.3 수화물 경로

- 원시: `/tmp/parity-ab/run-{1..10}/receipt.json`, `/tmp/parity-ab/aggregate-raw.json`,
  `/tmp/parity-ab/paired-cases.json`; 빌드·설치 로그는 `target/e1-ab/`.
- receipt: `docs/benchmark-receipts/<date>-e1-owned-handoff-ab.json`(§0 형식), 판정은
  `performance-evaluation.md` §8 후속에 기록.

### 1.4 채택/기각 기준

- **채택** 조건: 대형 응답 레인의 지오메단 후보/기존 비율 < 1 이고 쌍별 t(4) 구간이 1을
  제외(호스트 추정 ~1–2% — 절대 폭이 작게 나오는 것이 예상된다), AND 소형 응답 레인에 유의한
  회귀 없음(레인 지오메단 > 1 이면서 CI가 1을 제외하는 케이스 0), AND 10회 모두 90항목
  검증 통과(정확성, 핸들러 정확히 1회, free 짝 유지).
- **기각** 조건: 소형 응답 회귀가 유의하거나, 대형 레인 개선이 잡음 내일 때. 기각 시 main은
  그대로(probe 폴백 경로는 설계상 코드에 유지)이며 receipt에 `status: "rejected"` 로
  기록한다 — postcard 후보 선례(2026-09-16)가 기각 결과의 형식 예시다.

### 1.5 롤백

E1은 Rust 코어 + C++ 브리지 + 스냅샷/CHANGELOG에 걸쳐 있다. 롤백 = E1 커밋의 단일 revert(또는
위 두 소스 그룹을 pre-E1 상태로 `git checkout`), 재빌드 후 `cargo test -p rustra`,
`env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`,
`env -u RUSTRA_BUN_LIBRARY bun run test:all` 재실행. §1.1의 기존 arm 빌드가 롤백 검증 빌드를
겸한다.

## 2. A2 — 1-필드 명령 emit의 `createGeneratedFields1` 전환

### 2.1 전제와 선행 기록

순수 JS/codegen 변경이며 ABI 변경은 없다. 9월 호스트 마이크로벤치 warm 개선 20.81%와
호출 수 불변은 [결정 문서](dev/research/2026-09-24-emit-switch-decision.md)에 있다.
[10월 10일 receipt](benchmark-receipts/2026-10-10-host-gates-reverify.md)의 `4578c851`에서
Hermes 1,412/0, 호출 수 660,004=660,004·폴백 0을 재확인했다.
[10월 13일 native ASan 기록](verification/evidence/2026-10-13-native-asan.json)도
시뮬레이터 1,412/0과 teardown/reinstall 100회를 통과했다. C++ binder/generated
codecs/JSI가 계측 대상이고 fake Rust ABI peer를 사용한다. 사전 빌드된 Hermes/RN
의존성과 실기기 시간 효과는 이 증거에 포함되지 않는다.

새 기기 행렬의 소스를 고정한 뒤 다음을 재확인한다:

1. `bash examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh`
   — 실패 0. 스크립트의 bash shebang을 따른다.
2. `env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs`
   — JS 호출 수=네이티브 경로 호출 수, name fallback 0.
3. `env -u RUSTRA_BUN_LIBRARY bun run test:types`와
   `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`.

### 2.2 arm과 토글

두 arm은 **같은 네이티브 바이너리**를 공유한다. JS 번들만 다르다:

- **후보 (C)** = 현재 생성 `commands.ts`
  (`createGeneratedFields1(id, 'name', "key", 'fn')` 팩토리 emit).
- **기존 (L)** = 같은 트리에서 emit만 되돌린 상태 — 전환 이전 CLI(emit 커밋의 부모)로
  `examples/react-native-calculator/generated/commands.ts` 를 재생성하거나,
  `git checkout <emit-commit>^ -- examples/react-native-calculator/generated` 후 재번들.
  arm별 `bundleSha256` 를 기록한다. `binarySha256` 는 동일해야 정상 — 다르면 arm이 오염된
  것이므로 중단하고 재빌드한다.

### 2.3 표본 설계·레인·기준·롤백

- **iOS: §1.2와 동일한 5쌍 설치 교체 프로토콜**(10회, 전체 90항목 검증, §0.1 집계기의
  `manifestFor` 토글을 생성 `commands.ts` 변형으로 바꿔 재사용). **Android: 고정 후보, v2
  5회**(§1.2).
- **해석 레인:** indexed 케이스(트리 형상 4개 × sync-public + async-public = 8건)와
  `string` 케이스(sync + async = 2건) — §7.6의 "indexed 8건·string 2건". 이 레인들이
  1-필드 생성 명령이 기기에서 실제로 구동되는 레인이다. 나머지 전체는 무회귀 레인이다.
- **채택** 조건: indexed/string 레인 지오메단 비율 < 1 이고 쌍별 t(4) CI가 1을 제외(호스트
  효과는 호출당 ~4ns — 기기 효과는 크기가 아니라 부호 확정으로 읽는다), 전 레인 유의한 회귀
  없음, 선행 게이트 녹색.
- **롤백:** emit 전환 커밋 단일 `git revert` + 동일 CLI로 6개 예제의 `generated/` 재생성,
  `test:codegen-fresh:check` 로 확인
  ([결정 문서 롤백 전략](dev/research/2026-09-24-emit-switch-decision.md)).

## 3. rn-experiment — 동일 gzip 연산의 JSON/bytes 비교

### 3.1 비교군과 범위

같은 Release Hermes 앱에서 `gzipCompress`와 `gzipDecompress`를 각각 동일 입력으로
JSON과 `invokeTypedBuffer`에 호출한다. uuidV7은 정확성 예제이며 gzip의 transport
대조군이 아니다. 기본 입력은 결정적 LCG의 1/64/256KiB다. JSON 배열 확장 후에도
네이티브 1MiB 한도 안에 들어가도록 최대 256KiB로 제한한다. 여기서 1MiB bytes와
JSON을 비교하면 동일한 입력 조건이 성립하지 않는다.

`examples/rn-experiment`에서 iOS는 `bash modules/rustra-bridge/ios/build-rust-ios.sh`,
Android는 `bash modules/rustra-bridge/android/build-rust-android.sh`로 빌드한다.
실기기 iOS는 `RUSTRA_IOS_TARGET=aarch64-apple-ios`를 지정한다. 과거
[시뮬레이터 크로스컴파일](dev/research/2026-09-24-rn-experiment-ios.md)은 현재
수집기의 앱 설치·측정 증거를 대신하지 않는다.

### 3.2 구현된 수집기와 남은 기기 연결

- `examples/rn-experiment/apps/native-benchmark.ts`의 `runNativeBenchmark(options)`를
  생성 네이티브 모듈이 링크된 설치 앱에서 호출한다. Release Hermes, 설치/생성 계약
  해시 일치와 bytes capability를 확인한다. JS runtime당 한 번만 허용하지만 실제
  프로세스 재시작 여부는 플랫폼 드라이버 로그로 입증해야 한다.
- `apps/benchmark.ts`는 기본 5회 warmup, 100회 개별 호출을 순차 측정한다. JS 어댑터
  비용도 포함한다. gzip magic, 매 응답 byte 일치, 입력 불변과 SHA-256을 검사한다.
  `sha256` 함수, 고유 `launchId`, 교대 `order: 'json-bytes' | 'bytes-json'`, 실제
  source/bundle/native SHA 및 기기/OS/Hermes/RN 메타데이터를 전달한다.
  `target`은 실제 실행에 맞춰 `physical-device` 또는 `simulator`로 기록한다.
- 반환된 `BenchmarkReceipt`를 앱 파일/export 연동으로 런치별 JSON에 보존한다.
  설치·재시작·추출 드라이버와 실기기 실행은 아직 완료하지 않았다. 호스트 mock 검사를
  native 실행 증거로 사용하지 않는다.
- receipt는 `schemaVersion: 1`, `evidence: 'react-native-runtime'`, 개별 `samplesUs`,
  p50/p95, payload SHA와 runtime ID를 담는다. 할당/복사량은 명시적으로
  `null`/`not-instrumented`이며 입력·출력 크기로 대체하지 않는다.

실제 독립 런치 5회 후 저장소 루트에서 실행한다:

```bash
env -u RUSTRA_BUN_LIBRARY bun examples/rn-experiment/scripts/benchmark-receipts.ts \
  target/rn-experiment/summary.json \
  target/rn-experiment/launch-1.json target/rn-experiment/launch-2.json \
  target/rn-experiment/launch-3.json target/rn-experiment/launch-4.json \
  target/rn-experiment/launch-5.json
```

집계기는 runtime/launch ID 중복, 다른 소스/기기/빌드 환경, 교대하지 않은 순서,
누락 레인·변조 fixture·응답 불일치를 거부한다. 런치별 p50/p95 비율과 순서별 결과를
보존하며 판정은 `measurement-only`다.

### 3.3 표본과 해석

플랫폼별 독립 실기기 앱 런치 5회, JSON/bytes → bytes/JSON → JSON/bytes → bytes/JSON
→ JSON/bytes 순서로 실행한다. 개별 표본 전체, 원본 receipt, 설치/재시작 로그와
바이너리·번들 해시를 보존한다. 시뮬레이터는 별도 집단으로 기록하고 iOS/Android 또는
서로 다른 소스/빌드의 결과를 합치지 않는다.

집계 비율은 JSON/bytes(1보다 크면 bytes가 빠름)다. 인과적 성능 판정에는 동일 연산·
동일 입력, 모든 실행의 정확성, 런치별 쌍 로그비율의 명목 t(4) 95% CI가 1을 제외하는지와
순서 효과 분석이 필요하다. 현재 집계기에 CI/채택 분석은 없으므로 `measurement-only`를
자동 채택으로 승격하지 않는다. 할당/복사량 주장도 별도 계측이 필요하다. 효과가
확정되지 않으면 해당 workload의 미확정 결과로 남긴다.

원본과 집계는 `target/rn-experiment/`에 보존하고 실제 실행 후 환경·한계·분석을
`docs/benchmark-receipts/<date>-rn-experiment-buffer-ab.json`에 기록한다.
2026-10-13에는 실기기 receipt나 채택 판정을 만들지 않았다.

## 4. 실행 순서와 보고

1. arm 소스를 고정하고 A2 선행 게이트(§2.1)를 갱신한다. 역사적/현재 로컬 통과는 해당 절에 구분했다.
2. E1 행렬(§1) — 기대 효과 최대, 빌드 비용 최대(arm 빌드 2회).
3. A2 행렬(§2.3) — E1의 설치 앱 플럼빙을 재사용.
4. rn-experiment 수집기에 설치/재시작/export 드라이버를 연결한 뒤 별도 유휴 기기에서 측정한다(§3).
5. 실제 증거를 `performance-evaluation.md`에 추가하고 E1/A2는 §0, gzip은 §3 형식으로 receipt를
   남긴다. 이 런북 자체도 버전 관리하며, 프로토콜 이탈(기기 대체, 실행 유실)은 조용히
   흡수하지 말고 receipt의 `methodology` 블록에 기록한다.
