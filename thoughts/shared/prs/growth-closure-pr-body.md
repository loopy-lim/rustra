## Summary

6각도 병렬 심층 조사(코어·JS패키지·CI·문서·성능·생태계)로 발굴한 **70여 건의 성장 건덕지 전수 구현** — 리서치 → SPEC(WS1~7) → 구현 계획(Phase 1~6) → 구현·검증 완료.

- 리서치: `thoughts/shared/research/2026-08-21_18-50-00_growth-opportunities-survey.md`
- SPEC: `thoughts/shared/specs/2026-08-21_growth-closure.md` (status: complete)
- 플랜: `thoughts/shared/plans/2026-08-21_growth-closure-impl.md` (status: 구현 완료)

### 결함 수리 6건 (조사에서 신규 발견)

| # | 결함 | 수정 |
|---|------|------|
| 1 | release 빌드에서 `grant_capability`가 영원히 불가능 (freeze가 grant까지 차단 — Runtime Authority가 prod에서 죽어 있음) | freeze는 레지스트리 **구조** mutation(register/unregister/replace)에만 적용, 권한 부여는 동결 무관 허용 + `#[command(capability = "...")]` 매크로 속성 추가(문자열 재결합 제거) |
| 2 | README/architecture 퀵스타트가 컴파일 안 됨 (`add_numbers(a, b) -> i64` — 파라미터 2개 + Result 위반) | 실제 매크로 계약(단일 Input + `Result<O>`)으로 전면 수정 |
| 3 | `useCommand`/`useMutation`/`mock()`이 `Function.name` 의존 — minify에서 파손 | 코드젠이 `fn.commandId` 심음 + `resolveCommandId()` 헬퍼 (4예제 generated 재생성 포함) |
| 4 | useCommand×Node/Bun 조합이 첫 호출부터 `cancel.unsupported` throw | signal 정책 통일: abort 시에만 `cancelled`, 미abort 정상 실행(얕은 취소) — 매트릭스 갱신 |
| 5 | devtools instrumented 엔진이 options(signal/timeoutMs)를 조용히 탈락 | `invoke(command, args, options)` 시그니처 + 전달 |
| 6 | release.yml이 `0.1.3` 하드코딩 — 0.2.0 발행 시 대기 루프 no-op | `cargo metadata` 동적 파싱 + `NPM_CONFIG_PROVENANCE` |

### 이벤트 스토리 완결 ("한 번 정의하면 어디서든"의 절반 공백 해소)

- Rust `PackageBuilder::event::<E>("name")` → schema.json `events` 섹션 (미선언 시 섹션 부재 = 하위호환)
- TS CLI `generateEventsTs`: 페이로드 타입 + `RustraEventName` 유니언 + `onRustraEvent` 타입 안전 구독 헬퍼 (dual-path)
- `@rustra/tauri` `subscribeEvent`/`rustraEventChannel` — Rust `register_with_events`와 짝 (채널 규칙 정합)

### 비동기 스토리

- async invoke 3종 엔트리 → **고정 워커 풀**(2워커/256큐 bounded) — 호출당 `thread::spawn` 제거, 가득 시 `invoke.backpressure` 즉시 거부(JS hang 없음)
- `loop-stdio` 루프 런타임 bin + `createNodeLoopTransport`(persistent NDJSON + id 상관 + `__drainEvents`) — 호출마다 프로세스 재시작 종식
- `block_on` 실행기 제약(tokio 워커 절식/thread_local State 유실) 문서화

### 코어 안전성·성능

- caller-buffer **probe 캐시** — 비멱등 핸들러 사이드 이펙트 2회 실행 방지(카운터 테스트 고정)
- `$ref` 지원 판정이 definitions까지 재귀 검증 — map/oneOf를 가리키는 $ref의 와이어 불일치 제거
- 코어 `rustra_ffi_invoke_rkyv_v2[_into][_async]` 심볼 — calculator의 복제 패닉 가드+버퍼 프로토콜 제거 (free 심볼 레이아웃 분리 `free_rkyv_v2_buffer`)
- `Command` 스키마 `Arc<Value>`화(매 invoke deep copy 제거) + `id_to_command` 단일 조회
- **할당 카운팅 측정 신설**: `invoke_json` 9 vs `invoke_rkyv_v2` **4 allocs/call**, 콜드스타트 8.6x — benchmarks.md에 0.2.0 기준선 섹션 추가
- 패닉 메시지 포맷 경로 전체 단일화, async spawn 가드, payload 복사 전 선검사, emit 직렬화 경고, 에러 잘림 마커

