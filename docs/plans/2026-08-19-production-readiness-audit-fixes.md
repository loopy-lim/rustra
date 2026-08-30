# Production-Readiness 감사 후속 8개 항목 구현 계획

## 개요

감사 판정 No-Go의 사유 6개(배포 차단 4 + 인프라 2)와 권장 처리 순서 8단계를 7개 Phase로
정리해 순차 실행한다. 사용자 결정사항: nitro-bench는 codegenConfig 추가, Windows는
experimental 명시, Android 실기기 테스트는 이번엔 제외(빌드까지만), npm/crates 실제
발행은 준비까지만(별도 승인).

## 현재 상태 분석

### 주요 발견사항:

- **RN Android Rust 미연결**: `examples/react-native-calculator/modules/rustra-jsi/android/build.gradle`
  에 Rust 빌드를 트리거하는 Gradle 훅이 전혀 없음. `.a` 파일이 `src/main/cpp/libs/<ABI>/`에
  사전 존재해야 CMake 구성이 통과함. iOS는 podspec `prepare_command`가 자동 실행 — 비대칭.
- **DEX 중복(NativeAccessibilityInfoSpec)의 범인은 nitro-bench**: `modules/nitro-bench/nitro-bench/package.json`
  에 `codegenConfig`가 없어 코어 RN 스펙 ~70개가 `com.facebook.fbreact.specs`로 재생성되어
  `react-android` AAR과 충돌. `react-native-nitro-modules`는 `codegenConfig` +
  `android.javaPackageName: "com.margelo.nitro"`로 회피하는 선례 (`node_modules/react-native-nitro-modules/package.json:85-91`).
  rustra-jsi는 codegen을 만들지 않으므로 무관.
- **cargo audit 6건의 실범위**: `crates/rustra` 핵심은 rkyv crate에 의존하지 않음
  (serde_json 기반 수동 rkyv V2 구현). rkyv 0.8.16 직접 의존은 `examples/calculator/Cargo.toml:19`
  (RN 네이티브 경로)과 `runner/template/backend/Cargo.toml:26`뿐. runner template은 이미
  0.8.18로 풀림 → 루트 lock도 `cargo update -p rkyv`로 상승 가능. quick-xml 0.39.4는
  tauri 경유 transitive, crossbeam-epoch 0.9.18은 criterion dev-dep. lockfile은
  루트/runner backend/runner desktop/fuzz 4개.
- **test:compat "Node 통과/Bun 실패"의 구조적 원인**: `test:ts:node`(package.json:14)는 5개
  파일만, `test:ts:bun`(package.json:17)은 glob 7개 전부 실행. `transport-bench.test.ts`의
  subprocess 테스트 3개(:92, :98, :134)는 Bun에서만 돈다. 후보: (a) Bun `spawnSync`
  input/encoding 반환 차이(:49-54), (b) 10ms 지연 임계 초과(:24, :108), (c) `createRequire`
  `.node` 로드(:62-67).
- **버전**: 배포 패키지 10개 전부 0.1.2(이미 발행됨), `.changeset/` 존재하나 대기 changeset
  없음. `@rustra/react` 0.1.2는 미발행 신규. main이 origin/main보다 21 커밋 앞섬.
- **CI**: ci.yml은 debug 테스트+release 빌드(+typescript 잡)만. release.yml의
  `cargo-publish` 잡이 `workflow_dispatch`에서만 돌지만 `release`(npm) 잡도
  `workflow_dispatch` 조건이 있어 수동 우회 가능.

## 목표 상태

- `cd examples/react-native-calculator && ./gradlew assembleRelease`가 Rust 빌드부터 포함해
  클린 체크아웃에서 성공 (실기기 왕복 테스트는 사용자 기기 연결 시 별도 수행)
- `cargo audit` 루트 lockfile 0 취약점 (unmaintained/unsound 경고는 문서화만)
- `npm run test:compat` 완전 통과
- changeset 작성 완료로 `changeset version`이 0.1.3을 만들 수 있는 상태
- CI가 release 테스트 + cargo audit + test:compat + RN 빌드를 검증
- Windows 지원 범위가 experimental로 문서 명시
- PR 업로드 후 원격 CI green

