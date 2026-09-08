---
date: 2026-09-08 11:40 +0900
researcher: claude
git_commit: 07c7f745
branch: changeset-release/main
repository: loopy-lim/rustra
topic: 'A13 rkyv registry eager import — RN 번들 크기 교차 벤치 (개선안 판별 포함)'
tags: [research, react-native, bundle-size, codegen, metro, registry]
status: complete
last_updated: 2026-09-08
last_updated_by: claude
---

# 리서치: A13 rkyv registry — RN 번들 크기 교차 벤치

**날짜**: 2026-09-08 11:40 +0900
**연구자**: claude
**Git Commit**: 07c7f745 (changeset-release/main)
**기준 문서**: `docs/research/2026-09-08-zero-config-dx-audit.md` §A13 (문제
발굴), 같은 문서 §5 슬라이스 3 (별도 트랙 권고)
**후속 문서**: `docs/plans/2026-09-08-a13-rn-registry-subset-design.md` (별도
트랙 설계 — 본 문서의 근거를 받아 결정만 기록)

## 연구 질문

1. 감사 A13의 주장 — "RN 번들이 전체 명령 수에 비례해 커진다" — 을 실측으로
   확정한다. 몇 바이트/명령인가, 사용 명령 수와 무관한가.
2. 감사가 제시한 개선안 "lazy 팩토리 Map" 이 RN 번들 크기를 실제로 줄이는가?
   줄이지 않는다면 무엇이 번들 크기를 줄이는가? (Metro 는 트리셰이킹이
   없으므로 가설: 함수 본문 내 `require` 도 모듈 그래프에 포함되어 무효)
3. 번들러 레짐 차이 — Metro(RN, 트리셰이킹 없음) vs bun 번들러(bun 호스트,
   트리셰이킹 있음) — 가 개선안 요구사항을 어떻게 가르는가.
4. eager registry 의 런타임 초기화 비용(모듈 eval)은 얼마인가.

## 방법

- **실예제 metro 벤치**: `examples/react-native-calculator` — App.tsx 가
  30개 명령 중 `addNumbers` 1개만 사용하는 상태에서 Metro 0.83.8
  (`Metro.runBuild`, expo/metro-config, dev=false, minify=true, iOS) 로
  프로덕션 번들을 만들어 원본/gzip 바이트를 측정. 생성물 파일 교체로 5변형:
  - **V0 eager** — 현행 생성물 그대로(registry 가 모든 코덱을 정적 import)
  - **V1 lazy** — registry 를 `() => require('./rkyv-codecs.js').x` 팩토리
    Map 으로, 엔트리는 얇은 어댑터로 재구성(감사 개선안의 실측형)
  - **V2 subset** — registry 에 사용 명령 1개만 등록(코덱 파일은 단일 유지)
  - **V3 split+subset** — 코덱을 명령별 파일(`codec-<cmd>.ts`) +
    공유 헬퍼로 분할하고 registry 가 사용 코덱 파일만 import
  - **V4 none** — registry import 자체를 제거(JSON Tier 3 전용, 하한선)
- **스케일링 곡선**: 합성 schema(명령 4형태 회전: i64쌍/문자열/f64쌍/bool)를
  N ∈ {10, 50, 100, 200} 로 만들어 **실제 codegen**(packages/cli dist)으로
  생성, 앱은 항상 첫 명령 1개만 사용. Metro 로 V0/V3 곡선 측정. codegen
  파이프라인 검증: 예제 schema 재생성물이 checked-in 생성물과 바이트 동일.
- **bun 번들러 레짐**: N=100 생성물에서 registry 만 소비하는 엔트리를
  `bun build --target=bun --minify` 로 3변형 번들(트리셰이킹 동작 확인).
- **모듈 eval 비용**: N=100 에서 eager registry import(코덱 100개 평가) vs
  lazy(팩토리만) — 디렉터리 사본으로 모듈 캐시를 우회하고 **교차 n=9**
  (중앙값±범위, [[ab-bench-interleaved]] 절차). bun 런타임으로 측정.
- 번들 크기는 결정론적 값이라 교차 반복이 불필요하고, 타이밍 축인 eval
  비용만 교차 측정했다.

## 결과

### 1. 실예제 (N=30, 앱은 1개 명령 사용)

| 변형                       |     bytes |    gzip |        Δbytes vs V0 |
| -------------------------- | --------: | ------: | ------------------: |
| V0 eager (현행)            | 1,151,249 | 284,352 |                   — |
| V1 lazy 팩토리             | 1,152,161 | 284,447 |            **+912** |
| V2 subset (단일 코덱 파일) | 1,150,218 | 284,100 |              −1,031 |
| V3 split+subset            | 1,109,538 | 279,960 | **−41,711 (−3.6%)** |
| V4 registry 제거 (하한)    | 1,109,292 | 279,925 |             −41,957 |

- **V1 lazy 는 번들을 줄이지 않는다(+912B)** — 팩토리 클로저 30개+어댑터
  분량이 오히려 더해진다. Metro 가 함수 본문 내 `require` 도 모듈 그래프에
  포함하기 때문(감사 개선안 반증, 가설 확인).
- **V2 subset 도 사실상 무효(−1,031B, −0.09%)** — registry 가 어떤 export
  를 가져오든 `rkyv-codecs.js` 모듈 전체가 번들에 들어간다. Metro 출력은
  `__d(function…)` 래퍼(기준 번들 619개 모듈)라 크로스모듈 사후삭제(DCE)가
  불가하다. −1KB 는 registry 파일 자체 축소분.
