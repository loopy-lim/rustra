# 문서 영어화 + 구조 정리 설계 (2026-08-30)

## 목표

1. 활성 문서를 영어 기본으로 전환, 한국어 원본은 `*.ko.md` 병행 보존
2. 산발 문서(thoughts/, docs/superpowers/)를 docs/ 단일 규칙으로 통합
3. 개인 plan/spec 워크플로우 스킬 제거 — superpowers 워크플로우로 통일

## 결정 사항

- **스킬 비교 결론**: 개인 스킬(create_plan/create_spec)은 `thoughts/shared/`에
  하드코딩되어 공개 저장소에 부적합. superpowers 규칙(`docs/plans/*-design.md`,
  `*-impl.md`)이 npm/crates.io 발행 OSS에 맞다. 이후 이 저장소의 plan/spec은
  superpowers로 통일한다.
- **역사 문서(docs/plans 51개 + docs/superpowers 13개 + thoughts 14개, 약 2만 줄)는
  위치만 정리하고 번역하지 않는다.** 완료된 계획/스파이크 기록은 외부 사용자 대상이
  아니다.
- **한국어 원본 보존**: 영어 기본 + `*.ko.md` 병행. 각 문서 상단에 언어 전환 링크.

## 구조 정리 (git mv, 내용 무수정)

```
thoughts/shared/plans/*  (3)   → docs/plans/     (underscore → hyphen 개명)
thoughts/shared/specs/*  (2)   → docs/specs/     (신설)
thoughts/shared/research/* (6) → docs/research/  (underscore → hyphen 개명)
thoughts/shared/prs/*    (4)   → docs/prs/       (신설)
docs/superpowers/plans/* (8)   → docs/plans/
docs/superpowers/specs/* (5)   → docs/specs/
thoughts/ 디렉토리 → 소멸, docs/superpowers/ → 소멸
```

- 문서 내 `thoughts/`·`docs/superpowers/` 참조 링크 전수 검색 후 수정

## 번역 대상 (활성 문서만)

| 그룹 | 파일 |
|---|---|
| 루트 | README.md |
| crates.io 발행 | crates/rustra/README.md |
| docs 핵심 | architecture, getting-started, benchmarks, rust-api-guide, development-hurdles, migration-guide, compatibility-matrix, complex-codecs, security-audit, release-procedure, docs/README (compatibility-contract은 이미 영어) |
| docs 하위 | extending/adding-host, extending/react-native-setup, extending/transport-guide, internal/codegen, internal/crate-structure, internal/testing, migrations/0.3-to-0.4 |
| packages/ | node, bun, tauri, react-native, testing, devtools, cli, types (react는 이미 영어) |
| examples/ | calculator, calculator-napi, crud, benchmark, tauri-calculator, react-native-calculator, react-native-bare-calculator, streaming, auth, reference-app |
| 기타 | CONTRIBUTING.md |

**제외**: docs/plans 전체, docs/research의 기존 `.ko.md`들, CHANGELOG.md(발행 자동
생성), .github 템플릿(이미 영어), node_modules/Pods 하위.

## 번역 규칙

- 직역 금지, 기술 문서 관례(표/코드블록/링크 구조 보존)
- 코드·CLI 플래그·파일 경로·수치·벤치마크 수치 무수정
- 용어 통일: 호스트→host, 생성물→generated output, 명령→command,
  계약→contract, 와이어→wire, 코드젠→codegen, 어댑터→adapter,
  성능 영수증→performance receipt, 실기기→physical device
- 각 문서 상단: `English | [한국어](./xxx.ko.md)` 전환 링크 1줄
- 내부 상대 링크는 영어 문서 기준으로 재작성

## 검증 게이트

1. 내부 링크 전수 검사 스크립트 (끊긴 링크 0)
2. 코드블록 개수·표 행수 원본 대비 일치 확인
3. prettier --check 통과 (generated/ 제외, 기존 설정 준수)

## 커밋 분리

1. 문서 이동 + 링크 수정 (git mv만, 내용 무수정)
2. README 2개 + CONTRIBUTING 번역
3. docs/ 활성 문서 번역
4. packages/ + examples/ README 번역
5. 스킬 제거: `~/.codex/skills/`에서 create-plan, create-spec, implement-plan,
   validate-plan 4개 (저장소 밖, 커밋 없음)

## 스킬 제거

`~/.codex/skills/`에서 plan/spec 워크플로우 4개 제거:
create-plan, create-spec, implement-plan, validate-plan.
이후 이 저장소 plan/spec은 superpowers(brainstorming → writing-plans →
executing-plans)로 통일.
