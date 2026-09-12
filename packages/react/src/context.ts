import React, { createContext, useContext, type ReactNode } from 'react';
import type { EngineClient, InvokeOptions } from '@rustra/types';
import { getEngineRegistrationToken, invoke, RustraCommandError } from '@rustra/types';

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

let defaultEngine: EngineClient | undefined;
let defaultRegistration: symbol | undefined;

/** Shared by components and Suspense retries within one global registration. */
export function getDefaultEngine(): EngineClient {
  const registration = getEngineRegistrationToken();
  if (!defaultEngine || registration !== defaultRegistration) {
    defaultRegistration = registration;
    defaultEngine = {
      invoke: <T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> => {
        if (registration !== getEngineRegistrationToken()) {
          return Promise.reject(
            new RustraCommandError(
              'transport.unavailable',
              'The global engine was replaced; render with the current engine before invoking',
            ),
          );
        }
        return invoke<T>(command, args, options);
      },
    };
  }
  return defaultEngine;
}

/**
 * Returns the currently active `EngineClient`, either from `<RustraProvider>` or
 * a default engine invoking the global `invoke` singleton.
 */
export function useRustraEngine(): EngineClient {
  return useContext(RustraContext) ?? getDefaultEngine();
}
