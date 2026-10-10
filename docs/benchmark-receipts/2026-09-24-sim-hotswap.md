# 2026-09-24 — iOS 시뮬레이터 tauri-calculator 핫스왑 실측 (iPhone 17 / iOS 26.2)

`scripts/hot-swap-ios.sh --build` 전체 경로(프론트엔드 → tauri ios 앱 → 시뮬레이터 cdylib →
install → 컨테이너 스테이징 → `SIMCTL_CHILD_RUSTRA_HOT_CORE` launch)가 실기기 없이
부팅된 iPhone 17 시뮬레이터에서 종단 동작함을 확인하고, 핫스왑 교체(old/new contract
hash)를 두 계층에서 증명한 리시트.

- 스왑 유닛(교체 단위): `librustra_calculator_example.dylib`(기준 코어) →
  `librustra_hot_core_variant.dylib`(add-cmd 변형 — `multiplyNumbers` 추가로 스키마·계약
  해시 변화)
- 결론: **스왑 성공.** 프로브(`simctl spawn`) 관점에서 old/new contract hash 교체가
  관측되고, tauri 앱 프로세스 관점에서 새 코어(버전 카피 `hot-core-hot-1.dylib`)가
  UUID 일치로 매핑됨. 실패 없음.

## 환경

| 항목        | 값                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------- |
| 호스트      | macOS arm64, Xcode 26.2 (17C52)                                                                 |
| 시뮬레이터  | iPhone 17, iOS 26.2, UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC` (`xcrun simctl boot`으로 부트) |
| 앱          | `dev.rustra.calculator` (`examples/tauri-calculator`, aarch64-sim debug)                        |
| 핫코어      | `target/aarch64-apple-ios-sim/release/` (cargo release)                                         |
| bun 가드    | 세션에 `RUSTRA_BUN_LIBRARY` 미설정 — 그래도 모든 bun 경로를 `env -u RUSTRA_BUN_LIBRARY`로 실행  |
| 러스트 타깃 | `aarch64-apple-ios-sim` (rustup 설치됨)                                                         |

## 아티팩트 정체성

| 파일                                                                                   | sha256 (앞 16)     | UUID                                   | contract hash (앞 16)                               |
| -------------------------------------------------------------------------------------- | ------------------ | -------------------------------------- | --------------------------------------------------- |
| `librustra_calculator_example.dylib` (17:09 빌드, 스크립트가 스테이징)                 | `74426e86e7d0dcbd` | —                                      | 측정 안 함(아래 재빌드 바이트로 측정)               |
| `librustra_calculator_example-hot-live.dylib` (게이트 발행명, 위 바이트의 원자적 복사) | `74426e86e7d0dcbd` | `F2084113-D7F0-3474-BDA2-4E7E15E7880A` | —                                                   |
| `librustra_calculator_example.dylib` (17:17 재빌드, 프로브 측정분)                     | `bbd2c5db536030e1` | `3F69E653-C948-3D8B-ADEB-73E3E19396DF` | `e70c24c62944ff78` (64자 hex 전체는 아래 증거 로그) |
| `librustra_hot_core_variant.dylib` (add-cmd)                                           | `24519cd88c0ff871` | `A71E7995-959D-3193-817F-94B2FB6F4AD1` | `b0bf949c2ecf683b`                                  |

## 1) completion check — `bash scripts/hot-swap-ios.sh --build`

### 1차 실행: 실패 (환경 상태 — 잔여 빌드 산출물)

xcode `** BUILD SUCCEEDED **`까지는 통과했으나 tauri CLI의 마지막 앱 이동 단계에서
원문 에러:

```
failed to rename app /Users/loopy/dev/ll3/rustra-bridge/examples/tauri-calculator/src-tauri/gen/apple/build/rustra-tauri-calculator_iOS.xcarchive/Products/Applications/Rustra Tauri Calculator.app: Directory not empty (os error 66)
```

- 원인: `gen/apple/build/arm64-sim/Rustra Tauri Calculator.app`이 9월 9일 이전 실행의
  잔여 산출물로 존재. rename(2)은 목적지가 비어 있지 않은 디렉터리면 `ENOTEMPTY`
  (macOS os error 66)로 실패하며, tauri CLI는 목적지를 사전 청소하지 않는다.
- 분류: **스크립트(hot-swap-ios.sh) 로직 버그 아님 / 환경 부재도 아님 — 잔여 빌드
  산출물 상태 문제.** 재현: `gen/apple/build/arm64-sim`이 남은 상태에서
  `scripts/hot-swap-ios.sh --build`.
- 조치: `rm -rf .../gen/apple/build/arm64-sim`(재생성되는 빌드 산출물) 후 재실행.
  개선 제안으로 `--build` 시작 시 해당 출력 디렉터리 청소, 또는 실패 안내 메시지에
  이 케이스 명시를 기록해 둔다.

### 2차 실행: 성공 — 전 계약 단계 통과

`target/sim-hotswap/02-completion-check-retry.log` 전문. 핵심 라인:

```
hot-swap-ios: build 1/3 frontend
hot-swap-ios: build 2/3 tauri ios app (aarch64-sim, debug)
hot-swap-ios: build 3/3 simulator cdylib (aarch64-apple-ios-sim, release)
hot-swap-ios: artifact (plain cdylib; no gated -hot-live publish found): .../librustra_calculator_example.dylib
hot-swap-ios: simulator: 99B087B5-DEF6-4CF1-9177-81A5DE564CFC
hot-swap-ios: app data container: .../Application/6ACBBF1C-26AA-439B-8054-87F6B312C615
hot-swap-ios: staging hot-core (tmp copy + rename — never overwrite a mapped dylib in place)
hot-swap-ios: launching dev.rustra.calculator
  env SIMCTL_CHILD_RUSTRA_HOT_CORE=.../Documents/hot-core.dylib xcrun simctl launch --terminate-running-process ...
