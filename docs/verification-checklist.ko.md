English | [English](./verification-checklist.md)

# 호스트 검증 수동 체크리스트

CI에서 돌릴 수 없는(실제 WebView, 실기기, reload 타이밍) 검증 항목 — 실행과
기록을 손으로 해야 한다. 이 문서가 기록 양식이다: 항목별·실행별로 블록 하나를
채운다. 블록이 채워지지 않은 항목은 검증되지 않은 것이며,
[README "플랫폼 지원 매트릭스"](../README.ko.md)의 증거 수준을 올리는 데 쓸 수
없다.

자동화 대응물: calculator 통합 여정 테스트
(`examples/calculator/tests/journey.test.ts`)가 Node loop-stdio 실호스트 위에서
invoke → 이벤트 → progress → 취소 → 구독 해제 → 복구 → dispose 한 흐름을
커버한다. 아래는 자동화가 닿지 않는 잔여분이다.

## 기록 방법

항목마다 블록을 복사해 채운다:

```text
- 항목: <항목 번호와 제목>
- Host: <tauri-calculator / react-native-calculator / 기타>
- OS: <macOS 26 arm64 / Windows 11 / Ubuntu 24.04 / iOS 26 simulator / Android API 36 / 기기 모델>
- 빌드: <debug / release>
- SHA: <실행 시점 git rev-parse HEAD>
- 날짜: <YYYY-MM-DD>
- 결과: <PASS / FAIL / PARTIAL — 하위 단계별 메모>
- 증거: <receipt 경로 / 스크린샷 / 로그 발췌 — 선택이나 권장>
```

## 1. Tauri 실제 WebView (R01/R02/R03 + profiled 미노출)

범위: Tauri 어댑터의 WebView 전용 동작 — fixture가 경계를 시뮬레이션하므로 실물이
필요한 것들.

- [ ] **R01 — 콜백 경계 1회 실행.** 이벤트를 발생시키고 JS 콜백이 정확히 한 번
      실행되는지(재생·이중 전달 없음), 던지는 콜백이 재호출되지 않고 listener
      error 관측으로 귀결되는지 확인.
- [ ] **R02 — Unicode 채널명 엔드투엔드.** Rust에서 한글 이름 이벤트를
      `app.emit` 으로 발행하고, 같은 비 ASCII 채널명으로 만든 구독에서 수신.
- [ ] **R03 — payload 타입·값이 splice 를 넘어 보존.** 객체·문자열·원시값
      payload: 실제 WebView 는 `emit_str` JSON 을 `payload: {…}` 로 인라인하므로
      객체는 해석된 상태로 도착(신원 보존), 문자열은 정확히 한 번 `JSON.parse`,
      원시값은 실제 WebView 에선 원시값 그대로, 레거시 문자열 transport 에선
      원본 문자열(알려진 갈림 — 어느 쪽인지 확인).
- [ ] **production 등록에서 profiled dispatch 미노출.** production 커맨드
      레지스트리에서 profiled dispatch 진입점이 닿지 않아야 한다 — profiled
      전용 id/커맨드를 호출해 미등록 실패를 확인.

실행: `bun run test:runtime:tauri` (`examples/tauri-calculator` 빌드+smoke)에
더해 상호작용 단계는 `bun run --cwd examples/tauri-calculator tauri dev` 수동
세션. macOS 우선; Linux Tauri 는 build+smoke 증거까지만.

```text
- 항목: 1. Tauri 실제 WebView (R01/R02/R03 + profiled 미노출)
- Host:
- OS:
- 빌드:
- SHA:
- 날짜:
- 결과:
- 증거:
```

## 2. React Native 실호스트 (이벤트 형태, listener 예외, 재구독)

범위: 실제 RN 런타임 위의 RN 어댑터(JSON 및 rkyv V2 JSI). 시뮬레이터 수준이
현재 기준이고 실기기 실행은 별도 트랙이다 — 실제로 돌린 것을 빌드/OS 칸에 기록.

- [ ] **문자열 이벤트** 내용 온전히 전달.
- [ ] **원시값 이벤트** 원시값으로 전달(JSON 어댑터) — 같은 payload 의 rkyv V2
      경로 형태도 함께 기록.
