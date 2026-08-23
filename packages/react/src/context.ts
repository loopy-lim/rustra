import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { EngineClient, InvokeOptions } from '@rustra/types';
import { invoke } from '@rustra/types';

const RustraContext = createContext<EngineClient | null>(null);

export interface RustraProviderProps {
  engine: EngineClient;
  /** Optional to match React's createElement/conditional-composition ergonomics. */
  children?: ReactNode;
}

/**
 * Provides a scoped Rustra `EngineClient` to component subtree.
 */
export function RustraProvider({ engine, children }: RustraProviderProps): React.ReactElement {
  return React.createElement(RustraContext.Provider, { value: engine }, children);
}

/**
 * Returns the currently active `EngineClient`, either from `<RustraProvider>` or
 * a default engine invoking the global `invoke` singleton.
 */
export function useRustraEngine(): EngineClient {
  const contextEngine = useContext(RustraContext);
  return useMemo(() => {
    if (contextEngine) return contextEngine;
    return {
      invoke: <T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> =>
        invoke<T>(command, args, options),
    };
  }, [contextEngine]);
}