```

### 게이트 발행 `-hot-live` 경로 계약 준수 확인

`publishGatedArtifact`와 같은 원자적 절차(같은 디렉터리 tmp 복사 → rename)로
`librustra_calculator_example-hot-live.dylib`를 만든 뒤
`RUSTRA_HOT_IOS_SKIP_INSTALL=1 bash scripts/hot-swap-ios.sh` 재실행 — 스크립트가
게이트 발행 경로를 우선 선택함을 로그로 확인:

```
hot-swap-ios: artifact (gated -hot-live publish, dev-dylib.ts contract): .../librustra_calculator_example-hot-live.dylib
```

`packages/cli/src/dev-dylib.ts`의 `liveArtifactPath` 계약(stem + `-hot-live` + 확장자,
`target/<triple>/<profile>/`)과 일치. 폴백(plain cdylib) 동작도 1차 성공 실행에서
관측됨.

## 2) 스왑 증거 A — 프로브(`simctl spawn`) watch 관점: old/new contract hash

`examples/hot-core-probe --watch`는 tauri 앱과 동일한 `rustra::hot_core` 결합층
(DylibCore::open → sha256 폴링 감시 → `prepare_swap_copy` → swap)을 시뮬레이터
프로세스에서 구동한다. 감시 창(12 s) 도중 외부 발행자가 변형 dylib을 tmp+rename으로
발행했다. 재현 스크립트 `target/sim-hotswap/run-probe-watch.sh`, 원문 로그
`07-probe-watch-exitcode.log`:

```
PROBE CONTRACT e70c24c62944ff78fb6ca58b5658d85bb5cff49af4acc96b3a78bedcbdfb0a58
PROBE SWAP e70c24c62944ff78fb6ca58b5658d85bb5cff49af4acc96b3a78bedcbdfb0a58 -> b0bf949c2ecf683b540099697c51113a33b055b423a2e0cc961899ea89a9839d
PROBE WATCH DONE b0bf949c2ecf683b540099697c51113a33b055b423a2e0cc961899ea89a9839d
PROBE OBS addNumbers ok {"value":5}
PROBE OBS multiplyNumbers ok {"value":6}
PROBE OBS addNumbersV2 err command.not_found
```

- old `e70c24c6…` → new `b0bf949c…`: add-cmd 변형의 스키마 변화가 계약 해시 교체로
  관측됨.
- `PROBE OBS multiplyNumbers ok`: 스왑 **이후** 신규 명령이 실제 응답 — 디스패치가
  교체된 코어에 도달함을 데이터로 증명.
- `addNumbersV2 command.not_found`: rename-cmd 미활성으로 예상된 응답(음성 대조군).
- probe exit code `0`.

## 3) 스왑 증거 B — tauri 앱 프로세스 관점: 매핑 이미지 + UUID 교차검증

사전 확인: `RUSTRA_TAURI_PROBE_FILE`(run() 선두 분기)이 `42`를 기록하고 앱이 생존 —
`run()`의 핫 분기가 `RUSTRA_HOT_CORE` 환경에서 실행됨을 확인(에러 시 panic으로 종료됨).
`sample(1)`로 앱 프로세스(pid 82047)를 덤프:

발행 전(`11-sample-app.txt`) — 핫코어가 열려 있고 감시 스레드가 폴링 중:

```
Thread_7983996: rustra-hot-core-watch
  rustra::hot_core::watch::run_watch_loop ... hot_core_watch.rs:161
