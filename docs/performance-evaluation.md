# rustra 성능 종합 평가 보고서 (2026-09-24)

한국어 요약 문서입니다. 영어 수치 원문은 [benchmarks.md](benchmarks.md)와
[benchmark-receipts/](benchmark-receipts/)를 참고하세요.

- 측정일: 2026-09-24 (KST), 저장소 HEAD `58e1835e` (2026-09-24)
- 방법: 전체 테스트 스위트 실행 + 벤치마크 전체 재실측(코덱·트랙B·함수 디스패치·트리·티어)
- 본 문서의 모든 명령은 `env -u RUSTRA_BUN_LIBRARY`로 감싸 실행했다(워커 프로세스의
  loop 데몬 dylib 오염 제거 — 미제거 시 bun 어댑터가 무관한 dylib을 로드한다).

---

## 1. 핵심 결론 요약

1. **테스트 전량 통과**: Rust 워크스페이스 575/575, TS 릴리스 게이트 스위트
   807건 전부 통과(bun test (pass) 775 / (fail) 0 + 함수 통합 게이트 ok) — 실패 0건.
2. **코어 디스패치 오버헤드는 37ns 수준**: `function_dispatch` frame 라우트 37.5ns,
   9/18 기준선 대비 4~21% 개선 유지. 레거시 JSON 와이어(272.9ns)는 frame 대비 7.3배.
3. **코덱은 재귀·옵셔널 경로가 0.10.2 최적화 수준을 유지**(recursive_depth_8 787ns),
   반면 64키 맵·1024 시퀀스 같은 대형 컬렉션(≈14.4~14.8µs)이 현재 병목 상위.
4. **oneOf 데이터 이넘이 유일한 정체 구간**: 163.3ns로 0.10.2 receipt(167.1ns)와
   동급 — 0.10.2에서 +9.6% 열화했던 케이스가 회복되지 않았다(회귀 예산 10% 경계).
   2026-10-10 계측 정정: 잔여 격차의 원인 가설(untagged 순차 시도)은 기각 — 할당은
   이미 0.11.0에서 2→1회로 개선됐고 남은 것은 스키마 구동 라우트의 serde 트레이트
   기계 비용이다(§4-1, §5-2).
5. **와이어/모드 선택 격차가 지배적**: Tier 3 JSON은 postcard 대비 9.4배,
   8,191노드 트리에서 echo(전체 왕복) 6.77ms vs resident(인덱스만) 19.8µs — 341배.

---

## 2. 전체 테스트 통과 상태 요약

실행: `env -u RUSTRA_BUN_LIBRARY cargo test --workspace`,
`env -u RUSTRA_BUN_LIBRARY bun run test:all` (릴리스 게이트 스위트).

| 스위트                                       | 결과                                  | 비고                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust 워크스페이스 (`cargo test --workspace`) | **575 passed / 0 failed / 0 ignored** | `rustra` 237 단위 + 25개 통합 테스트 바이너리 + 예제 크레이트 + doctests 포함                                                                                |
| TS 릴리스 게이트 (`bun run test:all`, 8단계) | **EXIT 0, 실패 0**                    | release-tools → types → ts:bun → packages(node/tauri/react-native/react/testing/devtools) → cli → complex-codec/track-b 벤치 테스트 → bench-gate → functions |
| bun test 카운트 합계                         | **807 tests**                         | `(pass)` 마커 775건, `(fail)` 0건 — 나머지는 node 스타일 러너·통합 게이트                                                                                    |
| 함수 통합 게이트 (`test:functions`)          | ok                                    | 18 commands / 308 checked / 7 라우트 전부 확인                                                                                                               |

의존 태스크 요약(rust-tests: 전체 통과, ts-tests: 게이트 통과 + Tauri WebView 단계만
헤드리스 환경 한계로 제외)과 본 실측이 일치한다.

---

## 3. 벤치마크 수치표 (2026-09-24 실측)

### 3.1 코덱 — Rust `Package::invoke_frame` (complex_route, release/bench 프로파일, 500 samples)

| 케이스                  | 본 실측 (median) | 0.10.2 receipt (9/16)¹ | 배차 크기 |
| ----------------------- | ---------------: | ---------------------: | --------: |
| scalar_control          |         45.64 ns |               54.26 ns |      소형 |
| optional_none           |        129.92 ns |              155.96 ns |      소형 |
| recursive_depth_1       |        151.98 ns |              181.05 ns |      재귀 |
| oneof_data_enum         |        163.29 ns |              167.12 ns |      이넘 |
| optional_string_64      |        212.33 ns |              258.49 ns |    문자열 |
| map_of_seqs             |        315.35 ns |              430.91 ns |        맵 |
| wide_struct_32          |         1.408 µs |               1.465 µs |    와이드 |
| recursive_depth_8       |        787.08 ns |              950.55 ns |      재귀 |
| recursive_depth_16      |         1.740 µs |               1.935 µs |      재귀 |
| optional_string_64k     |         4.880 µs |               6.679 µs |    문자열 |
| map_keys_64             |        14.406 µs |              18.251 µs |        맵 |
| map_seq_1024            |        14.800 µs |              20.121 µs |        맵 |
| optional_chunks_near_1m |        78.536 µs |             105.730 µs |    문자열 |
| map_keys_2              |        483.85 ns |              664.07 ns |        맵 |

¹ 0.10.2 receipt는 동일 M1 Max이지만 rustc 1.98.0 측정분이다(본 실측은 1.95.0).
머신/컴파일러 차이가 섞이므로 **절대 우열의 귀속은 불가**하며, "최적화 수준 유지"
확인용 참조값이다. 전 케이스 5~27% 빠른 것은 환경 차이를 포함한다.

### 3.2 코덱 — JS complex 코덱 (complex-codec-bench, bun, 20,000회)

| 항목          |       본 실측 | 의존 receipt (같은 날) |       처리량 |
| ------------- | ------------: | ---------------------: | -----------: |
| encode (47 B) | 3.441 µs/call |               3.366 µs | ≈ 291k ops/s |
| decode (53 B) | 3.518 µs/call |               3.530 µs | ≈ 284k ops/s |

`nested-map-option-set-data-enum` 스키마, per-call writer/response 할당.
두 독립 실행이 ±2% 내 일치 — 재현성 양호.

