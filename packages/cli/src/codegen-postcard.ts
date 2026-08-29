import { postcardPrimitiveSource } from './codegen-postcard-primitive.js';
import { postcardWideSource } from './codegen-postcard-wide.js';
import { postcardTextSource } from './codegen-postcard-text.js';
import { postcardFloatSource } from './codegen-postcard-float.js';

export function postcardHelperSource(): string {
  return (
    `// ── postcard wire format helpers ─────────────────────────────\n\n` +
    postcardPrimitiveSource() +
    postcardWideSource() +
    postcardTextSource() +
    postcardFloatSource()
  );
}
