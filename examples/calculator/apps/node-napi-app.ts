import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// barrel(index) 대신 개별 모듈 import — react-doctor no-barrel-import.
// configure/createRkyvV2Engine 은 @rustra/types 전역 설정/엔진 팩토리다.
import { createNodeEngine } from '../../../packages/node/src/node-core.js';
import { configure } from '../../../packages/types/src/global-config.js';
import { createRkyvV2Engine } from '../../../packages/types/src/rkyv-engine.js';
import { addNumbers } from '../generated/commands.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// napi CLI의 산출명은 플랫폼별로 다르다: macOS 는 `darwin-arm64`(ABI 접미사
// 없음), linux 는 `linux-x64-gnu`/`linux-arm64-gnu`(libc ABI 접미사 포함).
// 두 형태를 순서대로 시도해 첫 존재 파일을 로드한다.
const napiCandidates = [
  `calculator-napi.${process.platform}-${process.arch}.node`,
  `calculator-napi.${process.platform}-${process.arch}-gnu.node`,
];
const napiDir = resolve(__dirname, '..', '..', '..', '..', 'examples', 'calculator-napi');
const napiFile = napiCandidates.find((f) => existsSync(resolve(napiDir, f)));
if (!napiFile) {
  throw new Error(`napi addon not found in ${napiDir}: tried ${napiCandidates.join(', ')}`);
}
const native = createRequire(__dirname)(resolve(napiDir, napiFile)) as {
  rustraInvoke: (cmd: string, args: string | undefined) => string;
  rustraInvokeBuffer: (cmd: string, args: string | string | undefined) => Buffer;
  rustraInvokeRkyvV2: (payload: Buffer) => Buffer;
};

const engine = createNodeEngine({
  async invoke(command: string, args?: unknown): Promise<unknown> {
    const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
    const rawResponse = native.rustraInvoke(command, argsJson);

    const response = JSON.parse(rawResponse) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'invoke failed');
    }

    return response.result;
  },
});
configure(engine);

// Buffer 변형 스모크 — String 왕복 없이 동일 프레임.
const raw = native.rustraInvokeBuffer('addNumbers', JSON.stringify({ a: 2, b: 3 }));
const buffered = JSON.parse(raw.toString('utf8')) as { ok: boolean; result: { value: number } };
if (!buffered.ok || buffered.result.value !== 5) {
  throw new Error('rustraInvokeBuffer round-trip failed');
}

// rkyv V2 스모크 — napi Buffer 직결(postcard 왕복, JSON/UTF-16 없음).
// RkyvV2Native 계약(payload: ArrayBuffer)에 맞추기 위해 버퍼를 복사한다.
// 코어 실측 JSON 1.11µs → rkyv V2 61.5ns(18x), napi 고정비 제외 순수 격차.
const rkyvNative = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer {
    const resp = native.rustraInvokeRkyvV2(Buffer.from(payload));
    // Buffer.buffer는 슬라이스 오프셋/SharedArrayBuffer를 가질 수 있다 —
    // 정확한 크기의 ArrayBuffer 사본으로 정규화한다.
    const out = new ArrayBuffer(resp.byteLength);
    new Uint8Array(out).set(resp);
    return out;
  },
};
const rkyvEngine = createRkyvV2Engine(rkyvNative, rkyvV2Registry);
const rkyvResult = await rkyvEngine.invoke<{ value: number }>('addNumbers', { a: 40, b: 2 });
if (rkyvResult.value !== 42) {
  throw new Error(`rkyv V2 napi round-trip failed: got ${JSON.stringify(rkyvResult)}`);
}

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`node napi-rs result: ${result.value}`);
console.log(`node napi-rs rkyv V2 result: ${rkyvResult.value}`);
