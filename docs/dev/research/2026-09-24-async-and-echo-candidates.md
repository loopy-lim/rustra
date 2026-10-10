---
date: 2026-09-24
researcher: loop-worker (diagnose)
git_commit: 58e1835e (작업 트리 기준, 미커밋 병렬 작업 제외)
topic: 'Nitro 비동기 잔여 격차(느림 18건)와 대형 트리 echo 변환 비용의 개선 후보 도출'
status: research-complete
---

# 비동기 잔여 격차·대형 트리 echo 변환 비용 개선 후보

[2026-09-16 잔여 격차 분석](2026-09-16-nitro-parity-gap-analysis.md), [후속 검증](2026-09-16-nitro-parity-followup.md), [공개 호출 CPU 관찰](2026-09-16-nitro-call-profile.md)과 현재 RN 어댑터·코덱·Rust 런타임 소스를 대조해 (a) 공개 비동기 경로의 느림 18건과 (b) 대형 트리 echo 변환 비용에 대해 각각 2–3개의 구체적 개선 후보를 도출했다. 이 문서는 후보 도출과 근거 정리이며, 새 구현·측정·채택 판정을 포함하지 않는다. 실기기 A/B 측정은 범위 밖이며, 모든 후보의 채택 절차는 [이름 재사용 채택 선례](2026-09-16-nitro-call-profile.md)(capability 마커 + Hermes/호스트 검증 + AB/BA 측정 플랜 문서화)를 따르는 것을 전제로 한다.

## 방법과 원본

- 판정 기준은 격차 분석의 공개 비동기 22개(느림 18, 미확정 4) 표를 그대로 사용한다(iOS 9건, Android 9건 — 근원별 분해는 아래 표).
- 현재 소스 대조 지점: [비동기 승격 경로](../../packages/types/src/global-config.ts)(`invokeGenerated`, 163–184행), [필드 라우트 캐시](../../packages/types/src/global-fields.ts)(`invokeFields`, 44–66행), [동기 디스패치](../../packages/types/src/frame-engine-dispatch.ts), [측정 차선](../../examples/react-native-calculator/src/nitro-parity/measurement.ts)(`measureAsyncPair` — 순차 `await`), [케이스 정의](../../examples/react-native-calculator/src/nitro-parity/cases.ts)(`rustraAsync = () => publicCommand(input)`), [엔진 구성](../../examples/react-native-calculator/src/nitro-parity/run.ts)(`configure(createFrameEngine(native))`), [네이티브 동기 tail](../../packages/react-native/native/cpp/RustraJSIBridge.cpp)(`typedInvokeTail`, 266–337행), [비동기 FFI·owned 응답 계약](../../packages/react-native/native/cpp/RustraJSIBridge.cpp)(1370–1683행), [caller-buffer 핸들러](../../crates/rustra/src/command_into.rs), [probe 캐시](../../crates/rustra/src/ffi_buffer_entries.rs)(62–98행)·[FFI 진입](../../crates/rustra/src/ffi_typed_buffer.rs)(30–98행), [생성 C++ 코덱](../../examples/react-native-calculator/modules/rustra-jsi/generated/rustra-generated-codecs.cpp), [Nitro 대응 구현](../../examples/react-native-calculator/modules/nitro-bench/nitro-bench/ios/HybridNitroBench.hpp)(24–32행), [C++ Writer/Reader](../../packages/react-native/native/cpp/rustra-codec.hpp), [Rust 핸들러 fixture](../../examples/calculator/src/parity_bench.rs).
- 코드 인용 행 번호는 2026-09-24 작업 트리 기준이다. 새 측정은 수행하지 않았고, 인용 수치는 모두 위 문서·수화물의 기존 결과다.

## 1. 비동기 잔여 18건의 구조 분해

