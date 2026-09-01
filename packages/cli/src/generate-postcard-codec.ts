import type { CommandSchema, PackageSchema } from './schema.js';
import { commandFunctionName, postcardHelperSource } from './codegen.js';
import { finishGeneratedText } from './generate-surface.js';
import { collectAllDefinitions, collectPostcardFields } from './generate-postcard-ir.js';
import { ENC_INTO_KINDS } from './generate-postcard-ir.js';
import {
  generateFieldEncodeExpr,
  generateFieldEncodeIntoExpr,
} from './generate-postcard-encode.js';
import { generateFieldDecodeExpr } from './generate-postcard-decode.js';
import { commandCodecSupported, complexCodecSupported } from './generate-postcard-support.js';
import { generateComplexCodec } from './generate-complex-codec.js';

export function generateRkyvCodecsTs(schema: PackageSchema): string {
  const allTypes = new Set<string>();
  for (const command of schema.commands) {
    if (command.inputType !== '()') allTypes.add(command.inputType);
    if (command.outputType !== '()') allTypes.add(command.outputType);
  }
  const definitions = collectAllDefinitions(schema);
  const importTypes = [...new Set([...allTypes, ...Object.keys(definitions)])].sort();
  let output = postcardHelperSource();
  output += "import { createComplexCodec } from '@rustra/types';\n";
  output += "import type { RkyvV2Codec, RustraError, ComplexSchema } from '@rustra/types';\n";
  output += `import type { ${importTypes.join(', ')} } from './types.js';\n\n`;
  for (const command of schema.commands) {
    const codec = generatePostcardCodec(command, definitions);
    if (codec !== null) output += codec;
    else if (complexCodecSupported(command, definitions))
      output += generateComplexCodec(command, definitions);
  }
  return finishGeneratedText(output);
}

function generatePostcardCodec(
  command: CommandSchema,
  definitions: Record<string, import('./schema.js').JsonSchema>,
): string | null {
  if (!commandCodecSupported(command, definitions)) return null;
  const fnName = commandFunctionName(command.name);
  const inType = command.inputType;
  const outType = command.outputType === '()' ? 'void' : command.outputType;
  const inResult = collectPostcardFields(command.inputSchema, definitions);
  const outResult = collectPostcardFields(command.outputSchema, definitions);
  if (inResult.unsupported.length > 0 || outResult.unsupported.length > 0) return null;
  const inFields = inResult.fields;
  const outFields = outResult.fields;
  const lines: string[] = [
    `export const ${fnName}Codec: RkyvV2Codec<${inType}, ${outType}> = {`,
    `  commandId: ${command.commandId},`,
    '',
    `  encode(args: ${inType}): ArrayBuffer {`,
    `    // [cmd_id: u16 LE][postcard(${inType})]`,
    `    const parts: Uint8Array[] = [];`,
    `    const cmdId = new Uint8Array(2);`,
    `    new DataView(cmdId.buffer).setUint16(0, ${command.commandId}, true);`,
    `    parts.push(cmdId);`,
  ];
  for (const field of inFields)
    lines.push(generateFieldEncodeExpr(field, `args.${field.name}`, definitions, '    '));
  lines.push(`    return _pcConcatUint8Arrays(parts).buffer as ArrayBuffer;`, `  },`);
  if (inFields.every((field) => ENC_INTO_KINDS.has(field.kind))) {
    lines.push(
      '',
      `  encodeInto(args: ${inType}, reuse?: Uint8Array): Uint8Array {`,
      `    let out = reuse ?? new Uint8Array(64);`,
      `    let w = 0;`,
      `    const ensure = (need: number) => {`,
      `      if (w + need <= out.length) return;`,
      `      const grown = new Uint8Array(Math.max(out.length * 2, w + need));`,
      `      grown.set(out.subarray(0, w));`,
      `      out = grown;`,
      `    };`,
      `    ensure(2);`,
      `    out[w++] = ${command.commandId & 0xff}; out[w++] = ${(command.commandId >> 8) & 0xff};`,
    );
    for (const field of inFields)
      lines.push(generateFieldEncodeIntoExpr(field, `args.${field.name}`, '    '));
    lines.push(`    return out.subarray(0, w);`, `  },`);
  }
  lines.push(
    '',
    `  decode(buf: ArrayBuffer | ArrayBufferView): { ok: boolean; result?: ${outType}; error?: RustraError } {`,
    `    // caller-buffer 뷰(Uint8Array subarray 등)도 받는다 — node-loop 가 왕복당`,
    `    // 사본 없이 프레임 뷰를 그대로 넘긴다. DataView 는 ArrayBuffer 만 받으므로`,
    `    // (buf.buffer, byteOffset) 로 정규화한다.`,
    `    const isView = ArrayBuffer.isView(buf);`,
    `    const u8 = isView`,
    `      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)`,
    `      : new Uint8Array(buf);`,
    `    const view = isView`,
    `      ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)`,
    `      : new DataView(buf);`,
    `    if (view.byteLength < 8) return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };`,
    `    if (u8[0] !== 1) {`,
    `      let err: RustraError = { code: 'invoke.failed', message: 'invoke failed' };`,
    `      try {`,
    `        const errLen = view.getUint16(8, true);`,
    `        if (errLen > 0) {`,
    `          // postcard({ code: String, message: String })`,
    `          const c = _pcDecodeString(u8, 10);`,
    `          const m = _pcDecodeString(u8, 10 + c.bytesRead);`,
    `          err = { code: c.value, message: m.value };`,
    `        }`,
    `      } catch {`,
    `        // 잘린/뒤틀린 에러 프레임 — 기본 err 를 유지한다.`,
    `      }`,
    `      return { ok: false, error: err };`,
    `    }`,
  );
  if (outFields.length === 0) {
    lines.push(`    return { ok: true, result: {} as ${outType} };`);
  } else {
    lines.push(
      `    // Decode postcard from offset 8`,
      `    let offset = 8;`,
      `    const result: Partial<${outType}> = {};`,
    );
    for (const field of outFields)
      lines.push(generateFieldDecodeExpr(field, `result.${field.name}`, definitions, '    '));
    lines.push(`    return { ok: true, result: result as ${outType} };`);
  }
  lines.push(`  },`, `};`, '');
  return lines.join('\n') + '\n';
}

export { commandCodecSupported, complexCodecSupported };
