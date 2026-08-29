import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeEngine, createNodeLoopTransport, type NodeLoopBinaryCodecs } from '@rustra/node';
import { createRkyvV2Engine } from '@rustra/types';
import { addNumbers, rustra } from '../generated/node.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';
import { benchmarkCommand } from './performance-stats.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// addNumbers 의 i64 결과는 fast-path 코덱이 safe 범위 밖에서 bigint 로 복원한다.
const validate = (result: { value: number | bigint }) => result.value === 42;

const oneShot = await benchmarkCommand({
  name: 'node-generated-one-shot',
  invoke: () => addNumbers({ a: 20, b: 22 }),
  validate,
  warmup: 10,
  iterations: 200,
});
rustra.dispose();

const loopTransport = createNodeLoopTransport({
  command: resolve(root, 'target/release/loop-stdio'),
  // 트랙 D — __hello 핸드셰이크 후 length-prefixed rkyv V2 프레임 왕복
  // (이중 JSON 제거). generated 코덱이 encode/decode 를 담당한다.
  codecs: rkyvV2Registry,
});
await loopTransport.ready();
const loopEngine = createNodeEngine(loopTransport);
const loop = await benchmarkCommand({
  name: 'node-persistent-loop',
  invoke: () => loopEngine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 }),
  validate,
  warmup: 100,
  iterations: 2_000,
});
loopTransport.dispose();

const addonDirectory = resolve(root, 'examples/calculator-napi');
const addonNames = [
  `calculator-napi.${process.platform}-${process.arch}.node`,
  `calculator-napi.${process.platform}-${process.arch}-gnu.node`,
];
const addonName = addonNames.find((name) => existsSync(resolve(addonDirectory, name)));
if (!addonName) {
  throw new Error(`Node N-API addon not found: tried ${addonNames.join(', ')}`);
}
const native = createRequire(import.meta.url)(resolve(addonDirectory, addonName)) as {
  rustraInvokeRkyvV2(payload: Buffer): Buffer;
};
const napiEngine = createRkyvV2Engine(
  {
    invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer {
      const response = native.rustraInvokeRkyvV2(Buffer.from(payload));
      const owned = new ArrayBuffer(response.byteLength);
      new Uint8Array(owned).set(response);
      return owned;
    },
  },
  rkyvV2Registry,
);
const napi = await benchmarkCommand({
  name: 'node-napi-rkyv-v2',
  invoke: () => napiEngine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 }),
  validate,
  warmup: 500,
  iterations: 10_000,
});

console.log(
  `RUSTRA_HOST_BENCH_JSON=${JSON.stringify({ runtime: `Node ${process.version}`, results: [oneShot, loop, napi] })}`,
);
