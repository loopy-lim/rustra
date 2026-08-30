/**
 * The canonical schema shape used by generated binary codecs.
 *
 * The Rust runtime still receives the original JSON Schema, but every
 * TypeScript-side generator (JS and C++) must make the same decisions from
 * this IR: declaration-order structs, sorted map/variant keys, optional
 * presence tags, and recursive references.
 */
export type CodecIrNode =
  | { kind: 'boolean' }
  | { kind: 'integer'; format?: string }
  | { kind: 'number'; format?: string }
  | { kind: 'string' }
  | { kind: 'null' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'enum'; values: (string | number | boolean | null)[] }
  | { kind: 'ref'; name: string }
  | { kind: 'optional'; inner: CodecIrNode }
  | { kind: 'sequence'; item: CodecIrNode; unique: boolean }
  | { kind: 'tuple'; items: CodecIrNode[] }
  | { kind: 'map'; value: CodecIrNode }
  | {
      kind: 'struct';
      fields: { name: string; node: CodecIrNode; optional: boolean }[];
    }
  | {
      kind: 'variant';
      key: string;
      node: CodecIrNode;
      wrapper: 'value' | 'property' | 'discriminator' | 'direct';
      property?: string;
      discriminator?: { key: string; value: string | number | boolean | null };
    }
  | {
      kind: 'oneOf';
      variants: {
        key: string;
        node: CodecIrNode;
        wrapper: 'value' | 'property' | 'discriminator' | 'direct';
        property?: string;
        discriminator?: { key: string; value: string | number | boolean | null };
      }[];
    };

export type CodecIrResult = { ok: true; node: CodecIrNode } | { ok: false; reason: string };