### 3.3 트랙B — wideAgg/tagSet JS 코덱 (track-b-bench, median of 3, 20,000회)

| 연산   | 스키마                           | 바이트 |  본 실측 | 의존 receipt |        처리량 |
| ------ | -------------------------------- | -----: | -------: | -----------: | ------------: |
| encode | wideAgg Vec\<u64\>+Option\<i64\> |   36 B | 1.641 µs |     1.724 µs |  ≈ 609k ops/s |
| decode | wideAgg Vec\<u64\>+Option\<i64\> |   28 B | 0.447 µs |     0.458 µs | ≈ 2.24M ops/s |
| encode | tagSet Set\<i64\>                |    7 B | 0.735 µs |     0.769 µs | ≈ 1.36M ops/s |
| decode | tagSet Set\<i64\>                |   23 B | 0.939 µs |     0.939 µs | ≈ 1.06M ops/s |

C++ 직접 마샬링이 대체하는 JS 측 비용만 측정한다(네이티브 경로 미포함).

### 3.4 함수 디스패치 (function_dispatch, release, 100 samples)

| 라우트         | 본 실측 (median) | 9/18 기준선² |    Δ |
| -------------- | ---------------: | -----------: | ---: |
| function/frame |         37.47 ns |     46.24 ns | −19% |
| function/into  |         14.75 ns |     15.40 ns |  −4% |
| function/json  |         38.91 ns |     49.64 ns | −22% |
| legacy/frame   |         37.42 ns |     43.30 ns | −14% |
| legacy/into    |         14.77 ns |     15.31 ns |  −3% |
| legacy/json    |        272.87 ns |    322.15 ns | −15% |

² 기준선은 `pre-perf` 스냅샷(2026-09-18, receipt
`2026-09-22-function-dispatch-smoke.json`과 계보 일치). 0.11.0의 bindSync·호출
최적화("소형 인자 경로 8–16%") 효과가 유지되고 있다.

### 3.5 디스패치 보조 — 동적 레지스트리·티어 (dev 프로파일, CI `bench.yml`와 동일 조건)

| 항목                     |  본 실측 | 기준선 대비 |
| ------------------------ | -------: | ----------: |
| register (동적 1회 등록) | 36.18 µs |       +5.0% |
| live_schema 조회         | 12.04 µs |       −2.9% |
| invoke_frame frozen      | 423.7 ns |      (신규) |
| invoke_frame mutable     | 503.5 ns |      (신규) |
| 티어: 정적 postcard      | 506.3 ns |       +7.3% |
| 티어: 동적 postcard      | 521.8 ns |       +9.0% |
| 티어: 동적 Tier 3 JSON   | 4.772 µs |       −0.4% |

- frozen 레지스트리가 mutable 대비 **16% 빠름**(RwLock 경로 제거 효과).
- 동적 postcard는 정적과 사실상 동급(3% 차이) — 런타임 등록의 조회 비용은 없음.
- **Tier 3 JSON은 postcard 대비 9.4배** — anyOf untagged 동적 스키마 비용.
- 타입 수 스케일링(type_scaling, dev): 1항 1.54µs → 10항 6.72µs → 100항 59.1µs →
  1000항 598.5µs (항목당 ≈0.6µs, 선형).

### 3.6 트리 라우트 (tree_route, release) — 모드별 격차

| 형상(노드)   | echo(전체 왕복) |   search | resident(레지던트) | dfs(순수 탐색) |
| ------------ | --------------: | -------: | -----------------: | -------------: |
| balanced31   |        25.64 µs | 13.53 µs |           115.6 ns |        66.2 ns |
| balanced255  |        207.7 µs | 116.2 µs |           644.6 ns |       589.0 ns |
| balanced1023 |        850.3 µs | 490.9 µs |           2.536 µs |       2.415 µs |
| balanced8191 |    **6.771 ms** | 3.808 ms |       **19.84 µs** |       19.56 µs |
| wide1025     |        785.5 µs | 439.9 µs |           2.204 µs |       2.110 µs |
| skew_limit   |        13.14 µs |  7.10 µs |            82.1 ns |        29.3 ns |
| payload255   |        224.9 µs | 128.2 µs |           647.5 ns |       597.6 ns |

8,191노드 기준 echo/resident 격차 **341배** — 코덱 왕복이 탐색 자체(dfs 19.6µs)를
지배한다. 대형 페이로드는 resident(인덱스/ID 전송) 라우트가 정답이다.

---

## 4. 병목 및 회귀 의심 구간 분석

1. **oneOf 데이터 이넘 — 유일한 정체 케이스(2026-10-10 단계별 계측으로 정정).**
   163.3ns로 0.10.2 receipt(167.1ns)와 동일 수준. 0.10.2 패치 당시 +9.6% 열화 후
   "회귀 예산(10%) 경계"로 관찰 대상. 당시의 원인 추정("untagged 이넘의 순차 시도(3항)
   비용")은 **기각됐다** — 단계별 할당 계측(full `invoke_frame` vs 분리 postcard 왕복
   vs 라우트 조회)으로 확정한 현재 경로: (a) oneOf 디코드는 순차 시도가 아니라 와이어
   인덱스로 변형 IR을 직접 선택한다(`complex_serde_de_enum.rs` `OneOfEnum`);
   (b) happy path 할당은 **1회 16바이트**뿐이다 — `invoke_frame` 계약상 반환 응답
   `Vec`(헤더 8B+예비 8B, `Writer::with_prefix`) 하나. 0.10.2 표의 "2회"는 그 이후
   0.11.0(`1b7449b6`, exact-reserve)에서 1회로 개선됐다. 남는 0.10.1 대비 +7.1%
   (152.49→163.29ns)은 스키마 구동 complex 라우트의 serde 트레이트 기계 비용으로 이
   아키텍처의 하한이며, 지원 형태는 이미 postcard fast-path(코어 56ns급)가 우회한다.
   criterion `change` +5.5%는 계보 불명 기준선과의 상대값으로 귀속 불가 — §9-1
   provenance 게이트가 이런 비교를 이제 "측정 불가"로 거부한다.
