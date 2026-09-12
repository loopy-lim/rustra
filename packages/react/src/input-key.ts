/**
 * Structural, type-tagged identity for supported command inputs. Tags are outside
 * user objects, so a record cannot impersonate a bigint, Set, or binary value.
 * Object keys are canonicalized; Map/Set iteration order and binary view type
 * are preserved because the original input is passed unchanged to the engine.
 */
export function inputKey(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): unknown {
    if (item === null) return ['null'];
    switch (typeof item) {
      case 'undefined':
        return ['undefined'];
      case 'string':
        return ['string', item];
      case 'boolean':
        return ['boolean', item];
      case 'bigint':
        return ['bigint', item.toString()];
      case 'number':
        return ['number', Object.is(item, -0) ? '-0' : String(item)];
      case 'function':
      case 'symbol':
        throw new TypeError('Rustra command inputs cannot contain functions or symbols');
    }
    if (ancestors.has(item)) throw new TypeError('Rustra command inputs cannot contain cycles');
    ancestors.add(item);
    try {
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
        const bytes =
          item instanceof ArrayBuffer
            ? new Uint8Array(item)
            : new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
        return ['binary', Object.prototype.toString.call(item), Array.from(bytes)];
      }
      if (item instanceof Date) return ['date', item.toISOString()];
      if (item instanceof Set) return ['set', Array.from(item, encode)];
      if (item instanceof Map)
        return ['map', Array.from(item, ([key, value]) => [encode(key), encode(value)])];
      if (Array.isArray(item)) {
        return [
          'array',
          Array.from({ length: item.length }, (_, index) =>
            index in item ? encode(item[index]) : ['hole'],
          ),
        ];
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Rustra command inputs must use supported values or plain records');
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        throw new TypeError('Rustra command inputs cannot contain symbol keys');
      }
      return [
        'object',
        Object.keys(item)
          .sort()
          .map((key) => [key, encode((item as Record<string, unknown>)[key])]),
      ];
    } finally {
      ancestors.delete(item);
    }
  }
  return JSON.stringify(encode(value));
}
