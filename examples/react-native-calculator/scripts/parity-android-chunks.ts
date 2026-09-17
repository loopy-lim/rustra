/** Parse only a PID-filtered logcat capture from the dedicated benchmark app. */
export function extractAndroidReceipt(log: string): unknown | undefined {
  const pieces = new Map<number, string>();
  let runId: string | undefined;
  let total: number | undefined;
  for (const line of log.split('\n')) {
    const failure = line.indexOf('RUSTRA_PARITY_FAILED=');
    if (failure >= 0) throw new Error(line.slice(failure));
    const offset = line.indexOf('RUSTRA_PARITY_CHUNK=');
    if (offset < 0) continue;
    const chunk = JSON.parse(line.slice(offset + 'RUSTRA_PARITY_CHUNK='.length));
    if (
      !chunk ||
      typeof chunk.runId !== 'string' ||
      !chunk.runId ||
      !Number.isInteger(chunk.total) ||
      chunk.total < 1 ||
      chunk.total > 4096 ||
      !Number.isInteger(chunk.index) ||
      chunk.index < 0 ||
      chunk.index >= chunk.total ||
      typeof chunk.text !== 'string'
    )
      throw new Error('invalid Android receipt chunk');
    if (runId !== undefined && (runId !== chunk.runId || total !== chunk.total)) {
      throw new Error('mixed Android receipt chunks');
    }
    runId = chunk.runId;
    total = chunk.total;
    if (pieces.has(chunk.index) && pieces.get(chunk.index) !== chunk.text) {
      throw new Error('conflicting Android receipt chunk');
    }
    pieces.set(chunk.index, chunk.text);
  }
  if (total === undefined || pieces.size !== total) return undefined;
  const text = Array.from({ length: total }, (_, index) => pieces.get(index)!).join('');
  const receipt = JSON.parse(text);
  if (!receipt || receipt.runId !== runId) throw new Error('Android receipt identity mismatch');
  return receipt;
}
