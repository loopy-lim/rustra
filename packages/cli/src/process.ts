import { spawn } from 'node:child_process';

export type SpawnInheritOptions = {
  env?: NodeJS.ProcessEnv;
  /** Cancel an owned command; completion still waits for child output to close. */
  signal?: AbortSignal;
  /** Human-readable operation name for long-running native commands. */
  progressLabel?: string;
  /** Keep progress on stderr so JSON stdout remains machine-readable. */
  progressStream?: 'stdout' | 'stderr';
  /** Forward child output to stderr when the caller owns a machine-readable stdout. */
  childOutput?: 'inherit' | 'stderr' | 'ignore';
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Only an operation cancelled by this owner is an expected disposal outcome. */
export function isAbortedOperation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  let cause = error;
  while (cause instanceof Error) {
    if (cause === signal.reason) return true;
    cause = cause.cause;
  }
  return false;
}

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
    options?.signal?.throwIfAborted();
    const writeStderr = process.stderr.write.bind(process.stderr);
    const childOutput = options?.childOutput ?? 'inherit';
    const child = spawn(command, args, {
      cwd,
      stdio: childOutput === 'stderr' ? ['ignore', 'pipe', 'pipe'] : childOutput,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      signal: options?.signal,
    });
    if (childOutput === 'stderr') {
      child.stdout?.on('data', (chunk: Buffer) => writeStderr(chunk));
      child.stderr?.on('data', (chunk: Buffer) => writeStderr(chunk));
    }
    const stream = options?.progressStream === 'stderr' ? console.error : console.log;
    const started = Date.now();
    let tick = 0;
    const render = (suffix: string): void => {
      if (!options?.progressLabel) return;
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
    let spawnError: Error | undefined;
    child.on('error', (error) => {
      finish();
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      finish();
      // 성공 체크마크는 exit 코드 판정 후에만 — 실패 직후 "✓ done"이 찍히면
      // CI 로그 독자가 "빌드는 됐는데 다른 게 죽었다"로 오독한다(Q3).
      if (options?.progressLabel) {
        const total = ((Date.now() - started) / 1000).toFixed(1);
        if (code === 0 && !spawnError) {
          stream(`[rustra] ✓ ${options.progressLabel} done in ${total}s`);
        } else {
          stream(`[rustra] ✗ ${options.progressLabel} failed in ${total}s`);
        }
      }
      if (spawnError) {
        reject(spawnError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
      }
    });
  });
}
