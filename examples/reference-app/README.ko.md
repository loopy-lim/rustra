# @rustra/example-reference-app

`@rustra/react` 훅(useCommand/useMutation/useEvent/RustraProvider)의 레퍼런스
앱 — CRUD + 이벤트 흐름을 어떻게 구성하는지 보여준다.

## 구조

```
src/
  App.tsx     훅 사용 UI 트리 (플랫폼 무관 — 엔진만 교체)
  app.ts      Node 진입점 — mock 엔진 + RustraProvider 로 App 렌더/검증
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

스모크는 실제 훅 트리를 실행해 CRUD 왕복을 검증한다 (mock 엔진 경유).

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

## 무엇을 증명하나

- `useCommand` — 마운트 시 자동 실행, input 변경 시 재실행, `commandId`
  기반 minify-안전 식별
- `useMutation` — 낙관적 갱신 없이 성공/실패 콜백 구성
- `useEvent` — 이벤트 구독 정리(unsubscribe)
- `RustraProvider` — 엔진 스코프 주입
