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
   감지해 스왑한다(stdout 으로 `PROBE SWAP` 보고)

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

성공 출력은 `PROBE SWAP <old> -> <new>` 라인(스왑 발생)과 `PROBE WATCH DONE
<hash>`(스왑된 코어가 계속 서비스)다.

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

| 파일          | 설명                                                |
| ------------- | --------------------------------------------------- |
| `src/main.rs` | 프로브 본체: 동기 검증 1–6, 감시 모드는 `run_watch` |
