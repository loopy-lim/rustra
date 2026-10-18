# scriptc native FFI 검사

기본 consumer 스모크는 `bash examples/calculator/scriptc/run.sh`로 실행한다.
취소·해제·큐 전달 스트레스는 스모크와 분리된 별도 게이트로 다음 명령에 든다.

```bash
node examples/calculator/scriptc/run-stress.mjs
node examples/calculator/scriptc/run-stress.mjs --sanitize
```

실제 핀 버전의 scriptc compiler로 네이티브 실행 파일을 만들고, 기본 5개 새 프로세스를
각각 15초 한도 안에서 실행한다. `--runs=1..100`으로 반복 횟수를 지정한다.
소스·staticlib·실행 파일 SHA-256, compiler/runtime 버전, 단계별 로그, 완료 영수증은
`target/scriptc-stress/<platform>-<arch>/{release,sanitize}/`에 남는다. `--sanitize`는 scriptc 생성 코드와
런타임의 ASan/RC audit이며, 함께 링크하는 Rust staticlib은 release 빌드다. Rust 전체를
ASan으로 계측했다고 해석하지 않는다.
sanitizer 모드는 먼저 scriptc hello가 main까지 도달하는지 확인하고, 별도 C canary의
의도적 heap-use-after-free를 ASan이 실제 검출하는지 검사한다. canary는 별도 실행 파일에만
링크하며 정상 consumer나 배포 라이브러리에 포함되지 않는다.

`stress-fixture`는 테스트 전용 package와 worker 대기·해제 진입을 제공한다. 공개 ABI를
추가하지 않는다. 실제 callback·async·취소·response free는 production rustra의 FFI다.
스트레스 매니페스트는 코드젠된 `ffi.json`의 descriptor를 그대로 사용하며, 링크할
fixture와 스케줄 제어 함수 3개만 추가한다. 기본 calculator consumer 스모크도 별도로
유지하므로 fixture 실행만으로 실제 calculator package 검증을 대신하지 않는다.

각 프로세스는 64회 등록/해제, 복사한 bytes 전달 192회, 이벤트 전달 128회, checkpoint
전 취소 64개, 완료 후 cancel ID 정리, 해제 이후 늦은 완료 억제를 검사한다. 취소는
두 worker가 실제 gate에 도달한 것을 확인한 후 제출하므로 sleep 시간에 의존하지 않는다.
handler gate 자체는 10초, gate 도착 대기는 5초로 제한한다.
Rust 완료를 관찰한 뒤에도 script loop를 50ms 유지하고 마지막 불변식을 다시 검사해,
프로세스 종료가 늦은 전달을 가리는 경우를 줄인다. 이는 장시간 실행 인증이 아니다.

## 해제와 이미 큐에 들어간 전달

Rust의 release는 새 native callback을 막고 실행 중인 native trampoline이 반환할 때까지
기다린다. scriptc foreign trampoline은 bytes/string을 복사해서 자기 이벤트 루프에 넣는다.
**release 전에 이미 큐에 들어간 script closure 호출은 release 후에도 배수된다.**
따라서 해제 뒤 UI/state 효과까지 막으려면 consumer가 별도 active/generation 상태를
검사해야 한다. 스트레스는 queued payload 복사본이 계속 유효한 것과, inactive consumer가
효과를 적용하지 않는 것을 모두 단정한다.

같은 named closure를 여러 번 등록하면 매번 짝 release가 필요하다. bytes channel은
같은 callback/context pair의 최신 native handle부터 해제한다. 이벤트는 단일 native
owner를 교체하지만, 교체된 scriptc closure의 retained 등록 역시 짝 release로 정리한다.
native callback 안의 동기 self-release는 금지다. script closure의 self-release는 native
trampoline이 반환한 뒤 실행되므로 별도이며 실제 async 완료 경로에서 검사한다.

2026-10-13의 release 반복 통과와 sanitizer 미완료 경계는
[실제 native consumer 검증 기록](../../../docs/dev/research/2026-10-13-scriptc-native-stress.md)에 정리했다.
