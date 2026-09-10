[English](./0001-record-track-a-contract-mechanization.md)

# ADR 0001 — Track A: 계약의 기계화 (UniFFI 성숙도 관행 채택)

- 상태: Accepted
- 날짜: 2026-09-11
- 관련 문서: [`docs/safety-contract.ko.md`](../safety-contract.ko.md),
  [`docs/research/2026-09-11-uniffi-maturity-catchup.md`](../research/2026-09-11-uniffi-maturity-catchup.md)

## 상태 (Status)

Accepted — 2026-09-11. 구현은 Track A 작업 항목(A1–A8)으로 분할되어 개별 진행된다.

## 배경 (Context)

Mozilla UniFFI 벤치마크 조사(`docs/research/2026-09-11-uniffi-maturity-catchup.md`)가
밝힌 성숙도의 실체는 언어 개수가 아니라 **계약의 기계화**다: 체크섬·로드시 검증·
실패주입 픽스처·픽스처 규율, 그리고 산출물 기준 코드젠 게이트. rustra 는 일부 축에서는
이미 앞서 있지만(공개 스키마, 와이어 freeze, 핫스왑, en/ko 문서), 강제 수준이 약한
지점 5곳이 성숙도 주장의 하중을 받는다:

1. FFI **서명** 변경이 api-surface 게이트를 통과한다(스냅샷이 심볼 **이름만** 비교).
2. 런타임 계약 검증(`contract.mismatch`)이 opt-in 이라 미설치 소비자는 검증 없이 지난다.
3. committed 생성물의 코드젠 신선도가 CI 에서 검증되지 않는다(doctor warn 에 불과).
4. 크로스언어 와이어 픽스처가 calculator 1개뿐이고, 모바일 런타임 E2E 가 없다(빌드만).
5. 불변식이 문서에 산재해 있고(안전 계약 문서 absent), ko 미러 완전성·typedoc 이 자동
   검사 없이 수동이다.

## 결정 (Decision)

UniFFI 의 성숙도 관행을 **rustra 모델을 유지한 채** 채택한다(Track A — 언어 커버리지
결정(Track B)과 독립). 여섯 가지:

1. **심볼별 서명 피닝**: api-surface 스냅샷 v2 로 승격해 심볼 이름을 넘어 서명(인자·반환·
   비동기 여부)을 비교한다 — UniFFI 의 심볼별 u16 체크섬에 상응하는 rustra 형태.
2. **contractVerification 정책 옵션**: `contract.mismatch` 런타임 검증을 escape hatch 를
   남긴 채 기본 활성으로 전환하는 정책 옵션을 도입한다.
3. **코드젠 신선도 게이트**: 재생성 → `git diff --exit-code` 로 committed 생성물 드리프트를
   CI 에서 실패로 전환한다(doctor warn 승격).
4. **와이어 픽스처 매트릭스**: 피처당 1 픽스처(태그드 유니온/맵/셋/에러/이벤트/채널/취소/
   비동기/대형 페이로드) + 3코너 pinned hex 확산 + "모든 크로스언어 버그는 픽스처로"
   규율 — UniFFI `fixtures/`의 적합성 스위트 모사.
5. **모바일 런타임 스모크**: rn-android/rn-ios 에뮬레이터·시뮬레이터 실행 잡을 CI 에
   올린다(핫코어 E2E 에서 실증된 인프라의 CI 화).
6. **서면 안전 계약 + ADR 관행**: 산재한 불변식을 [`docs/safety-contract.ko.md`](../safety-contract.ko.md)
   1장으로 통합하고, 이후 FFI 계약 변경은 번호 ADR 로 기록한다(이 디렉터리).

## 결과 (Consequences)

- **긍정**: 서명·신선도·계약 검증이 CI-hard 로 승격되어 "바인딩↔코어 불일치"가 UB 이전에
  실패로 전환된다. 안전 계약이 리뷰·변경의 1급 대상이 된다. UniFFI 대비 우위(공개 스키마,
  와이어 freeze, 핫스왑)를 유지한 채 관행 격차만 닫는다.
- **부정/비용**: 생성물 커밋이 없는 PR 은 신선도 게이트에 막힌다(재생성 커밋 필요).
  contractVerification 기본-온은 계약이 다른 구·신 아티팩트가 섞인 설치에서 기존에
  통과하던 앱이 실패할 수 있다(escape hatch 로 완화). 픽스처 매트릭스·모바일 스모크는
  CI 시간을 늘린다.
- **중립**: Track B(언어 커버리지)는 이 결정을 전제로 하며 별도 ADR 로 결정한다.
  안전 계약의 줄 번호 이동은 ADR 없이 갱신할 수 있다(계약 문서의 변경 규칙 참조).
