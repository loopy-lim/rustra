import type { DiagnosticCase } from './diagnostic';

export function verifyDiagnosticPreflight(
  caseId: DiagnosticCase,
  input: unknown,
  first: unknown,
  second: unknown,
): void {
  if (first === input || second === input || first === second)
    throw Error('diagnostic output must be fresh');
  if (caseId === 'buffer65536' || caseId === 'buffer1048571') {
    const source = (input as { data: ArrayBuffer }).data;
    const data = new Uint8Array(source);
    const outputs = [first, second].map((value) => {
      const buffer = (value as { data?: unknown } | null)?.data;
      if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer))
        throw Error('diagnostic buffer output invalid');
      const view =
        buffer instanceof ArrayBuffer
          ? new Uint8Array(buffer)
          : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return { backing: buffer instanceof ArrayBuffer ? buffer : buffer.buffer, view };
    });
    if (outputs[0].backing === outputs[1].backing) throw Error('diagnostic outputs share buffer');
    for (const { backing, view } of outputs) {
      if (backing === source || view.byteLength !== data.byteLength)
        throw Error('diagnostic buffer ownership/size mismatch');
      for (let i = 0; i < data.byteLength; i++)
        if (view[i] !== data[i]) throw Error('diagnostic buffer value mismatch');
    }
    return;
  }
  const expected = caseId === 'add' ? { value: 100 } : input;
  for (const value of [first, second]) {
    if (
      !value ||
      typeof value !== 'object' ||
      !expected ||
      typeof expected !== 'object' ||
      Object.keys(value).length !== Object.keys(expected).length ||
      !Object.entries(expected).every(
        ([key, field]) =>
          Object.prototype.hasOwnProperty.call(value, key) &&
          (value as Record<string, unknown>)[key] === field,
      )
    )
      throw Error('diagnostic result mismatch');
  }
}
