# @rustra/example-reference-app

`@rustra/react` 훅(useCommand/useMutation/useEvent/RustraProvider)의 레퍼런스
앱 — CRUD + 이벤트 흐름을 어떻게 구성하는지 보여준다.

## 구조

```
src/
  App.tsx     훅 사용 UI 트리 (플랫폼 무관 — 엔진만 교체)
  main.ts     Node 진입점 — 실 crud 런타임 상대로 훅 스모크 실행
```

`App.tsx`는 `../../crud/generated/commands.js`의 코드젠 산출물을 소비한다 —
crud 예제를 먼저 빌드해야 한다(아래 실행 참고).

## 실행 (Node 스모크)

```bash
# 저장소 루트에서
bun run test:app:reference
# 또는 직접:
cargo build -p rustra-crud-example && \
  tsc -p examples/reference-app/tsconfig.json && \
  node examples/reference-app/dist/examples/reference-app/src/main.js
```

스모크는 실제 훅 트리를 실행해 Node 프로세스 transport 로 실 `rustra-crud-example`
런타임 CRUD 왕복을 검증한다.

## 웹/RN으로 옮기기

UI 트리는 엔진 주입만 바꾸면 어디서든 동일하다:

```tsx
// RN
const engine = createReactNativeEngine(NativeModules.RustraJSI);
<RustraProvider engine={engine}>
  <App />
</RustraProvider>;

// 웹 (Tauri)
const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
<RustraProvider engine={engine}>
  <App />
</RustraProvider>;
```

### 채널도 4호스트 동형

역방향 스트림(`createChannel`)은 4호스트에서 동일 계약 `{ handle, close() }`를
노출한다 — `useMutation` 같은 훅 트리 안에서 핸들만 커맨드 인자로 통과시키면
Rust 가 회신을 푸시한다. 호스트별 발급자만 다르다:

```ts
// Node (loop-stdio) — createNodeChannel(loopTransport, cb)
// Bun (FFI) — createBunChannelBridge(options)(cb)
// Tauri — createChannel(cb) — 근사 유니캐스트(app.emit 브로드캐스트)
// RN (JSI) — createChannel(cb) — 네이티브 C++ 디스패처 직결
```

호스트별 지원 수준과 차이는
[호환성 매트릭스](../../docs/compatibility-matrix.md)의 Channels 행 참고.

## 무엇을 증명하나

- `useCommand` — 마운트 시 자동 실행, input 변경 시 재실행, `commandId`
  기반 minify-안전 식별
- `useMutation` — 낙관적 갱신 없이 성공/실패 콜백 구성
- `useEvent` — 이벤트 구독 정리(unsubscribe)
- `RustraProvider` — 엔진 스코프 주입
