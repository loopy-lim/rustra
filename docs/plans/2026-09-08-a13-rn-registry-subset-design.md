# A13 RN 레지스트리 서브셋 — 설계 (2026-09-08)

상태: 설계 확정 대기(태스크 분해 포함, 구현은 별도 세션). 감사 A13
(`docs/research/2026-09-08-zero-config-dx-audit.md` §A13)의 별도 트랙.
사실 근거는 전부 `docs/research/2026-09-08-a13-rn-bundle-registry-bench.md`
(이하 "벤치 문서") — 이 문서는 근거 재인용을 최소화하고 결정만 적는다.

## 문제 (벤치 문서 §판정 요약)

RN(metro) 번들이 **사용 명령 수가 아닌 전체 명령 수**에 비례해 커진다 —
미니파이 **+1,485 B/명령** (200명령 패키지에서 +297KB, 전체의 18.7%).
원인은 `rkyv-registry.ts` 가 모든 코덱을 정적 import 하는 것과 Metro 가
트리셰이킹을 하지 않는 것의 조합. 벤치가 가른 사실 3가지가 설계를 규정한다:

1. **lazy 팩토리는 무효** (+912B) — 함수 본문 `require` 도 metro 그래프에
   포함. 시작 eval 지연 효과(−1.8ms/100명령)도 서브셋에서는 소멸.
2. **subset registry만으로는 RN 에서 무효** (−1,031B) — 단일
   `rkyv-codecs.js` 모듈이 통째로 번들에 포함. **코덱 파일을 명령별로
   분할**해야 그래프가 가지치기된다(−41.7KB, 하한과 246B 차이).
3. **bun 번들러는 subset 만으로 충분** (121,841 → 3,581B) — 모듈 내
   미사용 export 제거가 됨. 파일 분할은 RN 을 위한 것.

## 설계

### 개요 결정 5줄

1. **옵트인 config `registry.commands`** — `rustra.json` 최상위
   `registry: { commands: string[] }`. 이 목록이 rkyv V2 정적 레지스트리에
   들어갈 명령(=번들에 코덱이 포함될 명령)을 정의한다.
2. **미설정 시 오늘과 바이트 동일** — 단일 `rkyv-codecs.ts` + 전체
   `rkyv-registry.ts`. 기존 프로젝트 재생성 출력 불변( breaking 없음,
   changeset 은 minor).
3. **설정 시 출력 형태 교체** — `rkyv-codec-helpers.ts` 공유 헬퍼 +
   포함 명령만 `codec-<command>.ts` + registry 가 그 파일들만 import
   (eager `Map` — **런타임 패키지 무변경**). 단일 `rkyv-codecs.ts` 는
   미생성(in-package 유일 소비자가 registry — 벤치 문서 §방법 검증).
4. **제외 명령은 자동 JSON 폴백** — 엔진이 이미 registry 밖 명령을 live
   schema commandId 로 Tier 3 처리(`packages/types/src/rkyv-engine.ts:20`).
   네이티브 협상·엔진 경로 무변경 — 감사의 비용 M 사유(협상 회귀)는
   성립하지 않아 **실비용 S-M 으로 하향**.
5. **doctor·codegen 이 배제를 가시화** — 생성 헤더에 배제 목록 각인,
   doctor 는 `registry.commands` 를 schema 명령과 대조(불일치 오류).

### A. config 표면

```jsonc
// rustra.json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "registry": { "commands": ["addNumbers", "benchAdd"] },
  "codegen": { "...": "..." },
}
```

- `packages/cli/src/config.ts`: `REGISTRY_CONFIG_KEYS = ['commands']` 추가,
  `RustraConfig.registry?: { commands: string[] }`. 최상위 키 화이트리스트
  (`CONFIG_ROOT_KEYS`)에 `registry` 등록 — L1 fail-closed 관례 유지.