2. **대형 컬렉션 직렬화가 절대 병목.** map_keys_64·map_seq_1024(≈14.4~14.8µs)와
   optional_chunks_near_1m(78.5µs)이 전체 상위. 0.10.2까지 개선된 재귀(≈0.79µs@
   depth8)와 대비되며, 맵 키 재할당·요소 복사가 지배적일 것으로 추정(할당 계측은 본
   실측 범위 밖 — `codec_allocations` 예제로 별도 확인 필요).
3. **레거시 JSON 와이어 잔존 비용.** legacy/json 272.9ns는 frame 37.4ns의 7.3배.
   디스패치 자체는 싸지만 와이어 선택만으로 7배 차이 — 프레임 패스트패스 미사용
   컨슈머가 있다면 즉시 이득이 큰 구간.
4. **동적 등록 콜드 비용.** register 36.2µs는 호출당 비용이 아니라 1회 등록 비용이라
   허용 범위다. 다만 hot-core 핫스왑 루프처럼 반복 등록이 예상되는 경로에서는
   누적된다(기준선 대비 +5.0%도 모니터링 가치).
5. **벤치 기준선 계보 불명확(측정 신뢰성 리스크).** criterion `change` 수치 중 일부는
   0.10.2 패치 이전 기준선과의 비교(recursive_depth_1 −81.3% 등은 이미 반영된
   0.10.2 최적화의 재확인일 뿐 신규 개선이 아님)이며, 기준선의 커밋·컴파일러
   메타데이터가 남지 않아 개선분 귀속이 불확실하다. 의존 벤치 태스크가 지적한
   리스크와 동일 결론.
6. **dev 전용 벤치 2개는 release 실행 시 패닉.** `tier_compare`·`dynamic_registry`는
   `Package::build()` 후 `register()`를 호출하는데, release 빌드는 build 시점에
   frozen(`builder_build.rs:105`, `!cfg!(debug_assertions)`)이라 `registry.frozen`
   으로 패닉한다. CI(`bench.yml`)는 `--profile dev`로 실행해 게이트는 정상이지만,
   로컬에서 `cargo bench --bench tier_compare`(기본 release)를 돌리면 실패한다.
   제품 회귀가 아니라 하네스 가드 부재.

---

## 5. 개선 제안 (상위 5)

1. **벤치 기준선 provenance 제도화** — 벤치 receipt에 커밋 해시·rustc 버전을 필수
   기록(function_dispatch receipt의 pre-perf 기록 방식을 전 벤치로 확장)하고,
   `check-criterion-regression.mjs`가 baseline provenance 불일치 시 "측정 불가"로
   판정하게 한다. 회귀 게이트의 귀속 불확실성을 제거하는 최우선 조치.
   **→ 구현됨(2026-10-10, §9-1).**
2. **oneOf untagged 경로 최적화 재시도** — 이넘 변종 태그 힌트 캐시 또는 코드젠 단계의
   discriminated encoding으로 3항 순차 시도를 축소. 회귀 예산 10% 경계의 마지막
   열화 구간을 해소한다. **→ 취소(2026-10-10 계측, §4-1):** 순차 시도는 존재하지
   않고(인덱스 직접 선택) 할당도 이미 1회 — 최적화 대상이 없다. 지원 형태는 postcard
   fast-path가 이미 우회하며, 이는 사용자 가이드로 귀결된다(§5-4, 가이드 §12).
3. **대형 맵/시퀀스 코덱 개선** — map_keys_64·map_seq_1024에서 키 임시 벡터 재할당
   제거(0.11.0의 "4개 이하 고정 저장소" 아이디어를 초과 맵으로 확장) 및
   optional_chunks 청크 복사 축소. 현재 상위 3개 병목을 직격.
4. **resident/인덱스 라우트 가이드·코드젠 힌트** — 대형 트리·컬렉션 커맨드에 대해
   전체 왕복 대신 resident 참조 전송을 유도하는 문서와 코드젠 힌트 제공(측정상 최대
   341개 차이). 문서 변경만으로도 사용자 체감 개선폭이 가장 크다.
5. **dev 전용 벤치에 release 실행 가드** — `tier_compare`·`dynamic_registry`에
   `#[cfg(debug_assertions)]` 가드 또는 frozen 판단 시 "이 벤치는
   `--profile dev`로 실행" 안내 후 조기 종료. 패닉 대신 명확한 오류로 개발자 혼란
   제거. **→ 구현됨(2026-10-10, §9-2).**

---

## 6. 측정 환경 메타데이터

| 항목          | 값                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 측정일        | 2026-09-24 (KST)                                                                                                                 |
| 저장소 HEAD   | `58e1835e5f2b74f9a8c1e21addabcf85836534cd` (2026-09-24)                                                                          |
| 워킹트리 차이 | `package.json` test 스크립트 env 정화 1건(측정 대상 런타임 코드와 무관)                                                          |
| 머신          | Apple M1 Max (T6000, 8P+2E 코어, arm64), 64 GiB RAM                                                                              |
| OS            | macOS 26.6.2 (Build 25G83, Darwin 25.6.0)                                                                                        |
| Rust          | rustc/cargo 1.95.0 (`rust-toolchain.toml` 핀, CI와 동일)                                                                         |
| Criterion     | 0.8.2                                                                                                                            |
| Bun / Node    | 1.4.1 (repo 핀: bun@1.4.0) / v26.8.2                                                                                             |
| rustra        | crates 0.11.0 (CHANGELOG 기준 0.11.0 + Unreleased hot-core 워치 변경)                                                            |
| 환경 정화     | 모든 bun/cargo 명령 `env -u RUSTRA_BUN_LIBRARY` (loop 데몬 dylib 오염 제거)                                                      |
| 프로파일 구분 | release(bench): complex_route·tree_route·function_dispatch / dev: tier_compare·dynamic_registry·type_scaling (각 벤치 계약 준수) |

### 방법론 및 한계

- 코어 criterion 벤치: 기본 설정(예열 3s, 500 samples / function_dispatch는 1s+100
  samples), 단일 프로세스 실측. JS 벤치: 20,000회·월클럭.
- 모든 수치는 단일 머신·단일 프로세스 실측이다. CI 머신과의 절대값 비교 불가 —
  회귀 판정은 반드시 같은 환경의 baseline 비교로 수행할 것.
