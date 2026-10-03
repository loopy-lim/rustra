# RN · Tauri · Node · Bun DX와 성능 감사

네 호스트의 DX·성능 불편을 조사하고 재현된 빈틈을 수정했다. 기존 dirty A2/E1
최적화와 RN 실험을 보존하면서 수명, 생성 entry, 개발 루프, native 자산과 실행
증거를 확인했다. 재현된 문제의 수정과 최종 통합 검증을 완료했다.

## 수정한 동작

| 경로                  | 재현된 문제                                                       | 수정 결과                                                                  |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Node 프로세스         | 실행 파일 누락이 unhandled child error로 앱 종료                  | 준비·호출 실패를 처리 가능한 에러로 반환                                   |
| Node transport        | 분할 UTF-8, hello/push 동시 수신, restart·ready timeout 수명 오류 | 세션별 decoder/handshake와 종료·재시작 처리 보강                           |
| Node 응답             | JSON null·배열·잘못된 error envelope에서 host 예외                | 응답 형태 검증 후 Rustra 에러로 정규화                                     |
| Node 생성 앱          | CRUD 상태 소실, 명령과 이벤트 producer 불일치                     | persistent 설정과 동일 bootstrap의 invoke/subscribe 사용                   |
| Bun FFI               | subscribe 직후 첫 이벤트 누락                                     | 최초 구독 시 라이브러리·sink 동기 준비                                     |
| Bun FFI 수명          | callback 내부 마지막 unsubscribe가 교착                           | callback 반환 뒤 sink 해제·JSCallback 종료                                 |
| Bun 소유권            | 이전 bootstrap dispose가 새 bootstrap의 sink 제거                 | 같은 canonical library의 event hub와 owner별 lease                         |
| 구독 수명             | 중복 unsubscribe가 새 구독 제거, dispose 뒤 callback 잔존         | 등록별 멱등 해제, 구독 집합·fallback polling 정리                          |
| RN JS                 | 무효 pollMs, drain 재진입, 등록 실패가 타이머/registry 오염       | lease·재진입·실패 rollback·마지막 타이머 해제                              |
| RN native async       | core별 async ID 충돌, 현재 core만 invalidate                      | host 토큰과 원래 producer를 함께 보관·취소                                 |
| RN native channel     | 이전 close가 재사용 handle 제거, invalidate 뒤 callback 누출      | producer/등록별 close binding, invoker generation, inflight drop 정리      |
| RN 플랫폼             | install/invalidate 스레드와 JS barrier 충돌                       | iOS JS method queue, Android JS queue dispatch 및 같은 queue에서 즉시 실행 |
| RN/Tauri bootstrap    | 초기화 중 dispose·교체 뒤 이전 owner가 ready/engine 유지          | pending 초기화와 반환된 engine까지 소유권 검사·해제                        |
| Tauri 이벤트          | 이미 디코드된 JSON 모양 문자열을 재파싱                           | decoded 기본값 보존, 명시적 serialized-json 호환 옵션                      |
| Tauri 계약            | 생성 TS와 native artifact의 계약 불일치 허용                      | generated strict handshake, mismatch 시 명령 실행 전 거부                  |
| Tauri native          | 긴 명령이 IPC 호출 스레드 점유                                    | blocking worker dispatch; 기존 sync Rust API 유지                          |
| JSON batch            | plain object 에러 누출, 응답 수/형식 미검증                       | typed 에러·cardinality/envelope 검사; 단일 IPC·빈 배치 계약 유지           |
| CLI metadata          | 동일 mtime/size, workspace 상속, Cargo cwd 설정 누락              | manifest·lock·Cargo 설정·toolchain 내용과 invocation context로 캐시 판정   |
| CLI config/legacy dev | 외부 schema, build.rs, dependency, custom target 편집 누락        | 내용 지문과 실제 Cargo 입력 discovery를 두 개발 경로에 적용                |
| CLI 감시              | symlink 재지정, 생성물·소스 디렉터리 중첩                         | 원래 namespace에서 재해석, manifest-owned 생성 파일만 제외                 |
| CLI Cargo 출력        | target-dir='.' 또는 별도 schema/engine 출력 중첩이 소스까지 제외  | 모든 producer의 실제 Cargo cwd와 소스를 함께 판정해 artifact만 제외        |
| CLI 종료              | pending parity 검증 뒤 닫힌 세션이 artifact 발행·watcher 재생성   | await 경계에서 dispose 확인; 종료 뒤 발행·reload 금지                      |
| 테스트/측정           | types 수동 목록 누락, dirty source/누락 artifact 표기 오류        | 전수 types 실행, 파일·artifact SHA 증거와 bounded benchmark 진단           |

