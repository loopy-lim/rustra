/** Converts platform-specific path separators to the manifest wire format. */
export function toPosixPath(value: string): string {
  return value.split('\\').join('/');
}
