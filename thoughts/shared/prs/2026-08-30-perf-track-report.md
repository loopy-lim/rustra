# Perf 5트랙 최종 리포트 (2026-08-30)

브랜치 `feat/perf-five-tracks` (8f0a04fd 이후 20 커밋). 5트랙 전부 완료.
이 문서는 트랙별 산출물·실측·게이트 결과와 미달/보류 항목의 이유를 기록한다.

## 트랙 요약 (T = 이번 세션의 동적 명령 트랙)

| 트랙                     | 목표                           | 결과                                                                                             |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| T0 (generation)          | 치환 동기화 계약               | 완료 — schema generation → FFI 노출 → TS 게이트 (6bdbb813, 2e841f87, c487bee6)                   |
| T1 (벤치 교정)           | tier_compare 연산 통제         | 완료 — wire 순수 비교 재작성 (0dba9edc)                                                          |
| T2 (동적 postcard)       | 동적 명령 postcard fast-path   | 완료 — Rust 핸들러 + TS 인터프리터 + 엔진 라우팅 + 실측 (639a494b, 2ded6a0d, fe24d42e, c8791d8f) |
| Track A/B (complex 코어) | Value 왕복 제거                | 완료 — IR 사전컴파일 + serde 직결 (2cd5552f, 92f24f54, 16555a95)                                 |
| Node loop (F2 잔여)      | persistent loop 바이너리화     | 완료 (c742eb7f, 7c1ccda5, a6ced290)                                                              |
| Tauri (측정 정합화)      | 타이머 그리드 왜곡 제거 + 배치 | 완료 (037c6488, 8c82d316)                                                                        |
| RN async byId            | 이름 마샬링 제거               | 완료 (456274e9)                                                                                  |
| Bun F2                   | 응답 slice 제거                | 완료 (6be09a2c)                                                                                  |

## T2 — 동적 명령 postcard (이번 세션 완료분)

### T2-1 Rust 핸들러 (639a494b)

`register()`가 `build_command(id, handler, force_tier3=false)`를 쓰도록 변경
(`crates/rustra/src/registry.rs`). `build_command`의 3-way 판정이 그대로 적용된다:

1. postcard 지원 스키마 → postcard binary 핸들러
2. oneOf payload enum → complex binary 핸들러 (t3align 계약과 동일 승격)
3. 둘 다 거부 (anyOf 3항 untagged 등) → Tier 3 JSON 유지

테스트 (`crates/rustra/src/runtime_registry_tests.rs`):
`dynamic_postcard_supported_command_gets_binary_handler`,
`dynamic_map_schema_gets_postcard_handler`,
`dynamic_oneof_schema_gets_complex_binary_handler`,
`dynamic_unsupported_schema_stays_tier3`. 와이어/fuzz/concurrency 통합 테스트를
postcard 프레임으로 전환, `dynamic_promoted_command_no_longer_parses_tier3_json`
은 postcard `from_bytes`가 trailing bytes를 수용함을 이용한 정합성 핀.

### T2-2 TS 스키마→postcard 코덱 인터프리터 (2ded6a0d)

`packages/types/src/schema-postcard-codec.ts` 신설 —
`createSchemaPostcardCodec(commandId, inputSchema, outputSchema, definitions?)`.
codegen `_pc*` 헬퍼의 미러 알고리즘(zigzag/uvar/zigzag64/uvar64, LEB128,
len-prefixed string, LE float, bytes, map, tuple, Set, string enum, struct,
`$ref` 재귀, Option). 미지원 노드는 fail-closed(null) → 엔진이 안전 폴백.

바이트 동일성은 PINNED hex 3면 고정(`wire_fixtures.rs` ↔ `cross-wire.test.ts`
↔ `index.test.ts`)으로 검증: addNumbers `01000406`, greet, divide error frame,
span, gauge, sizeOf, wideAgg 64-bit 경계, tagSet.

### T2-3 엔진 라우팅 (fe24d42e)

