/**
 * Inspector (B1) — Rust `rustra_ffi_capture_snapshot` 이 노출하는 표준 덤프
 * 스냅샷의 타입과 파서.
 *
 * # experimental
 *
 * 이 모듈과 `DumpedWire` 형태는 **experimental** 이다
 * (docs/versioning-policy.md 실험 표면 표 참조) — 필드 추가는 하위호환으로
 * 취급되지만, 형태 변경은 예고 없이 깨질 수 있다.
 *
 * 스냅샷 blob 은 JSON(UTF-8)이므로 "디코더"는 엄격한 JSON 검증으로 귀결된다:
 * 잘린 바이트·깨진 UTF-8·모양이 다른 문서를 조용히 받아들이지 않고, 위치와
 * 기대값을 밝히는 에러로 크게 실패한다(loud). 와이어 프레임(postcard)이
 * 스냅샷 자체에 포함되지는 않으므로 복잡 코덱 디코더의 재사용은 불필요하고,
 * 필요하면 B2 wire 뷰어(`rustra inspect`)가 그쪽 조립을 담당한다.
 */

import { RustraCommandError } from './errors.js';
import { decodeUtf8, encodeUtf8 } from './utf8.js';

/** `DumpedWire.limits` — 현재는 페이로드 크기 한도 하나다(존재하는 개념만 노출). */
export type DumpedWireLimits = {
  /** `rustra_ffi_get_max_payload` 과 동일 값(바이트). */
  maxPayloadBytes: number;
};

/** `DumpedWire.commands` 항목 — 레지스트리 명령의 덤프 표현. */
export type DumpedWireCommand = {
  /** command_id (u16, wire 디스패치에 쓰이는 것과 같은 값). */
  id: number;
  /** 명령 이름. */
  name: string;
  /** `required_capability` — 요구가 없으면 null. */
  capability: string | null;
};

/** `DumpedWire.stats` — 새 계측기 없이 기존 카운터만 노출한다. */
export type DumpedWireStats = {
  /** 레지스트리에 등록된 명령 수 (`commands.length` 와 항상 동일). */
  registeredCommands: number;
  /** 부여된 capability 이름 목록 (deny-by-default 해제 집합). */
  grantedCapabilities: string[];
  /** 이벤트 버스에 대기 중인 이벤트 수. */
  pendingEvents: number;
  /** 버스 용량 초과로 버려진 이벤트 누적 수. */
  droppedEvents: number;
};

/**
 * `rustra_ffi_capture_snapshot` blob (UTF-8 JSON)의 타입화된 형태.
 *
 * 미등록 패키지의 degenerate 스냅샷(`packageId`/`contractHash`/
 * `schemaGeneration` 이 null)도 이 타입으로 표현된다 — `packageId` 가
 * `null` 인지로 미등록 상태를 구분한다.
 */
export type DumpedWire = {
  /** 등록된 패키지 id — 미등록이면 null. */
  packageId: string | null;
  /** 네이티브 계약 해시(SHA-256 hex) — `rustra_ffi_contract_hash` 와 동일 값. 미등록이면 null. */
  contractHash: string | null;
  /** (T0) 스키마 세대 — `rustra_ffi_schema_generation` 과 동일 값. 미등록이면 null. */
  schemaGeneration: number | null;
  /** 레지스트리 명령 목록(id/name/capability). */
  commands: DumpedWireCommand[];
  /** 런타임 한도. */
  limits: DumpedWireLimits;
  /** 기존 카운터의 스냅샷. */
  stats: DumpedWireStats;
};

/** 검증 에러의 위치 정보 — 모양 불일치는 JSON 포인터 경로로 밝힌다. */
function unexpectedShape(path: string, expected: string, actual: unknown): never {
  const shown = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
  throw new RustraCommandError(
    'inspector.unexpected_shape',
    `snapshot '${path}' must be ${expected}, got ${shown}`,
  );
}

function expectString(path: string, value: unknown): string {
  if (typeof value !== 'string') unexpectedShape(path, 'a string', value);
  return value;
}

function expectFiniteNumber(path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    unexpectedShape(path, 'a finite number', value);
  }
  return value;
}

function expectArray(path: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) unexpectedShape(path, 'an array', value);
  return value;
}

function expectObject(path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    unexpectedShape(path, 'an object', value);
  }
  return value as Record<string, unknown>;
}

/**
 * UTF-8 JSON 바이트 또는 문자열 스냅샷을 [`DumpedWire`] 로 엄격하게 검증·파싱한다.
 *
 * 잘린 JSON, 깨진 UTF-8, 모양이 다른 문서(필수 필드 누락/타입 불일치)는
 * `inspector.invalid_snapshot` / `inspector.unexpected_shape` 코드의
 * [`RustraCommandError`] 로 크게 실패한다 — 덤프 도구가 조용히 빈 스냅샷을
 * 렌더하는 것을 막기 위한 계약이다.
 */
