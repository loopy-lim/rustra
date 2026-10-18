# 호스트 실행 경로의 추가 개선

앞선 구현 뒤에도 로컬에서 해결할 수 있는 문제가 남아 있었다. 추가 요청에 따라
실제 호출 경로를 다시 조사해 개발 모드의 오래된 실행 파일 사용, 실패 뒤 캐시 복구,
Node 분할 응답의 반복 복사, Bun 큰 응답의 probe 재시도를 다뤘다.
기준은 `f1a96b941ed709038b6e4fe8ae3753e895ffa8a6` 위 미커밋 소스다.

## 개발 모드의 두 결함

`cargo run --bin generate`만 성공하면 실행 파일이나 cdylib가 갱신되지 않아도
reload가 통지됐다. 구현만 바뀌어 계약 해시가 같으면 이전 Rust 결과가 그대로
성공할 수 있었다. 이제 Node/Bun의 실제 producer를 감시하고 빌드한 뒤 통지한다.

또한 생성 후 실행 파일 빌드가 실패하면 새 생성물과 이전 바이너리가 함께 남는다.
소스를 마지막 성공 상태로 정확히 되돌렸을 때 이전 입력 지문이 Cargo를 생략해
`contract.mismatch`가 발생하는 것을 실제 Node 여정으로 재현했다. 전체 파이프라인을
시작할 때 성공 지문을 무효화하고, 빌드·parity 검사까지 통과한 후에만 재채택한다.

실제 watch·Rust 컴파일 실패·원상 복구·계약 변경·설정 보존 기록은
[개발 루프 검증](2026-10-13-watch-runtime-recovery.md)에 있다. 각 reload에서 새로운
consumer 프로세스를 실행해 바이너리와 결과를 확인한다. 이미 실행 중인 앱의 메모리
상태나 UI 재연결까지 검증한 것은 아니다. 두 여정은 `test:onboarding:watch --host
node|bun`과 CI에 연결했다.

## Node 분할 응답

수신 청크마다 누적 prefix 전체를 `Buffer.concat`하던 구현을, 프레임이 완성되었을 때
한 번 합치는 방식으로 바꿨다. 완성된 단일 프레임은 입력 storage의 view를 바로
전달한다. 수신 길이 헤더만 보고 큰 버퍼를 미리 할당하지 않는다.

결정적 회귀 검사는 기존 코드에서 1MiB 응답을 4KiB씩 받을 때 **135,786,500바이트**를
복사해 실패했다. 수정 후에는 **1,048,576바이트**를 복사한다. 모든 청크 경계에서
빈 프레임·1바이트 프레임·여러 프레임, 보존된 응답 view, 미완성 `0xffffffff` 길이
헤더를 검사한다. Bun 단위 검사와 Node 프로세스/런타임 검사를 모두 사용한다.

별도 프로세스 5쌍을 AB/BA로 교대했다. 생성 코덱·실행한 adapter·types JS·Rust
바이너리 해시를 기록하고 측정 전후가 같은지 확인했다. 다른 작업자의 CPU 검사는
중단했으며 일반 데스크톱 환경의 다른 부하까지 통제한 결과는 아니다.

| 범위                       |  이전 평균 | 수정 평균 | 해석                                  |
| -------------------------- | ---------: | --------: | ------------------------------------- |
| 프레이머: 1MiB / 4KiB 청크 | 4,866.81µs |   63.43µs | 조각 결합만 측정; 앱 전체 지연이 아님 |
| 실제 native echo: 64B      |    23.98µs |   22.73µs | encode·pipe·Rust·decode 포함          |
| 실제 native echo: 64KiB    |    80.85µs |   83.08µs | 약 2.8% 비용 증가가 남음              |
| 실제 native echo: 256KiB   |   234.16µs |  213.77µs | 대응 실행 평균 비율 약 8.7% 감소      |

모든 크기에서 속도가 좋아졌다고 주장하지 않는다. 완성된 1MiB 프레임의 순수 함수
측정에도 약 39ns 비용 증가가 남았다. 작은/중간 응답의 비용과 큰 분할 응답의 개선을
함께 공개한다. 결과 바이트는 매 호출 clock 밖에서 대조했다. native 표본은 각 실행
500 warm-up 뒤 2,000개, 순수 함수 표본은 30 warm-up 뒤 200개다. coalesced 함수
표본은 100프레임 묶음이며 개별 호출 p95와 섞지 않는다.

[최종 원본 표본](../../benchmark-receipts/2026-10-13-node-framing-ab.json),
[최초 후보](../../benchmark-receipts/2026-10-13-node-framing-initial-ab.json),
[중간 fast-path 후보](../../benchmark-receipts/2026-10-13-node-framing-fastpath-ab.json)를
보존했다. 중간 후보의 연속 프레임 비용 때문에 완성 프레임 진입과 조각 처리 함수를
분리했다. 최종 비교의 baseline module은 HEAD의 기존 프레이머다.

