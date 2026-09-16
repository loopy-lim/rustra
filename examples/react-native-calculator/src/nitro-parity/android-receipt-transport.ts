/** Pace only finalized receipt delivery; timing and receipt data are already complete. */
export async function emitAndroidReceiptChunks(
  json: string,
  runId: string,
  emit: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const chunks = Math.ceil(json.length / 2000);
  for (let index = 0; index < chunks; index++) {
    emit(
      `RUSTRA_PARITY_CHUNK=${JSON.stringify({ runId, index, total: chunks, text: json.slice(index * 2000, (index + 1) * 2000) })}`,
    );
    await sleep(10);
  }
}
