/* global Bun, Response, console, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultBinary = resolve(root, 'target/release/rustra-tauri-calculator');
const corsHeaders = {
  'access-control-allow-headers': 'content-type, x-rustra-benchmark',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-origin': '*',
};

/** Runs the local app and accepts checkpoints without settling the final receipt. */
export async function runTauriBenchmark(options = {}) {
  const startedAt = Date.now();
  const timeoutMs =
    options.timeoutMs ?? Number(process.env.RUSTRA_TAURI_BENCH_TIMEOUT_MS ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new Error(
      'Tauri benchmark timeout must be an integer between 1000 and 600000 ms (RUSTRA_TAURI_BENCH_TIMEOUT_MS).',
    );
  }
  const onProgress =
    options.onProgress ??
    ((progress) =>
      console.error(
        `RUSTRA_TAURI_BENCH_PROGRESS=${JSON.stringify({ ...progress, elapsedMs: Date.now() - startedAt })}`,
      ));
  const onNativeCheckpoint =
    options.onNativeCheckpoint ??
    ((line) => console.error(`${line} elapsedMs=${Date.now() - startedAt}`));
  let resolveReceipt;
  let rejectReceipt;
  const receiptPromise = new Promise((resolveValue, rejectValue) => {
    resolveReceipt = resolveValue;
    rejectReceipt = rejectValue;
  });
  let finalReceived = false;
  let stage = 'app-launch';
  let diagnostics = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 19473,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
      const contentLength = Number(request.headers.get('content-length') ?? 0);
      if (
        request.method !== 'POST' ||
        url.pathname !== '/rustra-benchmark' ||
        request.headers.get('content-type') !== 'application/json' ||
        request.headers.get('x-rustra-benchmark') !== 'receipt-v1' ||
        contentLength > 100_000
      ) {
        return new Response('not found', { status: 404, headers: corsHeaders });
      }
      try {
        const message = await request.json();
        if (message?.type === 'progress') {
          if (
            typeof message.stage !== 'string' ||
            message.stage.length === 0 ||
            message.stage.length > 120 ||
            (message.completedCalls !== undefined &&
              (!Number.isSafeInteger(message.completedCalls) || message.completedCalls < 0)) ||
            (message.averageNs !== undefined &&
              (!Number.isFinite(message.averageNs) || message.averageNs <= 0))
          ) {
            return new Response('invalid progress', { status: 400, headers: corsHeaders });
          }
          stage = message.stage;
          onProgress(message);
        } else {
          finalReceived = true;
          if (typeof message?.error === 'string')
            rejectReceipt(new Error(`Tauri WebView failed at ${stage}: ${message.error}`));
          else resolveReceipt(message);
        }
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch (error) {
        rejectReceipt(error);
        return new Response('invalid receipt', { status: 400, headers: corsHeaders });
      }
    },
  });
  let app;
  let timeoutId;
  try {
    app = spawn(options.binary ?? defaultBinary, options.args ?? [], {
      cwd: options.cwd ?? root,
      env: {
        ...process.env,
        ...options.env,
        RUSTRA_BENCH: '1',
        RUSTRA_BENCH_RECEIPT_URL: `http://127.0.0.1:${server.port}/rustra-benchmark`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [app.stdout, app.stderr]) {
      let pendingLines = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-4000);
        pendingLines += chunk;
        const lines = pendingLines.split('\n');
        pendingLines = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('RUSTRA_TAURI_BENCH_NATIVE=')) onNativeCheckpoint(line);
        }
      });
    }
    app.on('error', (error) =>
      rejectReceipt(
        new Error(`Failed to launch Tauri benchmark: ${error.message}`, { cause: error }),
      ),
    );
    app.on('close', (code, signal) => {
      if (!finalReceived)
        rejectReceipt(
          new Error(
            `Tauri app exited before receipt (code ${code}, signal ${signal ?? 'none'}, last stage ${stage}). ${diagnostics}`,
          ),
        );
    });
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              `Tauri WebView receipt timed out after ${timeoutMs}ms (last stage ${stage}). ${diagnostics}`,
            ),
          ),
        timeoutMs,
      );
    });
    const receipt = await Promise.race([receiptPromise, timeout]);
    const result = receipt?.results?.[0];
    if (result?.name !== 'tauri-generated-webview-ipc' || result.correctness !== true) {
      throw new Error(`invalid Tauri benchmark receipt: ${JSON.stringify(receipt)}`);
    }
    return receipt;
  } finally {
    clearTimeout(timeoutId);
    app?.kill();
    server.stop(true);
  }
}

if (import.meta.main) {
  const receipt = await runTauriBenchmark();
  console.log(`RUSTRA_HOST_BENCH_JSON=${JSON.stringify(receipt)}`);
}
