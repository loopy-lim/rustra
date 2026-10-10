---
date: 2026-09-24
researcher: loop-worker (bench-a2)
git_commit: 58e1835e (작업 트리 기준, 미커밋 병렬 작업 제외)
topic: 'A2 필드 명령 라우트 세대 캐시(createGeneratedFields1) 호스트 마이크로벤치 실측'
status: bench-complete
---

# A2 세대 캐시 마이크로벤치 — invokeGeneratedFields1 vs createGeneratedFields1

**결론: 세대 캐시 팩토리 경로가 기존 헬퍼 경로 대비 warm 기준 호출당 약 4.0ns(20.8%) 빠르고, 재설정 직후 첫 호출에선 reset 비용 포함 72.1% 빠르다. 재설정 후에도 네이티브 라우트 호출 수가 정확히 JS 호출 수와 1:1로 유지됨을 함께 검증했다(공개 호출 closure 결합 기각 선례와의 구분 기준 충족).** 절대 폭은 [후보 문서의 기대치](2026-09-24-async-and-echo-candidates.md)(호출당 수십~150ns)의 하한보다 작은 수준이지만, 순수 JS 변경으로 호출당 고정 비교·조회를 확실히 제거함을 확인했다. 아래 수치는 모두 호스트(Bun/JSC) 실측이며 Hermes 수치가 아니므로 emit 전환 판단은 이 문서의 상대 개선과 [결정 문서](2026-09-24-optimization-decision.md) 3절의 채택 근거 절차를 함께 근거로 삼는다.

## 측정 대상

[계산기 예제 생성물](../../examples/react-native-calculator/generated/commands.ts) 122–125행의 실제 명령과 동일한 정체성(`commandId=38`, `parityIndexed`, 필드 `id`)을 사용한다.

| 경로           | 호출 형태                                                                                                                                        | 호출당 수행                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 기존 (legacy)  | `invokeGeneratedFields1(38, 'parityIndexed', input, input['id'])` — [global-fields.ts](../../packages/types/src/global-fields.ts) `invokeFields` | 엔진 조회 → `generatedFieldsRoutes[commandId]` 배열 조회 → `route.command === command` 문자열 비교 → fieldCount 재확인 → `invokeRoute` |
| 신규 (factory) | `createGeneratedFields1(38, 'parityIndexed', 'id')` 클로저 호출                                                                                  | 엔진 조회 → 세대 정수 비교 1회 → 캡처된 `invokeRoute`                                                                                  |

두 경로 모두 같은 스텁 엔진의 동일 라우트 함수를 공유하므로(동기 평범 객체 반환 — 네이티브 FFI 제외) 차이는 순수하게 JS 디스패치 오버헤드다. 두 경로 모두 호출당 `[field0]` 배열 1개와 `Promise` 1개를 생성하므로 할당 조건도 동일하다.

## 방법

- 스크립트: `scripts/a2-fields-microbench.mjs` — [complex-codec-bench](../../scripts/complex-codec-bench.mjs) 관례 준용(20,000회 타임 루프, `performance.now()` 월클록, 호출당 할당 정책 명시).
- 시나리오: **warm**(warmup 1,000회 뒤 20,000회 계측) / **afterReset**(`resetConfiguredRoutes()` 1회 뒤 warmup 없이 20,000회 — 첫 호출의 재해결 포함) / **cold**(reset+첫 호출 5,000회 평균 — `resetConfiguredRoutes()` 비용 자체를 포함하며 그 기준선(reset-only)은 별도 공통 측정).
- 반복: 5라운드, 라운드마다 경로 측정 순서를 교대해 순서 편향을 상쇄하고 중앙값 보고. 라운드 전 미계측 프리웜 100,000회로 JIT 정착.
- 불변성 검증(스크립트 내 단언): 라우트 호출 수 === JS 호출 수(660,004 = 660,004), 이름 폴백 경로 0회, 세대당 라우트 해결 ≤ 1회(경로별) — 세대 캐시가 호출마다 해결하지 않음을 보장.
- 실행: `env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs` (Bun 1.4.1, macOS arm64, Apple M1 Max).

## 결과

| 시나리오             | 기존 µs/call | 기존 ops/s | 팩토리 µs/call | 팩토리 ops/s |     개선율 |
| -------------------- | -----------: | ---------: | -------------: | -----------: | ---------: |
| warm                 |       0.0196 | 50,901,335 |         0.0156 |   64,274,168 | **20.81%** |
| afterReset           |       0.0224 | 44,572,417 |         0.0150 |   66,555,740 | **33.03%** |
| cold (reset+첫 호출) |       0.1353 |  7,393,267 |         0.0378 |   26,478,423 | **72.08%** |

