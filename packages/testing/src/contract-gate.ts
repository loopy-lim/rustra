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
