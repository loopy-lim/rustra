# 위협 모델 (A06)

상태: 초판 — 2026-09-07. 안정화 통합 트랙의 보류 항목 A06
(`docs/plans/2026-09-05-stabilization-unified.md`: "위협 모델 — 격리 요건이
생길 때"). 이 문서는 존재하지 않는 완화책을 만들지 않는다 — "완화" 열의
모든 항목은 오늘 이 저장소에 실재하는 코드를 가리킨다. 코드로 뒷받침되지
않는 것은 전부 [미해결 간극](#미해결-간극)에 적는다.

## 범위

rustra-bridge는 Rust 엔진과 TypeScript 브릿지 계층으로, JS 런타임(Node,
Bun, Tauri WebView, React Native)이 이진 FFI 경계를 넘어 컴파일된 Rust
명령 핸들러를 호출하게 한다. 아래 자산·경계는 현재 출하 형태 그대로의
`crates/rustra`, `packages/*`, 코드젠 클라이언트, CI/CD 표면을 다룬다.

범위 밖: 호스트 OS·WebView 엔진·JS 런타임 자체의 보안, 사용자 명령
핸들러 내부의 애플리케이션 수준 인가(rustra가 소유하는 경계는 capability
시스템까지다).

## 자산

| ID | 자산 | 중요한 이유 |
|----|------|------------|
| A1 | Rust 명령 핸들러(네이티브 로직, 호스트가 부여한 파일/네트워크/프로세스 접근) | 프로세스 내 최고 권한 코드 |
| A2 | FFI 경계의 프로세스 메모리 | 잘못된 길이의 해제·경계 외 읽기 1회가 곧 호스트 앱의 메모리 손상 |
| A3 | 와이어 프로토콜(rkyv V2 / JSON 프레임) | 파서 결함 = Rust의 메모리 안전 결함 |
| A4 | 이벤트 채널(`rustra://…`) | 핸들러 출력 유출·위조 방송으로 앱 상태 혼란 |
| A5 | 전역 엔진 슬롯(버전 부여된 `Symbol.for` 키) | 소유자가 JS 영역의 모든 `invoke`를 라우팅 |
| A6 | 공급망(crates.io·npm 의존성, 생성 코드) | 침해 시 모든 소비 앱에 실려 배포 |

## 신뢰 경계

1. **JS → Rust FFI 진입점**(`rustra_ffi_invoke*` 계열,
   `crates/rustra/src/ffi*.rs`). 여기 도착하는 모든 바이트는 길이를
   포함해 신뢰하지 않는다 — 페이로드 크기 게이트는 복사 **이전**에
   실행된다(`ffi_async_entries.rs`, `limits.rs`의 `max_payload_bytes()`).
2. **JSI 경계**(React Native, `packages/react-native/src/`). JSI 표면
   (`RustraJSINative`: `invoke(ArrayBuffer)`, `onEvent`, `createChannel`,
   `dropChannel`)에는 출처/권한 격리가 없다 — RN 컨텍스트에 적재된 모든
   JS가 호출할 수 있다. rustra의 방어는 JS 쪽이 아니라 Rust 쪽(A1
   capability 검사)에 있다.
3. **Rust → JS 이벤트 푸시**(`events.rs`, Tauri `emit`, RN
   `DeviceEventEmitter`). 브로드캐스트 신뢰 모델 — JS 영역의 모든 리스너가
   모든 `rustra://` 이벤트를 수신한다.
4. **역직렬화기**(`rkyv_decode.rs`, 어댑터의 JSON 경로). 정의상 신뢰하지
   않는 입력 — rkyv V2 디코더는 수동 작성된 경계 검사 커서 디코더다(모든
   슬라이스 앞에 길이 접두사를 `payload.len()`과 대조, 문자열은
   `from_utf8` 검증).
5. **코드젠/빌드 파이프라인**(`packages/cli`). `schema.json`이 단일
   진실원 — 생성물은 codegen `--check`와 `.rustra-generated.json`
   매니페스트로 보호된다.

## STRIDE 매핑

| 위협 (STRIDE) | 발생 위치 | 완화 (실제 코드) | 잔여 |
|---|---|---|---|
| **S** — 스푸핑: 위조 이벤트 전달 | `rustra://` 채널의 JS 리스너 | `event_channel()`이 모든 채널에 `rustra://` 접두사를 붙이고 `sanitize_event_name()`(`tauri_support.rs`)이 Unicode 영숫자 + `-/:/_` 만 허용; 이벤트는 핸들러가 발행한 페이로드만 실는다 | 같은 영역의 어떤 JS든 *구독*할 수 있고 호스트 이미터를 통해 그 네임스페이스로 *발행*할 수도 있다 — 이벤트별 출처 인증 없음. 동일 영역 신뢰 가정 — **미해결** |
| **S** — 스푸핑: 전역 엔진 슬롯 탈취 | `Symbol.for` 전역(`global-state.ts`) | 키가 **버전 부여**됨(`dev.rustra.types.v0.4.0.*`) — 버전이 다르면 대화 불가 | 마지막에 등록된 bootstrap이 이김(R08, 안정화 문서); 한 영역 내 라이브러리 간 슬롯 선점은 **미해결** |
| **T** — 변조: malformed invoke 프레임 | FFI 진입점 | 복사 전 크기 게이트(`payload.too_large`, 기본 1 MiB, `limits.rs`); `command_id`를 동결된 레지스트리에서 조회(`command.not_found`, `invoke_dispatch.rs`); 인자는 필드별 검사로 디코드(`command.invalid_args`) | 이 경로에서 알려진 것 없음 |
| **T** — 변조: 조작된 rkyv V2 페이로드 | `rkyv_decode.rs` | 수동 작성 경계 검사 커서 디코드(신뢰하지 않는 바이트의 `unchecked` 재해석 없음); 문자열 필드별 UTF-8 검증; 주간 fuzz(`fuzz.yml`, 시드 코퍼스, `invoke_rkyv_v2` 10분 실행); 코어 로직 주간 miri(`miri.yml`) | fuzz/miri는 실험 트랙(`continue-on-error`)이지 게이트가 아니다 — 커버리지는 최선 노력. **미해결(수용)** |
| **T** — 변조: OTA/클라이언트 불일치 라우팅 | command_id alias(`builder_capabilities.rs`) | 다른 명령의 실제 id를 그림자칠 alias는 선언/빌드 시점에 거부(panic — 조용히가 아니라 크게) | 알려진 것 없음 |
| **R** — 부인 | invoke/감사 흔적 | 범위 밖: rustra는 라이브러리다 — 내장 감사 로그 없음. 부인 방지 증거가 필요한 호스트는 자기 경계에서 로깅해야 한다 | **설계상 미해결** |
| **I** — 정보 유출 | 에러 프레임, 이벤트 페이로드 | 에러 프레임은 구조화된 `code` + 메시지만 실는다(`error.rs`) — raw 포인터·힙 주소·백트레이스는 경계를 넘지 않는다 | 핸들러 작성자의 메시지는 그대로 흐른다 — 유출 규율은 핸들러 작성자의 책임. **미해결(문서화된 기대)** |
| **D** — DoS: 네이티브 과부하 | async FFI 풀 | 고정 풀(워커 2) + bounded 큐(256)에서 즉시 `invoke.backpressure` 거부 — hang 없음, 스레드 폭증 없음(`ffi_pool.rs`); 페이로드 크기 게이트; 이벤트 버스는 drop-oldest + `dropped` 카운터(1024 상한, `events.rs`) | 풀/큐 상수는 고정이며 호스트별 조정 불가; 과부하 *계측*은 A08 카운터(`async_pool_stats()`)가 들어온 시점부터 존재. 실행기 튜닝은 측정 근거가 쌓일 때까지 보류 — **미해결(A08 잔여)** |
| **D** — DoS: 버퍼를 통한 메모리 고갈 | caller-buffer `_into` 경로 | 용량 검사 쓰기 + heap 프레임 폴백(`ffi_typed_async.rs`); 복사 전 `payload.too_large` | 알려진 것 없음 |
| **E** — 권한 상승: capability 게이트 명령 호출 | 레지스트리 디스패치 | **deny-by-default**: `required_capability`가 있는 명령은 부여 전 handler 실행 *이전*에 `capability.denied`로 거부(`registry.rs`); 부여는 `Package::grant_capability`만; `build()` 후 레지스트리 동결(구조 mutation 거부, grant는 허용) | capability 게이팅은 **명령별 opt-in** — `capability = "…"` 없이 선언된 명령은 브릿지에 닿는 모든 JS가 호출 가능. 이것이 문서화된 계약이지만, 새 패키지의 기본 자세가 allow라는 뜻이기도 하다 — **미해결(설계 결정, 격리 요건 발생 시 재검토)** |
| **E** — FFI 오용을 통한 메모리 안전 EoP | `rustra_ffi_free` | 디버그 전용 할당 추적기가 잘못된 길이/이중 해제/외부 포인터 해제를 분류하고 크게 abort(`ffi_free_guard.rs`) | 추적기는 release에서 컴파일 아웃 — release 빌드는 적대적 *호출자*의 `unsafe` FFI 오용을 건전하게 막을 수 없다. **미해결(FFI의 근본 한계, 소스 내 문서화됨)** |
| **E** — 공급망 침해 | crates.io / npm 의존성 | CI 게이트: 고정된 업스트림 예외 목록으로 `cargo audit --deny warnings`(양쪽 lockfile, `scripts/audit-rust.sh`), 라이선스/밴/출처의 `cargo-deny`(`ci.yml`); lockfile 커밋됨 | 대응하는 npm 측 자문 게이트(예: `bun pm audit`)가 CI에 없다 — **미해결**; 생성 코드 무결성은 git + 매니페스트에 의존, 서명 없음 — **미해결** |

## 경계별 요약

- **FFI의 신뢰하지 않는 JS 입력**: 크기 게이트 → 레지스트리 조회 → 스키마
  디코드 → capability 검사 → 핸들러. 각 실패 모드는 안정적인 에러 코드
  (`payload.too_large`, `command.not_found`, `command.invalid_args`,
  `capability.denied`, `invoke.backpressure`, `transport.*`, `cancelled`)를
  가지므로 JS 계층이 추측 없이 정규화할 수 있다(`normalizeRustraError`,
  `errors.ts`).
- **역직렬화(rkyv V2 / JSON)**: rkyv V2 디코드는 전면 수동·경계 검사;
  JSON 경로는 어댑터에 있으며 표준 파서와 에러 프레임용
  `parseRustraErrorString`을 지난다. rkyv 경로가 fuzz 대상; JSON 파싱
  에러는 FFI를 넘는 예외가 아니라 타입된 에러로 드러난다.
- **RN JSI**: JSI 모듈은 의도적으로 얇다 — 모든 신뢰 결정은 Rust에서
  이루어진다. JS 쪽 `exactArrayBuffer` 검사가 경계 통과 전 형태를 지킨다.
- **이벤트 채널 스푸핑**: 네임스페이스 + 살균화가 우발적 충돌과 호스트
  이벤트와의 교차를 막는다; 의도적인 동일 영역 스푸핑은 모델 밖(미해결
  간극 참조).
- **공급망**: audit + deny가 Rust 의존성을 게이트; npm 쪽은 미해결.

## 미해결 간극

1. **동일 영역 신뢰**: WebView/RN 컨텍스트의 모든 JS가 브릿지를 호출하고
   `rustra://` 채널을 구독(호스트 이미터를 통해 발행까지)할 수 있다. 이
   완화에는 아직 존재하지 않는 영역별 격리 요건이 필요하다 — A06이
   보류됐던 정확한 이유다("격리 요건이 생길 때").
2. **capability 게이팅은 opt-in**: "게이트 없는 명령 전면 거부" 스위치가
   없다.
3. **전역 엔진 슬롯**: 마지막 bootstrap 승리(R08) — loud-fail 가드는
   안정화 트랙에 계획됐지 여기에는 없다.
4. **release 빌드의 FFI 오용**: free-guard는 설계상 디버그 전용이다.
5. **npm 의존성 자문**이 CI에서 게이트되지 않는다.
6. **fuzz/miri/ASan은 실험 트랙**(`continue-on-error`)이지 필수 게이트가
   아니다 — 발견은 수동 수확.
7. **카운터 너머의 과부하 계측**: A08 최소 슬라이스
   (`rustra::ffi::async_pool_stats()`)가 제출/거부/완료 수를 측정한다 —
   큐 깊이 히스토그램, 명령별 귀속, 실행기 튜닝은 측정 근거가 쌓일 때까지
   남은 과제.

## 유지 보수

다음 경우 이 문서를 재검토한다: 새 신뢰 경계 추가(신규 호스트 어댑터),
와이어 포맷 변경, 위 미해결 간극의 폐쇄. STRIDE 표의 "완화" 열은 항상
실제 코드 경로를 지칭해야 한다 — 완화가 제거되면 같은 변경에서 해당 행을
미해결 간극으로 옮긴다.
