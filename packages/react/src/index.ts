/**
 * @rustra/react — React and React Native hooks for rustra-bridge.
 *
 * Provides declarative data fetching (`useCommand`), mutations (`useMutation`),
 * event subscriptions (`useEvent`), and scoped engine context (`RustraProvider`).
 *
 * @example
 * ```tsx
 * import { RustraProvider, useCommand, useMutation } from '@rustra/react';
 * import { getItem, createItem } from './generated/commands.js';
 *
 * function ItemView({ id }: { id: string }) {
 *   const { data, loading, error, refetch } = useCommand(getItem, { id });
 *   const { mutate, loading: creating } = useMutation(createItem, {
 *     onSuccess: () => refetch(),
 *   });
 *
 *   if (loading) return <div>Loading...</div>;
 *   return <div>{data?.item?.name}</div>;
 * }
 * ```
 */

export { RustraProvider, useRustraEngine } from './context.js';
export type { RustraProviderProps } from './context.js';

export { useCommand } from './useCommand.js';
export type {
  UseCommandOptions,
  UseCommandResult,
  CommandFn,
  VoidCommandFn,
} from './useCommand.js';

export { useMutation } from './useMutation.js';
export type { UseMutationOptions, UseMutationResult } from './useMutation.js';

export { useEvent } from './useEvent.js';
export type { EventCallback, UnsubscribeFn, SubscribeResult, SubscribeFn } from './useEvent.js';
