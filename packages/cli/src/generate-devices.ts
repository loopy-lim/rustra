/**
 * @rustra/cli — 커맨드별 디바이스 역량 렌더러
 *
 * 스키마 명령 항목의 `devices` 선언에서 `devices.ts`를 생성한다 — 패키지가
 * 선언에 사용한 토큰의 리터럴 유니언(`RustraDeviceCapability`) + 커맨드별
 * `{FN}_DEVICES` 상수. 선언은 계약 문서다 — 런타임 자동 게이팅이나 OS 권한
 * 요청은 없고, 가용성/권한 조회는 호스트가 등록한 provider 표면
 * (`getDeviceStatus`) 몫이다(설계 B/D절).
 *
 * 카탈로그 정렬·검증은 스키마 최상위 `deviceCapabilities`(Rust
 * `DeviceCapability::ALL` 원천)에서 단일 소싱한다 — CLI 수동 미러는 폐지
 * (Dev Tier B절). 카탈로그 밖 토큰은 debug 빌드가 수용한 선언이므로 throw
 * 대신 렌더하되 마커 주석을 남긴다 — 릴리스 벽은 doctor
 * `codegen.device_catalog` 검사다(Dev Tier C절).
 *
 * 선언 커맨드가 1건이라도 있으면 파일 내용을, 없으면 빈 문자열을 반환한다
 * (events.ts/errors.ts 관례 — 선언 없는 패키지는 기존 출력과 바이트 동일).
 */
import type { CommandSchema, PackageSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { finishGeneratedText } from './generate-surface.js';

export function generateDevicesTs(schema: PackageSchema): string {
  const declared = schema.commands.filter((command) => (command.devices?.length ?? 0) > 0);
  if (declared.length === 0) return '';

  // 카탈로그 단일소싱 — 구버전 rustra 스키마(필드 없음)에 선언이 있으면
  // 정렬·검증 자체가 불가능하므로 fail-closed로 재생성을 안내한다.
  const catalog = schema.deviceCapabilities ?? [];
  if (catalog.length === 0) {
    throw new Error(
      'Invalid schema: schema.json lacks the top-level deviceCapabilities catalog while ' +
        'commands declare devices — regenerate schema.json with a current rustra ' +
        '(the catalog is emitted alongside device declarations)',
    );
  }
  const catalogOrder = new Map(catalog.map((token, index) => [token, index]));

  const usedTokens = new Set<string>();
  const unknownTokens = new Set<string>();
  const surfaces: { fnName: string; constant: string; tokens: string[] }[] = [];
  const constants = new Set<string>();
  for (const command of declared) {
    const sorted = sortedCatalogTokens(command, catalogOrder);
    for (const token of sorted.tokens) usedTokens.add(token);
    for (const token of sorted.unknownTokens) unknownTokens.add(token);

    const fnName = commandFunctionName(command.name);
    const constant = `${constantCase(fnName)}_DEVICES`;
    if (constants.has(constant)) {
      throw new Error(
        `Invalid schema: commands colliding on device constant '${constant}' ('${command.name}' declared twice?) — ` +
          `${constant} would be emitted more than once`,
      );
    }
    constants.add(constant);
    surfaces.push({ fnName, constant, tokens: sorted.tokens });
  }

  const union = [...usedTokens]
    .sort(byCatalogOrder(catalogOrder))
    .map((token) => `'${token}'`)
    .join(' | ');
  let output = `/** 이 패키지가 선언에 사용한 디바이스 역량 토큰 (Rust 카탈로그 기준). */\n`;
  output += `export type RustraDeviceCapability = ${union};\n`;
  // 마커는 미지 토큰이 있을 때만 — 카탈로그 내 토큰만 쓰는 패키지의
  // devices.ts는 바이트 불변(기존 재생성 출력과 동일).
  if (unknownTokens.size > 0) {
    const unknownAll = [...unknownTokens].sort();
    output += `// 카탈로그 밖 토큰 ${unknownAll.length}개 — debug 빌드에서만 등록 가능하다(release 빌드는\n`;
    output += `// 패닉, rustra doctor codegen.device_catalog 검사가 릴리스 벽이다): ${unknownAll
      .map((token) => `'${token}'`)
      .join(', ')}\n`;
  }
  for (const surface of surfaces) {
    const list = surface.tokens.map((token) => `'${token}'`).join(', ');
    output += `\n`;
    output += `/** ${surface.fnName} 가 전제하는 디바이스 역량 (Rust 선언 기준 — getDeviceStatus(토큰)로 사전 조회). */\n`;
    output += `export const ${surface.constant}: readonly RustraDeviceCapability[] = [${list}];\n`;
  }
  return finishGeneratedText(output);
}

/**
 * 커맨드 하나의 토큰 정규화 — 중복 제거 후 카탈로그 순(known) 뒤 미지
 * 토큰 알파벳순. 미지 토큰은 debug 빌드가 수용한 선언이다(Dev Tier C절) —
 * 유니언·상수에 포함되고 마커 주석의 대상이 된다.
 */
function sortedCatalogTokens(
  command: CommandSchema,
  catalogOrder: Map<string, number>,
): { tokens: string[]; unknownTokens: string[] } {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of command.devices ?? []) {
    // 정확 중복 토큰은 무해하며 Rust 빌더가 이미 패닉 대상이다.
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  const known = tokens.filter((token) => catalogOrder.has(token));
  const unknownTokens = tokens.filter((token) => !catalogOrder.has(token));
  known.sort(byCatalogOrder(catalogOrder));
  unknownTokens.sort();
  return { tokens: [...known, ...unknownTokens], unknownTokens };
}

/** 같은 토큰 집합은 선언 순서와 무관하게 같은 유니언을 만든다(미지 토큰은 맨 뒤). */
function byCatalogOrder(catalogOrder: Map<string, number>): (a: string, b: string) => number {
  return (a, b) => (catalogOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (catalogOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
}

/** camelCase 함수명을 상수명용 UPPER_SNAKE로 — 'scanTags' → 'SCAN_TAGS'. */
function constantCase(fnName: string): string {
  return fnName
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toUpperCase();
}
