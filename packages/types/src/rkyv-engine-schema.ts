import {
  parseLiveSchemaDocument,
  type LiveSchemaEntry,
  type RkyvV2SchemaNative,
} from './live-schema.js';
import type { RkyvSchemaRuntime } from './rkyv-engine-context.js';

export function createRkyvSchemaRuntime(native: RkyvV2SchemaNative): RkyvSchemaRuntime {
  let liveSchemaCache: Map<string, LiveSchemaEntry> | undefined;
  const readLiveSchemaDocument = () => {
    const document = parseLiveSchemaDocument(native);
    liveSchemaCache = document.commands;
    return document;
  };
  const refreshLiveSchema = (): Map<string, LiveSchemaEntry> => {
    return readLiveSchemaDocument().commands;
  };
  const lookupCachedLiveSchemaEntry = (command: string): LiveSchemaEntry | undefined => {
    const cached = liveSchemaCache?.get(command);
    if (cached) return cached;
    try {
      return refreshLiveSchema().get(command);
    } catch {
      return undefined;
    }
  };
  return { refreshLiveSchema, readLiveSchemaDocument, lookupCachedLiveSchemaEntry };
}