실제 generated CRUD 앱은 create/read/update/filter/delete가 같은 Rust store를
사용함을 확인했다. streaming 앱은 같은 선택 프로세스에서 tick 5회와 완료
이벤트를 받았다. 예제·설정 schema·국문/영문 문서·changeset도 동작에 맞췄다.

Cargo discovery는 [metadata](https://doc.rust-lang.org/stable/cargo/commands/cargo-metadata.html),
[build script dep-info](https://doc.rust-lang.org/cargo/reference/build-scripts.html),
[relative dep-info](https://doc.rust-lang.org/cargo/reference/config.html)를 바탕으로
workspace/path dependency, target.src_path, build.rs, compiler가 기록한 외부 파일을
추적한다. 임의 build script의 기록되지 않은 외부 입력·모든 환경 변수의 자동
추적을 보장하지 않는다. 생성물은 manifest의 파일 소유권과 명시한 schema/mirror/
bindings 경계를 사용한다. UniFFI bindings 디렉터리는 전용 출력 경로가 전제다.

## 검증 증거

| 검증             | 결과                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| Rust workspace   | cargo test --workspace --exclude rustra-tauri-calculator --locked 통과                  |
| 최종 CLI         | Node 427개 + Bun 45개 통과; focused 72개·독립 실제 Cargo 경로 중첩 검증 포함            |
| Node             | native Node 87개 통과; 실제 generated CRUD/streaming 앱 통과                            |
| Bun              | 64개 통과; 실제 FFI 첫 이벤트·callback 내부 unsubscribe·다중 owner 회귀 포함            |
| Tauri            | JS 66개, native integration 및 contract/thread 회귀 통과                                |
| RN JS            | 81개 통과                                                                               |
| RN native        | 실제 Hermes macCatalyst host 1,412 assertion, 실패 0                                    |
| RN 플랫폼 API    | RN 0.81.5 헤더로 Catalyst ObjC++ syntax compile, SDK 35 Android Kotlin compile 통과     |
| RN Android queue | host queue harness 5개 통과; JNI/library endpoint는 대역 사용                           |
| 공유 types       | 13개 파일, 311개 통과                                                                   |
| 예제 TS          | Node 77개 통과; Bun 71개 통과, 호환성 skip 3개                                          |
| 함수 통합        | 18개 명령·308개 검사·7개 route 통과; C++ shim capability 검사는 이 스크립트 범위 밖     |
| 생성물           | 7개 codegen 예제 및 UniFFI bindings freshness 통과                                      |
| 배포 준비        | API snapshot, RN 자산·packed consumer, version coherence, registry fixture 검사 통과    |
| 온보딩           | init → doctor → build → codegen → demo → check → mutate → regen → rebuild → verify 통과 |
| 측정 도구        | benchmark gate 24개, codec 도구 4개, Tauri runner 6개 통과                              |
| 문서/릴리스 도구 | 문서 37개, release tools 86개, registry fixtures 39개 통과                              |
| 스타일/구조      | build·format·architecture 통과; lint 오류 0, 기존 경고 7개                              |
| 의존성 감사      | bun audit --audit-level=high: 163개 패키지, 알려진 취약점 0                             |

brace-expansion 5.0.9를 호환 patch 5.0.12로 갱신했다. 관련
[stack exhaustion advisory](https://github.com/advisories/GHSA-qhr7-859c-m2p7)와
[ReDoS advisory](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)의 영향 범위를
확인했고 major dependency 변경 없이 감사가 통과했다.

## 현재 후보 성능

동일 기기의 현재 경로 측정이다. 과거 후보 대비 개선율이나 실기기 성능으로
해석하지 않는다. Node/Bun은 세 번 반복한 개별 호출 분포이며 평균은
5% trimmed mean이다.

| 경로                    |         평균 |          p95 |
| ----------------------- | -----------: | -----------: |
| Node generated one-shot | 3,152.324 µs | 3,745.542 µs |
| Node persistent JSON    |    29.642 µs |   103.750 µs |
| Node persistent binary  |    26.955 µs |    89.375 µs |
| Node NAPI               |     2.812 µs |     5.958 µs |
| Bun generated FFI       |     6.213 µs |    16.042 µs |

상태를 유지하거나 빈번히 호출하는 Node 앱은 persistent 모드를 사용할 수 있다.
현재 측정에서는 매 호출의 프로세스 시작 비용이 native dispatch보다 크다.
기존 one-shot 기본값도 유지하며 persistent는 명시 설정 또는 event schema에서
선택된다. [Node/Bun 영수증](../../benchmark-receipts/2026-10-02-dx-hosts.json)은
실행 시점의 dirty source hash와 정확한 native artifact 네 개를 기록한다.

실제 macOS Tauri WebView에서 generated 호출 30,000회를 12.16초에 완료했다.
호출당 평균 368.679 µs, 1,000회 묶음의 호출당 평균 분포 p95 442 µs였다.
별도 profiled 호출 200회의 RTT는 277.778 µs, worker 내부 native 작업은
0.992495 µs였다. native 시간에는 blocking pool 대기가 포함되지 않는다.
창은 visible/unfocused였고 hidden 창 timeout 실행은 성공 수치에 넣지 않았다.
[Tauri 영수증](../../benchmark-receipts/2026-10-02-dx-tauri.json)은 실행 전후 native
binary와 frontend bundle hash 일치를 기록한다. 병렬 CLI 편집으로 전체 source
hash는 달랐으며 단일 frozen source 실행으로 표현하지 않는다.

RN은 실제 Hermes macCatalyst host와 production binder/codec를 사용했다.
Rust 대신 controlled C ABI peer를 사용하는 -O1 측정에서 2B 응답의 batch-mean
p50/p95는 0.233250/0.258041 µs, 1,024B 응답은 3.655980/6.690290 µs였다.
입력 object를 재사용하고 응답은 매번 새로 디코드했다. 이는 개별 호출 tail
latency, real Rust core A/B, release 또는 기기 성능이 아니다.
[RN 영수증](../../benchmark-receipts/2026-10-02-dx-rn-host.json)에 source, Hermes
dependency, binary, raw log hash와 1,412 assertion 검증을 함께 기록했다.

## 증거의 경계

- RN ASan은 통과하지 않았다. 정확한 PID가 main 이전 shadow-memory 초기화에서
  멈췄고 별도 empty-main Catalyst ASan probe도 시작하지 못했다. stack sample과
  로그를 보존했으며 memory safety 통과로 표현하지 않는다.
- 이번 실행에는 Android/iOS 실기기, Simulator 앱, 장시간 soak, Tauri mobile
  검증이 없다. 플랫폼 compile·packed 자산·host 실행을 기기 검증으로 확대하지 않는다.
- 현재 비용 비교이며 기존 A2/E1 후보의 과거 개선율을 재인증하지 않는다.
- raw 로그는 /tmp/rustra-dx-*와 /private/tmp/rustra-rn-audit-native-20261002/에 있다.
  [최종 통합 영수증](../../benchmark-receipts/2026-10-02-dx-validation.json)에 명령,
  결과, 현재 소스·로그 SHA와 측정 artifact 일치 검사를 함께 보존했다.