측정된 "비동기" 차선이 실제로 무엇인지 먼저 확정했다. 벤치앱은 프레임 엔진으로 구성되고([run.ts](../../examples/react-native-calculator/src/nitro-parity/run.ts) 27행), 생성 명령 함수를 옵션 없이 호출하면 [global-config.ts](../../packages/types/src/global-config.ts) 172–176행의 `invokeGenerated`가 `engine[invokeByIdSync]`(동기 디스패치) 결과를 `Promise.resolve(...)`로 감싼다. 즉 **공개 비동기 차선 = 동기 작업 + JS에서 만든 Promise + 순차 `await`**([measurement.ts](../../examples/react-native-calculator/src/nitro-parity/measurement.ts) `measureAsyncPair`)이며, 워커 스레드 `invokeTypedAsync` 경로를 통과하지 않는다. Nitro의 비동기 대응도 C++ 본문을 동일하게 실행한 뒤 `Promise<T>::resolved(...)`로 반환한다([HybridNitroBench.hpp](../../examples/react-native-calculator/modules/nitro-bench/nitro-bench/ios/HybridNitroBench.hpp) 24–32행). 따라서 이 비교의 프레임워크 간 차이는 (1) 상속된 동기 고정 비용과 (2) Promise 생성·JS 접착의 위치·층수다.

느림 18건을 근원별로 분해하면:

| 근원 범주                                | 건수 | 해당 항목                                                     |
| ---------------------------------------- | ---: | ------------------------------------------------------------- |
| indexed 고정 비용(동기 트랙과 공유)      |    8 | ios+android × balanced255/1023/8191/wide1025 indexed          |
| resident-dfs(동기 트랙과 공유, DFS 본체) |    5 | ios 255/1023/8191, android 255/1023                           |
| string 고정 비용(동기 트랙과 공유)       |    2 | ios, android string                                           |
| 대형 응답 전송·변환(echo)                |    1 | ios balanced8191/echo (1.057389 [1.050415, 1.064409])         |
| 대형 입력 변환 + 순서 민감 꼬리          |    2 | android buffer65536 (1.180049), balanced8191/setup (1.065043) |

비동기 차선만의 증분은 동기 공개 차선과의 p50 차이 비교로 추정한다(서로 다른 실행 집단이므로 서술적 참고). iOS에서 add +0.047µs, string +0.226µs, indexed255/8191/wide +0.242–0.262µs, Android에서 indexed 계열 +0.210–0.289µs, string +0.068µs였다. indexed·string처럼 결과 디코드·JS 접착이 있는 소형 호출에서 일관되게 나타나는 이 증분이 비동기 전용 레버의 목표 폭이다(수백 ns 수준). 한편 13/18건(indexed 8 + resident-dfs 5)의 주된 근원은 동기 트랙 고정 비용이 그대로 상속된 것이므로, 비동기 판정 정리에는 다음 절의 후보와 동기 트랙 개선이 함께 필요하다.

## 2. (a) 비동기 경로 개선 후보

### A1. 생성 비동기 명령의 네이티브 resolved-Promise 직결 진입

**내용.** 옵션 없는 생성 명령의 비동기 호출에 대해, JS 접착(`invokeFields`의 라우트 배열 조회 + 명령 문자열 비교 + `invokeRoute` 래퍼 + `Promise.resolve` JS 내장 호출)을 거치지 않고 **이미 resolve된 JS Promise를 C++에서 만들어 반환하는 단일 JSI 진입**(예: `invokeTypedPromiseById(cmdId, args)`, positional/bytes 변형 포함)을 capability 마커와 함께 추가하고, 코드젠이 마커 노출 시 이 진입을 직접 emit한다. 인코딩→FFI→디코드→`rt.createPromise`+동기 resolve까지 한 번의 JSI 횡단에서 끝난다. 마커가 없으면 기존 경로로 컴파일되는 구조는 [이름 재사용 후보의 `RUSTRA_GENERATED_BOUND_CODEC_CONTEXT` 선례](2026-09-16-nitro-call-profile.md)와 동일하다.

**근거.**

