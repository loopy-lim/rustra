/**
 * Structural, type-tagged identity for supported command inputs. Tags are outside
 * user objects, so a record cannot impersonate a bigint, Set, or binary value.
 * Object keys are canonicalized; Map/Set iteration order and binary view type
 * are preserved because the original input is passed unchanged to the engine.
 *
 * Values without a structural serialization never throw: class instances,
 * functions, and other exotic objects are keyed by a stable per-instance id from
 * a module-level WeakMap (same instance → same key on every render, different
 * instances → different keys; the WeakMap never retains a dead instance), and
 * symbols are keyed by `String(symbol)`, which includes the description —
 * description-less symbols therefore share a single key bucket. Only cycles
 * remain a TypeError. Identity-keyed inputs are not stable serialization
 * targets, so a dev-only console.warn is emitted once per derived key.
 */

const instanceIds = new WeakMap<object, string>();
let nextInstanceId = 0;
const warnedKeys = new Set<string>();
const warnedKeyLimit = 100;

function instanceId(item: object): string {
  let id = instanceIds.get(item);
  if (id === undefined) {
    id = String(nextInstanceId++);
    instanceIds.set(item, id);
  }
  return id;
}

function warnUnstableIdentityKey(key: string): void {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env;
  if (env?.NODE_ENV === 'production') return;
  // Warn once per key so re-renders do not spam; the set is capped so apps that
  // mint throwaway instances on every render cannot grow it without bound.
  if (warnedKeys.has(key) || warnedKeys.size >= warnedKeyLimit) return;
  warnedKeys.add(key);
  console.warn(
    '[rustra] command input contains a class instance, function, or symbol; it is keyed by identity and is not a stable serialization target',
  );
}

export function inputKey(value: unknown): string {
  const ancestors = new Set<object>();
  let usesIdentityKey = false;
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
      case 'symbol':
        // Includes the description; description-less symbols share a bucket.
        usesIdentityKey = true;
        return ['symbol', String(item)];
      case 'function':
        usesIdentityKey = true;
        return ['ref', instanceId(item)];
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
        // Class instances and host/exotic objects: identity-keyed, non-throwing.
        usesIdentityKey = true;
        return ['ref', instanceId(item)];
      }
      const entries = Object.keys(item)
        .sort()
        .map((key) => [key, encode((item as Record<string, unknown>)[key])]);
      const symbolKeys = Object.getOwnPropertySymbols(item);
      if (symbolKeys.length === 0) return ['object', entries];
      // Symbol-keyed properties join the key via String(symbol) instead of
      // throwing; they share the description-less bucket caveat of symbols.
      usesIdentityKey = true;
      return [
        'object',
        [
          ...entries,
          ...symbolKeys.map((symbol) => [
            'symbol',
            String(symbol),
            encode((item as Record<PropertyKey, unknown>)[symbol]),
          ]),
        ],
      ];
    } finally {
      ancestors.delete(item);
    }
  }
  const key = JSON.stringify(encode(value));
  if (usesIdentityKey) warnUnstableIdentityKey(key);
  return key;
}
