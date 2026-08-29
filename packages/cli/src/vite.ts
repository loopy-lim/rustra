/**
 * vite-plugin-rustra — Vite plugin for seamless rustra codegen & HMR.
 *
 * Automatically checks and regenerates Rustra TypeScript clients when
 * Vite starts up or when Rust backend source files change.
 */

import { resolve, join } from 'node:path';
import { detectDirty, planPipeline, runOnce, type StageRunners } from './dev.js';
import { runGenerate } from './index.js';
import { spawnInherit } from './process.js';

export interface RustraVitePluginOptions {
  /** Path to the Rust backend directory. Default: "backend" */
  backendDir?: string;
  /** Path to generated directory. Default: "src/generated" */
  generatedDir?: string;
}

export function rustraPlugin(options: RustraVitePluginOptions = {}) {
  const backendDir = options.backendDir ?? 'backend';
  const generatedDir = options.generatedDir ?? 'src/generated';

  const runners: StageRunners = {
    rustBin: async () => {
      await spawnInherit('cargo', ['run', '--bin', 'generate'], resolve(backendDir));
    },
    tsCli: async () => {
      const schemaPath = join(resolve(generatedDir), 'schema.json');
      await runGenerate(['--schema', schemaPath, '--output', resolve(generatedDir)]);
    },
  };

  return {
    name: 'vite-plugin-rustra',
    async buildStart(): Promise<void> {
      try {
        const dirty = detectDirty(resolve(backendDir), resolve(generatedDir));
        const plan = planPipeline(dirty);
        if (plan.rustBin || plan.tsCli) {
          await runOnce(plan, runners);
        }
      } catch {
        // Tolerant on initial build if backend directory is not configured yet
      }
    },
    async handleHotUpdate(ctx: {
      file: string;
      server: { ws: { send: (msg: unknown) => void } };
    }): Promise<void> {
      if (ctx.file.includes(backendDir) && ctx.file.endsWith('.rs')) {
        const dirty = detectDirty(resolve(backendDir), resolve(generatedDir));
        const plan = planPipeline(dirty);
        if (plan.rustBin || plan.tsCli) {
          await runOnce(plan, runners);
          ctx.server.ws.send({
            type: 'full-reload',
          });
        }
      }
    },
  };
}
