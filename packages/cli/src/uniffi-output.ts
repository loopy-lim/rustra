import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

async function filesAt(root: string, current = root): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!existsSync(current)) return files;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await filesAt(root, path)) files.set(name, bytes);
    } else if (entry.isFile()) files.set(relative(root, path), await readFile(path));
    else throw new Error(`uniffi binding drift: unsupported entry ${path}`);
  }
  return files;
}

/** Full path-set and byte comparison includes headers and stale extra files. */
async function checkBindings(staged: string, output: string): Promise<void> {
  const [generated, committed] = await Promise.all([filesAt(staged), filesAt(output)]);
  for (const name of new Set([...generated.keys(), ...committed.keys()])) {
    const actual = committed.get(name);
    const expected = generated.get(name);
    if (!actual || !expected || !actual.equals(expected)) {
      throw new Error(
        `uniffi binding drift: ${join(output, name)} differs from fresh bindgen output. Run rustra codegen to update bindings.`,
      );
    }
  }
}

/**
 * Bindgen always starts in an empty directory. Only a validated complete tree
 * is published. Rename on the same filesystem plus rollback preserves the
 * previous tree on a failed publish; backup removal happens after commit.
 */
export async function withBindingOutput(
  output: string,
  check: boolean,
  generate: (emptyDirectory: string) => Promise<void>,
): Promise<void> {
  const parent = check ? tmpdir() : dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(output)}-uniffi-`));
  const staged = join(staging, 'generated');
  const backup = join(staging, 'previous');
  await mkdir(staged);
  let preserveBackup = false;
  try {
    await generate(staged);
    if (check) {
      await checkBindings(staged, output);
      return;
    }
    const hadOutput = existsSync(output);
    if (hadOutput) await rename(output, backup);
    try {
      await rename(staged, output);
    } catch (error) {
      if (hadOutput) {
        try {
          await rename(backup, output);
        } catch (rollback) {
          preserveBackup = true;
          throw new AggregateError(
            [error, rollback],
            `uniffi publish and rollback failed; previous bindings retained at ${backup}`,
            { cause: rollback },
          );
        }
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true });
  }
}
