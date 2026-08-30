# 성능 트랙 Plan 3 — RN 잔여 최적화 + 기기 실측 보강

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RN은 이미 Nitro 패리티(1.0x 전후)라 이 트랙은 미세 잔여(cachedProp 2단 해시, async 이름 기반 진입) 정리와 **측정 공백 해소**(F3 async into, Android 실기기)가 본체다.

**Architecture:** 구현(G1)과 측정(G2)이 독립 — 병렬 가능. 구현은 수십 ns 규모라 리그레션 리스크 최소화가 우선 (기존 C++ codec 테스트 스냅샷 게이트 유지).

**Tech Stack:** C++ (JSI), Rust (FFI), TypeScript (RN 패키지), RN 예제 앱 벤치.

**Spec:** `docs/specs/2026-08-29-perf-five-tracks-design.md`

## Global Constraints

- 기존 wire/PINNED hex 게이트 유지 (RN 코드젠 산물 포함)
- C++ 게이트가 CI에 없음 — 정확성 게이트는 `run-cpp-codec-tests.sh` 스냅샷, 성능은 기기/시뮬레이터 실측으로만 확정
- positional facade는 이미 구현+측정 완료(487-504ns vs byId 591-620ns) — 재구현 아님
- 측정 시 로드 평균/시뮬레이터 조건 영수증 기재 (Metro 로그 판독 레시피)

---

## 트랙 G — RN 구현 잔여

### Task G1: cachedProp 정적 테이블화 (코드젠)

**Files:**
- Modify: `packages/cli/src/generate-*.ts` 중 C++ codec emit (cachedProp 생성부 —
  `examples/react-native-calculator/modules/rustra-jsi/generated/rustra-generated-codecs.cpp:44-56` 생성원)
- Test: `packages/cli/src/generate.test.ts`, C++ codec 테스트 스냅샷 재생성

**Steps:**

- [ ] **Step 1: 현황 확인** — 생성 코드의 `cachedProp(rt, name)`이 전역 `caches` map(Runtime* 키, weak_ptr lock) → `values.find(name)` 2단 해시임을 재확인. 목표: 명령별 필요 프로퍼티 name 목록을 **정적 배열**로 emit + 진입 시 1회 전역 해시 → `std::array<jsi::PropNameID>` (reload 시 `resetPropNameCache` 계약 유지 — 기존 리로드 대응 패턴 존재)
- [ ] **Step 2: 실패하는 테스트** — 코드젠 emit 스냅샷 테스트 (정적 테이블 포함 확인)
- [ ] **Step 3: 실패 확인** — `cd packages/cli && bun test src/generate.test.ts` → FAIL
- [ ] **Step 4: 구현** — 코드젠이 명령별 프로퍼티 name 정적 배열 + 인덱스 기반 `cachedPropByIdx` emit. decode/encode 생성 코드가 문자열 name 대신 인덱스 상수 사용
- [ ] **Step 5: 게이트** — 코드젠 재생성(RN 포함) + `run-cpp-codec-tests.sh` 스냅샷 전부 통과 + `bun test packages/cli`
- [ ] **Step 6: 벤치 + 커밋** — iOS 시뮬레이터 BenchmarkApp before/after (decode 중심 명령: benchEchoPair 등) → `perf(rn): PropNameID 정적 테이블 — decode 해시 조회 제거`

### Task G2: async byId 진입 (`invokeTypedAsyncById`)

**Files:**
- Modify: `packages/react-native/native/cpp/RustraJSIBridge.{hpp,cpp}:1115-1275` (async 경로), C++ 생성 코덱 emit (`encode_by_name`→`encode_by_id` 위임), `packages/react-native/src/index.ts:279-347` (createAsyncEngine)
- Test: `packages/react-native/src/index.test.ts`, C++ 테스트

**Steps:**

- [ ] **Step 1: 실패하는 테스트** — async 엔진이 cmdId로 진입하는지 (name 마샬링 없음) 검증. 기존 async 테스트(`index.test.ts:352-473`)를 byId 경로로 확장
- [ ] **Step 2: 실패 확인** — FAIL
- [ ] **Step 3: 구현** —
  - C++: `invokeTypedAsync(name,…)` 옆 `invokeTypedAsyncById(cmdId,…)` HostFunction 추가 — `encode_by_id`/`decode_by_id` 재사용, 완료 콜백의 `std::string name` 복사 제거 (에러 메시지 접미는 id 기반 조립)
  - JS: `createAsyncEngine`이 정적 id 캐시(`ensureStaticIds` 선례)로 byId 우선, 미노출 시 이름 폴백 (byId 동기 경로의 P0-3 패턴 그대로)