- 현재 경로는 [global-config.ts](../../packages/types/src/global-config.ts) 172–176행 → [global-fields.ts](../../packages/types/src/global-fields.ts) 44–66행 → `invokeRoute` → `Promise.resolve(route(...))`로 JS 프레임 4개 이상을 거친다. Nitro는 동등한 일을 C++ `Promise::resolved` 한 번으로 끝낸다([HybridNitroBench.hpp](../../examples/react-native-calculator/modules/nitro-bench/nitro-bench/ios/HybridNitroBench.hpp) 24–32행).
- [호출 프로파일](2026-09-16-nitro-call-profile.md)에서 소형 호출의 JS 스레드 CPU 중 FFI 422–543/8,1xx 표본 — JS 측 접착이 무시할 수준이 아님을 시사.
- 위 1절의 비동기 전용 증분(iOS string +0.226µs, indexed +0.21–0.29µs)이 이 접착+Promise 승격 비용의 상한 추정치다.

**기대 효과.** 소형 비동기 호출당 수십~수백 ns. 18건 중 string 2건·indexed 8건의 절대 격차에서 비동기 전용 몫을 상당 부분 제거할 수 있다. 다만 격차의 대부분은 동기 상속 몫이라 판정(비율 CI 상한 ≤1.05) 뒤집기 단독으로는 부족할 수 있으며, 특히 대형 항목은 비율이 희석된다.

**리스크.**

- 오류 의미 보존: 현재 동기 throw는 `Promise.reject`로 정규화된다([global-config.ts](../../packages/types/src/global-config.ts) try/catch). 새 진입도 네이티브에서 rejected Promise를 만들어 반환해야 한다.
- `then`/`await` 콜백이 마이크로태스크로 지연되는 현재 타이밍 계약 보존(C++에서 동기 resolve해도 await 반응은 마이크로태스크여야 한다).
- 재진입·엔진 세대·reload/dispose 검증, 취소 신호·타임아웃 옵션 경로는 기존 `invokeRaw`를 그대로 사용(옵션 있으면 현행 유지).
- `jsi::Runtime::createPromise`의 런타임별 구현 차이 — Hermes 실측 검증 필수.

**로컬 검증.** [run-hermes-sync-tests.sh](../../examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh) Hermes 단언 스위트(현 1,375 단언)에 신규 진입 추가: 결과 값·오류 거부·then 콜백 비동기 타이밍·재진입 중 호출·GC·런타임 재로드·구형 헤더 폴백(마커 부재 시 기존 경로·추가 바인딩 거부). 생성기 검사와 두 RN 예제 codegen check. 채택 판정용 측정 플랜: 이름 재사용 선례의 iOS AB/BA 5쌍(실행마다 설치 교체, 90개 항목 전체) + Android 원래 v2 5회 절차를 문서화만 수행(실기기 실행은 후속).

### A2. 필드 명령 라우트의 세대 캐시 클로저 emit (JS 전용, ABI 변경 없음)

**내용.** `parityIndexed`처럼 필드 경로를 쓰는 생성 명령은 현재 매 호출 [global-fields.ts](../../packages/types/src/global-fields.ts) `invokeFields`에서 `runtime.generatedFieldsRoutes[commandId]` 조회 + `route.command === command` 문자열 비교 + fieldCount 재확인을 반복한다. 같은 파일의 `createGeneratedFields2` 패턴(세대 정수 비교로 라우트를 캐시하는 클로저)을 일반 필드 명령 emit에도 적용해, 호출당 작업을 "세대 int 비교 + 캡처 클로저 1회"로 줄인다. A1의 네이티브 진입 없이 먼저 적용할 수 있는 하위 후보며, A1이 채택되면 그 하위 기반(폴백 경로)이 된다.

**근거.** [생성 commands.ts](../../examples/react-native-calculator/generated/commands.ts) 123행 등은 `invokeGeneratedFields1(38, 'parityIndexed', input, input["id"])` 형태로 매 호출 헬퍼를 경유한다. 1절의 indexed 비동기 증분 +0.21–0.29µs 중 라우트 조회·문자열 비교·래퍼 몫이 포함된다.