### JS 패키지

- `RustraErrorCode` 19종 상수 레지스트리 + `isRustraErrorCode` 가드
- mock 엔진: options 기록/pre-aborted `cancelled`/`invokeBatch` 라우팅/`reset`
- `expectContractCurrent` (러너 무관 expect-스타일 계약 게이트)
- `RustraJSINative` 3중 수동 미러링 → `RkyvV2SchemaNative` 상속 단일화
- `_utf8Encode` TextEncoder 폴백 + 사전 크기 추정 Writer / useCommand 세대 가드(StrictMode 경쟁) / positional facade byId 진입

### CI·인프라·시장

- 신규 게이트: `rust-msrv`(1.87 계약), `napi`(runtime 스모크), `cargo-deny`(라이선스/출처), audit 주간 cron, consumer-smoke **10종+CLI bin**, miri 야간, fuzz 시드 100개 git 등록, bench paths 확장+baseline 복원, dependabot actions
- 커뮤니티: SECURITY.md, CODEOWNERS, 이슈 템플릿 2종, PR 템플릿
- README: 배지/경쟁 비교표/로드맵/FAQ/영어 요약 · GitHub description+topics 8종 · RN Android 셋업 재작성(Stable 정합) · typedoc `docs:api`

## Verification

전 게이트 로컬 green:

- [x] `cargo test -p rustra -p rustra-macros` — 16 스위트 ok (신규 테스트 ~15건)
- [x] `cargo test -p rustra-calculator-example` — 8 스위트 ok (rkyv V2 위임 후 free 심볼 교체 반영)
- [x] `cargo clippy --all-targets -- -D warnings` — 0 에러
- [x] `npm run test:packages` — 7패키지 fail 0
- [x] `npm run test:ts:node` — green (crud wire round-trip 포함)
- [x] `npm run lint && npm run format:check` — clean
- [x] `loop-stdio` 수동 스모크 — 3요청 NDJSON 왕복 + drainEvents 확인
- [x] examples 4종 generated 재생성 (Rust bin dual-path, commandId 주입 확인)
- [ ] CI 전 잡 green (푸시 후 확인 — MSRV/napi/deny/miri·fuzz 야간은 스케줄)

## Checklist

- [x] Docs updated in the same PR (README/docs/CHANGELOG/매트릭스/benchmarks)
- [x] Changeset added — 9패키지 minor (`.changeset/growth-closure.md`, 발행은 별도 승인)
- [x] Wire format changes 없음 — `_into`/풀은 내부, JS 인터페이스 불변
- [x] signal 정책 변경은 하위호환 (기존 2-인수 호출 전부 동작)

## Notes for reviewers

- **signal 정책 변화**: node/bun/tauri 엔진이 미abort signal을 더 이상 에러로 거부하지 않습니다(얕은 취소). abort 시 `cancelled`는 유지 — `docs/compatibility-matrix.md`가 유일한 정합 소스입니다.
- **rkyv V2 심볼 위임**: calculator `rustra_calculator_invoke_rkyv_v2`는 코어 위임으로 바뀌었고, 응답 버퍼가 **코어 FFI 레이아웃**(8B 헤더)이 되어 해제 심볼이 `rustra_calculator_free_rkyv_v2_buffer`로 분리됐습니다. JSI C++ 동기 경로도 함께 교체 — 두 free 심볼은 교환 불가입니다.
- **별트랙 명시 유보** (SPEC 범위 제외): 배치 항목별 취소 네이티브, WASM/Electron, 프리빌트 배포, 무중단 주입, async 핸들러 trait 비동기화, JSI caller-buffer 기기 측정.