0x106000000 - 0x1062db427 +hot-core.dylib (0) <3F69E653-C948-3D8B-ADEB-73E3E19396DF> .../Documents/hot-core.dylib
```

17:25:13 변형 발행(컨테이너 `Documents/hot-core.dylib`에 tmp+rename) 5 초 후
(`12-sample-app-after-swap.txt`):

```
0x106000000 - 0x1062db427 +hot-core.dylib     (0) <3F69E653-C948-3D8B-ADEB-73E3E19396DF> .../Documents/hot-core.dylib
0x167800000 - 0x16790826f +hot-core-hot-1.dylib (0) <A71E7995-959D-3193-817F-94B2FB6F4AD1> .../Documents/hot-core-hot-1.dylib
```

- `hot-core-hot-1.dylib`는 감시 스레드가 만든 버전 카피(`prepare_swap_copy`의
  `<stem>-hot-<counter>` 명명)이며, 매핑 UUID `A71E7995…`가 **발행한 변형
  `librustra_hot_core_variant.dylib`의 UUID와 정확히 일치** — 앱 프로세스 안에서
  스왑이 실제로 일어났음의 구조적 증거.
- 구 코어(`3F69E653…`)가 여전히 매핑됨 — dlclose 없는 구 코어 생존 정책(design)과
  일치.
- 스왑 후 감시 스레드는 `run_watch_loop` → `nanosleep`(100 ms 폴링)로 복귀, 앱 생존
  유지. 발행→매핑 관측 상한 ≈ 5 s(폴링 100 ms + 샘플 타이밍; 정밀 지연 측정 아님).

## 4) 17:30 재실행 — completion check 재현성·교차검증 폐쇄

이전 세션 종료 후 `bash scripts/hot-swap-ios.sh --build` 재실행이 동일 실패로
끝나는지 확인하고(루프 체크 exit 1), 원인 제거 후 재통과시켰다.

- **재실행 1차: 실패 재현** (`13-rerun-check-first.log`) — xcode `** BUILD SUCCEEDED **`
  후 동일 원문: `failed to rename app .../Rustra Tauri Calculator.app: Directory not
