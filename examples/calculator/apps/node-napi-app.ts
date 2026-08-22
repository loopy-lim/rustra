import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { configure, createNodeEngine } from '../../../packages/node/src/index.js';
import { addNumbers } from '../generated/commands.js';

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

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`node napi-rs result: ${result.value}`);
