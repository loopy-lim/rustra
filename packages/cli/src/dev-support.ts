import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PipelinePlan {
  rustBin: boolean;
  tsCli: boolean;
}

export function planPipeline(dirty: {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
}): PipelinePlan {
  return {
    rustBin: dirty.rustNewerThanSchema,
    tsCli: dirty.rustNewerThanSchema || dirty.codecsStaleAgainstSchema,
  };
}

function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

export function detectDirty(backendDir: string, generatedDir: string) {
  const schemaPath = join(generatedDir, 'schema.json');
  const schemaMtime = existsSync(schemaPath) ? statSync(schemaPath).mtimeMs : 0;
  const rustNewest = newestMtime(join(backendDir, 'src'));
  const codecsNewest = Math.max(
    ...['rkyv-codecs.ts', 'rkyv-registry.ts'].map((file) => {
      const path = join(generatedDir, file);
      return existsSync(path) ? statSync(path).mtimeMs : 0;
    }),
  );
  return {
    rustNewerThanSchema: rustNewest > schemaMtime,
    codecsStaleAgainstSchema: schemaMtime > codecsNewest,
  };
}

export function detectConfigDirty(manifestDir: string, schemaPath: string, outputPath: string) {
  const schemaMtime = existsSync(schemaPath) ? statSync(schemaPath).mtimeMs : 0;
  return (
    newestMtime(join(manifestDir, 'src')) > schemaMtime || schemaMtime > newestMtime(outputPath)
  );
}

export interface StageRunners {
  rustBin: () => Promise<void>;
  tsCli: () => Promise<void>;
}

export async function runOnce(plan: PipelinePlan, runners: StageRunners): Promise<void> {
  if (plan.rustBin) await runners.rustBin();
  if (plan.tsCli) await runners.tsCli();
}
