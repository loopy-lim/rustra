import {
  rustra_mobile_init,
  rustra_ffi_invoke_json_into_len,
  rustra_ffi_event_sink_register_scriptc,
  rustra_ffi_event_sink_release_scriptc,
  rustra_ffi_channel_create_bytes,
  rustra_ffi_channel_release_scriptc,
  rustra_ffi_channel_send_bytes,
  rustra_ffi_invoke_json_async_channel,
  rustra_ffi_invoke_cancel,
  rustra_ffi_cancellation_status,
} from '../scriptc/scriptc-ffi.js';
import {
  rustra_stress_wait_workers,
  rustra_stress_release_workers,
  rustra_stress_handler_calls,
} from '../scriptc/stress-controls.js';

// A real native executable with an external deadline. The private fixture only
// controls worker scheduling; callbacks, async, cancellation and free are production.
rustra_mobile_init();
const cycles = 64;
const cancelledRequests = 64;
const decoder = new TextDecoder();
const output = new Uint8Array(1024);
const saved: Uint8Array[] = [];
let copiedCalls = 0;
let oldEvents = 0;
let newEvents = 0;
let eventApplications = 0;
let eventsActive = true;
let asyncCalls = 0;
let cancellationCalls = 0;
let lateCalls = 0;
let pollCount = 0;
let observedCompletion = false;
const ids: bigint[] = [];

const onCopied: (handle: number, payload: Uint8Array) => void = (_handle, payload) => {
  // Source storage was mutated and both registrations released before the loop
  // could run. Already queued deliveries must own an independent copy.
  if (payload.length !== 4 || payload[1] !== 0 || payload[2] !== 128 || payload[3] !== 255)
    throw new Error('borrowed native bytes were not copied before queueing');
  if (payload[0] !== Math.floor(copiedCalls / 3)) throw new Error('foreign queue order changed');
  saved.push(payload);
  copiedCalls += 1;
};
const onOld: (name: string, payload: string) => void = (name, payload) => {
  if (name !== 'notice' || Number(payload) !== oldEvents) throw new Error('old event mismatch');
  oldEvents += 1;
  if (eventsActive) eventApplications += 1;
};
const onNew: (name: string, payload: string) => void = (name, payload) => {
  if (name !== 'notice' || Number(payload) !== newEvents)
    throw new Error('new owner event mismatch');
  newEvents += 1;
  if (eventsActive) eventApplications += 1;
};

for (let cycle = 0; cycle < cycles; cycle += 1) {
  const first = rustra_ffi_channel_create_bytes(onCopied);
  const second = rustra_ffi_channel_create_bytes(onCopied);
  if (first === 0 || second <= first) throw new Error('channel handles must increase');
  const bytes = new Uint8Array([cycle, 0, 128, 255]);
  if (rustra_ffi_channel_send_bytes(first, bytes) !== 1) throw new Error('first send failed');
  if (rustra_ffi_channel_send_bytes(second, bytes) !== 1) throw new Error('second send failed');
  rustra_ffi_channel_release_scriptc(onCopied);
  if (rustra_ffi_channel_send_bytes(second, bytes) !== 0)
    throw new Error('newest owner was not released');
  if (rustra_ffi_channel_send_bytes(first, bytes) !== 1)
    throw new Error('older registration was lost');
  rustra_ffi_channel_release_scriptc(onCopied);
  if (rustra_ffi_channel_send_bytes(first, bytes) !== 0)
    throw new Error('released channel accepted send');
  bytes[0] = 255;
  bytes[2] = 0;

  rustra_ffi_event_sink_register_scriptc(onOld);
  rustra_ffi_invoke_json_into_len(JSON.stringify({ command: 'emit', args: cycle }), output);
  rustra_ffi_event_sink_register_scriptc(onNew);
  rustra_ffi_event_sink_release_scriptc(onOld);
  rustra_ffi_invoke_json_into_len(JSON.stringify({ command: 'emit', args: cycle }), output);
  rustra_ffi_event_sink_release_scriptc(onNew);
  rustra_ffi_invoke_json_into_len(JSON.stringify({ command: 'emit', args: 999 }), output);
}
// Release prevents new native posts. Already queued callbacks still drain, so
// disposing consumer state separately guards effects from those deliveries.
eventsActive = false;