재현 worker는 `scripts/node-framing-bench.mjs <built-module> <receipt.json>`과
`scripts/node-native-echo-bench.mjs <adapter-entry> <frame-registry> <runtime-binary>
<receipt.json>`이다. 이전/수정 adapter를 별도 폴더에 빌드해 같은 native 바이너리로
교대 실행한다. raw receipt에 실제 명령과 source/artifact hash가 있다.

## Bun 큰 응답과 scriptc 수명 검사

Bun은 코어가 owned 응답과 전용 free 심볼을 함께 제공하면 해당 경로를 사용한다.
구버전 코어는 기존 경로를 유지한다. 큰 응답의 probe 요청 복사·비교와 재시도 진입을
없애되, 디코드 전에 JS 소유 버퍼로 복사하고 Rust allocation을 정확히 한 번 해제한다.
owned free 호출이 추가되므로 전체 FFI 호출 수가 2회에서 1회가 됐다는 뜻은 아니다.

같은 native/codec/types를 쓴 독립 프로세스 5쌍에서 64KiB와 256KiB 응답의 paired
p50은 각각 11.8%, 12.2% 감소했다. 작은 응답은 신뢰구간이 1을 포함하므로 개선이나
무회귀를 확정하지 않는다. [Bun 구현·측정](2026-10-13-bun-owned-response.md)과
[30,000개 원본 표본](../../benchmark-receipts/2026-10-13-bun-owned-ab.json)에 세부
조건과 정확한 비율 계산을 남겼다. 패키지 검사 68개와 타입·lint·format을 통과했다.

scriptc 검사는 실제 핀 compiler로 만든 실행 파일에서 큐에 복사된 payload 보존,
등록 교체와 stale owner 해제, 취소 checkpoint, 늦은 완료 억제를 검사한다. 해제 전에
이미 scriptc 큐에 들어간 closure는 이후에도 배수된다. consumer의 active 상태로
해제 이후 효과 적용을 막는 계약과 새 native delivery 차단을 구분한다.

macOS의 독립 프로세스 20개에서 1,280 lifecycle, 3,840 copied payload,
2,560 event, 1,280 취소를 통과했고 기본 calculator 스모크와의 연결도 검사했다.
[scriptc 상세 판정](2026-10-13-scriptc-native-stress.md)과
[원본 로그·해시](../../verification/evidence/2026-10-13-scriptc-stress/evidence-manifest.json)에
release 결과와 sanitizer의 실패·부분 성공을 나눠 보존했다. macOS ASan은 FFI 없는
최소 hello에서도 시작하지 못했다. Linux ARM64에서는 hello와 의도적 heap-use-after-free
탐지까지 통과했지만 fixture 빌드가 디스크 부족으로 중단돼 실제 stress의 ASan/LSan은
미완료다. release 스트레스 통과를 누수 없음의 증거로 확대하지 않는다.

## 통합 검토

Node 프레이머는 다른 작업자의 독립 리뷰를 거쳤고 Bun 어댑터·개발 모드·scriptc
하네스는 주 작업자가 호출부와 오류·소유권 경계를 함께 검토했다. Node 런타임
검사 96개, CLI Node 509개와 Bun 45개, API surface 일치 검사가 통과했다.
최종 소스 후보의 React Doctor 0.9.12는 597파일, 100/100, 경고 0이다. 후보는
기존 사용자 소유 벤치 파일 두 개와 ignored 산출물을 제외했으며 원본을 보존했다.
모든 기존 검사를 새로 반복한 수치가 아니라 이번 변경에 영향을 받는 검증이다.
시각적 UI 변경은 없다.

최종 Linux sanitizer fixture 빌드 중 디스크 공간이 소진됐다. 이후 새 대규모 빌드를
중지하고, 이번 작업이 만든 중복 Cargo 중간산물만 추적·링크 경계를 확인해 정리했다.
소스·실행 기록·최종 영수증은 보존했다. 이 환경 실패를 sanitizer 통과로 세지 않는다.

Docker socket이 사라져 daemon에 접근할 수 없으므로 이번에 만든 검사 컨테이너
`rustra-scriptc-asan-oct13` 하나는 정리 대기다. Docker를 재시작하거나 기존 컨테이너를
변경하지 않았다. daemon이 돌아오면 아래 정확한 ID만 제거한다.

```bash
docker rm -f cf967b973317d243ed6a0244fe8bcb7907168e505f65e89ce4a1f389359acd32
```

실기기 모바일 A/B, 실제 앱 장시간 실행, 공개 배포와 원격 CI는 이 로컬 검증에
포함되지 않는다. 기존 사용자 벤치 파일 두 개는 수정하지 않았다.
