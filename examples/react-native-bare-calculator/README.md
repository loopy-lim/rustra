# Bare React Native zero-config fixture

Expo dependency 없이 React Native 0.81에서 Rustra generated package의 TypeScript
해석과 iOS/Android autolinking을 검증하는 fixture입니다.

```bash
bun install
bun run codegen
bun run typecheck
bun run test:autolink
```

`rustra.json`은 monorepo의 app crate 위치만 지정합니다. Cargo package/library,
Podspec, Gradle, CMake, JavaScript bootstrap은 생성기가 추론하거나 생성합니다.

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 20, b: 22 });
```

[`App.tsx`](App.tsx)는 Expo import나 수동 native 설치 없이 Button → generated command
→ React state 갱신까지 이어지는 전체 화면 예제입니다. 실제 앱도 같은
`@rustra/generated-react-native` autolink package를 사용합니다.

이 fixture는 autolinking 계약을 검증하며 simulator/device 런타임 증거를 대신하지
않습니다. 실제 네이티브 build/link는 Expo 비교 앱의 iOS/Android CI와 로컬 native
build 게이트가 담당합니다.