- **V3 만 유효(−41.7KB)** — V4 하한과 246B 차이로, 달성 가능한 절감의
  99.4%를 확보. 사용하지 않는 29개 코덱 ≈ 미니파이 1.44KB/개가 통째로 빠진다.

### 2. 스케일링 곡선 (사용 명령 1개 고정)

|   N |  V0 eager | V3 split+subset |                  절감 |
| --: | --------: | --------------: | --------------------: |
|  10 | 1,122,940 |       1,112,422 |               −10,518 |
|  50 | 1,182,185 |       1,118,510 |               −63,675 |
| 100 | 1,256,229 |       1,126,209 |              −130,020 |
| 200 | 1,405,029 |       1,141,709 | **−263,320 (−18.7%)** |

- V0 기울기 ≈ **1,485 B/명령(미니파이)**, gzip ≈ 56 B/명령 — 사용 여부와
  무관하게 전체 명령 수에 정비례. **감사 A13 주장 확정.** (원시 기준
  rkyv-codecs.ts 93.9KB/30명령 ≈ 3.1KB/명령과 정합)
- V3 기울기 ≈ **154 B/명령** — 잔여 증가는 commands.ts 파사드
  (`export * from './commands.js'` 도 Metro 비절감 대상. 코덱의 1/10,
  별도 후속 슬라이스).
- 절감량 ≈ **1,331 B/명령(미니파이)**. gzip 은 코덱이 상동 구조라 압축 후
  ≈ 38 B/명령에 그친다 — 문제의 실체는 원시/미니파이/Hermes 바이트코드
  축이지 전송 gzip 축이 아니다.

### 3. bun 번들러 레짐 (N=100, registry 소비 엔트리)

| 변형                  |     bytes |
| --------------------- | --------: |
| V0 eager              |   121,841 |
| V2 subset (단일 파일) | **3,581** |
| V3 split+subset       |     3,581 |

bun 번들러는 모듈 내 미사용 export 를 지운다 — **bun 호스트는 subset
registry 만으로 전체 절감**(코덱 파일 분할 불필요). V2==V3 는 남는 코드가
동일(헬퍼+사용 코덱 1개)임과 정합.

### 4. 모듈 eval 비용 (N=100, 교차 n=9, bun 런타임)

| 변형                  | 중앙값 | min~max    |
| --------------------- | -----: | ---------- |
| eager registry import | 2.11ms | 1.87~15.50 |
| lazy 팩토리 import    | 0.33ms | 0.26~1.76  |

eager 는 import 시점에 코덱 객체 100개를 평가한다 — **~1.8ms/100명령**
(데스크톱 bun 기준). Hermes 는 바이트코드로 사전 파싱되어 실기기 체감은
더 작다. 유의미하지만 본 트랙의 본축은 아니다. 단 V3(사용 코덱만 번들)에서는
미사용 코덱이 번들에 없으므로 lazy 화 필요성 자체가 소멸한다.

## 판정

1. **A13 문제 확정** — RN(metro) 번들은 사용 명령 수가 아닌 전체 명령 수에
   비례해 +1,485 B/명령(미니파이) 커진다. 100명령 패키지 ≈ +148KB,
   200명령 ≈ +297KB(전체의 18.7%).
2. **감사 개선안(lazy 팩토리)은 RN 번들 크기에 무효** (+912B). lazy 는
   시작 eval 지연(−1.8ms/100명령)에만 효과가 있고, subset 설계에서는 그
   효용도 소멸 — **트랙 설계에서 제외**한다.
3. **유효 개선안은 "subset registry + (Metro 한정) 코덱 파일 분할"**.
   레짐이 요구사항을 가른다: bun 은 subset 만, RN 은 subset+분할이 필요.
4. **런타임 변경이 불필요하다** — 엔진은 이미 registry 에 없는 명령을 live
   schema 의 commandId 로 Tier 3(JSON) 폴백 처리한다
   (packages/types/src/rkyv-engine.ts:20-25, react-native-async.ts:56
   staticIds 스윕도 registry 항목만 순회). 감사가 우려한 "네이티브 협상
   경로 회귐"(비용 M 사유)은 JS 측에서 성립하지 않는다. 본 트랙의 실비용은
   코드젠 렌더링+config+doctor+테스트로 **S-M**.
5. 서브셋 미등록 명령은 JSON 폴백으로 동작은 하지만 postcard 경로보다
   느리다 — 미등록은 config 의 명시적 선택이므로 codegen 헤더에 배제 목록을
   각인하고 doctor 가 drift 를 잡는다(설계 문서 §태스크).

## 트랙 권고

`docs/plans/2026-09-08-a13-rn-registry-subset-design.md` 로 별도 트랙을
연다 — 코드젠 옵트인 subset registry(+RN 용 코덱 파일 분할), 런타임 무변경,
commands.ts 파사드 잔여(154 B/명령)는 후속 슬라이스로 분리. 성능 트랙의
번들 크기 지표(감사 §5 슬라이스 3 예고)와 합류.

## 재현

벤치 하니스(변형 빌더·픽스처 생성·metro/bun/eval 스크립트)는 세션 스크래치
(/tmp/a13-bench)에서 수행 — 본 문서의 표가 절차 전부다. 재검증 요건:
(1) `node packages/cli/dist/index.js generate --schema <합성schema> --output
<dir>`, (2) 예제 generated/ 파일 교체 후 `Metro.runBuild`(expo/metro-config,
dev=false, minify=true), (3) 측정 후 `git checkout -- generated/`.
픽스처 원본(4형태 회전 schema)은 설계 문서 부록과 동일 구조.
