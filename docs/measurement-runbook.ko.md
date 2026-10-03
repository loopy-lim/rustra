# 실기기 A/B 측정 런북 — E1 owned 핸드오프 · A2 emit 전환 · rn-experiment 버퍼

채택 판정을 위해 남은 세 항목의 실기기 측정을 실행 가능한 런북으로 고정한 문서다. 이름 재사용
채택 선례([프로토콜](dev/research/2026-09-16-nitro-call-profile.md),
[수화물](benchmark-receipts/2026-09-18-nitro-name-reuse-ab.json), 계약
`rustra-name-reuse-ab/v1` 형식)와 [performance-evaluation.md §7.3/§7.6](performance-evaluation.md)의
플랜을 그대로 따른다.

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
3. **독립 실행, 실행마다 설치 교체.** 한 번에 정확히 하나의 arm만 설치한다. 전용 앱 id
   `com.rustra.nitroparity` 는
   `examples/react-native-calculator/scripts/parity-app-policy.ts`(`requireDedicatedApp`)가
   강제한다.
4. **실행마다 receipt 검증.** 모든 런치는 v2 전체 행렬 receipt 검증(90개 항목 = 30 id × 3
   레인, 케이스당 31라운드)을 호스트 매니페스트 대상으로 통과해야 하고, 실행 후 바이너리
   SHA-256을 재확인한다. `run-nitro-parity-once.ts` 가 둘 다 수행하며 위반 시 프로토콜을
   중단한다.
5. **통계.** 런치 쌍의 로그비율, t(4) 명목 95% 구간, 다중 비교 보정 없음. 후보/기존 비율의
   레인별·전체 지오메단. CI가 1을 포함하는 watch 항목은 유의하지 않음으로 보고하지,
   승리로 계산하지 않는다.
6. **receipt 수화물.** 실행된 각 항목은 `rustra-name-reuse-ab/v1` 형태의
   `docs/benchmark-receipts/<date>-<item>-ab.json` 을 남긴다: `contract`, `status`
   (adopted/rejected), `date`, `sourceCommit`, `candidateBaseline`, `decision`,
   `environment`(device, runtime, udid, jsEngine), `methodology`(protocol, runs,
   launchesPerArm, suite, validation, statistics), `arms`(arm별 description, runs,
   `binarySha256`, `bundleSha256`, `fingerprint`, launches), analysis. 원시 로그는
   `target/<item>-ab/` 에 보존한다.

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

