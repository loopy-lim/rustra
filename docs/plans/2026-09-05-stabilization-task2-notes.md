# Stabilization 트랙 — Task 2 검증 노트 (2026-09-05)

- 대상: be5ff260 (feat/stabilization-unified) — CI01 수정(0887ef39 + be5ff260) 이후 3개 실패 CI 잡(`typescript`, `rn-ios`, `rn-android`)의 로컬 재현 경로 통과 증명
- 성격: 검증 전용 — 커밋 없음, 이 파일은 커밋 대상 아님
- 환경: macOS (Darwin 25.6.0), CocoaPods 1.17.0, Xcode 26.2 (17C52), bun 1.4.0, node v22.21.1, ruby (homebrew)

## Step 1 — bare fixture 전체 경로: PASS

작업 디렉터리: `examples/react-native-bare-calculator`

| 명령                                 | 결과 | 핵심 출력                                           |
| ------------------------------------ | ---- | --------------------------------------------------- |
| `bun install --frozen-lockfile`      | PASS | `2 packages installed`                              |
| `bun run codegen`                    | PASS | exit 0                                              |
| `bun run typecheck` (`tsc --noEmit`) | PASS | exit 0                                              |
| `bun run test:autolink`              | PASS | `bare React Native autolinking: iOS + Android PASS` |

멱등성 증명 (텍스트 출력은 per-file 메시지가 없어 JSON 모드로 관측):

- `bun ../../packages/cli/src/index.ts codegen --config rustra.json --format json` →
  `drift: False`, `written` 22건 전부 `(unchanged)` 접미어 (`all unchanged: True`)
- 전체 생성물 sha256 before/after 일치 (`HASHES IDENTICAL`) — 재실행 시 바이트 변화 0
- `git status --porcelain` 클린 (예시 디렉터리 내 diff churn 없음)

CI01 결함 소멸 직접 증거:

- `modules/rustra-bridge/package.json` 첫 줄 `{` — `//` 헤더 없음, `json.load` 유효
- `modules/rustra-bridge/RustraBridge.podspec` → `ruby -c` → `Syntax OK` (네이티브 `#` 주석)
- `test:autolink` 내부가 정확히 CI 경계와 동일 (`bunx --bun react-native config` → `JSON.parse`)이므로 이 스크립트 통과가 `typescript` 잡 실패 경로의 소멸 증명

## Step 2 — pod install 로컬 재현: PASS (완주)

작업 디렉터리: `examples/react-native-calculator` (macOS + CocoaPods 설치 확인됨 — skip 아님)

```
bun install --frozen-lockfile          # 2 packages installed
bunx expo prebuild --platform ios --no-install   # ✔ Finished prebuild
cd ios && pod install --project-directory=.      # exit 0
```

- pod install이 podspec 파싱 경계를 넘어 **끝까지 완주**: `Pod installation complete! There are 79 dependencies from the Podfile and 78 total pods installed.` (83초)
- 로그 전체에서 `SyntaxError` 0회 (`grep -c` = 0)
- rustra podspec 파싱+설치 증거: 로그 186–187행 `Installing RustraBridge (0.0.0)` / `Installing RustraCalculator (1.0.0)`, `[Expo] Enabling modular headers for pod RustraBridge`, `Auto-linking React Native modules ... NitroBench, NitroModules, and RustraBridge`
- 3개 podspec 모두 `ruby -c` Syntax OK (`modules/rustra-jsi/RustraBridge.podspec`, `modules/rustra-calculator/ios/RustraCalculator.podspec`, `modules/nitro-bench/nitro-bench/NitroBench.podspec`)
- 네트워크 단계(CDN pod fetch)도 통과 — "podspec 파싱만 통과" 수준이 아니라 완전한 로컬 재현 성공

## Step 3 — Android settings.gradle 경계: PASS

작업 디렉터리: `examples/react-native-calculator`

```
bunx expo prebuild --platform android --no-install   # ✔ Finished prebuild
```

- `android/settings.gradle` 확인: 29행 `ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)` — CI rn-android 실패 지점과 동일한 주입 경계. 상단 pluginManagement는 `node --print require.resolve(...)` 형태의 node 실행 2건 포함 (5행, 13행)
- 경계 증명: `bunx --bun react-native config` → exit 0, 출력 JSON 파싱 성공
  - `@rustra/generated-react-native`의 `platforms.ios.podspecPath` = true, `platforms.android.sourceDir` = true (양 플랫폼 autolink 인식)
  - 전체 dependencies 4개, parse error 없음 — 생성된 `package.json`(첫 줄 `{`)을 node가 정상 파싱
- 전체 gradle 빌드는 범위 밖(과다) — CI가 재검증

## 트리 청결

- `expo prebuild`가 만든 `ios/`, `android/`는 `examples/react-native-calculator/.gitignore`의 `/ios`, `/android` 규칙으로 gitignored — tracked 파일 더러워지지 않음 (`git status --porcelain` prebuild 전후 모두 클린)
- 작업 후 `ios/`, `android/` 디렉터리 직접 삭제 (시작 시 존재하지 않았으므로 원상 복구)
- 최종 `git status --porcelain` 클린 — 검증 과정의 추적 아티팩트 0

## CI push 후 재검증 필요 항목

- `typescript` 잡: 로컬 `test:autolink`가 동일 경계(`react-native config` → JSON.parse)를 검증하므로 소멸 예상
- `rn-ios` 잡: 로컬 pod install 완주로 podspec Ruby SyntaxError 소멸 확인 — CI는 xcodebuild 전체를 추가 검증
- `rn-android` 잡: JSON 경계만 로컬 증명 — CI가 gradle 설정 단계(`settings.gradle`의 node commandLine + rnConfigCommand 실행)를 최종 검증

## Task 1에서 확인된 기존 결함 (CI01과 무관, be5ff260 부모 커밋에서도 재현됨)

1. 온보딩 게이트가 published `@rustra/node@0.6.0` 기준 `contract.mismatch` drift 보고
2. RN 예시들에서 `RUSTRA_SCHEMA_OUT` 기반 `codegen --check` 실패
