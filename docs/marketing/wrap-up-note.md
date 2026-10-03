# 통합 검증 노트 — ko 동기화 + SEO

- 날짜: 2026-02-15 (작업 시점 기준)
- 범위: `README.ko.md` 히어로 동기화(ko-sync) + GitHub 저장소 SEO 메타데이터(seo) 통합 확인
- 이 문서 외 로컬 소스 파일은 수정하지 않았음 (SEO는 GitHub 메타데이터만 변경)

## 1. 벤치마크 숫자 일치 확인 (README.ko.md vs README.md)

`grep`으로 히어로 벤치마크 4개 항목을 두 파일에서 직접 비교:

| 항목                     | README.md               | README.ko.md                | 일치 |
| ------------------------ | ----------------------- | --------------------------- | ---- |
| 요청 페이로드            | 4 B vs 47 B — ~11.8×    | 4 B vs 47 B — 약 11.8× 작음 | ✅   |
| 코어 왕복                | 134 ns — ~8.9× faster   | 134 ns — 약 8.9× 빠름       | ✅   |
| Node N-API Frame 핫 경로 | 793,185 ops/s (~2,188×) | 793,185 ops/s (약 2,188×)   | ✅   |
| React Native 패리티      | ±5% (iOS simulator)     | ±5% 이내 (iOS 시뮬레이터)   | ✅   |

- 비교표의 "11.8× smaller" / "JSON 대비 요청 와이어 11.8× 작음"도 양쪽 모두 확인 (`README.md:79`, `README.ko.md:76`).
- 상세 표의 793,185 ops/s도 양쪽 모두 확인 (`README.md:783`, `README.ko.md:730`).
- 출처 문서 [benchmark-highlights.md](benchmark-highlights.md)의 수치(4 B / 47 B / ~11.8× / 134 ns / ~8.9× / 793,185/s / ~2,188× / ±5%)와도 전부 일치.

## 2. GitHub 메타데이터 확인 (gh 재확인)

`gh repo view loopy-lim/rustra --json description,repositoryTopics` 실행 결과:

- **Description**: "One Rust core generates type-safe clients for Node, Bun, Tauri, and React Native over a compact binary wire, with CI contracts that block breaking schema changes." — 영어 피치로 갱신 완료
- **Topics (11개)**: `rust`, `typescript`, `ffi`, `tauri`, `react-native`, `codegen`, `bindings`, `nodejs`, `bun`, `bridge`, `cross-platform` — 요청 토픽 전부 반영

상세 증거는 [seo-result.md](seo-result.md) 참고.

## 3. 완료 체크 (Loop 선언 체크 재현)

| 체크                                                | 결과               |
| --------------------------------------------------- | ------------------ |
| `README.md` 한글 혼입 없음 (perl `\p{Hangul}` 스캔) | ✅ 통과 — 매치 0건 |
| `repositoryTopics` 개수 > 0                         | ✅ 통과 — 11개     |

## 4. 미해결 리스크

- 한국어 헤딩 앵커 4건(예: `#전제-조건`)은 파일 존재 검증만 수행 — GitHub 한글 슬러그 규칙과의 정확한 일치는 미검증 (기존 링크이며 이번 변경 대상 아님)
- GitHub description/topics는 저장소 설정이라 커밋과 무관하며, 로컬 git 상태와 충돌 없음
