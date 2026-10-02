import assert from 'node:assert/strict';
import { test } from 'bun:test';
import process from 'node:process';
import { runTauriBenchmark } from './benchmark.mjs';

const validReceipt = {
  runtime: 'controlled runner peer',
  results: [{ name: 'tauri-generated-webview-ipc', correctness: true }],
};

test('runner consumes progress without mistaking it for the final benchmark receipt', async () => {
  const stages = [];
  const script = `
    const send = body => fetch(process.env.RUSTRA_BENCH_RECEIPT_URL, {
      method:'POST', headers:{'content-type':'application/json','x-rustra-benchmark':'receipt-v1'},
      body:JSON.stringify(body)
    });
    await send({type:'progress',stage:'first-call',completedCalls:1,averageNs:123.5});
    await send(${JSON.stringify(validReceipt)});
    setInterval(()=>{},1000);
  `;
  const receipt = await runTauriBenchmark({
    binary: process.execPath,
    args: ['--eval', script],
    port: 0,
    timeoutMs: 3000,
    onProgress: (progress) => stages.push(progress),
  });
  assert.deepEqual(stages, [
    { type: 'progress', stage: 'first-call', completedCalls: 1, averageNs: 123.5 },
  ]);
  assert.deepEqual(receipt, validReceipt);
});

test('runner forwards a native window checkpoint without exposing unrelated app output', async () => {
  const checkpoints = [];
  const script = `
    console.error('unrelated app output');
    process.stderr.write('RUSTRA_TAURI_BENCH_NA');
    process.stderr.write('TIVE=window-ready visible=true focused=true\\n');
    await fetch(process.env.RUSTRA_BENCH_RECEIPT_URL,{method:'POST',headers:{'content-type':'application/json','x-rustra-benchmark':'receipt-v1'},body:JSON.stringify(${JSON.stringify(validReceipt)})});
    setInterval(()=>{},1000);
  `;
  await runTauriBenchmark({
    binary: process.execPath,
    args: ['--eval', script],
    port: 0,
    timeoutMs: 3000,
    onNativeCheckpoint: (line) => checkpoints.push(line),
  });
  assert.deepEqual(checkpoints, [
    'RUSTRA_TAURI_BENCH_NATIVE=window-ready visible=true focused=true',
  ]);
});

test('runner reports an app exit before receipt with its diagnostics', async () => {
  await assert.rejects(
    runTauriBenchmark({
      binary: process.execPath,
      args: ['--eval', 'console.error("native boot failed");process.exit(7)'],
      port: 0,
      timeoutMs: 3000,
    }),
    /exited.*7.*native boot failed/s,
  );
});

test('runner reports a spawn failure without an unhandled child error', async () => {
  await assert.rejects(
    runTauriBenchmark({
      binary: '/private/tmp/rustra-nonexistent-benchmark-app',
      port: 0,
      timeoutMs: 3000,
    }),
    /launch.*ENOENT/s,
  );
});

test('runner timeout identifies the last WebView checkpoint', async () => {
  const script = `
    await fetch(process.env.RUSTRA_BENCH_RECEIPT_URL,{method:'POST',headers:{'content-type':'application/json','x-rustra-benchmark':'receipt-v1'},body:JSON.stringify({type:'progress',stage:'webview-ready'})});
    setInterval(()=>{},1000);
  `;
  await assert.rejects(
    runTauriBenchmark({
      binary: process.execPath,
      args: ['--eval', script],
      port: 0,
      timeoutMs: 1000,
      onProgress() {},
    }),
    /timed out.*webview-ready/s,
  );
});

test('runner rejects an invalid deadline before launching the app', async () => {
  for (const timeoutMs of [0, Number.NaN, 600001]) {
    await assert.rejects(runTauriBenchmark({ timeoutMs }), /timeout.*1000.*600000/s);
  }
});