- 검증(fail-closed, 기존 closestMatch 제안 관례 재사용):
  - 배열 외 형태/빈 배열 → 오류 ("omit the registry section to include
    all commands" 안내).
  - schema.json 명령에 없는 이름 → 오류 + closestMatch 제안.
  - 중복 이름 → 오류.
- `packages/cli/rustra.schema.json`: `registry` 섹션 스키마 추가
  (에디터 검증).
- **호스트별 분리는 하지 않는다** — registry 파일은 RN/bun 엔트리가 공유하는
  1개다. 스키마 1개 = 앱 1개라는 패키지 구조에서 목록도 1개가 맞다(과설계
  회피). Node/Tauri 엔트리는 registry 를 import 하지 않아 무관.

### B. 코드젠 렌더링 (packages/cli)

- `generate-postcard-registry.ts`: config 서브셋 수령(경로: cli-generate →
  cli-generate-files → 렌더러 옵션). 두 모드:
  - **full(기본)** — 현행 렌더 유지(바이트 동일 검증: 골든 테스트).
  - **subset** — registry 가 `./codec-<command>.js` 를 명령별 import.
- 신규 렌더 `generate-postcard-codec-split.ts`: 기존 단일 파일 렌더
  (`rkyv-codecs.ts` 생성부)의 헬퍼 블록·코덱 블록을 재사용해
  `rkyv-codec-helpers.ts`(헬퍼 export 화) + `codec-<command>.ts`(헬퍼
  import + 해당 코덱 + complex 코덱의 `createComplexCodec` import) 분할
  출력. 블록 경계는 벤치 하니스가 검증한 `^export const` 분할과 동일 로직.
- 파일 확장 규약 유지(`.js` 지정자, metro.config 의 소스 우선 해석과 정합).
- `cli-generate-files.ts`: subset 모드에서 `rkyv-codecs.ts` 대신 분할
  파일군 addFile. **manifest(.rustra-generated.json) 는 모드 전환을
  감지해 이전 모드 파일을 삭제**한다(오늘은 불일치만 감지 — manifest 가
  기록한 파일 중 새 세트에 없는 것 제거. full→subset: rkyv-codecs.ts 제거,
  subset→full: codec-*.ts·헬퍼 제거). doctor 의 stale 감지가 이 전환을
  잡도록 `--check` 는 파일 존재+부재 양쪽을 본다.

### C. 생성물 헤더·doctor

- subset registry 헤더에 배제 목록 각인(벤치 V2 렌더의
  `// N command(s) excluded` 형식 확장): 배제 수 + 이름 목록 + "excluded
  commands route via the JSON fallback (Tier 3)" 1줄.
- `doctor-checks.ts`: 신규 검사 "registry subset" — (1) config 이름이
  schema 명령에 존재, (2) 생성 registry 가 config 와 일치(drift), (3)
  subset == 전체 명령이면 hint("registry.commands lists every command;
  omit the section for the single-file layout").

### D. 예제 채택 + 문서

- `examples/react-native-bare-calculator` 에 `registry.commands` 적용(최소
  앱 — 사용 명령이 적어 효과가 자명). README 에 절감 수치 인용(벤치 문서
  표 링크). react-native-calculator(전 명령 사용)은 full 유지 — 두 예제가
  두 모드를 함께 보여준다.
- 문서 en/ko 미러: codegen 가이드에 "Bundle size (RN)" 절 — 문제 원인
  3줄, config 예, 폴백 의미(제외 명령은 JSON 경로로 느리게 동작),
  벤치 문서 링크. 인덱스 등록.

### E. 테스트·게이트

- 유닛(packages/cli):
  - 렌더러 골든 — subset 픽스처(postcard 2 + complex 1 + 배제 1)로
    registry/codec-파일/헬퍼 출력 고정, full 모드 골든은 현행 바이트 동일.
  - config 검증 4케이스(빈 배열/불명확 이름/중복/정상).
  - manifest 모드 전환 정리(full↔subset).
  - doctor registry subset 검사 3케이스.
- e2e: bare-calculator 재생성(`rustra codegen`) 후 앱 동작 — RN 실행은
  기존 예제 게이트 경로 재사용. metro 번들 크기 측정은 CI 에 넣지 않는다
  (metro 세팅 비용 대비 가치 — 벤치 문서의 수동 재현 절차로 유지).
- api-surface: 패키지 export 무변경(생성물 파일 셋은 스냅샷 밖) — 예상
  무영향, 배터리로 확인.
- 전체 게이트 배터리 + changeset(minor, 사용자 승인 게이트).

### F. 명시적 범위 밖

- **commands.ts 파사드 잔여(154 B/명령)** — `export *` 도 metro 비절감.
  코덱의 1/10이라 후속 슬라이스로 분리(파사드를 lazy require 화하거나
  사용 명령만 노출). 본 트랙이 끝난 뒤 재측정으로 우선순위 판단.
- lazy 팩토리 렌더 — 벤치에서 목적(번들·시작 비용 양축)이 소멸했으므로
  구현하지 않는다.
- per-host 서브셋(호스트별 registry 파일) — 수요 근거 없음.

## 태스크

1. **config 표면** — `registry.commands` 파싱·검증·closestMatch + 스키마
   json 갱신 + config.test.ts 케이스 (XS)
2. **코드젠 subset 렌더링** — codec-split 렌더러 + registry 분기 +
   cli-generate-files 배선 + 골든 테스트 (S)
3. **manifest 모드 전환 정리** — 전환 시 이전 모드 파일 삭제 + `--check`
   부재 감지 + 테스트 (XS-S)
4. **doctor registry subset 검사** — 3케이스 + doctor.test.ts (XS)
5. **bare-calculator 채택 + 문서 en/ko** — 예제 config 적용·재생성,
   codegen 가이드 절 추가, 인덱스·미러 (S)
6. **게이트 배터리 + changeset 초안** — 전체 게이트, api-surface 확인,
   changeset(사용자 게이트 대기) (XS)

의존: 1→2→3→4 순차, 5는 2 완료 후, 6은 마지막. 1·2가 본체(S-M).