`packages/types/src/rkyv-engine-dynamic-codec.ts` 신설 — 동적 명령 binary 코덱
캐시. **entry 객체 식별** 무효화: generation 게이트(T0-3)가 live schema를
재조회하면 entry가 새 객체가 되어 바뀐 스키마를 다시 판정한다(스테일 와이어
차단). dispatch와 invokeAsync(취소 전파 경로) 양쪽이 같은 판정을 쓰고,
`tier2Outcome`/`payloadTooLargeError`는 정적 경로와 공유.

`LiveSchemaEntry.definitions` 파싱 추가 — Rust live schema가 비어있지 않을 때만
싣는 `$ref` 해결용 정의와 정합.

병행 결함 수정(같은 커밋):

- T2-2 테스트가 definitions 자리에 outputSchema를 중복 전달한 2건
- T0-3(c487bee6) 때 도입된 `echoCodec().decode`의 ArrayBufferView 전제 위반
  (examples calculator tsconfig 기준 tsc 오류 3건 → 0)

### T2-4 실측 + 문서 (b816fe89, c8791d8f)

tier_compare에 동적 postcard 라인 추가, Tier 3 라인은 `echo_any`(anyOf 3항
untagged — 유일하게 Tier 3가 유지되는 대표형)로 교체. type_scaling은
processPayload postcard 왕복으로 전환(구 tier3 벤치는 T2-1 이후 패닉).

**측정 (criterion, `--profile dev`, macOS arm64 Apple M-series, 3회 실행):**

| tier_compare (echo 동일 연산) | 평균                                                 |
| ----------------------------- | ---------------------------------------------------- |
| 정적 postcard                 | 459–478 ns                                           |
| **동적 postcard**             | **472–488 ns (정적 대비 1.02x — 목표 2x 이내 달성)** |
| 동적 Tier 3 JSON              | 4.72–4.75 µs (~9.9x)                                 |

| type_scaling (동적 postcard) | 평균                                           |
| ---------------------------- | ---------------------------------------------- |
| 1 items                      | 1.43–1.45 µs                                   |
| 10 items                     | 6.48–6.54 µs                                   |
| 100 items                    | 56.8–57.1 µs                                   |
| 1000 items                   | 575–580 µs (구 Tier 3 JSON 5.68 ms 대비 ~9.8x) |

원본 receipt: `docs/benchmark-receipts/2026-08-30-dynamic-postcard.json`.

## 기타 트랙 실측 요약

- **Node persistent loop**: 바이너리 모드 왕복 16.86 µs (persistent loop 기준) —
  OS pipe 왕복이 하한이라 JS측 3–6 µs 목표는 미달, 하한 기록으로 마감
  (`docs/benchmarks.md` host matrix 표).
- **Tauri**: 측정 정합화 후 WKWebView IPC 왕복 **246 µs** (trimmed-mean,
  native 성분 553–709 ns 분해) — 2회 실행 receipt
  (`2026-08-30-tauri-timing-run1/2.log`). 와이어 배치 `rustra_dispatch_batch`
  로 N 명령 단일 IPC 횡단 지원.
- **Complex 코어**: IR 사전컴파일 + serde 직결 — complex_route 벤치 기준
  oneOf data enum 1.00 µs, map of seqs 2.48 µs (receipt 동봉).
- **Bun F2**: 응답 slice 제거 — caller 버퍼 공유 (`6be09a2c`).
- **RN async byId**: 이름 마샬링 제거 — invokeAsync byId 진입 (`456274e9`).

## 목표 미달 항목 (기록 의무)

| 항목                      | 목표    | 실측     | 이유                                                                                                                   |
| ------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Node loop persistent 왕복 | ~3–6 µs | 16.86 µs | OS pipe 왕복 자체가 하한. 바이너리 프레이밍/직결로 JS측 비용은 제거했지만 프로세스 간 파이프 왕복 2회(RTT)는 제거 불가 |
| Bun ~1 µs 왕복            | parity  | 미달     | 같은 OS pipe 하한 구조 (Tauri는 IPC라 별도 기준)                                                                       |

## 보류/범위 밖 (이유 기록)

- **C3(b), Bun C1/C2** — Bun FFI caller-buffer 1차(Slice 제거)로 성분이 지배적이지
  않음이 확인됐고, 남은 격차는 OS pipe 구조 비용이라 추가 최적화의 한계 명확.
