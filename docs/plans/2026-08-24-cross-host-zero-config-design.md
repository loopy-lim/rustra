# Cross-host zero-config design

## 결정

공개 command 계약은 계속 host-neutral `commands.ts`에 둔다. 플랫폼별 생성 진입점만
초기화를 소유한다.

| Host         | 생성 진입점       | 기본 탐색                                   | 명시적 escape hatch             |
| ------------ | ----------------- | ------------------------------------------- | ------------------------------- |
| Node         | `node.ts`         | Cargo binary, Release → Debug, cwd ancestor | `RUSTRA_NODE_BINARY`            |
| Bun          | `bun.ts`          | Cargo cdylib, ABI probe, Release → Debug    | `RUSTRA_BUN_LIBRARY`            |
| Tauri        | `tauri.ts`        | `globalThis.__TAURI__.core/event`           | `createTauriEngine({ invoke })` |
| React Native | `react-native.ts` | generated autolinked JSI module             | custom native transport         |

`rustra.json`의 host 값은 모두 빈 객체로 시작할 수 있다. Cargo workspace가 모호한
경우에만 `rustManifest`, `rustPackage`, `rustBinary`, `rustLibrary`를 지정한다.

## 충돌 방지

- generated client는 host adapter를 직접 섞지 않는다. 앱은 하나의 플랫폼 진입점만
  import한다.
- CLI는 기존 dependency가 다른 release line을 가리키면 덮어쓰지 않고 실패한다.
- `@rustra/types` runtime state는 `0.4.0` versioned global symbol을 사용해 동일 버전의
  중복 설치만 공유한다.
- adapter가 등록한 lazy initializer보다 이후의 명시적 `configure()`가 우선한다.
- Tauri는 `@tauri-apps/api`를 강제 dependency로 넣지 않아 앱의 Tauri 버전과 충돌하지
  않는다.

## 수명과 실패 정책

- Bun FFI 응답은 Rust 메모리를 빌린 상태에서 JS 소유 `ArrayBuffer`로 복사하고, 반환된
  정확한 pointer/length 쌍으로 즉시 해제한다.
- 존재하는 library도 ABI symbol과 `rustra_mobile_init` 호출이 실패하면 stale 후보로
  간주하고 다음 profile로 넘어간다.
- Node transpile/bundle은 source-relative path를 깨뜨릴 수 있으므로 binary 이름을 함께
  생성하고 cwd ancestor 탐색을 보조 경로로 쓴다.
- 자동 탐색이 실패하면 추측 실행을 하지 않고 build 명령과 host별 환경변수를 안내한다.

## 버전 정책

`rustra`, `rustra-macros`, 공개 npm 패키지 9개는 하나의 release line이다. Changesets
fixed group과 release coherence gate가 다음 릴리스부터 모든 버전이 함께 올라가는지
검증한다.

## 증거 기준

- Node: transpiled generated entry에서 실제 Rust process 왕복
- Bun: generated entry에서 stable FFI, contract hash, rkyv V2 왕복
- Tauri: Bun-built browser bundle, Tauri release build, Rust runtime probe, global adapter test
- React Native: Expo와 bare autolinking, iOS/Android native build, simulator receipt

실제 Tauri WebView 사용자 조작, Android emulator/physical device, 모바일 실기기 성능은
각각 별도 runtime proof로 남긴다.
