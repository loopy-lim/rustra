// rustra.json 검증의 L2 — 교차 필드 의미 검사. L1(config-sections.ts)이 섹션 내부
// 유효성을 담당하는 반면, 여기는 필드 조합 위반을 전부 수집해 한 번에 나열한다.
// doctor 영역 환경 검사(devtools 설치 여부 등)는 여기 넣지 않는다 — 로드는 순수 함수.
import { WASM_ENGINES, type RustraConfig } from './config-schema.js';
import { unknownValueError } from './config-sections.js';

/**
 * L2 — 교차 필드 의미 검사. config 로드 경로에서 L1 통과 후 호출되며,
 * 위반을 하나도 놓치지 않고 전부 수집해 한 번에 나열한다(첫 위반에서 중단 않음).
 * 수집 순서는 고정 — reactNative 필요성, 잘못된 wasm/dylib 섹션 위치, parityGate,
 * engine. doctor 영역 환경 검사(devtools 설치 여부 등)는 여기 넣지 않는다 — 로드는 순수 함수.
 */
export function collectSemanticErrors(config: RustraConfig): string[] {
  const errors: string[] = [];
  const dev = config.dev;
  const target = dev?.target ?? 'native';

  if (target === 'wasm' && config.reactNative === undefined) {
    // wasm dev-target은 RN 어댑터의 staticlib 경로를 탄다 — RN 섹션이 필요하다.
    errors.push('dev.target "wasm" requires a reactNative section');
  }
  if (target !== 'wasm' && dev?.wasm !== undefined) {
    errors.push('dev.wasm is only valid when dev.target is "wasm"');
  }
  if (target !== 'wasm' && dev?.wasm?.parityGate !== undefined) {
    errors.push('dev.wasm.parityGate is only valid when dev.target is "wasm"');
  }
  if (target !== 'dylib' && dev?.dylib !== undefined) {
    errors.push('dev.dylib is only valid when dev.target is "dylib"');
  }
  if (target !== 'dylib' && dev?.dylib?.parityGate !== undefined) {
    errors.push('dev.dylib.parityGate is only valid when dev.target is "dylib"');
  }
  if (dev?.wasm?.engine !== undefined && !WASM_ENGINES.includes(dev.wasm.engine)) {
    // engine 미지 값이 L2 수집인 이유 — reactNative 요구 위반과 동시에 발생할 수 있어
    // 전부 나열해야 한다. 반면 dev.target/onMismatch 는 섹션 자체의 유효성이라 L1 fail-fast.
    // (신규 엔진 편성 시 WASM_ENGINES 만 갱신하면 타입·검증·메시지가 함께 따라간다.)
    // 문구는 L1 unknownValueError 와 동일하게 — did-you-mean + 허용값 표시를 통일한다.
    errors.push(unknownValueError('dev.wasm.engine', dev.wasm.engine, [...WASM_ENGINES]));
  }

  return errors;
}