**기대 효과.** 필드 명령 비동기 호출당 수십~150ns 수준(문자열 비교·프레임 제거). 효과는 A1보다 작지만 ABI·네이티브 변경이 없어 리스크가 낮다.

**리스크.** 세대 불일치(재구성) 시 재해결 경로 유지, lazy 구성(`ensureConfigured`) 경로 보존, 코드젠 출력 변화에 따른 codegen check 갱신. 기각된 "공개 호출 closure 결합" 후보([후속 검증](2026-09-16-nitro-parity-followup.md) — 재설정 이후 호출 수 증가로 폐기)와 다르게, 이 후보는 클로저 수를 줄이는 게 아니라 호출마다의 조회·비교를 세대 캐시로 대체하는 것으로 재설정 후 호출 수 변화가 없다.

**로컬 검증.** 패키지 types 기존 회귀(`bind-sync.test.ts`, `invoke-loose.test.ts`, `runtime-boundaries.test.ts`)에 세대 무효화·재구성 후 라우트 재해결 케이스 추가. Hermes 스위트는 A1과 동일 절차로 공유. 효과 확인은 Hermes/호스트 마이크로벤치(옵션 없는 생성 명령 1종에 대해 emit 변경 전후)로 계측 플랜만 문서화.

### (참고) 비동기 18건 중 나머지의 경로

ios echo8191·android setup8191·buffer65536은 3절의 echo/전송 후보(E1)와 순서 민감 꼬리 관측([후속 검증의 AB/BA 진단 프로토콜](2026-09-16-nitro-parity-followup.md))이 각각 대응한다. resident-dfs 5건·indexed 8건의 동기 상속 몫은 동기 트랙(소형 고정 비용, DFS core-only 분석 — 격차 분석 P1/P2)에서 별도로 다뤄야 하며 이 문서의 후보로 중복 정의하지 않는다.

## 3. (b) 대형 트리 echo 변환 비용 개선 후보

[호출 프로파일](2026-09-16-nitro-call-profile.md)에 따르면 8,191노드 왕복은 JS 스레드 CPU의 디코드 42%·인코드 36%·FFI 21% 구조다. 소형 맵 임시 할당·응답 버퍼·정수 시퀀스·이름 재사용은 이미 채택됐고([codec-scratch](2026-09-16-codec-scratch-and-frame.md), [정수 시퀀스](2026-09-16-integer-sequence-optimization.md), [이름 재사용](2026-09-16-nitro-call-profile.md)), Rust 코어의 잔여는 평평한 와이어 구조 비용이다([성능 여유 계측](2026-09-17-performance-headroom.md)). 아래 후보는 그 이후에 남은 전송·직렬화 경로의 구체적 낭비만 노린다.

### E1. 큰 응답의 probe-cache 2-FFI 왕복 제거 — owned 응답 핸드오프

**내용.** 동기 tail([RustraJSIBridge.cpp](../../packages/react-native/native/cpp/RustraJSIBridge.cpp) 286–322행)은 512B 스택 버퍼 시도 후, 부족하면 (i) Rust가 응답을 Vec에 인코딩해 probe 캐시에 보관(요청 전체 복사와 함께), (ii) C++가 `largeBuf.resize()`로 버퍼를 만들어 2차 FFI, (iii) Rust가 캐시 요청을 전체 비교한 뒤 응답을 memcpy. 이 왕복을 **비동기 경로가 이미 쓰는 owned 응답 계약**(같은 파일 1596–1660행의 `owned=1` + 정확한 (ptr, len) free 짝)을 동기 큰 응답에도 적용해 제거한다. 스택 버퍼 소형 경로와 `to_slice` 우선 시도·`serialized_size`+`to_extend` 폴백([command_into.rs](../../crates/rustra/src/command_into.rs) 44–74행)은 그대로 둔다. 최소형으로만 하려면 FFI 변경 없이 `largeBuf`의 zero-fill 제거(`new uint8_t[]` 등 미초기화 확보)만 먼저 뗄 수도 있다.

