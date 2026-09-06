/**
 * 계약 게이트 — schema.json 의 명령 목록과 클라이언트가 노출하는 명령 목록의 정합성.
 *
 * CI 에서 `rustra diff` (스키마 버전 간 breaking change) 와 짝을 이뤄,
 * 커밋된 schema.json 이 생성된 클라이언트와 어긋나는지 (드리프트) 검출한다.
 */
import { createHash } from 'node:crypto';

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
  lines.push('  → regenerate the client (bunx @rustra/cli generate) or update schema.json.');
  throw new Error(lines.join('\n'));
}

// ── 필드 수준 대조 — 생성 commands.ts 필드 키 ↔ schema.json ────────────────

/** 필드 수준 드리프트 한 건. */
export type ContractFieldDrift = {
  command: string;
  kind:
    | 'field_missing_in_schema'
    | 'field_missing_in_client'
    | 'field_order_mismatch'
    | 'unparseable_source';
  detail: string;
};

/** schema.json 의 한 명령이 게이트에 필요한 부분. */
type SchemaCommandForFields = {
  name: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
};

/**
 * 코드젠이 생성하는 4가지 명령 형태에서 (명령 이름, 필드 키 목록)을 추출한다.
 *
 * - `createGeneratedFields2<...>(1, 'addNumbers', "a", "b", 'addNumbers')` — 2필드
 * - `invokeGeneratedFields1|3<...>(id, 'name', input, input["x"], ..., options)` — 1/3필드
 * - `invokeGeneratedBytes<...>(id, 'name', input, input["data"], options)` — bytes 1필드
 * - 평문 `invokeGenerated<...>(id, 'name', input, options)` — 필드 계약 없음(null, 비교 스킵)
 *
 * 마지막 문자열 인자는 functionName(=command) 이므로 필드에서 제외한다.
 * 필드 순서는 와이어 순서와 동일 — 코드젠은 `properties` 키 순서로 필드를
 * 내보낸다(required 순서가 아니다. emitDemo 실측: required [stepDelayMs, ticks],
 * 생성 [ticks, stepDelayMs]).
 */
const GENERATED_FIELD_PATTERNS: Array<{
  re: RegExp;
  /** 매치에서 (이름, 필드 키들) 추출. null 이면 필드 계약 없는 형태. */
  extract: (m: RegExpMatchArray) => { command: string; fields: string[] } | null;
}> = [
  {
    // createGeneratedFields2<TIn, TOut>(id, 'name', "f0", "f1", 'fnName')
    re: /createGeneratedFields2<[^>]*>\(\s*\d+\s*,\s*'([^']+)'\s*((?:,\s*(?:"[^"]*"|'[^']*'))*?)\s*,\s*'[^']*'\s*\)/g,
    extract: (m) => ({ command: m[1], fields: parseStringLiterals(m[2]) }),
  },
  {
    // invokeGeneratedFieldsN<T>(id, 'name', input, input["f0"], ..., options)
    re: /invokeGeneratedFields([13])<[^>]*>\(\s*\d+\s*,\s*'([^']+)'\s*,\s*input\b([^;]*?)options\s*\)/g,
    extract: (m) => ({ command: m[2], fields: parseFieldAccessLiterals(m[3]) }),
  },
  {
    // invokeGeneratedBytes<T>(id, 'name', input, input["data"], options)
    re: /invokeGeneratedBytes<[^>]*>\(\s*\d+\s*,\s*'([^']+)'\s*,\s*input\b([^;]*?)options\s*\)/g,
    extract: (m) => ({ command: m[1], fields: parseFieldAccessLiterals(m[2]) }),
  },
  {
    // 평문 invokeGenerated<T>(id, 'name', input|undefined, options) — 필드 계약이
    // 클라이언트에 없는 형태(>3필드, 비스칼라, unit 입력). null 로 등록해 비교 스킵.
    // invokeGeneratedFields/Bytes 는 뒤에 글자가 이어져 이 정규식과 겹치지 않는다.
    re: /invokeGenerated<[^>]*>\(\s*\d+\s*,\s*'([^']+)'\s*,/g,
    extract: () => null,
  },
];