- **RN G1, G3, H1/H2/H3** — 기기/시뮬레이터 실측이 필요한 항목. C++ 게이트가
  CI에 없어 본 환경에서 재현 불가(트랙 F/B와 동일 사유). 기기 스모크 후속.
- **Track E1/E2, G2** — 완료됨 (브랜치 커밋 이력 참조).

## 완료 게이트 (전부 실행, 2026-08-30)

| 게이트                                         | 결과                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p rustra` (workspace 전 바이너리) | 전부 ok — lib 103 + 통합(wire 31, fuzz 10, concurrency 3, public_authoring 38, trust_baseline 19 등) + doc 9, fail 0 |
| `cargo test -p rustra --features tauri --lib`  | 108 pass, fail 0                                                                                                     |
| `cargo fmt -p rustra -- --check`               | clean                                                                                                                |
| `cd packages/types && bun test`                | 135 pass, fail 0                                                                                                     |
| `bun run test:ts:node`                         | 63 pass, fail 0 (컴파일 포함, tsc 오류 0)                                                                            |
| C++ codec tests (`run-cpp-codec-tests.sh`)     | OK — all passed                                                                                                      |
| `tier_compare` / `type_scaling` 벤치           | 정상 실행 (`--test` 스모크 + 실측)                                                                                   |
| 트리 상태                                      | clean (모든 커밋 prettier/cargo-fmt amend 흡수)                                                                      |

## 커밋 목록 (8f0a04fd..HEAD, 20 커밋)

```
c8791d8f perf(core): 동적 명령 postcard 실측 — dev 루프 Tier 1 근접
b816fe89 bench(core): 동적 postcard 실측 — tier_compare/type_scaling 갱신
fe24d42e feat(types): 동적 명령 postcard 라우팅 — generation 연동
2ded6a0d feat(types): 스키마→postcard 코덱 인터프리터 — 동적 명령 binary 지원
639a494b feat(core): 동적 명령 postcard fast-path — 지원 스키마 binary 핸들러
0dba9edc bench(core): tier_compare 연산 통제 재작성 — wire 순수 비교
6f78b8fa test(e2e): dev 치환 워크플로우 generation 재동기화 검증
c487bee6 feat(types): 치환 재동기화 — generation 게이트로 스테일 캐시 차단
2e841f87 feat(core): live_schema/FFI에 schema generation 노출
6bdbb813 feat(core): schema generation — 치환 동기화 계약 기반
456274e9 perf(rn): async byId 진입 — 이름 마샬링 제거
8c82d316 perf(tauri): 와이어 배치 rustra_dispatch_batch — N 명령 단일 IPC 횡단
037c6488 perf(tauri): IPC 벤치 측정 정합화 — 타이머 그리드 왜곡 제거 + 네이티브 성분 분해
a6ced290 perf(node): persistent loop 바이너리 왕복 실측 — 파이프 왕복 하한 기록
7c1ccda5 feat(node): 루프 transport 바이너리 모드 — Buffer 누적 프레이밍
c742eb7f feat(node): loop-stdio 바이너리 프레임 모드 — invoke_rkyv_v2 직결
6be09a2c perf(bun): 응답 slice 제거 — caller 버퍼 공유로 복사 제거
92f24f54 perf(core): complex 라우트 serde 직결 — Value 트리 왕복 제거
16555a95 perf(types): JS complex codec 스키마 사전컴파일 — 매 호출 resolve 제거
2cd5552f perf(core): complex 스키마 IR 사전컴파일 — 호출당 Value 재해석 제거
```

이 목록의 커밋 메시지/본문이 트랙별 근거의 1차 기록이다.

## 계약 보존 확인

- 정적/frozen 와이어 불변: PINNED fixtures(`wire_fixtures.rs` ↔
  `cross-wire.test.ts`) 전수 green — 정적 계약 해시 경로(`schema()`)에 필드
  추가 없음(live_schema 만 generation/definitions 노출).
- 금지 파일 미수정: `crates/rustra-macros/src/lib.rs`,
  `crates/rustra/src/codegen.rs`, `packages/types/src/errors.ts`,
  `packages/cli/**` (git diff로 확인).
- git push / changesets 없음 — 발행은 별도 승인 절차.
