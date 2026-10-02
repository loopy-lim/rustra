import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';

const adapter = new URL('./index.js', import.meta.url).href;
const library = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../target/debug',
  `librustra_calculator_example.${suffix}`,
);

function nativeScenario(action: string): void {
  const source = `
    import assert from 'node:assert/strict';
    import {createBunBootstrap,createBunEventSubscription} from ${JSON.stringify(adapter)};
    const bootstrap=createBunBootstrap({library:${JSON.stringify(library)},frameCodecs:new Map([['emitDemo',{
      commandId:11,encode:()=>Uint8Array.of(11,0,0,0).buffer,decode:()=>({ok:true,result:{emitted:1}})
    }]])});
    const engine=await bootstrap.ready();
    ${action}
    bootstrap.dispose();
  `;
  const result = spawnSync('bun', ['-e', source], { encoding: 'utf8', timeout: 2_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test('last native unsubscribe inside its callback returns without waiting on itself', () => {
  nativeScenario(`
    let calls=0;
    let unsubscribe=()=>{};
    unsubscribe=bootstrap.subscribeEvent('demo.done',()=>{calls++;unsubscribe();});
    await engine.invoke('emitDemo');
    assert.equal(calls,1);
    await new Promise(resolve=>queueMicrotask(resolve));
    await engine.invoke('emitDemo');
    assert.equal(calls,1);
    const next=bootstrap.subscribeEvent('demo.done',()=>calls++);
    await engine.invoke('emitDemo');
    assert.equal(calls,2);
    next();
  `);
});

test('disposing a native bootstrap inside its callback releases it after callback return', () => {
  nativeScenario(`
    let calls=0;
    bootstrap.subscribeEvent('demo.done',()=>{calls++;bootstrap.dispose();});
    await engine.invoke('emitDemo');
    assert.equal(calls,1);
    assert.equal(bootstrap.state,'disposed');
    await new Promise(resolve=>queueMicrotask(resolve));
  `);
});

test('old native unsubscribe closures cannot remove a replacement subscription', () => {
  nativeScenario(`
    const subscription=createBunEventSubscription({library:${JSON.stringify(library)}});
    const seen=[];
    const callback=payload=>seen.push(payload);
    const old=subscription.subscribeEvent('demo.done',callback);
    old();
    const next=subscription.subscribeEvent('demo.done',callback);
    old();
    await engine.invoke('emitDemo');
    assert.deepEqual(seen,[{emitted:1}]);
    next();subscription.dispose();
  `);
});

test('disposing an older bootstrap cannot unregister the newer library subscriber', () => {
  nativeScenario(`
    const seen=[];
    bootstrap.subscribeEvent('demo.done',()=>{throw new Error('retired callback invoked');});
    const newer=createBunBootstrap({library:${JSON.stringify(library)},frameCodecs:new Map([['emitDemo',{
      commandId:11,encode:()=>Uint8Array.of(11,0,0,0).buffer,decode:()=>({ok:true,result:{emitted:1}})
    }]])});
    const nextEngine=await newer.ready();
    newer.subscribeEvent('demo.done',payload=>seen.push(payload));
    bootstrap.dispose();
    await nextEngine.invoke('emitDemo');
    assert.deepEqual(seen,[{emitted:1}]);
    newer.dispose();
  `);
});
