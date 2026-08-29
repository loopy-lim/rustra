/**
 * Creates a render-stable key for command inputs.
 *
 * JSON.stringify throws for bigint values, which are a normal generated type
 * for Rust i64/u64 fields. The tagged representation also avoids conflating a
 * bigint with the same decimal string.
 */
export function inputKey(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? { $rustraBigInt: item.toString() } : item,
    ) ?? String(value)
  );
}
