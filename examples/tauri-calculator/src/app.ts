import { addNumbers, subscribeEvent } from '../../calculator/generated/tauri.js';
import { subscribeHotSwap, type HotSwapEvent } from '@rustra/tauri';

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

// 핫코어 스왑 보고 — register_dispatch_with_swap_events (RUSTRA_HOT_CORE 모드)가
// 설치한 싱크가 "rustra://hot-core/swapped" 예약 채널로 스왑 결과를 푸시한다.
// 성공 {oldContractHash, newContractHash} / 실패 {error}. 구·신 해시가 함께 오므로
// 이 이벤트가 JS 캐시 재동기화 신호를 대행한다(스왑 후 재호출 판단 가능).
function describeHotSwap(event: HotSwapEvent): string {
  const time = new Date().toLocaleTimeString();
  if ('error' in event) {
    return `${time} swap failed: ${event.error}`;
  }
  return `${time} swapped ${event.oldContractHash.slice(0, 8)} -> ${event.newContractHash.slice(0, 8)}`;
}

await subscribeHotSwap((event) => {
  const line = describeHotSwap(event);
  const status = document.querySelector('#hot-swap');
  if (status) {
    status.textContent = line;
  }
  document.body.dataset.lastHotSwap = line;
  console.log(`rustra hot-core: ${line}`);
});

const result = await addNumbers({ a: 20, b: 22 });
const output = document.querySelector('output');

if (output) {
  output.value = String(result.value);
}

document.body.dataset.result = String(result.value);
console.log(`tauri runtime result: ${result.value}`);
