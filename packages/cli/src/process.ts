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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Runs a child with inherited stdio and preserves exit-vs-signal diagnostics.
 *
 * With `progressLabel`, renders a spinner + elapsed clock on the chosen stream
 * while the child runs, then prints the total duration when it finishes — the
 * first cargo build can take minutes and must not look like a hang.
 */
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
    let tick = 0;
    const render = (suffix: string): void => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
      stream(`[rustra] ${frame} ${options.progressLabel} ${suffix} (${elapsed}s)`);
      tick += 1;
    };
    const timer = options?.progressLabel
      ? setInterval(() => {
          render('still running');
          // 1초 간격 로그 라인과 함께 진행 중 표시를 유지한다 — TTY가 아니어도
          // CI 로그에서 "멈춤"이 아님을 매 초 확인할 수 있어야 한다.
        }, 1000)
      : undefined;
    timer?.unref?.();
    if (options?.progressLabel) {
      stream(`[rustra] ⠋ ${options.progressLabel}...`);
    }
    const finish = (): void => {
      if (timer) clearInterval(timer);
    };
    child.on('error', (error) => {
      finish();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      finish();
      if (options?.progressLabel) {
        const total = ((Date.now() - started) / 1000).toFixed(1);
        stream(`[rustra] ✓ ${options.progressLabel} done in ${total}s`);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
      }
    });
  });
}
