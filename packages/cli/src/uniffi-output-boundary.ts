import { dirname, join, resolve, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { isWithin } from './watch.js';

// Resolve existing ancestors too: a symlinked output must not hide overlap with
// source/schema directories that the whole-tree transaction would replace.
function canonical(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : join(canonical(parent), basename(full));
}

export function assertDedicatedBindingOutput(
  output: string,
  protectedPaths: readonly string[],
  otherOutputs: readonly string[],
): void {
  const binding = canonical(output);
  const conflict =
    protectedPaths.find((path) => isWithin(binding, canonical(path))) ??
    otherOutputs.find(
      (path) => isWithin(binding, canonical(path)) || isWithin(canonical(path), binding),
    );
  if (conflict)
    throw new Error(
      `uniffi.output must be a dedicated binding directory; ${output} overlaps ${conflict}. Choose a separate directory before running codegen.`,
    );
}

/** Ignore the generated tree and its same-filesystem transaction staging. */
export function isBindingOutputPath(output: string, changed: string): boolean {
  if (isWithin(output, changed)) return true;
  const parent = dirname(resolve(output));
  const relative = resolve(changed).slice(parent.length + 1);
  return isWithin(parent, changed) && relative.startsWith(`.${basename(output)}-uniffi-`);
}
