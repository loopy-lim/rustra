# 다음 사이클 설계: 안정화 + 무중단(RN wasm dev) + 인스펙터 (2026-08-31)

> 상태: 사용자 승인 완료. 구현 계획은 `2026-08-31-next-cycle.md`에 작성.

## 목표

다음 버전 사이클을 3단계로 구동한다:

1. **Phase 0 — 현장 랜딩**: 미커밋 3-스트림(버전업 산출물 / complex_serde 분해 / docs
   영어화)을 분리 커밋해 착지시키고, 0.5.0 Version PR로 발행.
2. **Phase 1 — 안정화 트랙**: API 표면 고정, semver/폐기 정책, 계약 보증 게이트,
   마이그레이션/예제 점검.
3. **Phase 2 — 기능 2트랙 (병렬 워크트리)**: 무중단 핸들러 주입(RN 우선) + 인스펙터.

WASM/Web host 전체 지원은 다음 사이클 이후로 보류 (이번에는 RN dev 루프 우회로로만).

## 핵심 원리

- **안정화가 기능보다 먼저**: 무중단 주입 FFI와 인스펙터 덤프 API는 곧 새 public
  표면이다. Phase 1의 정책(넘버링·폐기·계약 보증)이 먼저 존재해야 나중에 재작업이 없다.
- **계약은 산문이 아니라 게이트로**: "갭이 없다"는 주장이 아니라 CI/rustra.json/빌드
  스크립트로 강제한다.
- **정직한 경계**: 커버 안 되는 것(동시성 부류, iOS 네이티브 핫스왑 불가)은 커버 안 된다고
  문서+게이트에 명시한다.

## Phase 0 — 현장 랜딩

현재 워킹트리에 섞인 3개 작업 스트림을 분리 커밋:

1. 버전업 산출물 — 9개 package.json/CHANGELOG + release.yml + bun.lock
2. 아키텍처 분해 — `complex_serde_*` 11개 파일 신설 + `complex_schema_ir_compile.rs`
3. docs 영어화 — `docs/english-reorg` 브랜치 → main 머지

이후 changeset Version PR 머지 → npm 9패키지 minor + crates 0.5.0 발행
(crates.io는 수동 전용 — [[publish-status-0-1-1]]).

## Phase 1 — 안정화 트랙 (단일 브랜치, 순차)

### 1-1. API 표면 고정

- crates 2종(rustra, rustra-macros) public export 목록 + FFI export 전수(현 29개) +
  npm 9패키지 d.ts 표면을 스냅샷 파일로 고정
- 드리프트 검사 게이트: 스냅샷과 실제 표면의 diff가 있으면 CI fail
- 의도적 노출 / 내부 구분 태깅 (`#[doc(hidden)]`, `@internal` 등)

### 1-2. semver/MSRV/폐기 정책 (docs/versioning-policy.md 신설)

- 호환 보증 대상 명문화: wire 포맷·계약 해시·FFI 시그니처·generated output
- 폐기 절차: deprecated → 최소 1 minor 유지 → 제거 규칙 (1.0 전 minor에서 제거 가능,
  deprecated 표기 필수)
- experimental 태그 규칙: `rustra_ffi_hot_reload` 등 1.0 전 제거 가능 표면의 명시적 분류

### 1-3. 계약 보증 게이트

- 기존 PINNED hex 와이어 게이트를 확장: 구 스키마 fixture vs 신 코덱 역호환 테스트를
  CI 상시화
- 계약 해시 정합성 테스트(경로 A==B 패턴)를 모든 타깃 행에 적용

### 1-4. 다중 타깃 검증 매트릭스

- `rustra doctor`가 `rustra.json`에 존재하는 **모든** 호스트/타깃 섹션을 전수 진단
  (수집형 — 한 섹션 red여도 나머지 계속 검사, exit code는 최악 상태 반영)
- 타깃별 상태 표 출력: `target / build / contract / runtime / notes`
- 섹션 간 일관성 검사: 전 타깃이 동일 스키마·동일 contract hash를 가리키는지 교차 검증
  ("한 프로젝트, 한 계약")
- CI 매트릭스에 wasm32 타깃 행 추가 (golden wire + 계약 해시 테스트를 행마다 실행)

### 1-5. 마이그레이션/예제 점검

- 0.5.0 기준 마이그레이션 가이드 보완
- examples 전수 점검 (빌드 + 게이트 통과)

## Phase 2 — 기능 2트랙 (병렬 워크트리)

### Track A — 무중단 핸들러 주입 (RN 우선)

**문제**: RN은 Rust 백엔드가 앱 바이너리에 정적 링크(staticlib)되어 런타임에 네이티브
코드 교체가 불가하다(iOS는 dyld 재로드 금지, 동적 코드 로드 차단). Node/Bun/Tauri는
cdylib 재로드가 가능하다.

