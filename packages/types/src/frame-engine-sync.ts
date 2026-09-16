import { parseRustraErrorString, RustraCommandError } from './errors.js';
import type { FrameEngineContext } from './frame-engine-context.js';

const unavailable = (detail: string) => new RustraCommandError('sync.unavailable', detail);

/** The host factory owns atomic validation+dispatch; a JS probe cannot prevent
 * concurrent hot-core replacement. Only native hosts providing that contract
 * expose this seam. Frozen package state and current core identity are separate. */
export function createSyncBindingResolver(
  context: FrameEngineContext,
  expectedHash: string | undefined,
): (command: string) => (input: unknown) => unknown {
  const { native, registry } = context;
  return (command) => {
    const codec = registry.get(command);
    if (!codec)
      throw new RustraCommandError('command.not_found', `No generated codec for "${command}".`);
    if (codec.execution !== 'sync')
      throw unavailable(`Command "${command}" is not declared synchronous.`);
    if (!expectedHash || !native.bindSyncCommand) {
      throw unavailable(
        'Sync binding requires an atomic native binding host and a generated contract hash.',
      );
    }
    const normalize = (error: unknown): never => {
      if (error instanceof RustraCommandError) throw error;
      throw parseRustraErrorString(error instanceof Error ? error.message : String(error));
    };
    const keys = codec.syncFields;
    const byteKey = codec.syncByteField;
    const route =
      byteKey !== undefined ? 4 : keys && keys.length >= 1 && keys.length <= 3 ? keys.length : 0;
    let bound: ReturnType<NonNullable<typeof native.bindSyncCommand>>;
    try {
      bound = native.bindSyncCommand(codec.commandId, command, expectedHash, route);
    } catch (error) {
      return normalize(error);
    }
    if (byteKey !== undefined) {
      return (input) => {
        try {
          return bound(input, (input as Record<string, unknown>)[byteKey]);
        } catch (error) {
          return normalize(error);
        }
      };
    }
    if (route && keys) {
      // Choose one closure at bind time. Snapshot keys and read each getter once;
      // nested calls share no argument storage.
      const [a, b, c] = keys;
      if (route === 1)
        return (input) => {
          try {
            return bound(input, (input as Record<string, unknown>)[a]);
          } catch (error) {
            return normalize(error);
          }
        };
      if (route === 2)
        return (input) => {
          try {
            const object = input as Record<string, unknown>;
            return bound(input, object[a], object[b]);
          } catch (error) {
            return normalize(error);
          }
        };
      return (input) => {
        try {
          const object = input as Record<string, unknown>;
          return bound(input, object[a], object[b], object[c]);
        } catch (error) {
          return normalize(error);
        }
      };
    }
    return (input) => {
      try {
        return bound(input);
      } catch (error) {
        return normalize(error);
      }
    };
  };
}
