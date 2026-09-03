# 레거시 제거 트랙 설계 (legacy-removal)

날짜: 2026-09-03
근거 리서치: docs/research/2026-09-03-16-00-00-dx-macro-first-assessment.md
상태: 사용자 승인 완료 (전면 제거 + 방안 1 + 벤치 기본 유지)

## 목표

"예제가 제품의 모습을 보여주도록" — calculator 앱 전용 legacy 프로토콜(벤치 픽스처)을
전면 제거하고, 제거 과정에서 확인된 잠재 결함 2건(invokeRkyvV2 등록 공백, init 스캔폴드
이중 작성자)을 동시 수정한다.

## 배경 (조사 확정 사실)

1. calculator lib.rs ~700줄이 `RUSTRA_ENABLE_LEGACY_BENCHMARKS` ifdef 블록(rust 측은
   ifdef 없이 상시 컴파일) — 소비자는 BenchmarkApp legacy 어댑터 6종, wire-bench bin,
   rkyv_v2_panic_guard.rs 일부뿐. CI bench.yml은 legacy 심볼을 전혀 사용하지 않는다.
2. **잠재 결함 A**: JSI `invokeRkyvV2` 등록이 legacy ifdef 안에 있고
   `rustra_calculator_invoke_rkyv_v2`(앱 전용 위임 심볼)로 연결돼 있다. legacy-OFF 빌드
   (bare-calculator)에는 `invokeRkyvV2`가 존재하지 않는다. 정적 커맨드는 C++ typed 경로로
   우회해 동작하지만, 엔진 tier3(동적 커맨드) 폴백과 JS-codec 폴백이 `native.invokeRkyvV2`
   를 호출하면 undefined 크래시. `RustraNative` public 타입은 이를 non-optional로 요구.
3. **잠재 결함 B**: init 스캔폴드 `src/bin/generate.rs`가 `write_to_dir`(Rust가
   types.ts/commands.ts/contract.ts까지 작성 — 0.6에서 제거된 구형 이중 작성자)을 사용.
   docs(getting-started §2-4)는 "schema.json만 쓴다"고 주장. README:709 안내를 따르면
   CLI codegen 산출물을 Rust 구형 렌더가 덮어쓴다.
4. 리서치 문서의 `__RUstra_doc_` "죽은 코드" 주장은 **오독** — 현재 전 파이프가 살아있다
   (build! → command_doc → schema description → TS JSDoc, gauge 실증). 문서 정정 대상.

## 제거 대상

### Rust (examples/calculator)
- legacy FFI 심볼: `rustra_calculator_invoke_{bytes,raw,msgpack,bincode,postcard,rkyv,hybrid}`,
  `rustra_calculator_free_buffer`, `rustra_calculator_invoke`(Swift 전용), 
  `rustra_calculator_invoke_json` 존재 여부 확인 후 처리, bincode 수동 코덱 함수군(~200줄),
  `alloc_response`, 벤치 전용 I/O 타입(BenchAdd/BenchStringPayload 등은 유지 판단 필요 —
  Nitro 비교가 bench_add/echo_string/echo_bytes/echo_pair를 코어 경로로 사용 중.
  **커맨드 bench_*는 유지, legacy C 심볼만 제거**)
- 유지: `invoke_rkyv_v2`/`free_rkyv_v2_buffer`/`invoke_typed_raw`/`invoke_rkyv_v2_async`는
  코어 위임 재노출이므로 제거하지 않되, 소비자 재배선 후 판단(아래 "신설" 참조)

### RN JSI 브리지 (packages/react-native)
- `RustraJSIBridge.cpp` legacy makeInvoke 블록(10종) + ifdef 제거
- `RustraJSIBridge.hpp` legacy 선언 + ifdef 제거
- **신설**: 비-legacy 영역에 `makeInvoke("invokeRkyvV2", rustra_ffi_invoke_rkyv_v2,
  rustra_ffi_free, ...)` — 코어 제네릭 심볼로 결함 A 수정
