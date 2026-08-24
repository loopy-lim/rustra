import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(root, 'target/release/rustra-tauri-calculator');
let resolveReceipt;
let rejectReceipt;
const receiptPromise = new Promise((resolveValue, rejectValue) => {
  resolveReceipt = resolveValue;
  rejectReceipt = rejectValue;
});

const corsHeaders = {
  'access-control-allow-headers': 'content-type, x-rustra-benchmark',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-origin': '*',
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 19473,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    const validReceiptRequest =
      request.method === 'POST' &&
      url.pathname === '/rustra-benchmark' &&
      request.headers.get('content-type') === 'application/json' &&
      request.headers.get('x-rustra-benchmark') === 'receipt-v1' &&
      contentLength <= 100_000;
    if (!validReceiptRequest) {
      return new Response('not found', { status: 404, headers: corsHeaders });
    }
    try {
      const receipt = await request.json();
      resolveReceipt(receipt);
      return Response.json({ ok: true }, { headers: corsHeaders });
    } catch (error) {
      rejectReceipt(error);
      return new Response('invalid receipt', { status: 400, headers: corsHeaders });
    }
  },
});

const app = spawn(binary, [], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
app.stderr.setEncoding('utf8');
app.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4_000);
});

let timeoutId;
const timeout = new Promise((_, reject) => {
  timeoutId = setTimeout(
    () => reject(new Error(`Tauri WebView receipt timed out. ${stderr}`)),
    60_000,
  );
});

try {
  const receipt = await Promise.race([receiptPromise, timeout]);
  const result = receipt?.results?.[0];
  if (result?.name !== 'tauri-generated-webview-ipc' || result.correctness !== true) {
    throw new Error(`invalid Tauri benchmark receipt: ${JSON.stringify(receipt)}`);
  }
  console.log(`RUSTRA_HOST_BENCH_JSON=${JSON.stringify(receipt)}`);
} finally {
  clearTimeout(timeoutId);
  app.kill();
  server.stop(true);
}
