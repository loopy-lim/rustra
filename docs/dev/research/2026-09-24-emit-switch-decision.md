---
date: 2026-09-24
researcher: loop-worker (decide-emit)
git_commit: 58e1835e (작업 트리 기준, 미커밋 병렬 작업 제외)
topic: '1-필드 명령 emit의 createGeneratedFields1 전환 여부 결정'
status: decision-complete
---

# emit 전환 결정 — 1-필드 명령을 createGeneratedFields1 로

**결정: 전환한다.** [마이크로벤치 문서](2026-09-24-a2-microbench.md)의 실측에서 warm 개선 20.81%(호출당 4.0ns)로 잡음 기준(3% 미만·재현 불안정)을 명확히 상회하고, 4회 연속 재현에서 부호·규모가 일관했다(20.8–24.4%). 재설정 직후 경로에서는 개선이 더 컸다(afterReset 33.03%, cold 72.08% — cold는 `resetConfiguredRoutes()` 기준선 0.0227µs/call 포함 수치로, 순수 첫 호출 환산 시 0.113→0.015µs). 호출 수 불변(660,004 JS 호출 = 660,004 라우트 호출, 폴백 0회, 세대당 해결 ≤1회)도 검증돼 [closure 결합 기각 선례](2026-09-16-nitro-parity-followup.md)의 기각 사유에 해당하지 않음이 확인됐다.

## 판정 근거 수치

[결정 문서](2026-09-24-optimization-decision.md) 3절의 채택 절차(호스트 검증으로 채택 판단 + 호출 수 불변 확인)에 따라 [벤치 원시 결과](2026-09-24-a2-microbench.md)를 판정한다.

| 기준              | 잡음 기준                   | 실측                                                                                                   | 판정 |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| warm 개선율       | 3% 미만이면 보류            | **20.81%** (0.0196 → 0.0156µs/call)                                                                    | 통과 |
| 재현 안정성       | 4회 연속 부호 불일치면 보류 | warm 20.8–24.4% / cold 71.8–75.4% / afterReset 22.7–33.0% — 부호·규모 일관                             | 통과 |
| afterReset 개선율 | (참고)                      | 33.03% (0.0224 → 0.0150µs/call)                                                                        | 통과 |
| cold 개선율       | (참고, reset 비용 포함)     | 72.08% — reset-only 기준선 0.0227µs/call 을 포함하므로 순수 개선은 이보다 작게 환산됨(0.113 → 0.015µs) | 통과 |
| 호출 수 불변      | 변화 시 기각                | 660,004 = 660,004, 폴백 0회, 세대당 해결 ≤ 1회                                                         | 통과 |

- 절대 폭(호출당 4.0ns)은 [후보 문서 기대치](2026-09-24-async-and-echo-candidates.md)(수십~150ns)의 하한보다 작지만, 잡음 기준은 상대 개선율·재현 안정성 기준이며 벤치가 순수 JS 디스패치 오버헤드만 측정(동일 스텁 엔진·동일 할당 정책)했으므로 상대값 신뢰에 영향이 없다. 기존 경로의 문자열 비교가 인턴된 동일 참조 비교라 절대 비용이 작았을 뿐, 세대 정수 비교가 그보다 확실히 저렴함은 재현됐다.
- 한계는 벤치 문서 그대로다: Bun/JSC 호스트 수치이며 Hermes 절대값과 다를 수 있다. 그러나 이 결정은 상대 개선·불변성 검증을 근거로 하며, [결정 문서](2026-09-24-optimization-decision.md) 3절의 기기 AB/BA 플랜 문서화 요건은 후속 태스크가 [후보 문서 A2 절](2026-09-24-async-and-echo-candidates.md) 정의를 문서화하는 것으로 유지된다.

## 전환 시 변경 파일 목록

후속 태스크(구현 워커)가 수행할 변경 목록이다. 이 문서는 결정만 포함하며 코드를 변경하지 않는다.

1. **`packages/cli/src/generate-commands.ts`** — emit 전환 본체.
   - `generatedHelpers` 수집 분기: `fields.length === 2 ? 'createGeneratedFields2' : \`invokeGeneratedFields${fields.length}\``에서 1-필드일 때`createGeneratedFields1` 을 추가하도록 수정.
   - 1-필드 emit 분기(`invokeGeneratedFields${fields.length}` 함수형 emit)를 2-필드 선례와 동일한 `export const ${fnName} = createGeneratedFields1<${inType}, ${outType}>(${command.commandId}, '${command.name}', ${fieldKey}, '${fnName}');` 형태로 교체.
   - `packages/types/src/global-fields.ts` 는 **변경 불필요** — `createGeneratedFields1` 이 이미 착지돼 있다(104행, 시그니처 `(commandId, command, field0Key, functionName = command)`, `createGeneratedFields2` 패턴 준용). 2·3-필드 경로와 옵션 폴백은 기존 헬퍼 그대로 유지.
2. **생성물 재생성(동일 CLI, 6개)** — 현재 `invokeGeneratedFields1` 을 사용하는 모든 생성 파일.
   - `examples/calculator/generated/commands.ts`
   - `examples/auth/generated/commands.ts`
   - `examples/crud/generated/commands.ts`
   - `examples/streaming/generated/commands.ts`
   - `examples/react-native-calculator/generated/commands.ts`
   - `examples/react-native-bare-calculator/generated/commands.ts`
   - (`examples/rn-experiment/generated/commands.ts` 는 현재 1-필드 헬퍼 미사용 — 재생성해도 emit 불변.)
3. **검증(구현 워커 수행)** — [결정 문서](2026-09-24-optimization-decision.md) 3절 검증 방법 준용: `packages/types` 회귀 + `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`(및 `--bindings`) + Hermes 스위트 + 벤치 문서의 호출 수 불변 단언 재확인.

## 롤백

순수 JS+코드젠 변경(ABI·네이티브·capability 마커 없음). 단일 커밋 `git revert` 후 동일 CLI로 생성물 재생성하고 `test:codegen-fresh:check` 로 원복 확인 — [결정 문서](2026-09-24-optimization-decision.md) 3절 롤백 전략 그대로.

## 재현

이 문서는 결정만 포함하므로 새 실행은 없다. 판정 수치의 재현:

```sh
env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs
```
