import { spawn } from 'node:child_process';

export type SpawnInheritOptions = {
  env?: NodeJS.ProcessEnv;
  /** Human-readable operation name for long-running native commands. */
  progressLabel?: string;
  /** Keep progress on stderr so JSON stdout remains machine-readable. */
  progressStream?: 'stdout' | 'stderr';
  /** Forward child output to stderr when the caller owns a machine-readable stdout. */
  childOutput?: 'inherit' | 'stderr' | 'ignore';
};

/** Runs a child with inherited stdio and preserves exit-vs-signal diagnostics. */
export function spawnInherit(
  command: string,
  args: string[],
  cwd: string,
  options?: SpawnInheritOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const childOutput = options?.childOutput ?? 'inherit';
    const child = spawn(command, args, {
      cwd,
      stdio:
        childOutput === 'inherit'
          ? 'inherit'
          : ['ignore', 'pipe', childOutput === 'stderr' ? 'pipe' : 'ignore'],
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });
    if (childOutput === 'stderr') {
      child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    }
    const stream = options?.progressStream === 'stderr' ? console.error : console.log;
    const started = Date.now();
    const timer = options?.progressLabel
      ? setInterval(() => {
          stream(
            `[rustra] ${options.progressLabel} still running (${Math.floor((Date.now() - started) / 1000)}s)`,
          );
        }, 1000)
      : undefined;
    timer?.unref?.();
    if (options?.progressLabel) stream(`[rustra] ${options.progressLabel}...`);
    const finish = (): void => {
      if (timer) clearInterval(timer);
    };
    child.on('error', (error) => {
      finish();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      finish();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
      }
    });
  });
}