empty (os error 66)`. 원인은 2차 성공 실행이 남긴 `arm64-sim/Rustra Tauri
Calculator.app` 잔여물 — 즉 **이 실패는 성공 직후 재실행마다 결정적으로 재현된다**
  (`--build`가 출력 디렉터리를 청소하지 않는 비멱등성). 분류 재확인: 스크립트 로직
  버그 아님 / 환경 부재 아님 / 잔여 빌드 산출물 상태.
- **재실행 2차: 성공** (`14-rerun-check-success.log`, exit 0) — `rm -rf
.../gen/apple/build/arm64-sim` 후 전 단계 통과. 이번 실행은 게이트 발행 경로를
  선택: `artifact (gated -hot-live publish, dev-dylib.ts contract):
.../librustra_calculator_example-hot-live.dylib` → install → tmp+rename 스테이징 →
  `SIMCTL_CHILD_RUSTRA_HOT_CORE` launch.
- **프로브 watch 재증거** (`14-rerun-probe-watch.log`, `15-rerun-probe-watch-runner.log`,
  exit 0) — `PROBE SWAP e70c24c6… -> b0bf949c…` + 스왑 후 `PROBE OBS multiplyNumbers
ok {"value":6}` + 음성 대조 `addNumbersV2 err command.not_found` 재현 동일.
- **앱 레벨 UUID 교차검증 폐쇄** (`16-rerun-sample-app.txt`, `17-rerun-sample-app-after-swap.txt`)
  — 체크가 스테이징한 게이트 아티팩트의 UUID `F2084113-D7F0-3474-BDA2-4E7E15E7880A`
  (dwarfdump)가 앱 프로세스에 매핑된 `hot-core.dylib`의 UUID와 정확히 일치(스테이징
  바이트 = 매핑 이미지). 17:31:31 변형 발행 6 s 후 동일 pid 94385 생존 +
  `hot-core-hot-1.dylib <A71E7995-959D-3193-817F-94B2FB6F4AD1>` 매핑 = 변형
  `librustra_hot_core_variant.dylib`의 dwarfdump UUID와 일치. 구 코어(`F2084113…`)
  잔존 매핑·감시 스레드 `run_watch_loop` 동작도 확인.
- 체크가 다시 통과할 수 있는 상태로 마무리: 검증 재실행이 남긴 `arm64-sim` 잔여물을
  제거(런북 1단계 `rm -rf`와 동일 조치). 재실행 전 이 청소가 없으면 위 1차 실패가
  다시 난다.

## 관측 한계 (정직 기록)

- **앱 프로세스 stderr(eprintln 스왑 배너)가 이 세션의 어떤 경로로도 잡히지 않았다**:
  `simctl launch --console`(백그라운드 파이프), `--console-pty`(`script(1)` 랩),
  `--stdout=/--stderr=` 파일 리다이렉트, unified log(`log show`, `--private`) 모두
  0 바이트/무관련. run() 실행·핫 분기 진입·감시 스레드 동작 자체는 위 프로브 파일과
  sample 덤프로 증명되므로, 이는 관측 채널 한계이지 핫스왑 동작 실패가 아니다.
  앱 내 보고 채널인 웹뷰 이벤트(`rustra://hot-core/swapped` → `src/app.ts` UI 표시)는
  사람 눈/스크린샷 판독이 필요해 이 세션에서 기계 검증하지 못했다.
- 첫 `--build` 실패(위 1차 실행)는 잔여 산출물 문제로 재실행으로 해결 — 스크립트
  버그 아님. 단 스크립트가 목적지를 청소하지 않는 점은 개선 여지이며, **성공한
  `--build` 직후 재실행 시에도 동일 실패가 결정적으로 재현됨**(4절 재실행 1차) —
  실행 전 `rm -rf .../gen/apple/build/arm64-sim` 또는 스크립트 내 청소가 필요하다.
- `tauri ios build` 산출 앱은 debug 프로필(스크립트 계약대로). release 앱 벤치는
  이 리시트 범위 밖.

## 증거 파일