## 범위 제한 (하지 않을 것)

- Android 실기기/에뮬레이터 JSI 왕복 테스트 (사용자가 기기를 연결할 때 별도)
- npm/crates 실제 발행 및 canary 배포 실행 (별도 승인)
- Windows PE 심볼 해석 등 런타임 검증 구현
- rkyv crate를 핵심 의존성에서 제거하는 리팩터링 (이미 제거되어 있음 — examples만 사용)
- CHANGELOG.md 수동 포맷을 changesets로 완전 이관 (정합 확인만)

## 구현 접근 방식

각 Phase를 plan → implement → 검증 순으로 진행, Phase별 커밋. 감사 항목 매핑:
Phase 1→감사 1+2, Phase 2→감사 3, Phase 3→감사 4, Phase 4→감사 5, Phase 5→감사 6,
Phase 6→감사 7, Phase 7→감사 8.

---

## Phase 1: RN Android 네이티브 빌드 수정

### 개요

Gradle이 Rust 정적 라이브러리를 자동 빌드하게 연결하고 DEX 중복을 제거해
Release APK가 클린 체크아웃에서 빌드되게 한다.

### 필요한 변경사항:

#### 1. rustra-jsi Gradle Rust 빌드 훅

**파일**: `examples/react-native-calculator/modules/rustra-jsi/android/build.gradle`
**변경사항**: `preBuild` 태스크가 `build-rust-android.sh`를 실행하도록 추가. 캐시:
`src/main/cpp/libs/<ABI>/librustra_calculator_example.a`가 최신이면 스킵(Gradle 입력/출력
또는 타임스탬프 체크). `RUSTRA_PROFILE`은 buildType에 따라 debug/release 매핑.

#### 2. nitro-bench codegenConfig 추가

**파일**: `examples/react-native-calculator/modules/nitro-bench/nitro-bench/package.json`
**변경사항**:

```json
"codegenConfig": {
  "name": "NitroBenchSpec",
  "type": "modules",
  "jsSrcsDir": "./src",
  "android": { "javaPackageName": "com.margelo.nitro.nitrobench" }
}
```

이름은 nitro 관례(`NitroModulesSpec`)를 따름. `jsSrcsDir: ./src`에 Flow/TS 스펙 파일이
있어야 codegen이 그 스펙만 생성 — 코어 스펙 재생성이 사라져 충돌 해소.

#### 3. 검증

```bash
cd examples/react-native-calculator/android && ./gradlew :rustra-jsi:externalNativeBuildRelease
./gradlew assembleRelease
```

### 성공 기준:

#### 자동 검증:

- [ ] nitro-bench codegen 출력에 코어 스펙(`NativeAccessibilityInfoSpec` 등)이 더 이상
      `com.facebook.fbreact.specs`로 생성되지 않음
- [ ] `./gradlew assembleRelease` 성공 (libs/\*.a 삭제 후 재시도 → Rust 자동 빌드 확인)
- [ ] RN iOS 빌드 회귀 없음: 기존 검증 스크립트 통과

#### 수동 검증:

- [ ] 생성된 APK 파일 존재 확인 (`app/build/outputs/apk/release/`)
- [ ] 실기기 JSI 왕복 테스트 — 사용자 기기 연결 시 별도 수행

---

## Phase 2: 보안 의존성 정리 + cargo audit CI

### 개요

cargo audit 6건 취약점을 해소(또는 범위 밖임을 문서화)하고 audit을 CI 게이트로 추가.

### 필요한 변경사항:

#### 1. rkyv 업데이트

루트 lock: `cargo update -p rkyv` → 0.8.18 (RUSTSEC 3건 해소 확인).

#### 2. quick-xml / crossbeam-epoch

- quick-xml 0.39.4는 tauri 경유 transitive — `cargo update -p quick-xml`로 0.41.x 상승
  시도, 상승 불가 시 tauri 버전 상황 문서화
- crossbeam-epoch 0.9.18은 criterion dev-dep — bench 전용 경로임을 문서화하고 가능하면 업데이트

#### 3. lockfile 4개 감사

루트/runner template backend/desktop/fuzz 각각 `cargo audit` 실행, 결과 기록.