export function parseSnapshot(input: Uint8Array | string): DumpedWire {
  // decodeUtf8 은 throw 하지 않고 U+FFFD 로 대체하므로(Hermes-safe 관례) 깨진
  // UTF-8 은 JSON 파싱 단계에서 malformed 로 귀결된다 — 별도 UTF-8 검증 불필요.
  const text = typeof input === 'string' ? input : decodeUtf8(input, 0, input.length);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // JSON.parse 의 위치 정보(V8: "… in JSON at position 42")를 살린다 —
    // 위치를 알려주지 않는 엔진(Bun/JSC: "Unterminated string")은 문구만
    // 전달된다. 어느 쪽이든 조용히 통과하지는 않는다(loud 계약).
    const position = /position (\d+)/.exec(error instanceof Error ? error.message : '');
    throw new RustraCommandError(
      'inspector.invalid_snapshot',
      `invalid snapshot: truncated or malformed JSON${
        position
          ? ` at byte ${position[1]}`
          : ` (${error instanceof Error ? error.message : 'parse error'})`
      }`,
      false,
      error,
    );
  }
  return validateDocument(expectObject('package', raw));
}

/** 파싱된 문서를 DumpedWire 로 좁힌다 — 모든 필드를 검증하고 모양 불일치는 loud. */
function validateDocument(raw: Record<string, unknown>): DumpedWire {
  const commandsRaw = expectArray('commands', raw.commands);
  const commands: DumpedWireCommand[] = commandsRaw.map((item, index) => {
    const command = expectObject(`commands[${index}]`, item);
    const id = expectFiniteNumber(`commands[${index}].id`, command.id);
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
      throw new RustraCommandError(
        'inspector.unexpected_shape',
        `snapshot 'commands[${index}].id' must be a u16 integer, got ${id}`,
      );
    }
    const capability = command.capability;
    if (capability !== null && typeof capability !== 'string') {
      unexpectedShape(`commands[${index}].capability`, 'a string or null', capability);
    }
    return {
      id,
      name: expectString(`commands[${index}].name`, command.name),
      capability,
    };
  });

  const limits = expectObject('limits', raw.limits);
  const stats = expectObject('stats', raw.stats);
  const granted = expectArray('stats.grantedCapabilities', stats.grantedCapabilities);

  const generation = raw.schemaGeneration;
  if (generation !== null && typeof generation !== 'number') {
    unexpectedShape('schemaGeneration', 'a number or null', generation);
  }
  if (typeof generation === 'number' && !Number.isFinite(generation)) {
    unexpectedShape('schemaGeneration', 'a finite number', generation);
  }
  const contractHash = raw.contractHash;
  if (contractHash !== null && typeof contractHash !== 'string') {
    unexpectedShape('contractHash', 'a string or null', contractHash);
  }
  const packageId = raw.packageId;
  if (packageId !== null && typeof packageId !== 'string') {
    unexpectedShape('packageId', 'a string or null', packageId);
  }

  const dumped: DumpedWire = {
    packageId,
    contractHash,
    schemaGeneration: generation,
    commands,
    limits: {
      maxPayloadBytes: expectFiniteNumber('limits.maxPayloadBytes', limits.maxPayloadBytes),
    },
    stats: {
      registeredCommands: expectFiniteNumber('stats.registeredCommands', stats.registeredCommands),
      grantedCapabilities: granted.map((cap, index) =>
        expectString(`stats.grantedCapabilities[${index}]`, cap),
      ),
      pendingEvents: expectFiniteNumber('stats.pendingEvents', stats.pendingEvents),
      droppedEvents: expectFiniteNumber('stats.droppedEvents', stats.droppedEvents),
    },
  };
  // 정합 불변식 — 등록 명령 수는 명령 배열 길이와 항상 같다 (Rust 조립자의
  // 단일 read-lock 판독이 보장하는 것). 어긋나면 문서가 손상됐다는 뜻이다.
  if (dumped.stats.registeredCommands !== commands.length) {
    throw new RustraCommandError(
      'inspector.unexpected_shape',
      `snapshot 'stats.registeredCommands' (${dumped.stats.registeredCommands}) must equal 'commands.length' (${commands.length})`,
    );
  }
  return dumped;
}

/**
 * [`parseSnapshot`] 의 역 — 스냅샷을 UTF-8 JSON 바이트로 직렬화한다. 테스트가
 * golden hex 를 만들 때와 호스트가 덤프 파일을 쓸 때 쓴다(에러 경로 없음 —
 * 스냅샷은 직렬화 가능한 값만 담는다).
 */
export function serializeSnapshot(snapshot: DumpedWire): Uint8Array {
  return encodeUtf8(JSON.stringify(snapshot));
}
