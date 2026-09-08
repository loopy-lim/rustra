/**
 * @rustra/cli — doctor 디바이스 토큰 릴리스 벽 검사 (Dev Tier C절).
 *
 * debug 빌드(rustra)가 수용한 카탈로그 밖 디바이스 토큰을 릴리스 전에
 * 보고한다 — release 빌드는 등록 시점 패닉이므로 doctor 가 JS 쪽 벽으로
 * 이중화한다. 판정:
 *
 * - 선언 자체가 없으면 `skip`(검사 부재와 의도된 스킵 구별 — 기존 관례)
 * - 선언은 있는데 스키마에 `deviceCapabilities` 카탈로그가 없으면 `warn`
 *   (구버전 rustra 재생성 안내)
 * - 카탈로그 밖 토큰이 있으면 `fail`(required) — 카탈로그 토큰 교체 또는
 *   rustra 카탈로그 확장 안내
 *
 * schema.json 이 없으면 `undefined` — codegen.schema_output warn 이 이미
 * 담당하므로 이중 보고하지 않는다(호출부가 undefined 를 스킵).
 */
import { existsSync, readFileSync } from 'node:fs';
import { check } from './doctor-support.js';
import type { DoctorCheck } from './doctor-types.js';

export function deviceCatalogCheck(schemaPath: string | undefined): DoctorCheck | undefined {
  if (!schemaPath || !existsSync(schemaPath)) return undefined;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      deviceCapabilities?: unknown;
      commands?: Array<{ name?: unknown; devices?: unknown }>;
    };
    const declared = (schema.commands ?? []).filter(
      (command) => Array.isArray(command.devices) && (command.devices as unknown[]).length > 0,
    );
    const catalog = schema.deviceCapabilities;
    if (declared.length === 0) {
      return check(
        'codegen.device_catalog',
        'skip',
        false,
        'No device declarations — catalog check not applicable',
      );
    }
    if (!Array.isArray(catalog)) {
      return check(
        'codegen.device_catalog',
        'warn',
        false,
        'schema.json lacks the deviceCapabilities catalog while commands declare devices',
        undefined,
        ['Run rustra codegen --config rustra.json with a current rustra'],
      );
    }
    const known = new Set(catalog.filter((token): token is string => typeof token === 'string'));
    const unknown = [
      ...new Set(
        declared.flatMap((command) =>
          (command.devices as unknown[]).filter(
            (token): token is string => typeof token === 'string' && !known.has(token),
          ),
        ),
      ),
    ].sort();
    return unknown.length === 0
      ? check(
          'codegen.device_catalog',
          'pass',
          false,
          `All declared device tokens are in the rustra catalog (${known.size} tokens)`,
        )
      : check(
          'codegen.device_catalog',
          'fail',
          true,
          `Device tokens outside the rustra catalog: ${unknown
            .map((token) => `'${token}'`)
            .join(', ')}`,
          'Debug builds accept catalog-outside tokens; release builds panic at registration',
          [
            'Rename to a catalog token or extend the rustra catalog (crates/rustra/src/device_capabilities.rs)',
          ],
        );
  } catch (error) {
    return check(
      'codegen.device_catalog',
      'fail',
      true,
      'schema.json could not be parsed for the device catalog check',
      error instanceof Error ? error.message : String(error),
    );
  }
}
