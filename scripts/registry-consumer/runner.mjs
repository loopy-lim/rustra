import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetails(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    stack: error.stack ?? null,
  };
}

export function sanitizeStepName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function formatRawLog({ step, command, result, thrown }) {
  const lines = [`step: ${step.name}`];
  if (command) lines.push(`cwd: ${command.cwd}`, `argv: ${JSON.stringify(command.argv)}`);
  if (result) {
    lines.push(
      `status: ${result.status ?? 'null'}`,
      `signal: ${result.signal ?? 'null'}`,
      '',
      '[stdout]',
      result.stdout ?? '',
      '',
      '[stderr]',
      result.stderr ?? '',
    );
    if (result.error)
      lines.push('', '[spawn-error]', JSON.stringify(errorDetails(result.error), null, 2));
  }
  if (thrown) lines.push('', '[exception]', JSON.stringify(errorDetails(thrown), null, 2));
  return `${lines.join('\n')}\n`;
}

function defaultRunner(step) {
  const command = step.command;
  const spawned = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: command.cwd,
    env: command.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: command.timeoutMs ?? STEP_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: spawned.status,
    signal: spawned.signal,
    stdout: spawned.stdout ?? '',
    stderr: spawned.stderr ?? '',
    error: spawned.error,
  };
}

export async function runOrderedSteps({ steps, runner = defaultRunner, logDir }) {
  mkdirSync(logDir, { recursive: true });
  const reports = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const startedAt = new Date();
    const rawLogPath = join(
      logDir,
      `${String(index + 1).padStart(3, '0')}-${sanitizeStepName(step.name)}.log`,
    );
    let result;
    try {
      result = await runner(step);
    } catch (error) {
      writeFileSync(rawLogPath, formatRawLog({ step, command: step.command, thrown: error }));
      const report = {
        name: step.name,
        ok: false,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        status: null,
        signal: null,
        rawLogPath,
      };
      reports.push(report);
      return {
        ok: false,
        steps: reports,
        error: { ...errorDetails(error), step: step.name, rawLogPath },
      };
    }
    writeFileSync(rawLogPath, formatRawLog({ step, command: step.command, result }));
    const ok = result?.status === 0 && !result?.error;
    const report = {
      name: step.name,
      ok,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      rawLogPath,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
    reports.push(report);
    if (!ok) {
      const diagnostics = [
        result?.error ? errorText(result.error) : '',
        result?.stderr?.trim() ?? '',
        result?.stdout?.trim() ?? '',
        result?.status !== undefined ? `exit status ${result.status}` : '',
        result?.signal ? `signal ${result.signal}` : '',
      ].filter(Boolean);
      return {
        ok: false,
        steps: reports,
        error: {
          message: diagnostics.join('\n') || 'child process failed without output or diagnostics',
          code: result?.error?.code ?? null,
          step: step.name,
          rawLogPath,
        },
      };
    }
  }
  return { ok: true, steps: reports };
}