#### 4. CI cargo audit 잡

**파일**: `.github/workflows/ci.yml`
**변경사항**: ubuntu 잡에서 `cargo audit` 실행 (rustsec/audit-check 또는 cargo install).
취약점 0이 게이트. 나중에 무시가 필요하면 `.cargo/audit.toml` 도입.

### 성공 기준:

#### 자동 검증:

- [ ] `cargo audit` (루트) 취약점 0
- [ ] `cargo test --workspace --exclude rustra-lynx-tauri-spike` 회귀 없음
- [ ] `cargo clippy --all-targets -- -D warnings` 통과
- [ ] runner template lockfile 2개 audit 결과 기록 (0 취약점 확인)

#### 수동 검증:

- [ ] unmaintained 18/unsound 2 경고 항목 검토 및 문서화 (무시 여부는 별도 결정)

---

## Phase 3: test:compat 완전 통과

### 개요

Bun 전용 subprocess 테스트 3개의 실패 원인을 규명해 `npm run test:compat`을 완전 통과시킨다.

### 필요한 변경사항:

#### 1. 실패 재현·규명 (systematic-debugging)

```bash
cargo build -p rustra-calculator-example -q && bun test examples/calculator/ts/transport-bench.test.ts
```

실패 메시지로 원인 판별: (a) spawnSync 반환 차이 → 인코딩 정규화, (b) 지연 임계 초과 →
임계/반복 조정은 성능 저하 왜곡 방지를 위해 최후, (c) createRequire → napi 경로 해결.

#### 2. 수정

원인에 따라 `transport-bench.test.ts` 수정. Node에서도 동일 경로가 돌도록 test:ts:node
실행 목록에 추가하는 방향도 병행 검토.

### 성공 기준:

#### 자동 검증:

- [ ] `bun test examples/calculator/ts/transport-bench.test.ts` 통과
- [ ] `npm run test:compat` 전체 통과
- [ ] `npm run test:ts:node` 회귀 없음

#### 수동 검증:

- [ ] 벤치마크 출력(avg/p50/p99)이 Node와 Bun에서 모두 합리적 범위 (출력 로그 확인)

---

## Phase 4: changeset + 0.1.3 버전 준비

### 개요

21 커밋 + 이번 작업분을 changeset으로 정리해 `changeset version`이 0.1.3을 만들게 한다.

### 필요한 변경사항:

#### 1. changeset 작성

`.changeset/`에 파일 추가. minor 버전(0.1.x → 0.1.3, semver pre-1.0 minor)로:

- `@rustra/types`, `@rustra/node`, `@rustra/bun`, `@rustra/tauri`,
  `@rustra/react-native`, `@rustra/lynx` — minor: JSI fast path 최적화 4종
- `@rustra/react` — 신규 공개 (첫 발행)
- `@rustra/cli`, `@rustra/testing`, `@rustra/devtools` — minor: dev/testing 트랙 내용
- CHANGELOG.md "Unreleased" 섹션과 내용 정합

#### 2. 버전 상태 확인

버전은 changesets가 `changeset version` 시점에 일괄 올림 — 이 Phase에서는 changeset
파일만 작성 (패키지 버전 필드는 건드리지 않음).

### 성공 기준:

#### 자동 검증:

- [ ] `npx changeset status`에서 모든 패키지가 버전업 대상으로 표시
- [ ] `npx changeset version --snapshot` dry-run 동작 (실제 버전 필드 변경 없이 확인)

#### 수동 검증:

- [ ] changeset 내용이 CHANGELOG.md Unreleased 및 21 커밋 log와 정합
- [ ] @rustra/react가 첫 발행 대상에 포함됨

---

## Phase 5: CI 강화

### 개요

ci.yml에 release 테스트·audit·test:compat·RN 빌드·consumer smoke을 추가하고
release.yml의 수동 우회를 막는다.

### 필요한 변경사항:

#### 1. ci.yml 확장

- rust 잡: Linux leg에 `cargo test --release` 추가
- 신규 `rust-audit` 잡: cargo audit (Phase 2와 연동)
- typescript 잡: `npm run test:compat` 추가
- 신규 `rn-ios` 잡: RN 예제 iOS Release 빌드 (macos runner)
- 신규 `rn-android` 잡: RN 예제 Android Release 빌드 (ubuntu + Android SDK, NDK/cargo-ndk)
- 신규 `consumer-smoke` 잡: npm pack → 임시 디렉터리에서 설치 → smoke 스크립트

