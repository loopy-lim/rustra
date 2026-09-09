# Tauri Calculator 예시

rustra 패키지를 Tauri 2 데스크톱 애플리케이션에 통합하는 예시입니다.

## 개요

Rust 측 한 줄 등록과 생성된 TypeScript 진입점만으로 Tauri IPC와 event push를
연결합니다. 프런트엔드에는 engine 생성이나 `configure()`가 없습니다.

## 실행

```bash
# 프로덕션 빌드
bun run build

# 프론트엔드만 빌드
bun run build:frontend

# 런타임 스모크 테스트
bun run smoke

# 실제 숨은 WebView에서 generated API 3,000회 측정
bun run bench
```

### 핫코어 dev 모드 (실험적)

`tauri dev`를 다시 돌리지 않고도 Rust 핸들러 수정이 실행 중인 앱에 스왑됩니다.
브리지 크레이트는 `examples/calculator`이지만 dev 설정은 이 예시 전용
(`rustra.hot.json`)으로 둡니다 — 공유하는 calculator 설정이 기본 `native`
타깃을 유지해야 하기 때문입니다:

```bash
# 터미널 1 — 감시 + codegen + cdylib 빌드 + parity 게이트 + 게이트 발행
rustra dev --config rustra.hot.json

# 터미널 2 — 앱이 정적 링크 대신 게이트를 통과한 라이브 아티팩트를 로드하고 감시합니다.
# RUSTRA_HOT_CORE 경로는 rustra dev 가 출력하는 그대로를 쓰세요
# (이 워크스페이스 기준 target/debug/librustra_calculator_example-hot-live.dylib).
RUSTRA_HOT_CORE=../../target/debug/librustra_calculator_example-hot-live.dylib bunx tauri dev
```

스왑은 stderr로 구·신 컨트랙트 해시와 함께 보고됩니다. 동시에 웹뷰에는
`rustra://hot-core/swapped` 이벤트로도 푸시됩니다 — 성공은
`{ oldContractHash, newContractHash }`, 실패는 `{ error }`. `@rustra/tauri` 의
`subscribeHotSwap` 으로 구독합니다(이 예제는 `src/app.ts` 에 스왑 시각과 해시
앞 8자를 표시합니다). 페이로드에 구·신 해시가 함께 실리므로 이 이벤트가 JS 캐시
재동기화 신호를 대행합니다 — 별도의 스키마 세대 카운터는 두지 않습니다. 채널·
리소스 테이블은 스왑되는 코어 안에 살아 있으므로 스왑 뒤 재수립이 필요합니다.
`docs/plans/2026-09-09-native-hot-core-design.md` 참고.

자동화 스모크(`bun run smoke`)는 파이프라인을 headless로 검증합니다 — 핫 설정
해석, cdylib 빌드, 게이트 발행, 발행된 dylib을 실제 호스트가 열어 감시 스레드를
띄우는 부팅까지. 실제 스왑 이벤트는 재빌드된 아티팩트가 필요하므로 전체 스왑
루프는 위 두 터미널 조합으로 직접 확인하세요.

### iOS 시뮬레이터 핫코어 (2026-09-09 검증)

같은 핫 모드가 시뮬레이터 앱 안에서도 동작합니다. 레이아웃은 Tauri 2 모바일
표준 분리(`src/lib.rs` 가 `tauri::mobile_entry_point` 의 `run()` 보유,
`main.rs` 는 데스크톱 래퍼)라 이 예제에 `tauri ios init` / `android init` 이
그대로 먹힙니다:

```bash
# 1. 시뮬레이터용 앱 빌드 (`bunx tauri ios init` 이후)
bun run build:frontend
bunx tauri ios build --target aarch64-sim --debug

# 2. 설치 + 앱 컨테이너에 핫코어 아티팩트 스테이징
xcrun simctl install booted "src-tauri/gen/apple/build/arm64-sim/Rustra Tauri Calculator.app"
CONTAINER=$(xcrun simctl get_app_container booted dev.rustra.calculator data)
cp ../../target/aarch64-apple-ios-sim/release/librustra_calculator_example.dylib \
  "$CONTAINER/Documents/hot-core.dylib"

# 3. SIMCTL_CHILD_ 접두사 환경변수로 실행 (simctl 이 앱 프로세스에 전달)
SIMCTL_CHILD_RUSTRA_HOT_CORE="$CONTAINER/Documents/hot-core.dylib" \
  xcrun simctl launch --console-pty booted dev.rustra.calculator

# 4. 아티팩트 재빌드 뒤 컨테이너 경로로 원자적 rename 발행
#    (제자리 덮어쓰기 금지 — 매핑된 dylib 변조는 커널이 처단)
```

프로브(`examples/hot-core-probe`)가 확인한 시뮬레이터 사실: dlopen, 버전 카피,
감시 스왑 모두 시뮬레이터 안에서 동작하며 앱 내 재서명은 불필요합니다(macOS
전용 `codesign` 단계는 호스트 측 — 기기 안에서의 재서명은 존재하지 않음).
Android 에뮬레이터 동급 시퀀스는 shell 도메인과 앱 도메인(`untrusted_app`,
targetSdk 35) 양쪽 모두 통과 — 프로브 README 매트릭스 참고. iOS 실기기는
라이브러리 검증 때문에 스코프 외(설계 문서).

## 예시가 보여주는 것

1. **Tauri 연동** — `tauri_support::register(package, builder)`로 커맨드 자동 등록
2. **Zero config 프런트엔드** — `generated/tauri.ts`가 global invoke/event를 lazy 감지
3. **실제 화면 코드** — 명령 결과의 `result.value`를 DOM에 반영하고 event를 구독
4. **WebView 성능 영수증** — 실제 `rustra_dispatch` IPC를 warm-up 뒤 3회 반복

## 핵심 파일

| 파일                    | 설명                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `src-tauri/src/lib.rs`  | 앱 본체 — 등록 분기 + iOS/Android `mobile_entry_point`                 |
| `src-tauri/src/main.rs` | `run()` 을 호출하는 데스크톱 래퍼 (Tauri 2 모바일은 lib 타깃 필수)     |
| `src-tauri/Cargo.toml`  | lib/bin 분리(`staticlib`/`cdylib`/`rlib`) + `tauri`/`hot-core` feature |
| `src/app.ts`            | generated command와 event를 사용하는 화면                              |
| `rustra.hot.json`       | 핫코어(dylib) dev 루프용 설정                                          |
| `runtime-smoke.mjs`     | 자동화 런타임 스모크 테스트                                            |
| `src/benchmark.ts`      | 실제 WebView IPC 정확성·지연 측정                                      |
| `benchmark.mjs`         | 숨은 앱 실행 + 로컬 영수증 수집                                        |

## Rust 측 설정

```rust
use rustra::tauri_support;
use rustra_calculator_example::calculator_package;

let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

## TypeScript 측 사용

```ts
import { addNumbers, subscribeEvent } from '../calculator/generated/tauri.js';

await subscribeEvent('calc.tick', console.log);
const { value } = await addNumbers({ a: 20, b: 22 });
document.querySelector('output').value = String(value);
```

Tauri 설정은 `app.withGlobalTauri: true`, `rustra.json`은 `"tauri": {}`를 사용합니다.
global API를 의도적으로 끈 기존 앱만 `createTauriEngine({ invoke })`를 escape hatch로
사용합니다.

## 현재 실측

2026-08-24 macOS arm64 Release에서 generated WebView IPC는 평균 279.04µs, p50
300µs, 약 3,584 ops/s였습니다. WKWebView 타이머가 약 1ms 단위라 20회 배치의
호출당 값으로 percentile을 계산합니다. 이는 Tauri UI IPC 비용을 포함하므로 Rust
직접 호출이나 Node/Bun 네이티브 ABI 수치와 같은 경계가 아닙니다.

## 사전 요구사항

- Rust 툴체인
- Tauri CLI 2.0+ (`bun add -g @tauri-apps/cli`)
- `rustra-calculator-example` 패키지 (같은 워크스페이스 내)