- 미측정: Rust 핸들러 내부 처리 시간, C++ JSI 마샬링, 실기기(RN iOS/Android),
  p95 꼬리 지연, 에너지. `host-bench`의 Tauri WebView 단계는 헤드리스 환경에서
  실행 불가(GUI 필요)로 제외했다.
- JS 벤치 수치는 본 워커 독립 실행과 의존 태스크 receipt
  (`2026-09-24-benchmark-suite.json`) 두 실행이 ±2% 내 일치 — 재현성 확인됨.

---

## 7. 2026-09-24 후속 — 개선 후보 구현·검증·측정 플랜

같은 날 진행된 후속 루프(후보 도출 → 선정 → 구현 → 전체 검증)의 취합이다.
근거 문서: [후보 도출](dev/research/2026-09-24-async-and-echo-candidates.md),
[선정 결정](dev/research/2026-09-24-optimization-decision.md),
[A2 마이크로벤치](dev/research/2026-09-24-a2-microbench.md),
[emit 전환 결정](dev/research/2026-09-24-emit-switch-decision.md),
[@rustra/react-native CHANGELOG Unreleased](../packages/react-native/CHANGELOG.md).
1~6절 수치(575 Rust / bun 807 마커)는 구현 이전 HEAD 기준이며, 아래 7.2의
게이트 수치가 본 후보 반영 후의 최신 상태다.

### 7.1 구현 내용

**E1 — 큰 응답 owned 핸드오프 (probe-cache 2-FFI 왕복 제거)** · 트리 echo 후보

512B 스택 버퍼를 초과하는 동기 typed 응답이 치르던 확정적 메모리 통과
(요청 전체 probe 캐시 복사 → `largeBuf.resize()` zero-fill → 2차 FFI 요청 전체
비교 + 응답 memcpy)를 제거한다.

- Rust `crates/rustra/src/ffi_typed_buffer.rs`: dispatch 본문을 공용 코어
  `frame_into_dispatch`로 추출하고, 신규 FFI `rustra_ffi_invoke_frame_owned` 가
  overflow 시 응답 `Vec` 소유권을 caller에 넘긴다(비동기 `owned=1` 프레임 계약의
  동기판). null 반환 = 제자리 기록, non-null 반환 = owned 핸드오프(free 짝은
  `rustra_ffi_free_owned_bytes` 정확히 (ptr, len) 1회 — `rustra_ffi_invoke_buffer`와
  동일한 짝). 기존 `rustra_ffi_invoke_frame_into`·probe 캐시는 구형 진입 폴백으로
  유지된다.
- C++ `packages/react-native/native/cpp/RustraJSIBridge.{hpp,cpp}`: 코어 함수
  테이블에 **옵셔널 엔트리** `invoke_frame_owned` 추가(테이블 끝 — 구형 셸
  레이아웃 호환). 정적 코어는 셸과 함께 빌드되므로 항상 채우고, 핫코어 dlsym은
  `RUSTRA_BIND_OPTIONAL`로 심볼 부재를 실패가 아닌 null(폴백 신호)로 처리한다.
  `typedInvokeTail` 은 엔트리 유무로 owned/probe 경로를 분기하고,
  `OwnedFrameGuard` 가 decode 경로 throw 시에도 정확히 1회 free 짝을 지키며
  생산 코어의 allocator로 해제한다(테이블 생성 시점 고정).
- 부수 갱신: `api-surface/snapshot.json`(신규 FFI 심볼), Hermes fake 피어
  (`native-sync-peers.inc` — `useOwned` 로 owned 경로 on/off, 할당 원장이 free 짝
  증명), RN CHANGELOG Unreleased 항목.

**A2 — 필드 명령 라우트 세대 캐시 (비동기 후보, 1단계: 팩토리 추가)**

- `packages/types/src/global-fields.ts`: 1-필드 생성 명령용 팩토리
  `createGeneratedFields1` 추가(`createGeneratedFields2` 패턴 준용 — 세대 정수
  비교 1회 + 캡처 라우트 직행, 옵션 있음·미구성·라우트 null 시 기존 경로
  폴백 유지). 매 호출의 라우트 배열 조회 + 명령 문자열 비교를 제거한다.
- **기존 경로 무변경**: `invokeGeneratedFields1..3`, CLI emit, 생성물은 그대로다
  (ABI·네이티브·capability 마커 불요 — 결정 문서 롤백 전략과 일치하는 순수 JS
  추가). 코드젠 emit 전환(`generate-commands.ts` + 생성물 재생성)은 마이크로벤치
  근거 확보 후 후속 단계로 수행했다(7.6).

**rn-experiment — RN 번들링 실험 예제 크레이트**

- `examples/rn-experiment`(신규, 워크스페이스 members·default-members 등록):
  3면 크레이트(rlib/cdylib/staticlib). `gzipCompress`/`gzipDecompress`(flate2,
  입력·출력이 정확히 하나의 `Vec<u8>` 필드인 bytes in/out 스키마 — Tier buffer
  fast path `rustra_ffi_invoke_buffer` 광고)와 `uuidV7`(uuid v7, 문자열 스키마 —
  JSON 경로 대조군). 워크스페이스 `[workspace.dependencies]` 에 `flate2`(default
  rust_backend — miniz_oxide, 모바일 타깃 안전)와 `uuid`(v7 feature) 추가.
- 생성물: `generated/`(schema.json, TS 명령·코덱·레지스트리),
  `modules/rustra-bridge/`(iOS podspec·build-rust-ios.sh, Android CMake·gradle·
  Kotlin 브리지, RN autolink 진입) — 모두 CLI codegen 산출물.

### 7.2 검증 증거

본 태스크(verify-all) 실행, 2026-09-24, HEAD `58e1835e` + 위 작업 트리 변경:

| 게이트            | 명령                                                       | 결과                                                                                                               |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Rust 워크스페이스 | `cargo test --workspace --exclude rustra-tauri-calculator` | **EXIT 0 — 551 passed / 0 failed / 2 ignored**(69개 결과 블록 전부 ok)                                             |
| TS 릴리스 게이트  | `env -u RUSTRA_BUN_LIBRARY bun run test:all`(8단계)        | **EXIT 0 — 실패 0**, bun test `(pass)` 781 / `(fail)` 0, 함수 통합 게이트 ok(18 commands / 308 checked / 7 라우트) |

