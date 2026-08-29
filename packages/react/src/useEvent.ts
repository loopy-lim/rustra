import { useEffect, useRef } from 'react';

export type EventCallback<T = unknown> = (payload: T) => void;
export type UnsubscribeFn = () => void;
export type SubscribeResult = UnsubscribeFn | Promise<UnsubscribeFn>;
export type SubscribeFn<T = unknown> = (
  eventName: string,
  callback: EventCallback<T>,
) => SubscribeResult;

/**
 * Subscribes to a Rustra event stream and automatically unregisters on unmount.
 *
 * @param eventName Name of the event to listen to (e.g. "progress.tick")
 * @param callback Handler called whenever the event fires
 * @param subscribe Optional subscription function (e.g., from `@rustra/react-native` `subscribeEvent`)
 */
export function useEvent<T = unknown>(
  eventName: string,
  callback: EventCallback<T>,
  subscribe?: SubscribeFn<T>,
): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!subscribe) return;
    let active = true;
    let unsubscribe: UnsubscribeFn | undefined;
    let result: SubscribeResult;
    try {
      result = subscribe(eventName, (payload) => {
        callbackRef.current(payload);
      });
    } catch (error) {
      console.error(`Rustra: event subscription for "${eventName}" failed:`, error);
      return () => {
        active = false;
      };
    }
    Promise.resolve(result).then(
      (cleanup) => {
        if (active) unsubscribe = cleanup;
        else cleanup();
      },
      (error) => {
        if (active) {
          console.error(`Rustra: event subscription for "${eventName}" failed:`, error);
        }
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [eventName, subscribe]);
}