| 레인                    | 기기                                                                                             | 비고                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS 실행                | iPhone 17 시뮬레이터, iOS 26.2 (2026-09-24 리시트의 UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC`) | 9/18 이름 재사용 채택이 iOS 행렬을 이 시뮬레이터에서 돌렸다 — 비교 가능성을 위해 재사용                                                          |
| iOS 실행 (선택: 실기기) | 실물 iPhone, `aarch64-apple-ios`                                                                 | `RUSTRA_IOS_TARGET=aarch64-apple-ios` 로 빌드, 설치·실행·인출은 `xcrun devicectl` — 저장소에서 아직 검증된 적 없는 경로라 미검증 플럼빙으로 취급 |
| Android 실행            | 실기기                                                                                           | v2 선례; 고정 후보 5회 실행이며 보존된 구집단과의 차이를 인과 A/B로 표현하지 **않는다**                                                          |

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
- 빌드: `sh modules/rustra-jsi/ios/build-rust-ios.sh`(fat release 코어) → sim-e1 리시트의
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

### 2.1 전제

- 순수 JS + 코드젠 변경(ABI·네이티브·capability 마커 없음). 호스트 마이크로벤치 근거는
  있다(warm 20.81%, 4회 재현, 호출 수 불변 660,004 = 660,004 —
  [결정 문서](research/2026-09-24-emit-switch-decision.md)).
- **기기 행렬 전 선행 게이트**(performance-evaluation.md §7.5 리스크 2 — 미재확인 항목을
  여기서 닫는다):
  1. 전환 트리에서 Hermes 단언 스위트 재실행:
     `sh examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh` —
     실패 0 필수.
  2. 호출 수 불변 재단언:
     `env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs` — 네이티브 라우트 호출
     수 = JS 호출 수, 이름 폴백 0회.
  3. `env -u RUSTRA_BUN_LIBRARY bun run test:types` +
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
  ([결정 문서 롤백 전략](research/2026-09-24-emit-switch-decision.md)).

## 3. rn-experiment — 버퍼 경로 우위 재측정 (실연산 워크로드)

### 3.1 전제

- `examples/rn-experiment` 는 `aarch64-apple-ios-sim` Release로 크로스컴파일되며 생성 모듈
  스크립트·podspec과 불일치 0이다
  ([빌드 증거](research/2026-09-24-rn-experiment-ios.md)). 실기기 iOS는
  `RUSTRA_IOS_TARGET=aarch64-apple-ios`, Android는
  `modules/rustra-bridge/android/build-rust-android.sh`.
- 이 항목은 **설치 교체 A/B가 아니다**: 하나의 앱 안에서 레인끼리 대조한다 —
  `gzipCompress`/`gzipDecompress`(단일 `data` 필드 bytes 스키마 → Tier buffer fast path,
  `rustra_ffi_has_buffer` 광고) vs `uuidV7`(문자열 스키마 → JSON 경로 대조군).
- 페이로드: LCG 결정적 생성의 반복+노이즈 버퍼, 32–64KiB(네이티브/어댑터 테스트와 같은
  알파벳), 순서 효과 watch용 1MiB 추가.

### 3.2 하네스 (실행 시점에 추가 — 스키마는 여기서 고정)

`BenchmarkApp`의 receipt 패턴을 따르는 RN 앱 측 수집기가 아직 없다. 실행 시 rn-experiment 앱에
추가하고 receipt 계약을 다음으로 고정한다:

```json
{ "contract": "rustra-rn-experiment-buffer/v1", "launch": 1, "platform": "ios|android",
  "order": ["gzipCompress","uuidV7"] | ["uuidV7","gzipCompress"],
  "payloads": { "bytesKiB": 32, "sha256": "…" },
  "samples": { "gzipCompress": {"p50ns": 0, "p95ns": 0, "roundTripOk": true},
               "gzipDecompress": {"p50ns": 0, "equalityOk": true},
               "uuidV7": {"p50ns": 0, "formatOk": true} } }
```

런치당 receipt 1개를 앱 `Documents/` 에 기록하고
`xcrun simctl get_app_container … data` + 복사로 인출한다(실기기:
`devicectl device copy from`).

### 3.3 표본 설계·기준·롤백

- **iOS와 Android 각 5회 독립 실행.** 런치마다 출력 순서를 교대한다(`gzip 먼저` /
  `uuid 먼저`) — Android 버퍼 진단(2026-09-16)에서 알려진 64KiB/1MiB 순서 민감성을
  관찰하기 위해서다. 순서 효과는 보고하되 평균으로 지워버리지 않는다.
- **채택(문서화된 버퍼 우위가 실연산 워크로드에서 재확인)** 조건: gzip 왕복 p50이 플랫폼별
  5회 중 ≥ 4회에서 `uuidV7` JSON 경로 대조군을 이기고 쌍별 로그비율 t(4) CI가 1을 제외하며,
  모든 런치에서 정확성 게이트(gzip 매직, decompress 일치, uuid 형식) 유지.
- **재현되지 않으면:** rn-experiment는 제품 표면이 없는 예제 크레이트라 롤백 없음.
  receipt를 기록하고(`status: "rejected"`), 버퍼 fast-path 우위 주장이 실연산 포함이 아니라
  변환만 해당(`benchEchoBytes`)임을
  `docs/rn-rust-native-bridge-comparison.ko.md` 와 성능 문서에 주석으로 남긴다.
- receipt: `docs/benchmark-receipts/<date>-rn-experiment-buffer-ab.json`.

## 4. 실행 순서와 보고

1. A2 선행 게이트(§2.1) — 저비용, §7.5 리스크 2를 먼저 닫는다.
2. E1 행렬(§1) — 기대 효과 최대, 빌드 비용 최대(arm 빌드 2회).
3. A2 행렬(§2.3) — E1의 설치 앱 플럼빙을 재사용.
4. rn-experiment 하네스(§3) — 독립 예제 앱으로, 2–3과 두 번째 머신에서 병렬 가능. 단
   시뮬레이터 하나에서 교차 실행은 하지 않는다.
5. 각 항목은 판정을 `performance-evaluation.md` §8에 추가하고 §0 형식으로 receipt를
   남긴다. 이 런북 자체도 버전 관리하며, 프로토콜 이탈(기기 대체, 실행 유실)은 조용히
   흡수하지 말고 receipt의 `methodology` 블록에 기록한다.
