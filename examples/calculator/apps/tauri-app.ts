import { addNumbers } from '../generated/tauri.js';
import { GENERATED_CONTRACT_HASH } from '../generated/contract.js';

const calls: Array<{ command: string; args: unknown }> = [];

(globalThis as typeof globalThis & { __TAURI__: unknown }).__TAURI__ = {
  core: {
    // 데모 앱 어댑터는 async 래핑을 표준 계약으로 시연한다(본문은 동기 반환).
    // eslint-disable-next-line @typescript-eslint/require-await
    async invoke(command: string, args?: unknown) {
      calls.push({ command, args });
      if (command === 'rustra_contract_hash') return GENERATED_CONTRACT_HASH;
      return { value: 42 };
    },
  },
};

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

if (
  JSON.stringify(calls) !==
  JSON.stringify([
    { command: 'rustra_contract_hash', args: { expectedHash: GENERATED_CONTRACT_HASH } },
    { command: 'rustra_dispatch', args: { command: 'addNumbers', args: { a: 20, b: 22 } } },
  ])
) {
  throw new Error(`unexpected Tauri invoke calls: ${JSON.stringify(calls)}`);
}

console.log(`tauri injected invoke result: ${result.value}`);
