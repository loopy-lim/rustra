/**
 * @rustra/cli — 커맨드별 디바이스 역량 렌더러
 *
 * 스키마 명령 항목의 `devices` 선언에서 `devices.ts`를 생성한다 — 패키지가
 * 선언에 사용한 토큰의 리터럴 유니언(`RustraDeviceCapability`) + 커맨드별
 * `{FN}_DEVICES` 상수. 선언은 계약 문서다 — 런타임 자동 게이팅이나 OS 권한
 * 요청은 없고, 가용성/권한 조회는 호스트가 등록한 provider 표면
 * (`getDeviceStatus`) 몫이다(설계 B/D절).
 *
 * 선언 커맨드가 1건이라도 있으면 파일 내용을, 없으면 빈 문자열을 반환한다
 * (events.ts/errors.ts 관례 — 선언 없는 패키지는 기존 출력과 바이트 동일).
 */
import type { CommandSchema, PackageSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { finishGeneratedText } from './generate-surface.js';

/**
 * Rust `DeviceCapability::ALL` 카탈로그 21종의 CLI 미러 — 원천은
 * crates/rustra/src/device_capabilities.rs (선언 순서 = 문서 교차표 순서).
 * 서로 다른 언어라 계약 테스트로 못 박을 수 없어 이 주석이 유일한 연결 고리다 —
 * 카탈로그에 토큰이 추가되면 이 배열도 rustra 릴리스와 함께 갱신한다.
 */
const DEVICE_CAPABILITY_CATALOG: readonly string[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
  'wifi',
  'bluetooth',
  'battery',
  'nfc',
  'biometric',
  'haptics',
  'flashlight',
  'contacts',
  'calendar',
  'photo-library',
  'motion',
  'usb',
  'serial',
  'network-state',
  'screen-brightness',
];

/** 카탈로그 순 인덱스 — 같은 토큰 집합은 선언 순서와 무관하게 같은 유니언을 만든다. */
const CATALOG_ORDER = new Map(DEVICE_CAPABILITY_CATALOG.map((token, index) => [token, index]));

export function generateDevicesTs(schema: PackageSchema): string {
  const declared = schema.commands.filter((command) => (command.devices?.length ?? 0) > 0);
  if (declared.length === 0) return '';

  const usedTokens = new Set<string>();
  const surfaces: { fnName: string; constant: string; tokens: string[] }[] = [];
  const constants = new Set<string>();
  for (const command of declared) {
    const tokens = sortedCatalogTokens(command);
    for (const token of tokens) usedTokens.add(token);

    const fnName = commandFunctionName(command.name);
    const constant = `${constantCase(fnName)}_DEVICES`;
    if (constants.has(constant)) {
      throw new Error(
        `Invalid schema: commands colliding on device constant '${constant}' ('${command.name}' declared twice?) — ` +
          `${constant} would be emitted more than once`,
      );
    }
    constants.add(constant);
    surfaces.push({ fnName, constant, tokens });
  }

  const union = [...usedTokens]
    .sort(byCatalogOrder)
    .map((token) => `'${token}'`)
    .join(' | ');
  let output = `/** 이 패키지가 선언에 사용한 디바이스 역량 토큰 (Rust 카탈로그 기준). */\n`;
  output += `export type RustraDeviceCapability = ${union};\n`;
  for (const surface of surfaces) {
    const list = surface.tokens.map((token) => `'${token}'`).join(', ');
    output += `\n`;
    output += `/** ${surface.fnName} 가 전제하는 디바이스 역량 (Rust 선언 기준 — getDeviceStatus(토큰)로 사전 조회). */\n`;
    output += `export const ${surface.constant}: readonly RustraDeviceCapability[] = [${list}];\n`;
  }
  return finishGeneratedText(output);
}

/** 커맨드 하나의 토큰 정규화 — 카탈로그 검증(미등록 throw) + 중복 제거 + 카탈로그 순. */
function sortedCatalogTokens(command: CommandSchema): string[] {
  const tokens: string[] = [];
  for (const token of command.devices ?? []) {
    if (!CATALOG_ORDER.has(token)) {
      throw new Error(
        `Invalid schema: command '${command.name}' declares device capability '${token}' — ` +
          `not in the Rust catalog (crates/rustra/src/device_capabilities.rs); ` +
          `regenerate schema.json with a current rustra or fix the token`,
      );
    }
    // 정확 중복 토큰은 무해하며 Rust 빌더가 이미 패닉 대상이다.
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens.sort(byCatalogOrder);
}

function byCatalogOrder(a: string, b: string): number {
  return (CATALOG_ORDER.get(a) ?? 0) - (CATALOG_ORDER.get(b) ?? 0);
}

/** camelCase 함수명을 상수명용 UPPER_SNAKE로 — 'scanTags' → 'SCAN_TAGS'. */
function constantCase(fnName: string): string {
  return fnName
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toUpperCase();
}