- CMakeLists.txt/react-native.ts의 RUSTRA_LEGACY_BENCHMARKS 배관 제거

### CLI (packages/cli)
- `legacyBenchmarks` config 키 제거(config.ts 3곳, react-native.ts, 
  react-native-template-android.ts, generate.test.ts 4건)
- **결함 B 수정**: init-template.ts generate.rs를 `write_schema_to_dir("generated")`로 교체
  + 메시지 갱신

### RN 예제 (examples/react-native-calculator)
- adapters/{msgpack,bincode,hybrid,rkyv,postcard}-adapter*.ts + 테스트 제거
  (json-adapter, rkyv-v2-adapter 유지)
- BenchmarkApp.tsx legacy 엔진 블록 제거(rkyvV2/Nitro 비교 유지) — 기본 엔트리는 벤치 유지
- Swift 모듈 `rustra_calculator_invoke` → 코어 `rustra_ffi_invoke_json` 교체
  (문자열 프로토콜 호환 확인 후)

### 타입 표면 (packages/types)
- `RustraNative`(public.ts)에서 invokeMsgpack/invokeBincode/invokePostcard/invokeRkyv/
  invokeHybrid/invokeRaw 제거. invokeRkyvV2는 유지(제네릭 승격).
- RustraJSINative는 이미 RkyvV2SchemaNative 기반이므로 변경 최소

### bench/bin
- `wire-bench.rs`: legacy C 심볼 대신 `Package::invoke_json` 직접 측정으로 재작성
  (측정 의미 동일 — docs/benchmarks.md 영수증 재현 경로 보존)

### 테스트
- rkyv_v2_panic_guard.rs: extern을 코어 `rustra_ffi_invoke_rkyv_v2`/
  `rustra_ffi_invoke_rkyv_v2_async`/`rustra_ffi_free`로 교체
  (현재도 코어 위임이라 와이어 동일)
- wire_fixtures.rs: `rustra_calculator_invoke_rkyv_v2` 참조 주석만 — 코드 무변경 확인

### 문서
- rust-api-guide(.ko).md: on_unimplemented 섹션을 "계획됨(미구현)"으로 정정 또는 실제
  E0277 예제로 교체; write_to_dir deprecated 표기는 실제 상태(우회 경로로 생존)에 맞게 정정
- architecture(.ko).md: write_to_dir deprecated 주석 갱신
- benchmarks(.ko).md: wire-bench 재작성 반영
- README(.md/.ko.md), examples README: legacy 벤치 언급 정리
- 리서치 문서: __RUstra_doc_ 오독 정정(팔로업 섹션 추가)

## 저장소 관례 준수

- generated/ 재생성: 이번 트랙은 Rust 표면에서 legacy C 심볼만 제거하므로 schema 비변경.
  다만 bench_* 커맨드 유지로 generated 무변경 확인을 `rustra codegen --check`로 게이트.
- 커밋: lefthook prettier 재스테이징 필요 시 amend 관례
- changeset: packages/types(RustraNative 축소=minor 이상), packages/cli(config 키 제거),
  packages/react-native(JSI 표면 변경) 대상 작성

## 검증

1. `cargo test -p rustra-calculator-example` green
2. `cargo clippy --workspace -- -D warnings` (legacy dead code 경고 소멸)
3. `bun test packages/cli` green (generate.test.ts 수정 포함)
4. `bun run test:onboarding` green (스캔폴드 변경 반영)
5. `rustra codegen --check` (calculator/bare-calculator generated 무드리프트)
6. bench 워크플로 대상(cargo bench) 회귀 없음 — legacy 미사용 확인 완료

## 명시적 범위 밖

- on_unimplemented 매크로 구현 (별트랙)
- 등록 목록 일원화, stdio_main! 매크로화 (DX 리서치 권고 1·2 — 별트랙)
- #[bridge_type] 스포츠코트 전환 (별트랙)
- BenchmarkApp 기본 엔트리 변경 (사용자 결정: 벤치 유지)