**근거.**

- [ffi_buffer_entries.rs](../../crates/rustra/src/ffi_buffer_entries.rs) 62–98행: probe 저장 시 `payload.to_vec()`(요청 전체 복사), 인출 시 `entry.request == payload`(요청 전체 비교). [ffi_typed_buffer.rs](../../crates/rustra/src/ffi_typed_buffer.rs) 84–93행: 용량 부족 시 캐시 저장 후 `SIZE_MAX`.
- echo8191 응답 528,012B 기준 호출당 추가 메모리 통과 ≈ 요청 복사 528KB + 요청 비교 528KB + `resize` zero-fill 528KB + 응답 memcpy 528KB ≈ 2.1MB, 528KB급 할당 3회, FFI 1회 추가. 측정 memcpy 대역폭 12.6GB/s([성능 여유 계측](2026-09-17-performance-headroom.md)) 기준 ≈170µs + 대형 할당·해제(페이지 폴트 포함) 비용.
- 판정 여유: ios async echo8191 상한 1.0644 → 1.05 도달에 약 1.4% Rustra 시간 감소 필요(격차 분석의 감소 여유 정의와 동일 계산). android buffer65536(응답 64KB, 매 배치 8회)도 같은 경로의 할당 압력을 공유한다.
- 소유권 선례: 비동기 owned=1 경로의 deleter는 정확한 (ptr, resp_len) 짝으로 dispatch 시점 코어에 free한다 — 동일 계약을 재사용하므로 새로운 소유권 모델이 아니다.

**기대 효과.** echo8191 왕복 ~1–2%(전송·할당 몫), buffer65536·대형 echo 전반의 할당 압력 감소. iOS async echo8191의 느림 판정이 동급으로 이동할 가능성. setup/update(응답 소형)에는 직접 효과 없음을 명시한다.

**리스크.** FFI 표면 추가(신규 진입점 + capability 마커 — 이름 재사용 선례 절차). probe 캐시 제거 시에도 핸들러 1회 실행 보존(owned 경로는 인코딩을 1회만 수행하므로 성립). free 짝·길이 불일치 방지(async 선례 재사용). 오류 프레임·malformed 응답의 기존 예외 메시지 보존. JS 디스패치 경로(tier 2 `invokeFrame`의 probe 프로토콜)와의 계약 정합 — 동기 tail만 새 진입으로 옮기고 나머지 호출자는 현행 유지.

**로컬 검증.** [run-cpp-codec-tests.sh](../../examples/react-native-calculator/modules/rustra-jsi/ios/run-cpp-codec-tests.sh) C++ codec/wire 검사에 대형 응답 소유권·free 짝·에러 프레임 케이스 추가. Rust는 `cargo test -p rustra`(caller-buffer 검사)와 `cargo bench -p rustra --bench tree_route` 교대 A/B(독립 프로세스, [codec-scratch 프로토콜](2026-09-16-codec-scratch-and-frame.md) 준용). AddressSanitizer 실행. Hermes 스위트로 공개 경로 무회귀. 기기 측정은 이름 재사용 선례의 AB/BA 플랜 문서화로 대체.

### E2. 대형 요청 Writer의 성장 재할당 복사 축소

**내용.** [rustra-codec.hpp](../../packages/react-native/native/cpp/rustra-codec.hpp)의 `Writer`는 128B inline → heap ×2 doubling(`ensure_capacity`)으로 자란다. 528KB 요청(echo/setup/update 입력)은 성장 중 총 약 2×최종크기(≈1MB)의 기존 내용 복사와 최대 2배의 예약 오버슈트를 매 호출 부담한다. 대역(예: 64KB 초과)에서 성장 인수를 ×2→×4로 올리거나, doubling 구간을 유지하되 마지막 확장만 필요치 정확히 예약하는 정책을 시험한다. 요청 Writer는 FFI 직후 해제되는 짧은 수명이므로 [성능 여유 계측](2026-09-17-performance-headroom.md)에서 기각된 "응답 writer 사전 예약"(입력 길이 힌트로 인한 비대칭 핸들러 메모리 잔류)과 달리 메모리 잔류 계약이 없다.

