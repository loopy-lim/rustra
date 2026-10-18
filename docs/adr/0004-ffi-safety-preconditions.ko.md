[English](./0004-ffi-safety-preconditions.md)

# ADR 0004 — FFI 포인터 전제와 외래 예외의 책임 경계

- Status: Accepted
- Date: 2026-10-13
- Related: [안전 계약](../safety-contract.ko.md), [ADR 0001](0001-record-track-a-contract-mechanization.ko.md)

## Status

Accepted. 공개 ABI와 release 할당 경로는 유지하고, 실제 보장 범위와 검사 범위를 정정한다.

## Context

총괄 계약은 악의적인 FFI 계약 위반도 UB가 없다고 했지만 S3와 구현은 유효한 포인터와
정확한 소유권을 호출자에게 요구했다. 해제된 포인터의 magic을 읽는 것 자체도 UB일 수
있다. S2의 `C-unwind`가 외래 예외를 반드시 abort한다는 설명 역시 언어 보장이 아니다.
Rust panic 검사는 C++ exception 검사를 대신하지 않는다.

## Decision

1. 악성 바이트 입력 검증은 포인터 범위·정렬·수명·동시 접근·해제 페어링이라는 unsafe
   전제 안에서 보장한다. 임의 raw pointer의 유효성까지 인증하지 않는다.
2. debug live 추적기는 오용을 역참조 전에 진단하고 abort한다. release는 기존의 호출자
   계약을 유지한다. global 추적기와 잠금을 release 핫 경로에 넣는 변경은 하지 않는다.
3. C++ 콜백의 `noexcept` wrapper가 `catch (...)`로 예외를 기록하고 복귀하거나 명시
   abort한다. 외래 예외가 Rust `catch_unwind`까지 도달하는 동작에 의존하지 않는다.
4. 자식 프로세스 테스트로 실제 debug 오용 abort를 확인한다. C++ harness는 실제 throw의
   호스트 내 복구와 명시 abort를 검사하며, release UB를 실행하지 않는다.
5. 코어 lib ASan/LSan에 FFI 통합 debug/release 검사를 추가한다. 기존 1KiB fuzz와
   큰 입력·1MiB 경계·재귀 깊이 캠페인을 구분하고 각각 원본 로그와 자원 예산을 남긴다.
6. S3는 소유 응답과 호출자 버퍼·빌린 callback 데이터를 구분한다. S6는 응답 인코딩을
   보장하며 channel 종료 후 전달을 보장하지 않는다. 유지한 async channel을 폐기하는
   호스트는 자신의 대기 작업을 종료해야 한다.
   release 전에 외부 런타임에 큐잉한 callback은 이후에도 배수될 수 있으므로 폐기한
   상태에 대한 효과는 consumer가 별도로 방어한다.

## Consequences

무조건적인 안전성 표현은 철회되지만 ABI·호출 비용·기존 호스트 의무는 바뀌지 않는다.
호스트 wrapper의 예외 처리는 호스트가 구현해야 한다. 검사 구현은 RN 실기기 메모리
안전성이나 모든 플랫폼의 실행 성공을 뜻하지 않는다. Linux sanitizer의 실제 완료는
같은 소스에서 실행한 로그로 판단한다.

근거: [Rust FFI unwind 규칙](https://doc.rust-lang.org/nomicon/ffi.html#ffi-and-unwinding),
[`catch_unwind`](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html#notes).