- [ ] **Unicode 이벤트**(한글, emoji) 양쪽 어댑터에서 encode/decode 생존.
- [ ] **listener 예외 흡수** — 던지는 구독 콜백이 싱크/drain 루프나 다른
      구독자를 깨지 않고, 실패가 관측 가능해야 한다(listener error 경로 —
      무음 금지).
- [ ] **구독 해제 뒤 재구독** — unsubscribe 뒤 늦은 emit 은 전달되지 않고, 새
      구독은 새 emit 을 받는다.

실행: `examples/react-native-calculator` 를 iOS 시뮬레이터 및/또는 Android
에뮬레이터에서, 해당 README 기준으로.

```text
- 항목: 2. React Native 실호스트
- Host:
- OS:
- 빌드:
- SHA:
- 날짜:
- 결과:
- 증거:
```

## 3. emit 타이밍 정책 (호스트 불문)

범위: 모든 푸시 경로(Tauri emit, RN JSI 싱크, Bun FFI 싱크, Node stdout 프레임)가
문서화하는 4개 타이밍 경계. 내보내는 어댑터마다 최소 하나의 실호스트에서 확인.

- [ ] **등록 전 emit** — JS 구독이 존재하기 전의 `app.emit`(또는 호스트 emit).
      푸시 경로는 계약상 버리고, 폴링 경로는 보관할 수 있다. 내 어댑터의 동작이
      어느 쪽인지 확인.
- [ ] **구독 후 emit** — 정상 전달, 기준 케이스.
- [ ] **unsubscribe 후 emit** — 전달되지 않고, 오류 없고, 재구독 때 재생
      되지도 않는다.
- [ ] **reload 직후 늦은 emit** — dispose/reload 사이클과 경주하는 emit 이
      listener 를 되살리거나 호스트를 깨뜨리지 않아야 한다(버려질 수는 있다).

```text
- 항목: 3. emit 타이밍 정책 (대상 어댑터: ____ )
- Host:
- OS:
- 빌드:
- SHA:
- 날짜:
- 결과:
- 증거:
```

## 4. A09 — RN 실기기 ownership 관찰 (기록만)

범위: **실기기** RN 에서 cancel·teardown 흐름 뒤 ownership 이상 잔여 여부 관찰
(네이티브 핸들 보유, dispose 뒤 발화하는 콜백, 회수되지 않는 메모리). 이 항목은
관찰 기록만 담당한다 — sanitizer/누수 검출은 별도 트랙이며 이 체크리스트 밖이다.
관찰된 것이 없어도 결과다: "이상 관찰 안 됨" 또는 이상 내용을 적는다.

```text
- 항목: 4. A09 RN 실기기 ownership 관찰
- Host:
- OS (기기 모델 + OS 버전):
- 빌드:
- SHA:
- 날짜:
- 결과:
- 증거:
```

## 5. A11 준비 — 발행 승인 후 registry consumer 절차 (문서화만, 실행 금지)

범위: 발행이 승인된 뒤 한 번 실행할 절차. 검증 실행의 일부로 **실행하지
않는다** — 이 항목은 절차가 문서로 존재하고 찾을 수 있는지 확인한다.

1. npm 발행 워크플로우가 green 으로 끝나면, 이 워크스페이스 밖의 스크래치
   프로젝트에 발행된 `@rustra/*` 버전을 설치한다.
2. 발행된 `@rustra/types` 계약에 대해 발행된 CLI(`rustra codegen`)로 클라이언트를
   생성한다 — 워크스페이스 소스가 아니라.
3. calculator 예제의 generated-client 테스트를 그 산출물 위에서 실행한다.
4. 사용한 버전과 registry consumer 출력을 아래 블록에 기록한다.

```text
- 항목: 5. A11 registry consumer 절차
- Host:
- OS:
- 빌드: n/a (발행 산출물)
- SHA: <절차를 따른 커밋>
- 날짜:
- 결과:
- 증거:
```

## 다른 증거와의 관계

- 플랫폼 수준 증거 요약(현재 어느 수준까지 검증됐나):
  [README "플랫폼 지원 매트릭스"](../README.ko.md).
- 기능 × 어댑터 capability 차이: [호환성 매트릭스](compatibility-matrix.ko.md).
- 측정 receipt: [docs/benchmark-receipts/](benchmark-receipts/) 와
  [docs/benchmarks.ko.md](benchmarks.ko.md). 벤치 통과는 위 행동 검증의 대체가
  아니다.