| 경로 (`target/sim-hotswap/`)                                    | 내용                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `01-completion-check-build.log`                                 | 1차 `--build`: xcode 성공 후 rename 실패 원문                                           |
| `02-completion-check-retry.log`                                 | 2차 `--build`: 전 단계 성공 전문                                                        |
| `03-gated-artifact-contract.log`                                | `-hot-live` 게이트 발행 경로 계약 확인 실행                                             |
| `04-console-baseline.log`, `09/10-app-std*.log`                 | 앱 stderr 캡처 시도들(launch ack만/빈 — 한계 기록; pty 랩 시도는 세션 로그에 원문 보존) |
| `06-probe-watch.log`, `07-probe-watch-exitcode.log`             | 프로브 watch 스왑 원문(해시 교체·OBS)                                                   |
| `run-probe-watch.sh`                                            | 프로브 watch 재현 스크립트(exit code 포함)                                              |
| `11-sample-app.txt`                                             | 발행 전 앱 sample: 핫코어 매핑 + 감시 스레드                                            |
| `12-sample-app-after-swap.txt`                                  | 발행 후 앱 sample: `hot-core-hot-1.dylib <A71E7995…>` 매핑                              |
| `05-screenshot.png`                                             | 시뮬레이터 스크린샷(참고용)                                                             |
| `13-rerun-check-first.log`                                      | 17:30 재실행 1차: 성공 후 재실행 ENOTEMPTY 재현 원문                                    |
| `14-rerun-check-success.log`                                    | 17:30 재실행 2차: 청소 후 전 단계 성공(gated -hot-live 선택)                            |
| `14-rerun-probe-watch.log`, `15-rerun-probe-watch-runner.log`   | 재실행 프로브 watch: 해시 교체·OBS·exit 0                                               |
| `16-rerun-sample-app.txt`, `17-rerun-sample-app-after-swap.txt` | 재실행 앱 sample: 발행 전/후 매핑, UUID `F2084113…`·`A71E7995…` 교차검증                |

## 재현 런북

```bash
UDID=99B087B5-DEF6-4CF1-9177-81A5DE564CFC   # iPhone 17, iOS 26.2
xcrun simctl boot $UDID && xcrun simctl bootstatus $UDID -b

# 1. 전체 빌드 + 설치 + 스테이징 + 핫코어 런치 (bun 가드 포함)
rm -rf examples/tauri-calculator/src-tauri/gen/apple/build/arm64-sim   # 잔여 산출물 클리어(있으면)
env -u RUSTRA_BUN_LIBRARY bash scripts/hot-swap-ios.sh --build

# 2. 스왑 유닛 빌드: add-cmd 변형 + 프로브 (시뮬레이터 타깃)
cargo build --release --target aarch64-apple-ios-sim \
  -p rustra-hot-core-probe -p rustra-calculator-example
cargo build --release --target aarch64-apple-ios-sim \
  --manifest-path examples/hot-core-variant/Cargo.toml --lib --features add-cmd

# 3. 프로브 watch 스왑 (PROBE SWAP old -> new 해시 관측, exit 0)
bash target/sim-hotswap/run-probe-watch.sh 12

# 4. 앱 레벨 스왑 (발행 후 sample 로 hot-core-hot-1.dylib 매핑·UUID 확인)
CONTAINER="$(xcrun simctl get_app_container $UDID dev.rustra.calculator data)"
cp target/aarch64-apple-ios-sim/release/librustra_hot_core_variant.dylib \
   "$CONTAINER/Documents/.publish.tmp"
mv -f "$CONTAINER/Documents/.publish.tmp" "$CONTAINER/Documents/hot-core.dylib"
sleep 5 && sample "$(pgrep -f 'Rustra Tauri Calculator.app/Rustra')" 2 \
  -file /tmp/app-after-swap.txt && grep hot-core /tmp/app-after-swap.txt
```
