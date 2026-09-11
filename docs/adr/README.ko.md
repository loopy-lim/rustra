[English](./README.md)

# 아키텍처 결정 기록 (ADR)

rustra 의 계약 또는 그 강제 방식을 바꾸는 결정의 번호 기록. 형식은 문서당
Status / Context / Decision / Consequences. 거부된 선택지도 기록할 가치가 있다 —
왜 거부했는지까지 적는다.

| 번호                                                     | 제목                                             | 상태     | 날짜       |
| -------------------------------------------------------- | ------------------------------------------------ | -------- | ---------- |
| [0001](0001-record-track-a-contract-mechanization.ko.md) | Track A: 계약의 기계화 (UniFFI 성숙도 관행 채택) | Accepted | 2026-09-11 |
| [0002](0002-uniffi-track-b1-carrier.ko.md)               | Track B1: UniFFI 를 Kotlin/Swift 언어 캐리어로   | Accepted | 2026-09-11 |

## 규약

- 파일명: `NNNN-short-kebab-title.md` (`.ko.md` 한국어 미러 — 한국어를 먼저 집필).
- 상태 생명주기: `Proposed` → `Accepted` / `Rejected` → `Superseded by NNNN`
  (대체하는 문서가 거슬러 링크한다).
- [안전 계약](../safety-contract.ko.md)은 항목(S1–S7, 총괄 불변식)의 의미 변경에 ADR 을
  요구한다.
