# @rustra/lynx

Lynx(ReactLynx) 네이티브 모듈을 공통 `EngineClient` 인터페이스로 변환하는 어댑터입니다. rkyv V2 바이너리 fast-path를 기본으로 제공합니다.

## 공개 API

```ts
// rkyv V2 fast-path (권장)
type RustraLynxNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  getSchema?(): ArrayBuffer;
};

function createFastEngine(
  native: RustraLynxNative,
  options: { rkyvV2Codecs: Map<string, RkyvV2Codec<any, any>> },
): EngineClient;

// JSON 폴백
function createLynxEngine(native: { invoke(payload: ArrayBuffer): ArrayBuffer }): EngineClient;

// Lynx 글로벌 NativeModules에서 네이티브 모듈 획득
function getRustraNative(): RustraLynxNative;
```

## 사용 예시

```ts
import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
import { rkyvV2Registry } from './generated/rkyv-registry.js';

// Lynx Native Module이 등록되어 있어야 함 (NativeModules.RustraModule)
configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));

// 생성된 커맨드 헬퍼는 모든 플랫폼에서 동일
const result = await addNumbers({ a: 20, b: 22 });
```

## 네이티브 모듈

이 어댑터는 Lynx 런타임이 주입하는 `NativeModules.RustraModule`을 사용합니다. 네이티브 모듈 등록은 앱 쪽에서 수행합니다:

- **iOS**: Objective-C `RustraModule <LynxModule>` — `[globalConfig register_module:RustraModule.class]`
- **Android**: Kotlin `@LynxMethod fun invokeRkyvV2(payload: ByteArray): ByteArray`

네이티브 모듈은 Rust staticlib의 `rustra_calculator_invoke_rkyv_v2` FFI를 호출합니다. 설정 가이드는 `docs/extending/lynx-setup.md`를 참조하세요.

## 주의사항

이 패키지는 `@lynx-js/*`, `react`, Lynx 런타임 등을 직접 import하지 않습니다. Lynx가 제공하는 `NativeModules` 글로벌에서 네이티브 모듈을 읽으므로, 생성된 커맨드 헬퍼는 특정 Lynx 아키텍처에 종속되지 않습니다.
