[English](./README.md) | 한국어

# hot-core 프로브

실험적 [`hot-core`](../../docs/plans/2026-09-09-native-hot-core-design.md)
표면을 **Rust 바이너리를 실행할 수 있는 모든 프로세스** — macOS 호스트, iOS
시뮬레이터(`simctl spawn`), Android 에뮬레이터(`adb shell`) — 안에서 엔드투엔드로
밟아보는 단독 검증 바이너리다. 호스트 앱의 핫 모드(`examples/tauri-calculator`)가
수행하는 것과 같은 시퀀스를, 호스트 앱 띄우기가 번거로운 타깃에서 관측 가능하고
종료 코드로 단정 가능하게 만든다.

## 검증 항목

1. `DylibCore::open` — dlopen → `rustra_mobile_init` → 심볼 바인딩
2. JSON 디스패치 왕복(`addNumbers`) + 미지 명령 에러 재분할
3. 계약 해시 조회(SHA-256 hex, 64자)
4. 버전 스왑 카피(`prepare_swap_copy`) → 카피 open → 동일 해시
5. `HotCoreHandle::swap` — 새 호출은 새 코어로 향한다
6. 구 코어 생존 — dlclose 없음, 스왑으로 밀려난 코어도 계속 호출 가능
7. `--watch N` — sha256 폴링 감시 스레드가 외부 발행자의 아티팩트 바이트 교체를
   감지해 스왑하고(stdout 으로 `PROBE SWAP` 보고), 감시 종료 뒤 스왑된 코어에
   고정 커맨드 목록을 invoke 해 그 와이어를 그대로 보고한다(`PROBE OBS`)

## 사용법

```bash
# 타깃별 프로브 + 스왑 단위 cdylib 빌드
cargo build --release -p rustra-hot-core-probe -p rustra-calculator-example
# iOS 시뮬레이터
cargo build --release --target aarch64-apple-ios-sim \
  -p rustra-hot-core-probe -p rustra-calculator-example
# Android (arm64 에뮬레이터), cargo-ndk
cargo ndk -t arm64-v8a build --release \
  -p rustra-hot-core-probe -p rustra-calculator-example

# macOS 호스트
./target/release/rustra-hot-core-probe \
  ./target/release/librustra_calculator_example.dylib

# iOS 시뮬레이터(부팅된 기기 UDID, 절대 경로)
xcrun simctl spawn <UDID> \
  target/aarch64-apple-ios-sim/release/rustra-hot-core-probe \
  target/aarch64-apple-ios-sim/release/librustra_calculator_example.dylib

# Android 에뮬레이터(shell 도메인)
adb push target/aarch64-linux-android/release/rustra-hot-core-probe /data/local/tmp/
adb push target/aarch64-linux-android/release/librustra_calculator_example.so /data/local/tmp/
adb shell chmod 755 /data/local/tmp/rustra-hot-core-probe
adb shell /data/local/tmp/rustra-hot-core-probe /data/local/tmp/librustra_calculator_example.so
```

종료 코드 `0` + `PROBE PASS` 가 전 단계 통과다. 실패 단계는 `PROBE FAIL
step=<이름>` 을 출력하고 exit `1` 로 끝난다.

### 감시 모드

```bash
rustra-hot-core-probe <artifact> --watch 10
```

프로브는 아티팩트를 열고 감시 스레드를 띄운 뒤 10초간 폴링한다. 그 사이 외부
발행자가 아티팩트 바이트를 교체한다. 발행자 계약: **제자리 쓰기 금지, 반드시
원자적 rename 으로 교체** — 프로세스가 매핑한 dylib 파일을 덮어쓰면 그 자체가
파손이다(macOS/iOS 는 `SIGKILL`, Android 는 `SIGSEGV`). 이는 CLI 계약과 같은
맥락이다 — `rustra dev` 는 게이트 통과 `-hot-live` 아티팩트를 tmp 파일 + rename
으로 발행해 살아있는 매핑의 기존 inode 를 보존한다.

동기 모드와 달리 감시 모드는 값 단정(`addNumbers(2,3) == 5` 등)을 하지 않는다:
시작 아티팩트는 시나리오의 스왑 유닛이고 그 `addNumbers` 의미는 feature 조합마다
달라질 수 있기 때문이다(스왑 유닛은 `examples/hot-core-variant` — cargo
feature 조합이 곧 시나리오다). 단정하는 것은 초기/최종 계약 해시가 64자 SHA-256
hex 라는 것까지다.