**근거.** 위 성장 수열 계산(2^7…2^19 복사 합 ≈ 1MB). ios/android setup·update·echo의 대형 입력이 모두 같은 경로. 호출당 절대치는 ≈40–80µs(12.6GB/s 기준)로 전체의 0.2–0.4% 수준 — E1에 비해 작지만 확률적으론 확실한 감소.

**기대 효과.** 대형 입력 명령(setup/update/echo/input-dfs) 전반 0.2–0.4%. 단독 채택 기준은 아니고 E1과 동일 묶음에서 부수 효과로 측정.

**리스크.** 성장 인수 상향 시 일시적 요청 버퍼 피크 증가(수명이 짧아 실사용 메모리 영향 제한적, 그래도 피크 bytes를 계측해 보고). 인라인→heap 전환·`take()` 이동 의미 보존.

**로컬 검증.** 할당 카운트 예제(`codec_allocations`) 패턴으로 요청측 alloc bytes·횟수 전후 비교, [complex-codec-bench](../../scripts/complex-codec-bench.mjs)와 C++ codec 검사로 바이트 동일성, 트리 벤치 교대 A/B.

### E3. C++ 생성 코덱의 숫자 시퀀스 벌크 경로 (Rust H3의 C++ 짝)

**내용.** Rust 코어는 동일 정수 시퀀스의 반복 분기를 제거해 큰 배열을 벌크 처리했다([정수 시퀀스 최적화](2026-09-16-integer-sequence-optimization.md), 채택). C++ 생성 코덱은 아직 대응이 없다: `children`(f64 배열, balanced8191에서 약 8,190원소) 인코딩은 원소마다 `rustra_f64` 라벨 인자 호출을, 디코딩은 원소마다 `read_f64`+`setValueAtIndex`를 반복한다. 시퀀스 진입 시 원소 타입을 1회 확인한 뒤 원소별 타입 검사는 유지하면서 루프 본문을 벌크화(검사 함수 인라이닝/호이스팅, varint·f64 판독을 지역 버퍼로 묶는 것까지만)한다. 원소별 타입 검사·오류 메시지·깊이 한도는 유지한다.

**근거.** [생성 코덱](../../examples/react-native-calculator/modules/rustra-jsi/generated/rustra-generated-codecs.cpp) `encode_body_parityEcho`/`decode_body_parityEcho`의 children 루프. 컴파일러가 `rustra_f64`를 이미 인라인할 수 있어 실효는 계측 전까진 미확정 — [성능 여유 계측](2026-09-17-performance-headroom.md)의 트리 왕복 프로파일이 평평하다는 사실과 모순되지 않는 범위(원소별 호출·경계 분기는 개별 프레임으로는 관측 한계 미만)에서 먼저 호스트 계측으로 존재 여부를 확인하는 것을 전제로 한다.

**기대 효과.** 확정 불가(계측 우선). children 원소당 수 ns × 8–16K원소면 호출당 수십~수백 µs의 상한이지만, 인라인 흡수 시 0에 수렴할 수 있다. 계측 결과가 미미하면 즉시 기각한다.

**리스크.** 생성기 출력 복잡도 증가, 원소별 오류 보고 정밀도 유지, 숫자가 아닌 원소 혼입 시 기존 오류와 동일한 메시지·위치 보존.

**로컬 검증.** Hermes 인코더 대조군([소형 맵 코덱 후보 때 사용한 프로토콜](2026-09-16-nitro-parity-followup.md) — 독립 프로세스, wire 바이트 전후 대조)로 children 포함 트리 인/디코드 시간·바이트 동일성 비교. 생성기 검사·codegen check 갱신.

## 4. 명시적 제외 — 기각·보류 선례와의 중복 없음 확인

