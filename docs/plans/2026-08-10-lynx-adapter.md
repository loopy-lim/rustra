# Lynx Host Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** rustra 지원 host에 Lynx(ReactLynx) 어댑터를 추가한다. rkyv V2 바이너리 fast-path를 처음부터 내장하며, iOS + Android 모바일을 타겟팅한다.

**Architecture:** Rust FFI 심볼(`rustra_calculator_invoke_rkyv_v2`)과 host-neutral `createRkyvV2Engine`(`@rustra/types`)을 재사용한다. 새로 작성할 것은 (1) TS 어댑터 `packages/lynx`(RN 어댑터 복사, 글로벌만 `NativeModules.RustraModule`로 교체), (2) Lynx Native Module(iOS Obj-C `<LynxModule>` + Android Kotlin `@LynxMethod`) 두 개뿐이다. 상세 설계는 `docs/plans/2026-08-10-lynx-adapter-design.md`를 참조.

**Tech Stack:** TypeScript(어댑터), Objective-C(Lynx Module iOS), Kotlin/JNI(Android), Rust staticlib(재사용), ReactLynx + rspeedy(예시).

**참조 API (재사용, 변경 금지):**

```ts
// @rustra/types
export type RkyvV2SchemaNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  getSchema?(): ArrayBuffer;
};
export function createRkyvV2Engine(
  native: RkyvV2SchemaNative,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient;
```

---

## Phase 1: TS 어댑터 (`packages/lynx/`) — 자동화 가능, TDD

### Task 1: 패키지 스캐폴드

**Files:**

- Create: `packages/lynx/package.json`
- Create: `packages/lynx/tsconfig.json`
- Create: `packages/lynx/README.md`

**Step 1: package.json 작성** (`packages/react-native/package.json`을 복사해 이름/키워드만 Lynx로 교체)

```json
{
  "name": "@rustra/lynx",
  "version": "0.1.0",
  "description": "Lynx (ReactLynx) adapter for rustra-bridge",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "test": "tsc --noEmit"
  },
  "dependencies": { "@rustra/types": "^0.1.0" },
  "devDependencies": { "typescript": "^5.9.0" },
  "keywords": ["rustra", "bridge", "lynx", "reactlynx", "adapter"],
  "repository": {
    "type": "git",
    "url": "https://github.com/loopy-lim/rustra.git",
    "directory": "packages/"
  },
  "bugs": { "url": "https://github.com/loopy-lim/rustra/issues" },
  "homepage": "https://github.com/loopy-lim/rustra#readme"
}
```

**Step 2: tsconfig.json** (RN 것과 동일)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: README.md** (RN 것을 Lynx로 변환 — `NativeModules.RustraModule` 예시)

### Task 2: 어댑터 + 실패 테스트 작성 (TDD)

**Files:**

- Create: `packages/lynx/src/index.ts`
- Test: `packages/lynx/src/index.test.ts`

**Step 1: 실패 테스트 작성** (RN의 `index.test.ts`를 rkyv V2 경로 기반으로 복사)

`packages/lynx/src/index.test.ts` — 모킹 `invokeRkyvV2(ArrayBuffer): ArrayBuffer` 네이티브로 `createFastEngine` 검증. RN 테스트(`createReactNativeEngine` JSON 경로)를 `createFastEngine` + codec 경로로 치환. 핵심 케이스:

- fast engine이 codec 인코딩 → native.invokeRkyvV2 → codec 디코딩으로 라우팅
- 에러 응답(`ok:false`) throw
- `getRustraNative()` — `globalThis.NativeModules.RustraModule` 없을 때 throw

**Step 2: 테스트 실행해 실패 확인**

Run: `cd packages/lynx && bun --bun test src/index.test.ts` (또는 `node --test`)
Expected: FAIL (모듈 미존재 / import 에러)

**Step 3: 최소 구현** `packages/lynx/src/index.ts`

