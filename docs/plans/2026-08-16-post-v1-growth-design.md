# 0.1.1 이후 성장 트랙 — dogfooding 주도 + 병렬 풀가속

- **상태:** 구현 완료 (2026-08-16) — 구현 계획 `2026-08-16-post-v1-growth-impl.md` 참조.
- **날짜:** 2026-08-16
- **전제:** 0.1.1 발행 완료(npm 7종 + crates.io), CI 3종 green, macOS/iOS/Android
  런타임 증명 완료. 실제 제품 앱은 별도 저장소에서 진행 중(핵심 소비자).
- **목표:** 준풀타임 투입으로 (1) 프레임워크 기능 확장 3스프린트와
  (2) 백그라운드 기술 부채(Windows CI 실험, FFI 퍼징)를 병렬 진행한다.

---

## 접근 선택 근거

후보 3종(완결성 우선 / dogfooding 주도 / 병렬 풀가속) 중 **병렬 풀가속(C)** 선택.

- Dogfooding 주도를 메인으로: 실제 앱이 겪는 아픔이 우선순위를 결정 → hot-reload가
  최우선(개발 루프 하루 수십 회 회전), 이어 테스팅·devtools(같은 관측성 트랙).
- Windows/퍼징은 대기가 많은 성격이라 백그라운드 CI 러너에 위임.
- 플러그인 시스템은 외부 사용자 등장 전 설계는 over-engineering으로 **보류**.
- 새 호스트 어댑터(Electron/Deno/웹)는 수요 확인 전 보류.
- 1.0 API 동결은 이르지만, 진행 중 가벼운 버전 정책 문서는 중간에 반영.

---

## 메인 트랙 (~70%)

### Sprint 1 — Hot-reload / live codegen (깃발)

문제: Rust 명령 시그니처 변경 시 수동 `cargo run` codegen → 번들 재빌드 →
앱 재시작 루프가 실제 앱 개발의 주 마찰.

기존 기반: debug 빌드 런타임 레지스트리(`register_fn`/`replace`/`unregister`,
release 자동 freeze), `rustra generate --watch` CLI, codegen dual-path 검증.

목표 UX:

```
rustra dev
  1. cargo watch로 backend 재컴파일 감지
  2. 재빌드 → 실행 중 호스트에 핸들러 주입 (레지스트리 replace 경우)
  3. TS 클라이언트 재생성 → 빌드 체인 전파
  4. 스키마 드리프트 시 rustra diff 경고
```

핵심 기술 결정(구현 시 검증): dylib hot-swap vs 프로세스 재시작 vs
재컴파일된 패키지 핸들러 테이블 주입. `replace()` API 존재로 주입 경로가
유력 후보.

증명 게이트: runner 템플릿 앱에서 Rust 함수 수정 → 앱 재시작 없이
(a) 새 결과 반영 (b) 시그니처 변경 시 새 TS 타입 에러 표시.
macOS desktop + iOS 시뮬 두 환경.

### Sprint 2 — 테스팅 프레임워크

- `@rustra/testing` 패키지: `createMockEngine()` — 순수 TS, Rust 의존 없음.
  핸들러 등록(`.on(command, handler)`)으로 생성된 클라이언트를 그대로 테스트.
- 계약 게이트: `rustra diff`로 생성 코드 vs 커밋된 schema.json 정합성 CI 추가.
- Rust 쪽은 cargo test 이미 갖춰짐 — JS 사이드 승리 중심.

### Sprint 3 — Devtools

- `@rustra/devtools`: engine 래퍼로 호출 로그·지연·에러 수집.
- CLI: `rustra dev --inspect` — 명령별 p50/p95, 에러율, 슬로우 콜 타임라인.
- `Package::emit`/EventBus 이벤트 스트림 재활용.

## 백그라운드 트랙 (~30%)

- **B1 Windows P1:** GitHub Actions `windows-latest`에서 Lynx SDK 다운로드 →
  `lynx_desktop_win.cpp` 컴파일 → FML PE 심볼 `dumpbin /exports` 확인 →
  아티팩트 저장. 실패해도 심볼 덤프가 다음 단계 정보.
  기존 자산: `verify-windows.ps1`, `desktop/WINDOWS.md` 포팅 3포인트.
- **B2 FFI 퍼징:** rkyv V2 디코드 경로(신뢰 경계)에 cargo-fuzz. CI에서
  10분 타임박스, 크래시 아티팩트 → 이슈화.

## 리스크

- hot-reload의 iOS 시뮬 환경 증명은 복잡할 수 있음 — macOS desktop 우선,
  iOS는 주입 메커니즘 검증 후 확장.
- Windows CI 런너의 Lynx SDK 가용성 미확인 — 실패 시 심볼 덤프만으로도
  수확 (정직한 부분 성공 정책).
- 퍼징 크래시가 쏟아지면 우선순위 재조정 (신뢰성 트랙 승격).
