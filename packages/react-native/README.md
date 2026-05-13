# @rustra/react-native

React Native 네이티브 모듈을 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다.

## 공개 API

```ts
type ReactNativeRustraModule = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createReactNativeEngine(nativeModule: ReactNativeRustraModule): ReactNativeEngineClient;
```

## 사용 예시

```ts
import { createReactNativeEngine } from "@rustra/react-native";
import { NativeModules } from "react-native";

const engine = createReactNativeEngine(NativeModules.Rustra);
```

## 주의사항

이 패키지는 `react-native`, `expo`, `react-native-nitro-modules` 등을 직접 import하지 않습니다. 앱이 네이티브 모듈을 주입하므로, 생성된 커맨드 헬퍼는 특정 RN 아키텍처에 종속되지 않습니다.
