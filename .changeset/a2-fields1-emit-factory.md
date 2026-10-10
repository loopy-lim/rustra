---
'@rustra/cli': minor
---

1-필드 struct 명령의 TypeScript emit을 함수형(`invokeGeneratedFields1` 직접
호출)에서 팩토리형(`createGeneratedFields1`)으로 전환한다. 2-필드
명령의 `createGeneratedFields2` 선례와 동일한 형태로, 라우트 해결 결과를
엔진 세대(generation)별로 캐시해 warm 디스패치 비용을 줄인다. 호스트
마이크로벤치(Bun/JSC)에서 warm 호출당 0.0196→0.0156µs(20.8% 개선,
4회 재현 20.8–24.4% 일관), 엔진 재설정 직후 경로 22.7–33.0% 개선,
라우트 호출 수·폴백 수 불변(660,004 = 660,004)을 확인했다
(docs/dev/research/2026-09-24-emit-switch-decision.md).

재생성된 `commands.ts`는 `createGeneratedFields1`을 import하므로 이 헬퍼를
포함한 `@rustra/types`와 함께 배포돼야 한다(헬퍼는 `@internal` codegen import
contract). 호출 표면은 소스 호환이다 — 생성된 `const` 커맨드도 동일한
`(input, options)` 시그니처와 `commandId` 프로퍼티를 노출한다. 2·3-필드
경로와 bytes·옵션 폴백 emit은 변함없다. 생성물을 체크인한 저장소는 CLI
업그레이드 후 `rustra codegen`으로 갱신한다.
