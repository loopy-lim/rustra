# @rustra/react-native

React Native 네이티브 모듈을 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다.

## JSON 호환 엔진

```ts
type ReactNativeRustraModule = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
};

type ReactNativeEngineClient = {
  invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T>;
};

function createReactNativeEngine(nativeModule: ReactNativeRustraModule): ReactNativeEngineClient;
```

## 사용 예시

```ts
import { configure, createReactNativeEngine } from '@rustra/react-native';
import { installRustraJSI } from 'your-rustra-native-module';

await installRustraJSI();
const native = globalThis.__rustraNative;
configure(createReactNativeEngine(native));
```

JSON은 UTF-8 `ArrayBuffer` 요청/응답을 사용하며 Hermes에 `TextEncoder`/
`TextDecoder`가 없어도 동작한다. 취소와 `timeoutMs`는 공통 `EngineClient`
계약을 따른다.

## rkyv V2 고속 엔진

```ts
import { configure, createFastEngine, getRustraNative } from '@rustra/react-native';
import { rkyvV2Registry } from './generated/rkyv-registry.js';

configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
```

## 주의사항

이 npm 패키지는 JavaScript 어댑터이며 네이티브 JSI 바이너리를 포함하지 않는다.
앱은 자신의 Rust 패키지를 연결한 iOS/Android 네이티브 모듈을 제공하고 앱 시작
시 설치해야 한다. 저장소의 `examples/react-native-calculator/modules/rustra-jsi`
는 동작하는 참조 구현이지만 아직 범용 prebuilt npm 모듈은 아니다.

따라서 `bun add @rustra/react-native`만으로 네이티브 호출이 활성화되지는 않는다.
현재 검증된 설정과 빌드 흐름은 저장소의 React Native calculator README를 따른다.
어댑터 자체는 `react-native`, Expo, Nitro Modules를 직접 import하지 않으므로
생성 커맨드와 엔진 계약은 특정 RN 네이티브 구현에 종속되지 않는다.
