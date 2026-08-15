# @rustra/types

rustra-bridge의 핵심 타입 패키지입니다. 모든 플랫폼 어댑터(Node, Bun, Tauri,
React Native, Lynx)가 공유하는 `EngineClient` 인터페이스, 에러 타입, rkyv V2
코덱, Tauri-like 글로벌 invoke를 제공합니다.

## 공개 API 개요

```ts
// 플랫폼별 엔진을 한 번만 설정
import { configure } from '@rustra/types';
import { createRkyvV2Engine } from '@rustra/react-native';
configure(createRkyvV2Engine(native, registry));

// 어디서든 타입 안전 호출 (generated 클라이언트 내부에서 사용)
import { addNumbers } from './generated/commands.js';
const result = await addNumbers({ a: 42, b: 58 });
```

주요 익스포트:

- `EngineClient` — `invoke<T>()` (+선택적 `invokeBatch`) 공통 인터페이스
- `configure()` / `invoke()` — 글로벌 invoke (Tauri-like 단일 진입점)
- `RustraCommandError` — 직렬화 가능 에러 + `parseRustraErrorString`
- rkyv V2 코덱 — Rust `invoke_rkyv_v2` 왕복용 pure-JS 인코더/디코더
- `contractHash` 검증 — 빌드 시 계약과 런타임 계약 일치 확인

## 관련 문서

- [rustra-bridge](https://github.com/loopy-lim/hostra#readme)
- `docs/architecture.md`, `docs/compatibility-contract.md`