- 절대 폭: warm 4.0ns/call, afterReset 7.4ns/call, cold 97.5ns(reset 포함 — reset-only 기준선 0.0227µs/call, 순수 첫 호출 환산 ≈ 0.113 → 0.015µs).
- 참고(라운드별 샘플): warm 기존 `[0.0523, 0.0215, 0.0188, 0.0196, 0.0196]` / 팩토리 `[0.0187, 0.0131, 0.0156, 0.0155, 0.0286]` — 첫 라운드 잔여 드리프트를 제외하면 안정.
- 재현성: 동일 명령 4회 연속 실행에서 warm 개선율 20.8–24.4%, cold 71.8–75.4%, afterReset 22.7–33.0% — 부호·규모 일관.

## 원시 결과 (공식 실행 1회분, scripts/a2-fields-microbench.mjs JSON)

```json
{
  "bench": "a2-generated-fields-route",
  "route": "generated-fields-dispatch-js",
  "command": { "commandId": 38, "name": "parityIndexed", "fieldKey": "id" },
  "iterations": 20000,
  "warmup": 1000,
  "repeats": 5,
  "coldSamples": 5000,
  "legacy": {
    "warm": { "usPerCall": 0.0196, "opsPerSecond": 50901335 },
    "coldFirstCall": { "usPerCall": 0.1353, "opsPerSecond": 7393267 },
    "afterReset": { "usPerCall": 0.0224, "opsPerSecond": 44572417 }
  },
  "factory": {
    "warm": { "usPerCall": 0.0156, "opsPerSecond": 64274168 },
    "coldFirstCall": { "usPerCall": 0.0378, "opsPerSecond": 26478423 },
    "afterReset": { "usPerCall": 0.015, "opsPerSecond": 66555740 }
  },
  "improvementPct": { "warm": 20.81, "coldFirstCall": 72.08, "afterReset": 33.03 },
  "resetBaseline": { "resetOnlyUs": 0.0227 },
  "invariance": {
    "totalJsCalls": 660004,
    "routeInvocations": 660004,
    "routeResolutions": 50025,
    "generationEvents": 75013,
    "maxResolutionsPerGeneration": 2,
    "looseFallbackInvocations": 0
  },
  "verified": true
}
```

## 해석과 한계

- **개선의 성격.** warm 20.8%는 "필드 디스패치 오버헤드" 기준 상대값이다. 절대값은 호출당 ~4ns로, 후보 문서가 상정한 수십~150ns 하한보다 작다 — 기존 경로의 문자열 비교는 모듈 인턴된 동일 참조 비교(포인터 동등 빠른 경로)로, JSC에서 기대만큼 비싸지 않았다. 그러나 afterReset(33.0%)과 cold(72.1%)에서 개선이 커지는 것은 재설정·첫 호출 직후의 라우트 재확립 경로에서 세대 정수 비교가 배열 재구성+문자열 비교 대신 확실히 유리함을 보여준다.
- **호출 수 불변 확인.** closure 결합 기각 선례와 달리 세대 캐시는 네이티브 호출 수를 변화시키지 않는다 — 660,004회 JS 호출에 정확히 660,004회 라우트 호출, 폴백 0회, 해결은 세대 이벤트당 최대 1회. A2 채택의 두 축(오버헤드 제거 + 호출 수 불변)이 모두 호스트에서 확인됐다.
- **한계.** (1) Bun/JSC 호스트 실측이며 대상 런타임인 Hermes 수치가 아니다 — 인라이닝·인턴 특성이 달라 절대 폭은 Hermes에서 다를 수 있다. (2) 계측은 Promise 생성까지의 동기 디스패치 구간이고 호출자 `await`(양쪽 동일)는 제외다. (3) cold 수치에는 `resetConfiguredRoutes()` 비용이 포함된다(기준선 별도 보고). (4) 월클록 단일 프로세스 샘플이라 GC·티어 전이 잡음이 있으며, 교대 순서+중앙값으로 완화했다.
- **기기 측정.** [결정 문서](2026-09-24-optimization-decision.md) 3절에 따라 iOS AB/BA 5쌍 + Android v2 5회 플랜은 [후보 문서 A2 절](2026-09-24-async-and-echo-candidates.md)의 정의를 문서화만 수행하며, 이 벤치가 그를 대체하지 않는다.

## 후속(emit 전환) 판단 근거 요약

1. warm/afterReset/cold 전 시나리오에서 개선(부호 일관, 재현 4회).
2. 호출 수 불변·폴백 미사용·세대당 해결 1회 — 회귀 위험 신호 없음.
3. emit 전환 시 codegen 출력 변화가 따르므로 `test:codegen-fresh:check` 갱신이 필요하고, CLI emit 전환은 이 문서를 근거로 후속 태스크([결정 문서](2026-09-24-optimization-decision.md) 3절 구현 위치)에서 수행한다.

## 재현

```sh
env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs
# 옵션 조정: runA2FieldsMicrobench({ iterations, warmup, repeats, coldSamples, prewarmCalls })
```
