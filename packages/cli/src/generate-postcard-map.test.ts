import { expect, test } from 'bun:test';
import ts from 'typescript';
import { generateFieldDecodeExpr } from './generate-postcard-decode.js';
test('nested typed string map decoder typechecks without weakening the DTO', () => {
  const expression = generateFieldDecodeExpr(
    { name: 'metadata', kind: 'map_string' },
    '_obj.metadata',
    {},
    '',
  );
  const text = `declare const u8: Uint8Array; declare let offset: number;
 declare function _pcDecodeVarint(a: Uint8Array,b: number): {value:number;bytesRead:number};
 declare function _pcDecodeString(a: Uint8Array,b: number): {value:string;bytesRead:number};
 const _obj: {metadata:Record<string,string>}={metadata:{}};
 ${expression}`;
  const filename = '/virtual-nested-map.ts';
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, create) =>
    name === filename
      ? ts.createSourceFile(name, text, version, true)
      : original(name, version, onError, create);
  const program = ts.createProgram([filename], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === filename)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
  ).toEqual([]);
});