구현 태스크가 남긴 로컬 증거(의존 요약 인용):

- **E1**: `cargo test -p rustra` 신규 4검사 — owned 와이어 동일성(overflow/여유
  버퍼 모두 `invoke_frame` 과 바이트 일치), 핸들러 정확히 1회 실행, free 짝
  정확히 (ptr, len) 1회(debug `free_guard` 활성), 에러 프레임 와이어 보존,
  probe 폴백 경로 생존. Hermes 단언 스위트 **1,383 단언 0 실패**(신규 "owned
  response handoff skips probe and frees the exact pair" 포함 — 할당 원장이
  owner/len/이중 free 검증, fake 피어 `stat("ownedHandoffs")` 로 probe 미경유
  증명). C++ codec 스위트 통과.
- **A2**: `packages/types` 회귀 + 신규 6검사(세대 캐시 계약 — 능력 조회 세대당
  1회, `configure` 재구성 후 라우트 재해결, 옵션 있으면 기존 경로, 필드 심볼
  부재 엔진은 이름 경로 폴백, lazy 구성 1회 초기화, 미구성 `transport.unavailable`).
- **rn-experiment**: 크레이트 통합 5검사(typed 와이어 gzip 왕복 + 매직 넘버,
  `rustra_ffi_has_buffer` 광고 + 버퍼 FFI 왕복, 잘못된 스트림 `args.invalid_args`,
  uuid v7 버전/variant/정렬 계약, 스키마 3커맨드 선언)가 7.2 상단 워크스페이스
  게이트에 포함돼 통과했다.

### 7.3 실기기 A/B 측정 플랜 (항목별 — 문서화만 수행, 실행은 범위 밖)

공통 절차(이름 재사용 채택 선례 준용): 서식 보정 포함 새 소스 고정 → 계측
제거 Release 빌드 → 동일 플랫폼 독립 실행, 프로파일러 없이, 느린 표본 제외
없음.

1. **E1(owned 핸드오프)** — iOS: 기존/후보 순서를 AB, BA, AB, BA, AB 5쌍,
   실행마다 설치 교체(총 10회), 각 실행은 v2 전체 90개 항목 통과 필수, 대형
   트리 echo 항목 위주로 레인을 나눠 해석. Android: 고정 후보로 원래 v2 5회
   실행, 이전 집단과의 차이는 인과 A/B로 표현하지 않음. 채택 기준: 대형
   응답(8,191노드급) 레인 기하중앙 개선 + 소형 응답 무회귀. 호스트 선행 증거:
   `tree_route` 교대 A/B(독립 프로세스), `codec_allocations` 패턴 할당 통과
   비교, AddressSanitizer.
2. **A2(세대 캐시 emit)** — 1단계는 호스트/Hermes 마이크로벤치: 옵션 없는
   1-필드 생성 명령(`parityIndexed`)의 emit 변경 전후 호출당 시간과 함께
   **호출 수 불변**을 검증(기각된 closure 결합 선례와의 구분 근거). 감소가
   확인되면 코드젠 emit을 `createGeneratedFields1`로 전환한 뒤 E1과 동일한
   기기 절차(iOS 5쌍 + Android v2 5회)로 indexed 8건·string 2건 레인 확인.
3. **rn-experiment(버퍼 우위 재확인)** — `gzipCompress`/`gzipDecompress`
   (32–64KiB 반복+노이즈 페이로드, LCG 결정적 생성) 버퍼 경로 대 `uuidV7`
   문자열(JSON) 대조군: iOS/Android 각 5회, gzip 왕복 p50과 대형 버퍼
   (64KiB/1MiB) 순서 효과 관찰을 병행한다. 이 크레이트의 스키마가
   `benchEchoBytes`(변환만)와 달리 **실연산 포함** 버퍼 우위를 같은 단일
   `data` 필드 모양으로 재측정할 수 있다.

### 7.4 실험 크레이트 사용법 요약 (`examples/rn-experiment`)

- **커맨드 계약**: `uuidV7`(id 1, 문자열 스키마·입력 없음), `gzipCompress`(id 2),
  `gzipDecompress`(id 3) — gzip 커맨드는 입력·출력이 정확히 하나의 required
  `Vec<u8>`(`data`) 필드여서 Tier buffer fast path가 광고된다.
- **로컬**: `cargo test -p rustra-rn-experiment`, 스키마 재생성
  `cargo run -p rustra-rn-experiment --bin generate`, 코드젠 검사
  `cd examples/rn-experiment && env -u RUSTRA_BUN_LIBRARY bun run codegen:check`.
- **기기**: `modules/rustra-bridge/ios/build-rust-ios.sh`(staticlib) ·
  `android/build-rust-android.sh`(cdylib, `ANDROID_ABIS` 기본 x86_64+aarch64)로
  `rustra_rn_experiment` 을 빌드하고 RN 앱에서 `installRustraJSI()` 후
  `generated/commands.ts` 의 함수를 호출한다.

### 7.5 미해결 리스크

1. **Apple 신형 링커 제약(E1)** — 실행 이미지의 unresolved weak 참조를 거부해
   "구형 정적 코어 + 신형 셸" 링크 조합은 지원되지 않는다. 정적 코어는 셸과
   동시 빌드를 가정하고, 옵셔널 의미는 코어 테이블 null 검사(정적)와 핫코어
   dlsym(동적)에 존재한다. 구형 코어 폴백 검증은 Hermes fake 피어(테이블 null)로
   대체 수행했다.
2. **A2 emit 전환은 완료됐으나 Hermes 재확인 미수행** — 팩토리 추가 단계(7.1)에
   이어 마이크로벤치 근거로 emit 전환·생성물 재생성까지 완료했다(7.6). 단,
   [결정 문서](dev/research/2026-09-24-emit-switch-decision.md) §3의 검증 방법 중
   Hermes 스위트·호출 수 불변 단언 재확인은 이번 구현 태스크 범위 밖이었고 본
   검증 태스크의 완료검증 두 게이트에도 포함되지 않는다 — 상위 플로우에서 별도
   게이트로 실행해야 한다.
