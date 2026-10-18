// rn-experiment RN 어댑터 플로우 — examples/calculator/apps/react-native-app.ts 패턴.
// 실기기(JSI) 없이 호스트에서 RN JSON 어댑터 경로를 검증한다: 네이티브 유닛
// (examples/rn-experiment/src/lib.rs — gzip 2종 + uuidV7)을 주입 모듈로 에뮬레이션해
// 생성 명령(gzip 왕복 바이트 일치, uuid v7 형식, 어댑터 에러 경로)을 점검한다.
import { gzipCompress, gzipDecompress, uuidV7 } from '../generated/commands.js';
import { RustraCommandError } from '../generated/types.js';
// Use the same public package instances as generated commands and errors.
// Mixing src/ imports and package dist/ creates distinct RustraCommandError classes.
import { configure } from '@rustra/types';
import { createReactNativeEngine } from '@rustra/react-native';
import { gzipSync, gunzipSync } from 'node:zlib';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** LCG 기반 결정적 페이로드 — 네이티브 테스트(tests/rn_experiment.rs)와 동일 알파벳. */
function pseudoRandomPayload(len: number): Uint8Array {
  let state = 0x1234_5678 | 0;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    bytes[i] = state >>> 28;
  }
  return bytes;
}

/** JSON 와이어의 byte 필드(number 배열)를 바이트로 복원한다. */
function toBytes(value: unknown): Uint8Array {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError('expected byte payload as a number array');
}

/** UUID v7(48비트 ms 타임스탬프 + ver 7 + RFC 변형)을 생성한다 — 네이티브 에뮬레이션. */
function uuidV7Native(): string {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const variant = (0x8 + (parseInt(random.slice(3, 4), 16) % 4)).toString(16);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

function respond(message: unknown): ArrayBuffer {
  return encoder.encode(JSON.stringify(message)).buffer as ArrayBuffer;
}

// 주입 네이티브 모듈 — FfiFormat::Json 와이어({command,args} → {ok,result|error}).
const NativeRustraModule = {
  invoke(payload: ArrayBuffer): ArrayBuffer {
    const request = JSON.parse(decoder.decode(payload)) as {
      command: string;
      args?: { data?: unknown };
    };
    if (request.command === 'gzipCompress') {
      const compressed = gzipSync(Buffer.from(toBytes(request.args?.data)));
      return respond({ ok: true, result: { data: Array.from(compressed) } });
    }
    if (request.command === 'gzipDecompress') {
      try {
        const decompressed = gunzipSync(Buffer.from(toBytes(request.args?.data)));
        return respond({ ok: true, result: { data: Array.from(decompressed) } });
      } catch (error) {
        return respond({
          ok: false,
          error: `command.invalid_args: invalid gzip payload: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (request.command === 'uuidV7') {
      return respond({ ok: true, result: { value: uuidV7Native() } });
    }
    return respond({
      ok: false,
      error: `command.not_found: command not found: ${request.command}`,
    });
  },
};

function bytesEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** 응답 byte 필드(ArrayBuffer 포함 유니언)를 바이트 뷰로 통일한다. */
function asBytes(value: import('../generated/types.js').GzipPayload['data']): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);
}

const engine = createReactNativeEngine(NativeRustraModule);
configure(engine);

// 1) gzip 왕복 — 네이티브 JSON 와이어에서 byte 필드는 number 배열로 직렬화된다.
const originalBytes = pseudoRandomPayload(64 * 1024);
const compressed = asBytes((await gzipCompress({ data: Array.from(originalBytes) })).data);

// 2) gzip 출력 — gzip 멤버 스트림 매직 넘버(0x1f 0x8b) + deflate 방법(0x08) + 실제 압축.
if (compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 0x08) {
  throw new Error('gzipCompress output is not a gzip member stream');
}
if (compressed.length >= originalBytes.length) {
  throw new Error(
    `repetitive payload should compress (raw=${originalBytes.length}, compressed=${compressed.length})`,
  );
}
console.log(
  `pass: gzipCompress — gzip member stream, ${originalBytes.length} B → ${compressed.length} B`,
);

const restored = asBytes((await gzipDecompress({ data: Array.from(compressed) })).data);
if (!bytesEqual(restored, originalBytes)) {
  throw new Error('gzipDecompress roundtrip mismatch');
}
console.log('pass: gzipDecompress roundtrip — original 65536 bytes match');

// 3) uuid v7 형식 — 하이픈 형식, ver 니블 7, RFC 변형(8/9/a/b), 임베디드 ms 타임스탬프.
const { value } = await uuidV7({});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
if (!uuidPattern.test(value)) {
  throw new Error(`uuidV7 format mismatch: ${value}`);
}
const embeddedMs = Number.parseInt(value.replace(/-/g, '').slice(0, 12), 16);
if (Math.abs(embeddedMs - Date.now()) > 60_000) {
  throw new Error(`uuidV7 timestamp not aligned with now: ${value}`);
}
console.log(`pass: uuidV7 — valid UUID v7 (${value})`);

// 4) 어댑터 에러 경로 — 잘못된 gzip 스트림은 command.invalid_args 로 거부된다.
let invalidArgsError: unknown;
try {
  await gzipDecompress({ data: Array.from(encoder.encode('definitely not a gzip stream')) });
} catch (error) {
  invalidArgsError = error;
}
if (!(invalidArgsError instanceof RustraCommandError)) {
  throw new Error('expected RustraCommandError for an invalid gzip stream');
}
if (invalidArgsError.code !== 'command.invalid_args') {
  throw new Error(`expected command.invalid_args, got ${invalidArgsError.code}`);
}
console.log('pass: invalid gzip stream — command.invalid_args via the adapter');

console.log('react native injected module (rn-experiment): 4 checks passed');
