# 2026-10-13 FFI 안전성 계약과 실행 검증

기준 HEAD는 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6`다. 아래 결과는
수정 중인 로컬 소스의 검증이며, 원격 CI·릴리스·RN 실기기 수용 결과가 아니다.
커밋·푸시·발행은 수행하지 않았다.

## 계약과 구현

- [안전 계약](../../safety-contract.ko.md)과
  [ADR 0004](../../adr/0004-ffi-safety-preconditions.ko.md)는 악성 **바이트** 검증과
  raw pointer의 유효 범위·정렬·수명·동시 접근·해제 페어링 전제를 구분한다.
  release에서 임의 포인터나 double-free를 안전하게 복구한다고 보장하지 않는다.
- debug 오용 검사는 실제 자식 프로세스로 wrong length, wrong allocator,
  double-free, 외부 포인터 7개 경우의 `SIGABRT`와 진단을 확인한다. release는
  올바른 소유권 페어링만 실행하며, UB 실행을 통과 증거로 사용하지 않는다.
- 실제 C++ `throw`는 `noexcept` host wrapper 안에서 처리한다. 복구 후 두 번째
  Rust 이벤트 수신과 명시 `std::abort`의 별도 자식 프로세스를 확인한다.
  Rust panic 검사를 C++ exception 검사로 취급하지 않으며, foreign exception을
  Rust로 넘겨도 안전하다는 주장을 하지 않는다.
- Sanitizer workflow는 기존 lib 외에 `trust_baseline_ffi`, `payload_robustness`,
  `ffi_process_contract`, `large_payload_boundary`, `ffi_scriptc`의 debug/release를
  ASan/LSan으로 검사한다. leak 검사를 끄지 않았다.
- 기존 3개 fuzz 캠페인은 유지한다. 별도 `invoke_large_boundary`는 최대 1MiB+1
  입력, 정확한 payload 제한 전후, 큰 유효 바이트 배열, 재귀 깊이, malformed 입력을
  600초·2GiB RSS·입력당 10초 예산으로 검사한다. 19개 재현 시드는 스크립트로 생성한다.
- scriptc callback 검사에 oversized/malformed 응답, 두 worker를 막은 뒤의 취소,
  callback 실행 중 release 대기, 해제 후 미전달을 보완했다. 동일 callback/context
  pair는 같은 owner이고, 서로 다른 세대 식별자가 아니라는 문서도 추가했다.
  caller buffer와 빌린 callback 데이터는 host free 대상이 아니다. channel 폐기 후의
  대기 작업 종료는 호스트 책임이다.

## 실행 명령과 원본 증거

macOS Apple Silicon에서 실행:

```bash
cargo test -p rustra --test ffi_process_contract --test large_payload_boundary
cargo test -p rustra --release --test ffi_process_contract --test large_payload_boundary
cargo test -p rustra --test ffi_scriptc
cargo test -p rustra --release --test ffi_scriptc
cargo clippy -p rustra --test ffi_scriptc --test ffi_process_contract \
  --test large_payload_boundary -- -D warnings
SAFETY_LOG_DIR="$PWD/target/safety/local" \
  bash scripts/run-safety-check.sh foreign-exception \
  bash scripts/run-foreign-exception-check.sh