3. **E1 호스트 효과는 추정치**(~1–2%, 전송·할당 몫) — 판정은 7.3의 실기기
   플랜 실행으로만 확정한다.
4. 루트 `package.json` 의 `test` 스크립트 env 정화(`env -u RUSTRA_BUN_LIBRARY
bun run test:all` 위임)는 이번 루프의 환경 선행 변경으로 그대로 유지된다.

### 7.6 후속 루프(2) 완결 — A2 마이크로벤치·emit 전환·rn-experiment 어댑터 플로우 (2026-09-24)

7.1~7.5의 1차 후보 반영 후, 같은 날 이어진 후속 루프(마이크로벤치 → 결정 →
emit 전환 → RN 어댑터 플로우 → 전체 회귀)의 결과다. 근거: [A2 마이크로벤치](research/2026-09-24-a2-microbench.md), [emit 전환 결정](dev/research/2026-09-24-emit-switch-decision.md).

#### A2 마이크로벤치 수치와 결정

`scripts/a2-fields-microbench.mjs`(complex-codec-bench 관례 — 20,000회·월클럭,
교대 순서 5라운드 중앙값, Bun 1.4.1)로 `invokeGeneratedFields1`(기존) 대
`createGeneratedFields1`(팩토리) 디스패치를 측정했다:

| 시나리오                                                   | 기존 µs/call | 팩토리 µs/call |     개선율 |
| ---------------------------------------------------------- | -----------: | -------------: | ---------: |
| warm (warmup 1,000회 후)                                   |       0.0196 |         0.0156 | **20.81%** |
| afterReset (재설정 직후 첫 호출 포함)                      |       0.0224 |         0.0150 | **33.03%** |
| cold (reset+첫 호출, reset-only 기준선 0.0227µs/call 포함) |       0.1353 |         0.0378 | **72.08%** |

- 재현성: 4회 연속 실행에서 warm 20.8–24.4% / cold 71.8–75.4% / afterReset
  22.7–33.0% — 부호·규모 일관(잡음 기준 3% 미만과 명확히 구분됨).
- **호출 수 불변 확인**: 660,004회 JS 호출 = 660,004회 네이티브 라우트 호출,
  이름 폴백 0회, 세대당 라우트 해결 ≤ 1회 — closure 결합 기각 선례와 달리
  네이티브 호출 수를 변화시키지 않는다.
- 한계: Bun/JSC 호스트 실측(Hermes 절대값 아님), 절대 폭은 호출당 ~4.0ns로
  후보 문서 기대치 하한보다 작다 — 판정은 상대 개선율·재현 안정성·불변성으로.

**결정: emit 전환 실행**([결정 문서](dev/research/2026-09-24-emit-switch-decision.md)).

#### emit 전환 구현 (impl-emit)

- `packages/cli/src/generate-commands.ts`: 1-필드 struct 명령 emit을 함수형
  (`invokeGeneratedFields1` 직접 호출)에서 팩토리형(`createGeneratedFields1<In, Out>(id, 'name', "key", 'fn')` — 2-필드 `createGeneratedFields2` 선례와 동일
  형태)으로 전환. 3-필드 경로·bytes emit·옵션 폴백은 무변경.
- 생성물 재생성 6건: calculator·auth·crud·streaming·react-native-calculator·
  react-native-bare-calculator 의 `generated/commands.ts` + `.rustra-generated.json`.
  재생성 후 어떤 예제 생성물에도 `invokeGeneratedFields1` 이 남지 않음을 확인했다
  (rn-experiment 생성물은 애초에 필드 헬퍼 미사용 — emit 불변).
- 부수: CLI 신규 검사 "generateCommandsTs emits 1-field commands via
  createGeneratedFields1 factory", changeset `.changeset/a2-fields1-emit-factory.md`
  (`@rustra/cli` minor — 생성물이 `createGeneratedFields1` 을 import하므로 이
  헬퍼를 포함한 `@rustra/types` 와 함께 배포 필요, 호출 표면은 소스 호환),
  react-native-calculator 빌드 지문 갱신.
- 순수 JS+코드젠 변경(ABI·네이티브·capability 마커 없음) — 단일 커밋 revert 후
  재생성으로 롤백 가능(결정 문서 롤백 전략 준용).

#### rn-experiment RN 어댑터 플로우 (rn-consumer)

`examples/rn-experiment/apps/react-native-app.ts` — calculator 예제의
`apps/react-native-app.ts` 패턴 준용. 실기기(JSI) 없이 호스트에서 RN JSON 어댑터
경로를 검증한다: 주입 네이티브 모듈이 7.1의 네이티브 유닛(gzip 2종 + uuidV7,
FfiFormat::Json 와이어)을 에뮬레이션하고, 생성 명령(`generated/commands.ts`)을
어댑터 경유로 호출해 다음 4검사를 통과한다(실행: `bun run test:app:rn-experiment`):

1. `gzipCompress` — gzip 멤버 스트림 매직(0x1f 0x8b 0x08) + 반복 페이로드 실제
   압축(65,536 B → 35,476 B, LCG 결정적 생성 — 네이티브 테스트와 동일 알파벳).
2. `gzipDecompress` 왕복 — 원본 65,536 바이트와 정확히 일치.
3. `uuidV7` — 하이픈 형식·ver 7 니블·RFC 변형·임베디드 ms 타임스탬프 정렬(±60s).
4. 어댑터 에러 경로 — 잘못된 gzip 스트림이 `RustraCommandError`
   (`command.invalid_args`)로 정규화되는지.

게이트 편입: 루트 `package.json` 에 `test:app:rn-experiment` 스크립트 추가 —
streaming/auth/reference 의 `test:app:*` 컨벤션과 동일한 로컬 게이트
(`test:all` 체인 밖, 다른 `test:app:*` 와 동일). 단 `examples/rn-experiment/**`
는 eslint/prettier 게이트 글롭 밖이라 스타일 검사가 적용되지 않는다.

#### 전체 회귀 검증 (verify-all, 본 단계)

HEAD `58e1835e` + 위 작업 트리 변경(7.1 구현 + emit 전환 + 어댑터 플로우 포함):