/** `"a", "b"` 같은 인자 리스트에서 문자열 리터럴을 순서대로 뽑는다. */
function parseStringLiterals(list: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** `input["x"], input["y"]` 형태의 field-access 인자에서 필드 키를 뽑는다. */
function parseFieldAccessLiterals(list: string): string[] {
  const out: string[] = [];
  const re = /input\[(?:"([^"]*)"|'([^']*)')\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(list)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * 생성 commands.ts 소스와 schema.json 의 필드 키를 대조해 드리프트를 반환한다.
 *
 * 스키마 측 필드 순서의 원천은 `inputSchema.properties` 키 순서(=와이어 순서,
 * 코드젠과 동일한 순회)다. properties 가 없으면 `required` 배열로 폴백한다.
 * 둘 다 없으면 필드 없는 명령으로 간주한다. 생성 측에서 그 명령의 형태를
 * 찾지 못하면(평문 invokeGenerated, unit 입력 등) 비교 스킵 — 필드 계약이
 * 클라이언트에 존재하지 않기 때문이다.
 *
 * 파싱 실패는 조용한 통과가 아니라 게이트 실패다: 소스에서 코드젠 패턴이
 * 하나도 매칭되지 않으면 각 스키마 명령에 `unparseable_source` 를 보고한다.
 */
export function assertContractFieldsCurrent(
  schema: { commands: SchemaCommandForFields[] },
  generatedCommandsSource: string,
): { drift: ContractFieldDrift[] } {
  const generated = new Map<string, string[]>();
  let matchCount = 0;
  for (const { re, extract } of GENERATED_FIELD_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(generatedCommandsSource)) !== null) {
      matchCount++;
      const parsed = extract(m);
      if (parsed) generated.set(parsed.command, parsed.fields);
      // null(평문 invokeGenerated 형태)은 등록만 되고 비교에서 스킵된다.
      else generated.set(m[1], []);
    }
  }
  const sourceHasNoCodegenPattern = matchCount === 0;
  const drift: ContractFieldDrift[] = [];
  for (const cmd of schema.commands) {
    const schemaFields = schemaFieldKeys(cmd.inputSchema);
    const generatedFields = generated.get(cmd.name);
    if (generatedFields === undefined) {
      if (sourceHasNoCodegenPattern) {
        drift.push({
          command: cmd.name,
          kind: 'unparseable_source',
          detail:
            'no codegen pattern matched in generated commands source — parse failure is a gate failure',
        });
      } else if (schemaFields.length > 0) {
        drift.push({
          command: cmd.name,
          kind: 'field_missing_in_client',
          // "emitted in an unrecognized helper form" — 코드젠이 신규 헬퍼 형태로
          // 바뀌어 이 파서가 읽지 못하는 경우도 조용한 통과로 놓치지 않게 한다.
          detail:
            'command entry not found in generated source (or emitted in an unrecognized helper form)',
        });
      }
      continue;
    }
    if (generatedFields.length === 0) continue; // 필드 계약 없는 형태 — 스킵
    if (schemaFields.length === 0) {
      // 생성에만 필드가 있다.
      for (const field of generatedFields) {
        drift.push({
          command: cmd.name,
          kind: 'field_missing_in_schema',
          detail: `field "${field}" present in generated fields but missing from schema properties`,
        });
      }
      continue;
    }
    const schemaSet = new Set(schemaFields);
    for (const field of generatedFields) {
      if (!schemaSet.has(field)) {
        drift.push({
          command: cmd.name,
          kind: 'field_missing_in_schema',
          detail: `field "${field}" present in generated fields but missing from schema properties`,
        });
      }
    }
    const generatedSet = new Set(generatedFields);
    for (const field of schemaFields) {
      if (!generatedSet.has(field)) {
        drift.push({
          command: cmd.name,
          kind: 'field_missing_in_client',
          detail: 'field "' + field + '" present in schema but missing from generated fields',
        });
      }
    }
    // 길이가 같고 위 집합 대조에서 드리프트가 없으면 집합이 동일 — 그때만 순서 비교.
    const sameSet =
      generatedFields.length === schemaFields.length && !drift.some((d) => d.command === cmd.name);
    if (sameSet && generatedFields.some((f, i) => f !== schemaFields[i])) {
      drift.push({
        command: cmd.name,
        kind: 'field_order_mismatch',
        detail: `field order differs: generated [${generatedFields.join(', ')}] vs schema [${schemaFields.join(', ')}]`,
      });
    }
  }
  return { drift };
}

/** 스키마 측 필드 키(와이어 순서): properties 키 순서, 없으면 required 배열. */
function schemaFieldKeys(inputSchema: SchemaCommandForFields['inputSchema']): string[] {
  if (inputSchema?.properties && typeof inputSchema.properties === 'object') {
    return Object.keys(inputSchema.properties);
  }
  if (Array.isArray(inputSchema?.required)) return inputSchema.required;
  return [];
}

/**
 * `expectContractCurrent` 의 필드 수준 버전 — 드리프트가 있으면 사람이 읽는
 * 메시지로 조립해 throw 하고, 정합이면 조용히 통과한다.
 */
export function expectContractFieldsCurrent(
  schema: { commands: SchemaCommandForFields[] },
  generatedCommandsSource: string,
): void {
  const { drift } = assertContractFieldsCurrent(schema, generatedCommandsSource);
  if (drift.length === 0) return;
  const lines = ['rustra contract field drift detected:'];
  for (const d of drift) {
    lines.push(`  [${d.command}] ${d.kind}: ${d.detail}`);
  }
  lines.push('  → regenerate the client (bunx @rustra/cli generate) or update schema.json.');
  throw new Error(lines.join('\n'));
}

// ── contract hash 대조 — schema.json 원문 ↔ contract.ts ────────────────────

/**
 * schema.json 파일 원문의 sha256 이 contract.ts 의
 * `GENERATED_CONTRACT_HASH` 와 일치하는지 검증한다(코드젠 `generateContractTs`
 * 와 동일한 해시 입력). 불일치 또는 상수 추출 실패 시 throw 한다.
 */
export function assertContractHashCurrent(
  schemaJsonContent: string,
  contractTsContent: string,
): void {
  const expected = createHash('sha256').update(schemaJsonContent, 'utf8').digest('hex');
  const m = /GENERATED_CONTRACT_HASH\s*=\s*['"]([0-9a-fA-F]{64})['"]/.exec(contractTsContent);
  if (!m) {
    throw new Error(
      'rustra contract hash check failed: GENERATED_CONTRACT_HASH constant not found in contract.ts\n' +
        '  → regenerate the client (bunx @rustra/cli generate).',
    );
  }
  const actual = m[1];
  if (actual !== expected) {
    throw new Error(
      'rustra contract hash mismatch:\n' +
        `  expected (sha256 of schema.json): ${expected}\n` +
        `  actual (contract.ts):             ${actual}\n` +
        '  → regenerate the client (bunx @rustra/cli generate).',
    );
  }
}