bun run test:docs
```

macOS 결과: free/large debug 4개 통과(자식 진입점 1개는 일반 실행에서 의도적으로
ignored), release 3개 통과. scriptc debug/release 각각 2개 통과. C++ 복구 exit 0과
명시 abort exit -6 통과. clippy 경고 0, docs 테스트 37개 및 EN/KO 78개 문서 검사 통과.
workflow YAML 파싱, shell 문법, `git diff --check`도 통과했다.

Linux는 이 작업에서 만든 `rust:1.95-slim` Docker 컨테이너의
`aarch64-unknown-linux-gnu`, nightly `1.101.0 (e9bbadf68 2026-10-12)`,
`cargo-fuzz 0.13.2`로 실행했다. Actions의 x86_64 실행 증거와 구분한다.

```bash
bash scripts/safety/run-linux-validation.sh
```

원본 로그는 `target/safety/linux-validation/`에 남긴다. 각 단계는
`scripts/run-safety-check.sh`가 `.log`와 `.exit-code`를 함께 기록한다.
성능 코드와 scriptc 테스트의 마지막 변경 이후에는 동일 ASan/LSan 옵션으로
lib 및 5개 통합 대상의 debug/release를 `final-*` 이름으로 다시 실행했다.
소스 226개 파일의 SHA-256은 `source-before.json`, 당시 내용은
`verified-source.tar.gz`에 보존했다. `source-after.json`과 비교한 226개 파일의 변경은
0개다. 각 파일의 정확한 전체 hash는 두 JSON에 남는다.

| 최종 Linux ASan/LSan 단계 | 결과                                            | 원본 로그                       |
| ------------------------- | ----------------------------------------------- | ------------------------------- |
| lib                       | 227 passed / 0 failed                           | `final-lib.log`, exit 0         |
| FFI debug 5개 대상        | 42 passed / 0 failed, child entry 1 ignored     | `final-ffi-debug.log`, exit 0   |
| FFI release 5개 대상      | 41 passed / 0 failed                            | `final-ffi-release.log`, exit 0 |
| C++ host containment      | recover 0 / explicit abort -6                   | `foreign-exception.log`, exit 0 |
| 대형 fuzz seed 재생       | 19개 seed, 21 runs                              | `large-seeds.log`, exit 0       |
| 대형 fuzz 캠페인          | 601초, 1,736,052 runs, crash 0, 최대 RSS 395MiB | `large-campaign.log`, exit 0    |

source archive SHA-256:
`0049e1265f885883e9e1da39e2f2c080e177ff62935d1ceed21e4b9b9140d8e0`.

주요 소스 SHA-256:

| 파일                                                  | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `crates/rustra/src/ffi_scriptc.rs`                    | `8d33817a70edd34730666d94b05ceb1f6f7d237542df009e40f60fbaaf9371a1` |
| `crates/rustra/tests/ffi_scriptc.rs`                  | `84460ac318246b672cbb97d63ea4e1df8db6f948d4b58acad1a02a4a8dc66894` |
| `crates/rustra/tests/ffi_process_contract.rs`         | `eb06b985ddd5b1e3b54c59dff163b152a1fed2c6aaddcbf1bef9a3c7292f8e32` |
| `crates/rustra/tests/support/large_boundary_cases.rs` | `9ad5f654eaab66fb6ea99226d36cfa3cc444373ef700cbd6b7f68686e5e11594` |
| `fuzz/fuzz_targets/invoke_large_boundary.rs`          | `b64216cc70604d8a6148581c5fd1915f2a1387babaa6139701fca1c4ef498d09` |
| `scripts/safety/foreign-exception/host.cpp`           | `062eeee63e126d8a2ebf8483abc0954c2cb6d572a38b461bc755a081d83fffdf` |
| `scripts/safety/run-linux-validation.sh`              | `e50bd18140660610ed8d988316c03972600cad218fc7643775de80e8f4da4b0f` |

이 archive/hash 비교는 최종 ASan 검사 시점의 소스를 고정한다. 먼저 시작한 fuzz와
C++ harness는 별도 실행 로그로 구분하며, 서로 다른 시점의 전체 workspace를 하나의
원격 후보 SHA 검사처럼 합쳐서 해석하지 않는다.

캠페인 완료 후 이 작업이 생성한 `rustra-safety-oct13` 컨테이너는 stop 및 제거했다.
호스트에 마운트한 원본 로그와 corpus는 보존했다. fuzz는 성능 계측이 아니며,
동시에 수행한 안전성 검사로 처리량을 성능 수치로 해석할 수 없다.

## 판정 경계

검사 범위는 [게이트 맵](../../gate-map.ko.md),
[릴리스 절차](../../release-procedure.ko.md), [위협 모델](../../threat-model.ko.md)의
EN/KO 문서와 동기화했다. 이 기록은 유효 포인터 전제 안의 검사 결과이며 임의 포인터
유효성 인증, 모든 ABI의 foreign exception 복구, RN native sanitizer, 실기기 장시간
안전성, 새 원격 CI 성공 또는 배포 완료를 뜻하지 않는다.
기존 Miri workflow와 작은 입력 fuzz 3개는 유지했지만 이 로컬 작업에서는 새로 실행하지
않았다. 다음 릴리스는 여전히 최종 후보 SHA의 원격 Miri·ASan·전체 Fuzz 성공을 요구한다.
