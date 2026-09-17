export const LEGACY_CONTRACT = 'rustra-nitro-parity/v1';
export const CONTRACT = 'rustra-nitro-parity/v2';
export const DEFAULT_WIRE_LIMIT = 1024 * 1024;
// command ID (2 bytes) + postcard length (3 bytes) counts against the wire limit.
export const BUFFER_LIMIT = DEFAULT_WIRE_LIMIT - 5;
export const EXPECTED_IDS = [
  'add',
  'string',
  'pair',
  'buffer64',
  'buffer65536',
  `buffer${BUFFER_LIMIT}`,
  ...['balanced255', 'balanced1023', 'balanced8191', 'wide1025'].flatMap((shape) =>
    ['echo', 'input-dfs', 'resident-dfs', 'indexed', 'setup', 'update'].map(
      (op) => `${shape}/${op}`,
    ),
  ),
];
export const LEGACY_LANES = ['sync-internal-diagnostic', 'async-public'] as const;
export const LANES = [...LEGACY_LANES, 'sync-public'] as const;
export function lanesForContract(contract: string) {
  if (contract === CONTRACT) return LANES;
  if (contract === LEGACY_CONTRACT) return LEGACY_LANES;
  throw new Error('unsupported experiment contract');
}
export type Lane = (typeof LANES)[number];
