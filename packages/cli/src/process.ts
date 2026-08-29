import { spawn } from 'node:child_process';

export type SpawnInheritOptions = {
  env?: NodeJS.ProcessEnv;
};

/** Runs a child with inherited stdio and preserves exit-vs-signal diagnostics. */
export function spawnInherit(
  command: string,
  args: string[],
  cwd: string,
  options?: SpawnInheritOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
      }
    });
  });
}