```ts
import type {
  EngineClient as EngineClientType,
  RkyvV2Codec,
  RkyvV2SchemaNative,
} from '@rustra/types';
import { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

export type { EngineClient, RustraError, RkyvV2Codec, RkyvV2SchemaNative } from '@rustra/types';
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';

export type RustraLynxNative = RkyvV2SchemaNative;

export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, RkyvV2Codec<any, any>>;
};

export function getRustraNative(): RustraLynxNative {
  const mods = (globalThis as Record<string, unknown>).NativeModules as
    Record<string, RustraLynxNative> | undefined;
  const native = mods?.RustraModule;
  if (!native) {
    throw new Error(
      'Lynx NativeModules.RustraModule not registered. Register RustraModule via [globalConfig register_module:] (iOS) or Lynx module setup (Android).',
    );
  }
  return native;
}

export function createFastEngine(
  native: RustraLynxNative,
  options: FastEngineOptions,
): EngineClientType {
  return createRkyvV2Engine(native, options.rkyvV2Codecs);
}

// JSON 폴백(옵션) — Lynx 네이티브 모듈이 JSON invokeRaw도 노출할 때 사용
export type RustraLynxJsonNative = { invoke(payload: ArrayBuffer): ArrayBuffer };

export function createLynxEngine(native: RustraLynxJsonNative): EngineClientType {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const payload = encoder.encode(JSON.stringify({ command, args }));
      const resp = JSON.parse(decoder.decode(native.invoke(payload.buffer))) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!resp.ok) throw new Error(resp.error ?? 'Rustra invoke failed');
      return Promise.resolve(resp.result as T);
    },
  };
}
```

**Step 4: 테스트 실행해 통과 확인**

Run: `cd packages/lynx && bun --bun test src/index.test.ts`
Expected: PASS

**Step 5: 타입 체크**

Run: `cd packages/lynx && bun run test` (`tsc --noEmit`)
Expected: 에러 없음

**Step 6: 빌드**

Run: `cd packages/lynx && bun run build`
Expected: `dist/` 생성

**Step 7: 루트 테스트 체인에 추가 + Commit**

루트 `package.json`의 `test:adapters`/`test:compat`에 `test:adapter:lynx` 추가.

```bash
git add packages/lynx
git commit -m "feat(lynx): @rustra/lynx 어댑터 — rkyv V2 fast-path + JSON 폴백"
```

---

## Phase 2: iOS 네이티브 모듈 — 환경 의존 (Xcode, CocoaPods, Lynx SDK)

> Lynx Explorer 또는 통합 앱 프로젝트가 필요. 자동 검증 어려움 — 수동 빌드/실행.

### Task 3: Rust iOS 크로스컴파일 스크립트

**Files:**

- Create: `examples/lynx-calculator/modules/rustra-lynx/ios/build-rust-ios.sh` (RN의 `rustra-jsi/ios/build-rust-ios.sh` 복사)

**Step 1:** RN 스크립트 복사 → crate 경로/출력 확인. `aarch64-apple-ios-sim` + `aarch64-apple-ios` 타겟.
**Step 2:** `cargo build -p rustra-calculator-example --lib --release` for iOS targets → `rust/lib/librustra_calculator_example.a`.
**Step 3:** FFI free 심볼 확인 — `rustra_ffi_free` 또는 `rustra_calculator_free_*`가 staticlib에 노출되는지 `nm`로 검증.

### Task 4: Obj-C `RustraModule <LynxModule>`

**Files:**

- Create: `examples/lynx-calculator/modules/rustra-lynx/ios/RustraModule.h`
- Create: `examples/lynx-calculator/modules/rustra-lynx/ios/RustraModule.m`
- Create: `examples/lynx-calculator/modules/rustra-lynx/ios/RustraLynx.podspec`

**Step 1:** design doc의 Obj-C 스니펫으로 `RustraModule` 구현 — `+name`, `+methodLookup`(`invokeRkyvV2`), `-invokeRkyvV2:(NSData*)` → `rustra_calculator_invoke_rkyv_v2` → `NSData` 반환 + free.
**Step 2:** podspec — `vendored_libraries = 'rust/lib/librustra_calculator_example.a'`, `force_load`.
**Step 3:** `setupLynxEnv`에서 `[globalConfig register_module:RustraModule.class]`.
**Step 4 (리스크 검증):** Lynx Native Module의 **동기 반환** 지원 확인. `invokeRkyvV2`가 `NSData*`를 직접 반환하는지, callback만 지원하는지. callback 전용이면 TS 어댑터의 엔진 팩토리를 Promise 래핑으로 조정.
**Step 5:** 빌드 + Lynx Explorer에서 `addNumbers` 호출 → 42 확인.

