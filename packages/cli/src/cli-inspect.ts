/**
 * Inspector (B2) — `rustra inspect <file>` 커맨드.
 *
 * B1 스냅샷(`rustra_ffi_capture_snapshot` blob — UTF-8 JSON) 덤프 파일을 읽어
 * 사람이 읽는 필드 트리로 렌더한다. 입력은 (a) hex 텍스트(0x 접두·공백 허용)나
 * (b) raw 바이트 — 정확한 짝수 길이 16진수 텍스트면 hex, 아니면 raw 로 취급하는
 * 자동 판별. 모호한 입력은 raw 쪽으로 넘기고 raw 해석의 JSON 파싱이 실패하면
 * 그 이유를 그대로 크게 보고한다.
 *
 * 실패는 loud 계약: 잘린 JSON·모양 불일치는 parseSnapshot 의 메시지(위치·필드
 * 경로 포함)를 접거나 바꾸지 않고 `inspect: <path>: <underlying>` 접두로
 * 재보고한다. 파일 읽기 실패(ENOENT 등)도 같은 접두로 이유를 보존한다.
 *
 * # experimental
 *
 * `DumpedWire` 자체가 experimental 이므로 이 커맨드 출력도 experimental 이다
 * (docs/versioning-policy.md 실험 표면 표 참조).
 */

import { readFile } from 'node:fs/promises';
import { parseCliArgs } from './cli-arg-parser.js';
import { parseSnapshot, type DumpedWire } from '@rustra/types';

/**
 * 정규화된 문자열이 정확한 hex 텍스트인지 — 비어 있거나 홀수 길이면 hex 가
 * 아니다(1바이트는 2자리). raw JSON 은 이 판정기를 통과하지 못한다({, ", [ 등).
 */
function isHexText(normalized: string): boolean {
  if (normalized.length === 0 || normalized.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(normalized);
}

/** hex 텍스트를 바이트로 만든다 — 판정기를 통과한 입력만 들어온다. */
function hexToBytes(compact: string): Uint8Array {
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 0x 접두·주석·공백을 제거하는 공통 정규화 — 판정과 디코드가 같은 형태를 본다.
 * `#` 로 시작하는 주석 줄은 저장소의 표준 덤프 아티팩트 형식
 * (crates/rustra/tests/fixtures/inspector-golden.hex.txt 헤더 관례)이므로
 * 벗겨낸다 — rustra inspect 가 그 아티팩트를 그대로 소비할 수 있어야 한다.
 */
function normalizeHexText(text: string): string {
  const withoutComments = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  return withoutComments.replace(/^0x/i, '').replace(/\s+/g, '');
}

/**
 * 덤프 파일 내용을 스냅샷 바이트로 판별한다. hex 텍스트로 정확히 해석되면
 * hex 디코드, 아니면 원문 바이트(raw)를 그대로 돌려준다.
 */
export function decodeDump(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('utf8');
  const normalized = normalizeHexText(text);
  if (isHexText(normalized)) return hexToBytes(normalized);
  return bytes;
}

/**
 * [`parseSnapshot`] 결과를 결정적 필드 트리 텍스트로 렌더한다.
 * 섹션 순서 고정(헤더 3필드 → Commands → Limits → Stats), 라벨 열은 헤더
 * 필드명 최대 길이에 맞춰 정렬한다. null 은 `-`, 빈 목록은 `(none)` 으로 표기.
 */
export function formatInspectText(dumped: DumpedWire): string {
  const headerWidth = Math.max(
    'packageId'.length,
    'contractHash'.length,
    'schemaGeneration'.length,
  );
  // 라벨에 콜론을 붙여 헤더 필드명 최대 길이(+콜론)에 맞춘 뒤 값 열을 정렬한다.
  const pad = (label: string): string => `${label}:`.padEnd(headerWidth + 1);
  const identity = (value: string | null): string => value ?? '-';

  const lines = [
    `${pad('packageId')} ${identity(dumped.packageId)}`,
    `${pad('contractHash')} ${identity(dumped.contractHash)}`,
    `${pad('schemaGeneration')} ${dumped.schemaGeneration === null ? '-' : String(dumped.schemaGeneration)}`,
    '',
    `Commands (${dumped.commands.length}):`,
    ...dumped.commands.flatMap((command) => [
      `  - id: ${command.id}`,
      `    name: ${command.name}`,
      `    capability: ${command.capability ?? '-'}`,
    ]),
    '',
    'Limits:',
    `  maxPayloadBytes: ${dumped.limits.maxPayloadBytes}`,
    '',
    'Stats:',
    `  registeredCommands: ${dumped.stats.registeredCommands}`,
    `  grantedCapabilities: ${dumped.stats.grantedCapabilities.length > 0 ? dumped.stats.grantedCapabilities.join(', ') : '(none)'}`,
    `  pendingEvents: ${dumped.stats.pendingEvents}`,
    `  droppedEvents: ${dumped.stats.droppedEvents}`,
  ];
  return lines.join('\n');
}

/**
 * `rustra inspect <file>` 진입점 — 덤프 파일 하나를 받아 필드 트리를
 * stdout 으로 렌더한다. 실패는 `inspect: <path>: <underlying>` 형태로 크게
 * 던진다(기존 커맨드 관례대로 main 이 stderr + exit code 로 마무리).
 */
export async function runInspect(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    command: 'inspect',
    valueFlags: [],
    booleanFlags: ['help', 'h'],
    allowPositionals: true,
  });
  if (parsed.flags.has('help') || parsed.flags.has('h')) {
    console.log(
      'Usage: rustra inspect <file>\n\nOptions:\n  --help, -h       Show this help message',
    );
    return;
  }
  const files = parsed.positionals;
  if (files.length !== 1)
    throw new Error('Provide one snapshot dump file. Usage: rustra inspect dump.hex');
  const path = files[0]!;
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new Error(`inspect: ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  // parseSnapshot 의 위치·필드 경로 메시지를 접지 않고 경로 접두만 얹는다(loud 계약).
  let dumped: DumpedWire;
  try {
    dumped = parseSnapshot(decodeDump(raw));
  } catch (error) {
    throw new Error(`inspect: ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  console.log(formatInspectText(dumped));
}