**해법 — 백엔드를 데이터로 스왑**: 핸들러 로직을 wasm32 모듈(그냥 바이트 파일)로
컴파일하고, wasm3 인터프리터(JIT 아님 → iOS W^X 문제 없음)를 앱에 한 번 정적 링크.
dev 루프가 새 .wasm을 기기로 푸시하면 앱이 새 인스턴스를 컴파일해 엔진 포인터를
원자적 교체 — 앱 재시작 없음.

```
[RN 앱 - 최초 1회 빌드] JSI 모듈 + wasm3 (정적, 불변)
        ↑ .wasm 바이트 스왑 (파일 교체)
[rustra dev] 백엔드 재컴파일 → wasm32 .wasm → 기기 푸시
        ↓ [앱 안] 새 WASM 인스턴스 컴파일 → 엔진 포인터 원자적 교체
```

**순서:**

- **A0 (스파이크, 최우선)**: 실기기(iOS+Android)에서 wasm3 기반 백엔드 스왑 PoC.
  합격 기준 단 하나: 앱 재시작 없이 백엔드 로직 교체 → 동일 command 응답이 native와
  바이트 동일. 실패 시 트랙 종료, RN은 "재빌드 필요" 경계 문서화 + `@rustra/testing`
  목업 대체로 회귀.
- **A1**: Node/Bun/Tauri cdylib 핫스왑 (dev 루프 연결).
- **A2**: `rustra_ffi_hot_reload` FFI — 기존 `replace()` 경로 재사용
  (command_id 유지, live_schema 무효화, frozen 게이트 의미론 유지).
  experimental 태그 (1-2 정책 적용).
- **A3**: 워크플로 통합 — `rustra dev`에 wasm 타깃, 빠른 반복은 wasm/확정은 native.

**dev-실동작 갭 관리 (사용자 지점 반영 — "갭이 매우 어려워 보인다"):**

| 버그 부류                          | wasm dev 재현?                          | 판정                           |
| ---------------------------------- | --------------------------------------- | ------------------------------ |
| 로직·와이어·계약                   | 재현됨 (같은 Rust core, 순수 연산)      | 안전 — 게이트로 증명           |
| 동시성 (race/취소/백프레셔/데드락) | **절대 재현 안 됨** (단일스레드 협동형) | native 전용 — 이름 박아 문서화 |
| 플랫폼 I/O·FFI 경계                | 구조적으로 없음 (channels 위임)         | 위임 계약으로 관리             |

완화 장치 3개:

1. **패리티 게이트 (CI + dev 루프)**: golden wire·계약 해시를 native/wasm32 양쪽에서
   대조, 불일치 fail + 리로드 거부.
2. **동시성 스위트 native-only 고정**: 취소/타임아웃/백프레셔 테스트에 "wasm 미커버"
   명시 — 아는 미지로 만든다.
3. **환경별 버그 이분법 진단**: native에서만 터지는 버그 → 인스펙터 덤프로 native wire
   vs wasm wire 바이트 비교 → 동일하면 엔진/호스트 계층, 다르면 계약 게이트 실패.
   (Track B와 맞물림)

킬스위치: native-only 버그가 잦아 손해라 판명되면 "새 코드만 wasm 반복, 의심 시 즉시
native 빌드"로 다이얼 조임 — staticlib 경로가 사라지지 않으므로 후퇴 비용 0.

**정직한 비용 (문서화 대상):** wasm3 인터프리터 성능(수 배~수십 배 느림, dev 전용),
wasm32 단일스레드(취소·백프레셔 축소), 핸들러 fs/네트워크 I/O는 channels로 네이티브
위임, Hermes에 WASM 없음(우리가 직접 wasm3 탑재, 앱 +수백 KB, debug 한정), iOS
네이티브 핫스왑은 물리적 불가(문서로만).

### Track B — 인스펙터 (4요소, "덤프 API 먼저"가 지반)

- **B1 표준 덤프 API**: 산포 FFI를 스냅샷 모델로 통일 —
  `captureSnapshot() -> { contractHash, schemaGeneration, commands[], events[],
channels, limits, stats }`. `@rustra/types`에 DumpedWire 타입 + 스키마 주도
  postcard→사람용 값 디코더 (TS 복잡 코덱 디코더 재사용).
- **B2 wire 뷰어/디코더**: hex 덤프 → 스키마 주도 파싱 → 필드 트리 렌더.
  CLI `rustra inspect <dump-file>` (의존성 없이 터미널).
- **B3 호출 타임라인 UI**: `@rustra/devtools` DevtoolsLog → 타임라인 렌더.
  1차 산출물은 정적 HTML 리포트 생성기 (프레임워크 무관). Live TUI/웹 대시보드는
  다음 사이클.
