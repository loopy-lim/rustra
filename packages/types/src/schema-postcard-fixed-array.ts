type Node = {
  encode(value: unknown): Uint8Array;
  decode(buffer: Uint8Array, offset: number): { value: unknown; bytesRead: number };
};

/** Serde fixed arrays have exactly N elements and no postcard length prefix. */
export function compileFixedArray(length: number, element: Node, bytes: boolean): Node {
  return {
    encode(value) {
      const values = bytes && value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (!(Array.isArray(values) || values instanceof Uint8Array) || values.length !== length)
        throw new Error('invalid fixed array length');
      const parts = Array.from(values, (item) => element.encode(item));
      const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    },
    decode(buffer, offset) {
      let cursor = offset;
      const values: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const decoded = element.decode(buffer, cursor);
        values.push(decoded.value);
        cursor += decoded.bytesRead;
      }
      return {
        value: bytes ? new Uint8Array(values as number[]) : values,
        bytesRead: cursor - offset,
      };
    },
  };
}