const onAsync: (handle: number, payload: Uint8Array) => void = (_handle, payload) => {
  const envelope = JSON.parse(decoder.decode(payload));
  if (envelope.ok) {
    if (envelope.result !== 100 && envelope.result !== 101)
      throw new Error('cancelled handler ran');
  } else {
    if (!String(envelope.error).startsWith('cancelled:')) throw new Error('unexpected async error');
    cancellationCalls += 1;
  }
  asyncCalls += 1;
  if (asyncCalls === cancelledRequests + 2) rustra_ffi_channel_release_scriptc(onAsync);
};
const asyncChannel = rustra_ffi_channel_create_bytes(onAsync);
ids.push(
  rustra_ffi_invoke_json_async_channel(
    JSON.stringify({ command: 'block', args: 100 }),
    asyncChannel,
  ),
);
ids.push(
  rustra_ffi_invoke_json_async_channel(
    JSON.stringify({ command: 'block', args: 101 }),
    asyncChannel,
  ),
);
if (!rustra_stress_wait_workers()) throw new Error('both workers did not enter the gate');
for (let index = 0; index < cancelledRequests; index += 1) {
  const id = rustra_ffi_invoke_json_async_channel(
    JSON.stringify({ command: 'count', args: index }),
    asyncChannel,
  );
  if (id === 0n || !rustra_ffi_invoke_cancel(id)) throw new Error('queued cancellation failed');
  if (rustra_ffi_cancellation_status(id) !== 2) throw new Error('cancel state not observable');
  ids.push(id);
}
const onLate: (handle: number, payload: Uint8Array) => void = (_handle, _payload) => {
  lateCalls += 1;
};
const lateChannel = rustra_ffi_channel_create_bytes(onLate);
const lateId = rustra_ffi_invoke_json_async_channel(
  JSON.stringify({ command: 'count', args: 999 }),
  lateChannel,
);
rustra_ffi_channel_release_scriptc(onLate);
if (rustra_ffi_invoke_json_async_channel('{', lateChannel) !== 0n)
  throw new Error('closed invocation accepted');
rustra_stress_release_workers();

function finish(): void {
  pollCount += 1;
  if (pollCount > 1000) throw new Error('scriptc stress did not drain before its deadline');
  if (
    copiedCalls !== cycles * 3 ||
    oldEvents !== cycles ||
    newEvents !== cycles ||
    asyncCalls !== cancelledRequests + 2 ||
    rustra_ffi_cancellation_status(lateId) !== 0
  ) {
    setTimeout(finish, 5);
    return;
  }
  // Keep the real script loop alive after observing Rust completion. Otherwise
  // process exit could hide a forbidden delivery racing the completion checkpoint.
  if (!observedCompletion) {
    observedCompletion = true;
    setTimeout(finish, 50);
    return;
  }
  if (cancellationCalls !== cancelledRequests || rustra_stress_handler_calls() !== 1)
    throw new Error('cancelled commands crossed their dispatch checkpoint');
  if (lateCalls !== 0 || eventApplications !== 0)
    throw new Error('disposed consumer received an effect');
  for (let index = 0; index < saved.length; index += 1) {
    if (saved[index][0] !== Math.floor(index / 3) || saved[index][2] !== 128)
      throw new Error('retained callback bytes changed after later deliveries');
  }
  for (let index = 0; index < ids.length; index += 1) {
    if (
      ids[index] === 0n ||
      rustra_ffi_cancellation_status(ids[index]) !== 0 ||
      rustra_ffi_invoke_cancel(ids[index])
    )
      throw new Error('completed cancellation ID stayed live');
  }
  console.log(
    `scriptc stress PASS cycles=${cycles} copied=${copiedCalls} events=${oldEvents + newEvents} cancelled=${cancellationCalls} late=${lateCalls}`,
  );
}
setTimeout(finish, 5);