- **B4 계약 diff 진단**: CLI schema-diff 확장 — mismatch 시 원인 지목
  (command_id displacement, alias 누락, 타입 변경). OTA onContractMismatch 콜백에
  진단 객체 연결.

## rustra.json — 관리 허브 + 작성 UX

### `dev` / `inspector` 섹션 신설

```jsonc
{
  "schema": "./generated/schema.json",
  "output": "./src/generated",
  "dev": {
    "target": "native" | "wasm",       // 기본 native
    "wasm": {
      "engine": "wasm3",
      "parityGate": true               // 기본 true — 리로드마다 native↔wasm 대조
    }
  },
  "inspector": {
    "captureWire": true,
    "onMismatch": "diagnose"
  }
}
```

- 패리티 게이트를 설정으로: `dev.wasm.parityGate` (기본 true) — 끄려면 명시적 해제 필요.
- doctor 확장: `target: wasm`이면 "협동형 취소만 유효 — 릴리스 전 native 검증 필수"를
  진단 리포트에 출력.
- 릴리스 오염 방지: wasm 백엔드 활성 시 release 빌드 스크립트가 구조적으로 fail.

### 작성 UX ("잘 넣게 해주세요")

1. **JSON Schema 발행**: `rustra.schema.json` 패키지 포함, `rustra init`이 생성하는
   config에 `"$schema"` 삽입 → 에디터 인라인 검증/자동완성. 스키마↔`config.ts` 타입
   동기화 테스트 게이트.
2. **검증 사다리 3단** (앞단 실패 시 뒷단 진행 안 함):
   - L1 구조: JSON 파싱, known keys(fail-closed 유지), 타입, closestMatch "did you mean"
   - L2 의미(신설): 교차 필드 제약 — `dev.target=wasm`인데 `reactNative` 섹션 부재,
     `wasm.engine` 허용값 고정, `parityGate`는 wasm에서만 유효,
     `inspector.onMismatch=diagnose`인데 devtools 미사용 안내, 타깃 간 백엔드 불일치 경고.
     에러는 복수 수집해 한 번에 나열, 각 에러에 필드 경로 + 수정 예시 스니펫.
   - L3 환경: 경로·툴체인 존재 — doctor 영역 (config 로드는 순수 함수 유지).
3. **`rustra init` 상황별 템플릿**: 호스트 감지(package.json deps, Cargo.toml) 후 필요한
   섹션만 든 최소 config. `--host` 플래그. 기존 config 존재 시 병합 없이 안내.
4. **상황 매트릭스 테스트 (게이트)**: 호스트 단독/조합, 부분 설정, 오타 키, 잘못된 타입,
   신규 섹션 없는 구형 config(native 기본), wasm+rn 부재, 경로 역행 시도 등을 표로
   전수 고정 — 각각 기대 결과를 테스트로.
5. **하위호환 불변식**: `dev`/`inspector` 없는 기존 config = 지금과 동일 동작.
   알 수 없는 키 fail-closed 유지 (구 CLI + 신 config 조합 loud fail).

## 테스트 전략

- Phase 1: 표면 스냅샷 드리프트 게이트, 역호환 golden fixture 테스트, doctor 다중 타깃
  테스트, wasm32 CI 행.
- Track A: 스파이크 합격 기준(실기기 바이트 동일 응답), reload 전후 wire round-trip
  동일성, 진행 중 invocation 취소 경계, mismatch loud-reject.
- rustra.json: 상황 매트릭스 전수 테스트, 스키마↔타입 동기화 게이트.
- Track B: 디코더 golden 테스트(PINNED hex 재사용), schema-diff 진단 케이스 테스트.

## 마일스톤 요약

| 순서       | 산출물                                                                                  | 완료 판정                          |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| Phase 0    | 3-스트림 랜딩 + 0.5.0 발행                                                              | main green, Version PR 머지        |
| Phase 1    | 표면 스냅샷+게이트, versioning-policy.md, 역호환 테스트, doctor 매트릭스, examples 점검 | CI 전 게이트 green                 |
| Phase 2-A0 | 실기기 wasm 스왑 스파이크 판정                                                          | 합격 기준 충족 or 정직한 종료 문서 |
| Phase 2-A  | Node/Bun/Tauri 핫스왑 + FFI + dev 통합                                                  | reload 후 계약 게이트 green        |
| Phase 2-B  | 덤프 API + inspect CLI + 타임라인 리포트 + diff 진단                                    | golden 테스트 green                |

## 범위 밖 (명시적 이월)

- WASM/Web host 전체 지원 (브라우저 배포) — 다음 사이클 이후
- Live TUI/웹 인스펙터 대시보드
- 프로덕션 핸들러 스왑의 감사 로그 강화 (A2의 replace() 경로가 기반)
- Android 전용 dlopen 네이티브 스왑 (메커니즘 2개 유지보수 비용)
- 채널 iOS 실기기 증빙 (기존 보류 항목 유지)
