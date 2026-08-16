import { configure } from '@rustra/types';
import { addNumbers } from '../../calculator/generated/commands.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';

declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke<T>(command: string, args?: unknown): Promise<T>;
      };
      event: {
        listen<T>(event: string, handler: (payload: { payload: T }) => void): Promise<() => void>;
      };
    };
  }
}

const engine = createTauriEngine({
  invoke: window.__TAURI__.core.invoke,
});
configure(engine);

// 이벤트 푸시 수신 — Rust 측 register_with_events 가 설치한 싱크가
// Package::emit 을 "rustra://{name}" 채널로 전달한다 (폴링 불필요).
// 채널 이름의 "." 는 "_" 로 치환된다 (Tauri 채널 이름 규칙).
// 페이로드는 웹뷰에서 이미 파싱된 객체로 도착한다 (emit_str 원시 splice).
const EVENT_NAME = 'calc.tick';
const CHANNEL = `rustra://${EVENT_NAME.replace(/\./g, '_')}`;

interface CalcTick {
  value: number;
}

await window.__TAURI__.event.listen<CalcTick>(CHANNEL, ({ payload }) => {
  const tick = document.querySelector('#tick');
  if (tick) {
    tick.textContent = String(payload.value);
  }
  document.body.dataset.lastTick = String(payload.value);
  console.log(`rustra push event ${CHANNEL}: ${payload.value}`);
});

const result = await addNumbers({ a: 20, b: 22 });
const output = document.querySelector('output');

if (output) {
  output.value = String(result);
}

document.body.dataset.result = String(result);
console.log(`tauri runtime result: ${result}`);