출력 계약:

```
PROBE CONTRACT <해시>            # 연 아티팩트의 기준 해시
PROBE SWAP <old> -> <new>        # 적용된 스왑마다 1행(감시 스레드)
PROBE SWAP FAILED <error>        # 거부/실패한 스왑 시도
PROBE WATCH DONE <해시>          # 스왑된 코어가 계속 서비스
PROBE OBS <명령> ok <json>       # 관측 단계, 성공 와이어
PROBE OBS <명령> err <코드>      # 관측 단계, 에러 와이어(코드만)
```

관측 단계는 고정 목록 `addNumbers`, `multiplyNumbers`, `addNumbersV2`(공통
인자 `{"a":2,"b":3}`)를 스왑 뒤 코어에 invoke 하고 그 와이어를 그대로
보고한다. hard assert 는 없다 — 시나리오에 따라 어느 쪽이든 정답이 될 수
있기 때문이다(rename 스왑 뒤 `addNumbers` 의 `command.not_found` 가 곧 통과
조건인 식).

#### 스왑 시나리오 (`examples/hot-core-variant`)

```bash
# 시나리오별 스왑 유닛을 빌드해 스테이징하고, rename 으로 발행한다:
cargo build --release -p rustra-hot-core-variant                    # 기본
cargo build --release -p rustra-hot-core-variant --features behavior
cp target/release/librustra_hot_core_variant.dylib publish.tmp.dylib
mv -f publish.tmp.dylib /path/to/live.dylib
```

macOS arm64 실측(2026-09-09) — 각 시나리오는 feature 하나의 변화 + 감시 중
원자적 rename 1회다:

| 시나리오          | feature 변화                    | 계약 해시 | 관측(`PROBE OBS`)                                                            |
| ----------------- | ------------------------------- | --------- | ---------------------------------------------------------------------------- |
| 1. 로직만 변경    | 기본 → `behavior`               | 불변      | `addNumbers ok {"value":105}` (이전 `5`) — 해시가 그대로인데 데이터가 변했다 |
| 2. 명령 추가      | → `add-cmd behavior`            | 변함      | `multiplyNumbers ok {"value":6}`                                             |
| 3. 명령 이름 변경 | → `rename-cmd add-cmd behavior` | 변함      | `addNumbers err command.not_found` + `addNumbersV2 ok {"value":105}`         |
| 4. 시그니처 변화  | → `sig-change behavior`         | 변함      | `addNumbers err command.invalid_args` (`{a,b}` 호출에 `c` 가 없다)           |

## 검증 매트릭스 (2026-09-09)

| 타깃                                                 | dlopen + 디스패치 | 버전 카피 + 스왑                | 감시 스왑 | 비고                        |
| ---------------------------------------------------- | ----------------- | ------------------------------- | --------- | --------------------------- |
| macOS arm64 (호스트)                                 | ✅                | ✅                              | ✅        | ad-hoc 재서명 경로          |
| iOS 시뮬레이터 (aarch64-apple-ios-sim, iOS 26.2)     | ✅                | ✅                              | ✅        | 앱 내 codesign 불필요       |
| Android 에뮬레이터 (aarch64-linux-android, API 36.1) | ✅                | ✅                              | ✅        | shell 도메인                |
| Android 앱 도메인 (`untrusted_app`, targetSdk 35)    | ✅                | ✅ (duplicate SONAME 동시 로드) | —         | `filesDir` 의 `System.load` |

Android 앱 도메인 행이 Phase 3의 전제가 실제로 성립함을 보여준다 — 앱은
자신에게 복사된 `app_data_file` 을 dlopen 할 수 있고, 첫 로드와 함께 두 번째
버전 카피를 동시에 로드할 수도 있다(bionic 은 경로 기준 로드라 버전 카피의
공유 SONAME 이 충돌하지 않는다).

iOS 실기기는 설계상 스코프 외다(라이브러리 검증 상시 — 설계 문서 참고).

## 주요 파일

| 파일          | 설명                                                           |
| ------------- | -------------------------------------------------------------- |
| `src/main.rs` | 프로브 본체: 동기 검증 1–7, 감시 모드는 `run_watch`(스왑+관측) |