| 게이트                 | 명령                                                                                 | 결과                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust 워크스페이스      | `env -u RUSTRA_BUN_LIBRARY cargo test --workspace --exclude rustra-tauri-calculator` | **EXIT 0 — 551 passed / 0 failed / 2 ignored**(69개 결과 블록 전부 ok)                                                                         |
| TS 릴리스 게이트       | `env -u RUSTRA_BUN_LIBRARY bun run test:all`(8단계)                                  | **EXIT 0 — 실패 0**, bun test `(pass)` 781 / `(fail)` 0(신규 emit 팩토리 검사 포함), 함수 통합 게이트 ok(18 commands / 308 checked / 7 라우트) |
| 코드젠 신선도(보조)    | `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`                         | **EXIT 0** — 7개 예제 커밋 생성물이 재생성 결과와 일치                                                                                         |
| rn-experiment 앱(보조) | `env -u RUSTRA_BUN_LIBRARY bun run test:app:rn-experiment`                           | **EXIT 0 — 4 checks passed**                                                                                                                   |

참고: `test:docs`(docs-gate)는 위 두 게이트 범위 밖에서 현재 3건 실패 중이며
모두 이번 검증 태스크 편집 밖의 선행 변경에서 왔다 — (1) `docs/rust-api-guide.{md,ko.md}`
의 `docs:sync` 임베드가 emit 전환 후 재생성된 `examples/calculator/generated/commands.ts`
import 줄(신규 `createGeneratedFields1` 정렬)과 어긋남(impl-emit 범위), (2) 본 문서의
한국어 미러 `performance-evaluation.ko.md` 부재(문서 신규 생성 시 미러 관례 미적용 —
1차 후속 루프에서 이미 실패 상태였음). 아래 후속 4항에서 처리한다.

#### 남은 후속 (실기기 A/B)

7.3의 플랜이 그대로 유효하며, 이번 단계는 문서화·호스트 검증까지만 수행했다:

1. **E1(owned 핸드오프)** — iOS AB, BA 교대 5쌍 + Android v2 5회(대형 트리 echo
   레인).
2. **A2(emit 전환 후)** — iOS 5쌍 + Android 5회, indexed 8건·string 2건 레인.
   마이크로벤치가 Bun/JSC 호스트 수치인 만큼 Hermes 절대값은 이 측정으로 확정.
   더불어 결정 문서 §3의 Hermes 스위트·호출 수 불변 재확인을 선행 게이트로
   실행한다(7.5 리스크 2).
3. **rn-experiment(버퍼 우위 재확인)** — `gzipCompress`/`gzipDecompress`
   (32–64KiB 반복+노이즈, LCG 결정적) 버퍼 경로 대 `uuidV7` 문자열(JSON) 대조군,
   iOS/Android 각 5회 + 64KiB/1MiB 대형 버퍼 순서 효과 관찰.
4. **docs 게이트 수습(문서)** — `docs/rust-api-guide.{md,ko.md}` 의 `docs:sync`
   임베드 import 줄을 emit 전환 후 생성물로 갱신하고,
   `docs/performance-evaluation.ko.md` 미러(en/ko 쌍 관례)와 `docs/README`
   인덱스를 추가해 `test:docs` 를 녹색으로 복원한다.

---

## 8. 2026-09-24 후속(3) — 시뮬레이터 실측 취합과 측정 런북 (참고용 수치, 채택 판정 아님)

실기기 없이 진행된 세 검증의 결과 취합이다. **이 절의 모든 수치는 시뮬레이터·크로스컴파일
참고치며 adoption-grade 판정이 아니다.** 채택 판정은
[measurement-runbook](measurement-runbook.ko.md)(§7.3/§7.6 플랜의 실행 가능한 런북화)을
실행한 뒤에만 내린다.

### 8.1 tauri-calculator 핫스왑 실측 (sim-hotswap)

[리시트](benchmark-receipts/2026-09-24-sim-hotswap.md) — `scripts/hot-swap-ios.sh --build`
전체 경로가 부팅된 iPhone 17 시뮬레이터(iOS 26.2)에서 종단 동작함을 확인하고, 스왑 유닛
`librustra_calculator_example.dylib`(기준) → `librustra_hot_core_variant.dylib`(add-cmd
변형)의 교체를 두 계층에서 증명했다:

- **프로브(`simctl spawn`) 관점**: `PROBE SWAP e70c24c6… -> b0bf949c…` — 스키마 변화가
  old/new contract hash 교체로 관측되고, 스왑 후 신규 명령 `multiplyNumbers` 가 실제
  응답(`{"value":6}`). 음성 대조 `addNumbersV2 → command.not_found` 재현.
- **앱 프로세스 관점**: 발행한 변형 dylib의 UUID(`A71E7995…`)가 앱에 매핑된
  `hot-core-hot-1.dylib`와 정확히 일치 — 프로세스 안에서의 실스왑 구조 증거. 구 코어는
  dlclose 없이 생존(design 대로).
- **비멱등성 주의(런북 규칙화)**: 성공한 `--build` 직후 재실행 시 tauri CLI의 rename 단계가
  잔여 `arm64-sim` 산출물 때문에 `Directory not empty (os error 66)` 로 결정적으로 실패한다 —
  재실행 전 `rm -rf examples/tauri-calculator/src-tauri/gen/apple/build/arm64-sim` 필요
  (스크립트 버그 아님, 잔여 산출물 상태 문제).

### 8.2 RN 계산기 Release에서 E1 owned 경로 Hermes 종단 검증 (sim-e1)

[리시트](benchmark-receipts/2026-09-24-sim-e1-hermes.md) — `examples/react-native-calculator`를
Release-iphonesimulator로 빌드해 iPhone 17 시뮬레이터에 설치·실행, `__RUSTRA_SMOKE_OK__
addNumbers(42,58)=100` 관측(pid 18114). 증명 체인: 앱 바이너리에
`rustra_ffi_invoke_frame_owned`·`rustra_ffi_free_owned_bytes` 정의 확인(`nm`) → 코어 테이블
옵셔널 엔트리 무조건 바인딩 → 이 실행의 모든 typed invoke가 E1 분기 통과(probe 폴백 도달
불가). receipt(`jsEngine: "hermes"`, 정합성 게이트 통과)가 `invokeTypedPos` 직결 레인의 E1
경로 측정을 수치로 남겼다.

