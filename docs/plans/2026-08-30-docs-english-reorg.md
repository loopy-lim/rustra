# 문서 영어화 + 구조 정리 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 활성 문서를 영어 기본(`*.ko.md` 병행)으로 전환하고 산발 문서(thoughts/, docs/superpowers/)를 docs/ 단일 규칙으로 통합하며, 개인 plan/spec 스킬 4개를 제거한다.

**Architecture:** 이동은 `git mv`로 내용 무수정 수행, 번역은 영어 교체 + 한국어 원본 `.ko.md` 병행. 검증은 링크 전수 검사 스크립트 + 코드블록/표 구조 대조 + prettier 게이트.

**Tech Stack:** git, bash, prettier (기존 저장소 설정), superpowers 워크플로우

**설계 문서:** `docs/plans/2026-08-30-docs-english-reorg-design.md`

---

### Task 1: 역사 문서 이동 + 링크 수정

**Files:**
- Move: `thoughts/shared/plans/*` → `docs/plans/` (underscore→hyphen)
- Move: `thoughts/shared/specs/*` → `docs/specs/` (신설)
- Move: `thoughts/shared/research/*` → `docs/research/` (underscore→hyphen)
- Move: `thoughts/shared/prs/*` → `docs/prs/` (신설)
- Move: `docs/superpowers/plans/*` → `docs/plans/`, `docs/superpowers/specs/*` → `docs/specs/`
- Modify: `docs/README.md` 및 `thoughts/`·`docs/superpowers/` 참조 링크 보유 문서

**Step 1:** 브랜치 생성: `git checkout -b docs/english-reorg`

**Step 2:** git mv로 이동 (개명: `_` → `-`). 이동 후 충돌 파일명이 있으면 스킵하고 기록.

**Step 3:** `grep -rl "thoughts/shared\|docs/superpowers" --include="*.md" .` 로 참조 문서 찾아 경로 수정 (worktree/node_modules 제외)

**Step 4:** 검증: `thoughts/`·`docs/superpowers/` 디렉토리 소멸 확인, 끊긴 상대 링크 0

**Step 5:** 커밋: `git commit -m "docs: 산발 문서를 docs/ 단일 규칙으로 통합 (thoughts/, docs/superpowers 소멸)"`

### Task 2: 루트 README + crates README 영어화

**Files:**
- Create: `README.ko.md` (기존 README.md 원본)
- Rewrite: `README.md` (영어)
- Create: `crates/rustra/README.ko.md`
- Rewrite: `crates/rustra/README.md` (영어, crates.io 발행분)

**Step 1:** 기존 README.md를 README.ko.md로 git mv, crates/rustra 동일

**Step 2:** 영어 README 작성 — 직역 금지, 표/코드블록/링크 구조 보존, 수치 무수정. 상단 언어 전환 링크: `English | [한국어](./README.ko.md)` 형식 (예시 텍스트이므로 실제 링크 아님)

**Step 3:** 검증: 한국어 README 대비 섹션 수 일치, 링크 유효

**Step 4:** 커밋: `git commit -m "docs: README 영어 기본 전환 (.ko.md 병행)"`

### Task 3: CONTRIBUTING + docs/ 핵심 문서 영어화

**Files:**
- Rewrite+Create: CONTRIBUTING.md / CONTRIBUTING.ko.md
- Rewrite+Create: docs/README.md / README.ko.md (문서 인덱스, 읽기 경로 갱신 반영)
- Rewrite+Create: docs/{architecture,getting-started,benchmarks,rust-api-guide,development-hurdles,migration-guide,compatibility-matrix,complex-codecs,security-audit,release-procedure}.md + 각 .ko.md
- docs/compatibility-contract.md: 이미 영어 — 무수정 확인만

**Step 1:** 원본을 .ko.md로 복사 후 영어 작성 (용어표 준수: host, generated output, command, contract, wire, codegen, adapter, performance receipt, physical device)

**Step 2:** 검증: 코드블록 개수·표 행수 원본 대조, prettier --check

**Step 3:** 커밋: `git commit -m "docs: docs/ 핵심 문서 영어화"`

### Task 4: docs/ 하위 문서 영어화

**Files:**
- extending/{adding-host,react-native-setup,transport-guide}.md + .ko.md
- internal/{codegen,crate-structure,testing}.md + .ko.md
- migrations/0.3-to-0.4.md + .ko.md

**Step 1~3:** Task 3과 동일 절차, 커밋: `git commit -m "docs: extending/internal/migrations 영어화"`

### Task 5: packages/ + examples/ README 영어화

**Files:**
- packages/{node,bun,tauri,react-native,testing,devtools,cli,types}/README.md + .ko.md (react는 이미 영어)
- examples/{calculator,calculator-napi,crud,benchmark,tauri-calculator,react-native-calculator,react-native-bare-calculator,streaming,auth,reference-app}/README.md + .ko.md

**주의:** examples/react-native-calculator/ios/Pods/** 는 서드파티 — 제외

**Step 1~3:** 동일 절차, 커밋: `git commit -m "docs: packages/examples README 영어화"`

### Task 6: 개인 plan/spec 스킬 제거

**Files (저장소 밖, 커밋 없음):**
- Remove: `~/.codex/skills/{create-plan,create-spec,implement-plan,validate-plan}`

**Step 1:** 삭제 전 4개 디렉토리 존재 확인

**Step 2:** `rm -rf` 4개 디렉토리

**Step 3:** 검증: 디렉토리 소멸, 다른 스킬(research-codebase, ralph-* 등) 잔존 확인

### Task 7: 최종 검증

**Step 1:** 링크 전수 검사 스크립트 — 모든 md의 상대 링크가 실제 파일로 해석되는지 (Pods/node_modules/worktree/generated 제외)

**Step 2:** `bun run format:check` (docs 관련 실패 시 prettier --write 후 재검)

**Step 3:** `docs/plans/2026-08-30-docs-english-reorg-design.md` 체크박스 완료 갱신 + 최종 커밋

**Step 4:** main으로 병합 여부는 사용자에게 보고 후 결정
