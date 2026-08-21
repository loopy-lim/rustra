/**
 * 계약 게이트 — schema.json 의 명령 목록과 클라이언트가 노출하는 명령 목록의 정합성.
 *
 * CI 에서 `rustra diff` (스키마 버전 간 breaking change) 와 짝을 이뤄,
 * 커밋된 schema.json 이 생성된 클라이언트와 어긋나는지 (드리프트) 검출한다.
 */

/** schema.json 의 명령 목록과 클라이언트가 노출하는 명령 목록의 정합성. */
export function assertContractCurrent(
  schema: { commands: Array<{ name: string }> },
  clientCommands: string[],
): { missingInClient: string[]; missingInSchema: string[] } {
  const schemaNames = schema.commands.map((c) => c.name);
  const schemaSet = new Set(schemaNames);
  const clientSet = new Set(clientCommands);
  return {
    missingInClient: schemaNames.filter((n) => !clientSet.has(n)),
    missingInSchema: clientCommands.filter((c) => !schemaSet.has(c)),
  };
}

/**
 * expect 스타일 계약 검증 — vitest/jest 양쪽 테스트 러너에서 바로 쓸 수 있는
 * throw 기반 게이트. 드리프트가 있으면 사람이 읽는 메시지와 함께 에러를 던지고,
 * 정합이면 조용히 통과한다:
 *
 * ```ts
 * import { expectContractCurrent } from '@rustra/testing';
 *
 * test('client matches schema.json', () => {
 *   expectContractCurrent(schemaJson, Object.keys(generatedCommands));
 * });
 * ```
 *
 * `assertContractCurrent` 의 순수 함수 결과를 메시지로 조립하는 얇은 래퍼다 —
 * 러너 의존(vitest expect 등) 없이 어떤 테스트 프레임워크에서도 동작한다.
 */
export function expectContractCurrent(
  schema: { commands: Array<{ name: string }> },
  clientCommands: string[],
): void {
  const { missingInClient, missingInSchema } = assertContractCurrent(schema, clientCommands);
  if (missingInClient.length === 0 && missingInSchema.length === 0) return;
  const lines = ['rustra contract drift detected:'];
  if (missingInClient.length > 0) {
    lines.push(
      `  commands in schema.json but missing from the client: ${missingInClient.join(', ')}`,
    );
  }
  if (missingInSchema.length > 0) {
    lines.push(
      `  commands in the client but missing from schema.json: ${missingInSchema.join(', ')}`,
    );
  }
  lines.push('  → regenerate the client (npx rustra generate) or update schema.json.');
  throw new Error(lines.join('\n'));
}