아래는 이전에 기각·보류되어 이 문서의 후보로 다시 제안하지 않는 안이다.

- **postcard bounded heap(2종)**: 실측 10.04%/17.55% 느림으로 폐기([후속 검증](2026-09-16-nitro-parity-followup.md), [수화물](../benchmark-receipts/2026-09-16-nitro-postcard-rejected.json)). E1은 직렬화 패스 수(`serialized_size`+`to_extend`)를 그대로 두고 완성된 응답의 전송·소유권만 바꾸므로 이 기각과 무관하다.
- **공개 호출 closure 결합**: 재설정 이후 호출 수 증가로 폐기(후속 검증). A2는 클로저 수 축소가 아니라 호출마다의 조회·문자열 비교 제거이며 재설정 후 호출 수가 변하지 않는다(위 리스크 항 참조).
- **응답 writer 사전 예약, 맵 인코딩 스트리밍**: [성능 여유 계측](2026-09-17-performance-headroom.md)에서 기각·보류. E2는 요청측 성장 정책만 다룬다.
- **wire v3·zero-copy 디코드**: 공개 Frame 계약 위반, 메이저 버전 트랙 전용(같은 문서). 범위 밖.
- **fixture 알고리즘 변경(DFS→indexed 치환, 결과 생략, 보호 검사 제거), JSI handle 캐시·ABI 일괄 교체**: 격차 분석의 비후보 규정 준수. ABI 추가는 이름 재사용 선례의 "capability 마커 + 폴백" 형태만 허용한다.
- **resident DFS 본체·iOS 8,191 resident의 배치 가설, 64KiB/1MiB 버퍼 순서 효과의 원인 확정**: core-only 프로파일·분리 실행·GC 관측이 선행되어야 하는 조사 항목(격차 분석 P0/P2, 후속 검증의 AB/BA 진단)이지 이 문서의 코드 후보가 아니다.

## 5. 권장 실행 순서와 채택 기준

| 순서 | 후보                               | 채택 조건(선례 준용)                                                               |
| ---- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | E2(요청 Writer 성장)               | 트리 벤치·codec 검사 통과, 할당 bytes 감소와 함께 E1 묶음 측정에 포함              |
| 2    | E1(owned 응답 핸드오프)            | C++/Rust/Hermes 검증 + 호스트 A/B에서 대형 echo 완화, 소형·오류 경로 무회귀        |
| 3    | A2(세대 캐시 라우트 emit)          | types 회귀·codegen check 통과, Hermes 마이크로벤치에서 감소 확인                   |
| 4    | E3(시퀀스 벌크, 계측 우선)         | 계측에서 원소별 오버헤드 부재가 확인되면 즉시 기각                                 |
| 5    | A1(네이티브 resolved-Promise 진입) | Hermes 타이밍·오류·재진입 단언 통과 후 AB/BA 플랜 문서화, 마커 없는 헤더 폴백 유지 |

모든 후보의 최종 판정은 "서식 보정 포함 새 소스 고정 → 계측 제거 Release → 동일 플랫폼 독립 실행" 절차(격차 분석 6절)를 따르고, 이 문서 시점의 판정 수치를 갱신 근거로 재사용하지 않는다.

## 재현

이 문서는 분석만 포함하므로 새 실행은 없다. 인용 수치의 원본 재현:

```sh
bun scripts/analyze-nitro-parity-gaps.ts          # 격차 분석 JSON 재집계(분석 게이트)
cargo bench -p rustra --bench tree_route          # 호스트 트리 왕복(성능 여유/codec-scratch 원본)
cd examples/react-native-calculator/modules/rustra-jsi/ios && ./run-cpp-codec-tests.sh
cd examples/react-native-calculator/modules/rustra-jsi/ios && ./run-hermes-sync-tests.sh
```

(워커 환경 주의: `RUSTRA_BUN_LIBRARY` 오염 변수가 있으므로 bun 명령은 `env -u RUSTRA_BUN_LIBRARY`로 감싼다.)
