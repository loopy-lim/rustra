import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { RustraCommandError, parseRustraErrorString } from '@rustra/types';
import type { NodeInvokeTransport } from './node-core.js';

type LoopResponseFrame = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  events?: Array<{ name: string; payload: unknown }>;
};
export type NodeLoopTransport = NodeInvokeTransport & {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
  dispose(): void;
  readonly pid: number | null;
};

/** Persistent NDJSON transport for Rust loop-stdio runtimes. */
export function createNodeLoopTransport(options: {
  command: string;
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
}): NodeLoopTransport {
  let child: ChildProcessWithoutNullStreams | null = null;
  const pending = new Map<
    number,
    { resolve: (frame: LoopResponseFrame) => void; reject: (error: RustraCommandError) => void }
  >();
  let nextId = 1;
  let stdoutBuffer = '';
  const ensureProcess = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null) return child;
    const proc = spawn(options.command, options.args ?? [], options.spawnOptions ?? {});
    child = proc as ChildProcessWithoutNullStreams;
    if (!proc.stdout || !proc.stderr) {
      child = null;
      throw new RustraCommandError('transport.error', 'stdio unavailable', true);
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let frame: LoopResponseFrame;
        try {
          frame = JSON.parse(line) as LoopResponseFrame;
        } catch {
          continue;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        frame.ok
          ? waiter.resolve(frame)
          : waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', () => {
      const error = new RustraCommandError(
        'transport.error',
        'runtime process exited before responding',
        true,
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    return child;
  };
  const write = (payload: Record<string, unknown>): Promise<LoopResponseFrame> =>
    new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = ensureProcess();
      } catch (error) {
        reject(error);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(new RustraCommandError('transport.error', `write failed: ${String(error)}`, true));
        }
      });
    });
  return {
    invoke(command, args) {
      return write({ command, args: args ?? {} }).then((frame) => frame.result);
    },
    async drainEvents() {
      return (await write({ command: '__drainEvents', args: {} })).events ?? [];
    },
    dispose() {
      if (child && child.exitCode === null) {
        child.stdin.end();
        child.kill();
      }
      child = null;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}