#### 2. release.yml 우회 게이트

`release` 잡의 `workflow_dispatch` 조건 제거(또는 CI green인 SHA 확인 로직 추가)해
CI를 통과하지 않은 커밋의 발행을 막는다.

### 성공 기준:

#### 자동 검증:

- [ ] 워크플로우 구문 유효: `act` 없이 actionlint 또는 gh api로 검증
- [ ] PR에서 강화 CI가 실제 green (Phase 7에서 확인)

#### 수동 검증:

- [ ] CI 실행 시간이 허용 범위인지 확인 (매트릭스/캐시 전략 점검)
- [ ] release.yml 수동 실행이 CI 게이트를 우회하지 못함을 로직으로 확인

---

## Phase 6: Windows 실험 단계 명시

### 개요

Windows 지원 범위를 experimental로 문서에 명시한다.

### 필요한 변경사항:

#### 1. README/docs 업데이트

- README.md 플랫폼 지원 표/섹션에 Windows = Experimental (Runtime 검증 전, FML PE 심볼
  해석 미구현) 명시
- windows-experiment.yml 상단 주석 유지 + 관련 docs 페이지가 experimental임을 강조

### 성공 기준:

#### 자동 검증:

- [ ] 문서 빌드/마크다운 린트 회귀 없음 (해당 시)

#### 수동 검증:

- [ ] README에서 Windows 상태가 한눈에 확인됨

---

## Phase 7: PR 생성 + 원격 CI 통과

### 개요

21 커밋 + 이번 작업분을 PR로 올려 원격 CI green을 확보한다.

### 필요한 변경사항:

#### 1. 브랜치/PR

- 작업 브랜치 생성 (feat/production-audit-fixes), Phase 1~6 커밋 push
- `gh pr create` — 감사 항목 8개 매핑과 검증 결과 요약
- 원격 CI green 확인, 실패 시 수정

#### 2. canary 절차 문서화

canary/rollback 절차를 docs에 문서화 (실행은 별도 승인).

### 성공 기준:

#### 자동 검증:

- [ ] PR 생성 및 CI green
- [ ] merge 후 workflow_run 기반 release가 정상 대기하는지 확인

#### 수동 검증:

- [ ] PR 본문에 감사 8개 항목별 처리 결과 정리
- [ ] canary/rollback 문서 검토

---

## 테스트 전략

- Phase 1: gradle 빌드 성공 + codegen 출력물 검사 (자동)
- Phase 2: cargo audit + 테스트 회귀 (자동)
- Phase 3: bun test 재현 → 수정 → test:compat 전체 (자동)
- Phase 4: changeset status (자동) + CHANGELOG 정합 (수동)
- Phase 5: actionlint + PR CI (자동)
- Phase 6: 문서 검토 (수동)
- Phase 7: 원격 CI green (자동)

## 성능 고려사항

- Rust Gradle 훅은 증분 빌드 캐시 필수 (매 빌드 cargo 재실행 방지)
- CI 신규 잡(rn-ios/rn-android)은 캐시 없이 15~25분 예상 — 타임아웃과 캐시 전략 점검
- transport-bench 임계값 수정은 최후 수단 (성능 왜곡 방지)

## 마이그레이션 참고사항

- rkyv 0.8.16→0.8.18은 패치 수준(세부는 CHANGELOG 확인) — API 호환 예상
- quick-xml은 tauri가 버전 범위를 못 올리는 경우 문서화로 대체 가능

## 참고 자료

- 감사 문서: 이 대화의 사용자 메시지 (No-Go 판정 6사유 + 권장 8단계)
- nitro codegenConfig 선례: `node_modules/react-native-nitro-modules/package.json:85-91`
- iOS podspec 자동 빌드 선례: `modules/rustra-jsi/ios/RustraJSI.podspec:11`
- Rust 정적 라이브러리 소비: `modules/rustra-jsi/android/CMakeLists.txt:14-17`