### Task 5: 예시 앱 (iOS) + Commit

**Files:**

- Create: `examples/lynx-calculator/` (ReactLynx + rspeedy 스캐폴드)
- Create: `examples/lynx-calculator/src/App.tsx`
- Create: `examples/lynx-calculator/src/typing.d.ts` (`declare let NativeModules: { RustraModule: { invokeRkyvV2(...): ArrayBuffer } }`)

**Step 1:** `npm create rspeedy@latest` 기반 스캐폴드.
**Step 2:** `App.tsx`에서 `configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: registry }))` 후 `addNumbers({a:20,b:22})`.
**Step 3:** Lynx Explorer QR 스캔 → 결과 42.
**Step 4:** Commit.

```bash
git add examples/lynx-calculator
git commit -m "feat(lynx): iOS 예시 앱 + Obj-C RustraModule (Lynx Module API)"
```

---

## Phase 3: Android 네이티브 모듈 — 환경 의존 (Android SDK, NDK, cargo-ndk)

> rustra-bridge에 Android 레퍼런스 없음. JNI + cargo-ndk를 새로 잡아야 함.

### Task 6: Rust Android 크로스컴파일

**Files:**

- Create: `examples/lynx-calculator/modules/rustra-lynx/android/build-rust-android.sh`

**Step 1:** `cargo ndk`로 `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android` 타겟 빌드 → `librustra_calculator_example.a`.
**Step 2:** JNI 링크 확인 (`CMakeLists.txt`에서 `find_library` + static lib).

### Task 7: Kotlin `RustraModule` + JNI

**Files:**

- Create: `examples/lynx-calculator/modules/rustra-lynx/android/src/main/java/.../RustraModule.kt`
- Create: `examples/lynx-calculator/modules/rustra-lynx/android/src/main/cpp/rustra_jni.cpp`
- Create: `examples/lynx-calculator/modules/rustra-lynx/android/src/main/cpp/CMakeLists.txt`

**Step 1:** `RustraModule.kt` — `@LynxMethod fun invokeRkyvV2(payload: ByteArray): ByteArray`, `com.lynx.react.bridge` 매핑.
**Step 2:** `rustra_jni.cpp` — `JNI_OnLoad`/정적 메서드 → `rustra_calculator_invoke_rkyv_v2` + `rustra_ffi_free`.
**Step 3:** 기기/에뮬레이터에서 `addNumbers` → 42 확인.
**Step 4:** Commit.

---

## Phase 4: 문서 + npm 스크립트

### Task 8: 문서 업데이트

**Files:**

- Modify: `README.md` (어댑터 표/설치/플랫폼 어댑터 섹션에 Lynx 추가)
- Create: `docs/extending/lynx-setup.md` (`react-native-setup.md`와 대칭)
- Modify: `docs/extending/adding-host.md` (결정 트리에 Lynx 분기: "Lynx? → C FFI → Lynx Module API")
- Modify: `docs/architecture.md` (어댑터 표/transport 다이어그램에 Lynx 추가)
- Modify: 루트 `package.json` (`test:adapter:lynx`, `test:runtime:lynx`, `test:compat`)

**Step 1:** 각 파일 수정.
**Step 2:** `npm run lint && npm run format:check` 통과.
**Step 3:** Commit.

```bash
git add README.md docs package.json
git commit -m "docs(lynx): Lynx 어댑터 가이드 + 아키텍처/README/adding-host 갱신"
```

---

## 리스크 재확인 (Phase 2 진입 전)

1. **Lynx Native Module 동기 반환** — fast-path 성능의 핵심. 미지원 시 callback→Promise.
2. **Android JNI** — 신규 인프라. cargo-ndk + ABI.
3. **Lynx SDK 버전(3.6)** — Native Module API 호환성.
4. **FFI free 심볼** — staticlib 노출 여부.