참고 수치(시뮬레이터, receipt 전문은 리시트 참조):

| 레인                        | Nitro avg | rustra avg | rustra/Nitro [95% CI] |
| --------------------------- | --------: | ---------: | --------------------: |
| add (소형, E1 분기)         |   2.44 µs |    2.75 µs | 1.128x [1.098, 1.158] |
| string (소형, E1 분기)      |   2.51 µs |    2.78 µs | 1.111x [1.089, 1.133] |
| bytes64KiB (버퍼 라우트)    |   8.04 µs |   10.90 µs | 1.357x [1.229, 1.498] |
| bytes1MiBWire (버퍼 라우트) |  70.51 µs |   95.30 µs | 1.352x [1.212, 1.508] |

정직한 한계(§8 판정 유예의 직접 근거): (1) **E1 overflow 서브브랜치**(512B 초과 → owned
핸드오프 → free 짝 1회)의 직접 관측은 없었다 — 스톡 BenchmarkApp의 대형 레인은 버퍼 라우트라
`OwnedFrameGuard.adopt` 가 호출되지 않는다(호스트 유닛·Hermes fake 피어로만 검증). (2) 분기
도달 카운터 계측 부재 — 증명은 "심볼 존재 + 무조건 바인딩 + typed 호출 성공"의 추론 체인이다.
이 보완이 measurement-runbook §1의 기기 A/B(owned/probe 두 arm 빌드)다.

### 8.3 rn-experiment 모바일 진입 크로스컴파일 (rn-experiment-ios)

[연구 문서](dev/research/2026-09-24-rn-experiment-ios.md) — `cargo build -p
rustra-rn-experiment --target aarch64-apple-ios-sim --release` 성공(8.01s, 에러/경고 0),
`librustra_rn_experiment.a` 20MB arm64, `_rustra_mobile_init` Export, `vtool` 로
`platform IOSSIMULATOR minos 14.0` 확인. 생성물 `build-rust-ios.sh`·`RustraBridge.podspec`
계약 대조 **불일치 0건**(codegen 산출물 유지가 정답), 스크립트 end-to-end 재현으로 fat
아카이브(x86_64 + arm64-sim, 40MB)까지 확인. 실기기 빌드는 `RUSTRA_IOS_TARGET=aarch64-apple-ios`
오버라이드로 동일 스크립트 재사용 — 런북 §3에 절차화됐다.

### 8.4 판정 규정과 후속

- 위 세 항목으로 §7.5 리스크 상태 갱신: 리스크 2(A2 Hermes 재확인 미수행)는 여전히 **미수행**이며
  measurement-runbook §2.1의 선행 게이트로 이동했다. 리스크 3(E1 호스트 효과 추정)은 시뮬레이터
  참고 수치로 보강됐을 뿐 해소되지 않았다.
- §7.3/§7.6의 실기기 A/B 플랜은 [measurement-runbook](measurement-runbook.ko.md) 로
  실행 절차·수화물 경로·채택/기각/롤백 기준까지 고정됐다. 실행 결과는 각 항목의 receipt
  (`docs/benchmark-receipts/<date>-<item>-ab.json`)와 이 점에 대한 §8 추기로 귀결된다.
- 부수(문서): `docs/rust-api-guide.{md,ko.md}` 의 `docs:sync` 임베드를 emit 전환 후 생성물
  import 줄로 갱신하고 `performance-evaluation.ko.md` 미러와 `docs/README` 인덱스를 추가해
  §7.6의 남은 후속 4항(docs 게이트 녹색 복원)을 닫았다.

---

## 9. 2026-10-10 후속 — 벤치 하네스 가드 2종 (§5 제안 1·5 구현)

§5의 1번(기준선 provenance 제도화)과 5번(dev 전용 벤치 release 가드)을 구현했다. 제품
(코덱·디스패치) 코드 변경은 없다 — 측정 신뢰성 하네스만 바뀌므로 §1~§8 수치의 비교 가능성은
그대로다.

### 9-1. 기준선 provenance 게이트

- `check-criterion-regression.mjs`는 비교 판정 전에 `restored-runner-environment.json`
  (기준선 시대 기록)과 `runner-environment.json`(현재 시대 기록)을 요구한다. 하나라도 없거나
  깨진 경우 **exit 2 "측정 불가"** — 판정 보류, baseline 미채택. §4-5의 "벤치 기준선 계보
  불명확" 리스크를 제도적으로 닫는다.
- 안정 섹션(host/tools/configurationDigests)이 어긋나면 WARN 자문으로 보고한다. runner 이미지
  패치(ImageVersion)만으로 흔들리는 필드까지 hard-fail 하면 인프라 이유로 게이트가 상시 거부되므로
  자문으로 남기고, 거친 시대 대혼입의 방어는 기존 mixed-changes 판정(exit 3)이 담당한다.
- 운용 규약은 런북 §0-7로 고정: 측정 세션마다
  `env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-environment.mjs target/criterion` — 2회째
  호출부터 직전 기록이 restored 쌍이 된다. CI(`bench.yml`)는 이미 매 실행 앞에 기록하며,
  `comparison_ref` 워크플로우는 benchmark-comparison.mjs가 기준선 설치 전에 환경을 기록하므로
  (같은 러너) 그대로 통과한다.

### 9-2. dev 전용 벤치 release 가드

- `tier_compare`·`dynamic_registry` 본문 앞에 `common::require_dev_profile` 가드를 뒀다.
  release(기본 프로필)로 실행하면 frozen 패닉 대신 명확한 안내 3줄과 함께 exit 2 — §4-6의
  "하네스 가드 부재"를 해소한다. 빌드(`--no-run`)는 여전히 통과하므로 CI 캐시·빌드 검증에는
  영향이 없다.
- 실증: release 빌드 바이너리 직접 실행 → 안내 출력 + exit 2 (양쪽 벤치),
  `--profile dev -- --quick`은 정상 측정, `cargo clippy -p rustra --all-targets -- -D warnings`
  통과. 벤치 게이트 단위 테스트 35건 통과(provenance 신규 5케이스: 출처 불명 3형태, 시대 드리프트
  자문, 안정 섹션 경계 포함).
