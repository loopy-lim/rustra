import { addNumbers, subscribeEvent } from '../../calculator/generated/tauri.js';

// 이벤트 푸시 수신 — Rust 측 register_with_events 가 설치한 싱크가
// Package::emit 을 "rustra://{name}" 채널로 전달한다 (폴링 불필요).
// 채널 이름의 "." 는 "_" 로 치환된다 (Tauri 채널 이름 규칙).
// 페이로드는 웹뷰에서 이미 파싱된 객체로 도착한다 (emit_str 원시 splice).
const EVENT_NAME = 'calc.tick';

interface CalcTick {
  value: number;
}

await subscribeEvent<CalcTick>(EVENT_NAME, (payload) => {
  const tick = document.querySelector('#tick');
  if (tick) {
    tick.textContent = String(payload.value);
  }
  document.body.dataset.lastTick = String(payload.value);
  console.log(`rustra push event ${EVENT_NAME}: ${payload.value}`);
});

const result = await addNumbers({ a: 20, b: 22 });
const output = document.querySelector('output');

if (output) {
  output.value = String(result.value);
}

document.body.dataset.result = String(result.value);
console.log(`tauri runtime result: ${result.value}`);
