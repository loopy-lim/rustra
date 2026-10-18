# scriptc native stress evidence

2026-10-13 실제 실행에서 남은 텍스트 결과를 `target/scriptc-stress/`에서 바이트 그대로 복사했다.
원본과 SHA-256은 [evidence-manifest.json](evidence-manifest.json)에 있다. 실행 파일·정적 라이브러리·LLVM IR은 원래 `target/` 경로에 보존했다.

- `macos-release/receipt-20-runs.json`: 최종 runner/app으로 실행한 release 20개 프로세스의 통과 결과.
- `macos-release/receipt.json`: 뒤이어 `bash examples/calculator/scriptc/run.sh`가 실행한 release 5개 프로세스의 통과 결과. 두 실행의 바이너리 해시는 같다.
- `macos-release/run-1.log`~~`run-5.log` 및 build/version 로그는 뒤의 5회 실행 때 덮어써졌다. `run-6.log`~~`run-20.log`는 앞의 20회 실행에서 나온 원본이다. 20회 전부의 종료 상태는 보존된 20회 receipt에 있다. 동일 파일을 별도 두 실행의 원본 로그라고 세지 않는다.
- `linux-sanitize/`: 최종 runner의 ASan hello 통과, 의도적 C heap-use-after-free 검출, 이어진 Rust fixture 빌드의 `No space left on device` 실패. stress 실행 단계에는 도달하지 않았다.
- `linux-setup.log`: 작업 전용 Linux ARM64 container에 clang, 검증한 Node 26.8.2, scriptc 0.2.1을 준비한 출력.
- `macos-sanitize-startup/`: 앞선 runner/app 버전으로 시도한 ASan native stress가 15초 시작 제한에 걸린 원본 receipt. 현재 최종 소스의 검사 결과가 아니다. FFI가 없는 `hello.ts`도 main에 도달하지 못했고 `hello-startup.log`의 마지막 출력은 `AddressSanitizer: libc interceptors initialized`였다.

release receipt의 선택한 소스 15개를 복사 시점에 다시 해시한 결과 변경은 0개다. 이것은 저장소 전체나 모든 전이 의존성의 동일성 검사가 아니다. HEAD는 실행 당시의 기반 커밋이며 변경 중인 worktree 전체를 커밋으로 식별하지 않는다.

자세한 판정과 재실행 명령은 [검증 기록](../../../dev/research/2026-10-13-scriptc-native-stress.md)을 참고한다.