- [ ] **Step 4: 게이트** — `bun test packages/react-native` + C++ 스냅샷 + 예제 앱 스모크 (channelDemo/emitDemo async 경로)
- [ ] **Step 5: 커밋** — `perf(rn): async byId 진입 — 이름 마샬링 제거`

### Task G3: async 컨텍스트 슬롯 풀링 (선택, G2 이후 판단)

**Files:**
- Modify: `RustraJSIBridge.cpp:1115-1275` (make_shared/new/레지스트리 뮤텍스 → 고정 슬롯 배열 + generation)

**Steps:**

- [ ] **Step 1:** G2 벤치 결과에서 async 잔여 비용 중 make_shared/new/뮤텍스 비중 확인 — 콜드 패스(emitDemo 등 장기 작업)면 **보류 판단**이 기본값
- [ ] **Step 2:** 채택 시에만 구현 (슬롯 재사용 + generation 카운터로 stale 콜백 무시 — 기존 exactly-once free 계약 유지)
- [ ] **Step 3: 커밋** — `perf(rn): async 컨텍스트 슬롯 풀링` (보류 시 이 태스크 삭제)

---

## 트랙 H — 측정 보강 (구현 없음)

### Task H1: F3 async into 기기 실측

**Files:**
- Modify: `examples/react-native-calculator/BenchmarkApp.tsx` (async into 경로 측정 블록 — 이미 "pos full avg" 선례 존재), `docs/benchmarks.md`

**Steps:**

- [ ] **Step 1:** BenchmarkApp에 async owned=0(512B 내) vs owned=1(초과) vs 구 vector 경로 비교 블록 — worker-pool 왕복 포함
- [ ] **Step 2:** iOS 시뮬레이터 측정 (Metro 로그 판독) — success 기준: async/sync 격차가 복사 제거 전 기록 대비 축소
- [ ] **Step 3:** `docs/benchmarks.md` F3 절 채움 + receipt 보존
- [ ] **Step 4: 커밋** — `docs(bench): F3 async into iOS 실측`

### Task H2: Android 실기기/에뮬레이터 스모크

**Files:**
- Modify: `docs/benchmarks.md` (Android 수치), 필요 시 예제 앱 빌드 스크립트

**Steps:**

- [ ] **Step 1:** `examples/react-native-bare-calculator` Android 빌드 + 벤치 앱 구동 (Android 3대 갭 레시피 참조 — 과거 스파이크 문서)
- [ ] **Step 2:** 동기(raw/positional/byId) + async + batch 측정 → `docs/benchmarks.md` "Android 에뮬레이터/실기기 수치는 별도 검증 필요" 문구 해소
- [ ] **Step 3: 커밋** — `docs(bench): Android RN 실측 — iOS 수치 이식 제거`

### Task H3: positional facade 사용/폐기 결정

**Files:**
- Modify: 없음 (판단 기록) 또는 `examples/react-native-calculator` 앱에 `installRustraPositional` 설치
- Output: `docs/benchmarks.md` 노트

**Steps:**

- [ ] **Step 1:** 생성된 `positional-facade.ts`의 `callPos` rest-args 경로와 엔진 route 클로저(`rkyv-engine.ts:402-443`) 직통 경로의 비교 벤치 — 패사드가 오히려 프레임 2개+rest 배열 오버헤드가 있다는 조사 결과 검증
- [ ] **Step 2:** 결정 기록 — (a) 앱 설치 불요(엔진 직통이 이미 pos 사용) 확정 시 facade 파일 폐기 or 유지(직접 사용자용 API), (b) 설치가 이득이면 앱에 설치
- [ ] **Step 3: 커밋** — `docs(rn): positional facade 필요성 판정 기록`

---

## 병렬 실행 노트

- 트랙 G(C++)와 H(측정)는 병렬 가능 — H는 G 결과를 기다리지 않는다 (F3/Android는 현재 코드 기준 측정)
- G1/G2는 C++ 생성 코드 중심 — `command.rs` 등 코어와 무충돌 (트랙 A/B와 병렬 안전)
- G3는 판단 태스크 — 구현 강제 아님
- H2(Android)는 환경 제약으로 불가하면 `docs/benchmarks.md`에 블로커 기록으로 대체
- 시뮬레이터 벤치는 Metro 로그 판독이 가장 빠름 — 스크린샷 OCR은 실패하는 레시피
