import {
  configureLazy,
  disposedBootstrapError,
  ensureConfigured,
  RustraCommandError,
  type BootstrapState,
  type FrameEngine,
} from '@rustra/types';
import { createBunFfiEngine } from './bun-ffi.js';
import type { BunFfiEngineOptions, BunFfiRuntime } from './bun-ffi-library.js';
import { createBunEventSubscription, type BunEventSubscription } from './bun-event-subscription.js';

export type BunBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 공용 `BootstrapState`(@rustra/types).
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: BootstrapState;
  ready(): Promise<FrameEngine>;
  /** Subscribe synchronously on the library selected by this bootstrap. */
  subscribeEvent(name: string, callback: (payload: never) => void): () => void;
  dispose(): void;
  /**
   * Dev-loop reload hook target (Task A1). Empirically (macOS, Bun 1.4.0),
   * `bun:ffi` dlopen caches the library image per process: re-dlopen of a
   * REPLACED file at the same path returns the OLD bytes while any handle of
   * that image has ever been opened in the process — only close-then-reopen
   * picks up new bytes, and even then only when no other handle is alive.
   * Consequence: reload() re-runs engine init (fresh state over the resolved
   * library) and WARNS that a rebuilt binary applies on the next process start
   * unless every previous handle was closed first. Contract is the warning +
   * state reset, not a true image swap — see docs/compatibility-matrix.md.
   */
  reload(): Promise<void>;
};

export function createBunBootstrap(options: BunFfiEngineOptions): BunBootstrap {
  let runtime: BunFfiRuntime | undefined;
  let state: BootstrapState = 'initializing';
  let reloadPromise: Promise<void> | undefined;
  let events: BunEventSubscription | undefined;
  let eventFailure: unknown;
  const subscriptions = new Set<{
    name: string;
    callback: (payload: never) => void;
    unsubscribe?: () => void;
  }>();
  const closeEvents = () => {
    events?.dispose();
    events = undefined;
    for (const entry of subscriptions) entry.unsubscribe = undefined;
  };
  const attachEvents = (created: BunFfiRuntime) => {
    if (subscriptions.size === 0) return;
    events ??= createBunEventSubscription({ library: created.library });
    for (const entry of subscriptions) {
      if (!entry.unsubscribe) entry.unsubscribe = events.subscribeEvent(entry.name, entry.callback);
    }
  };
  const assertActive = () => {
    if (state === 'disposed') throw disposedBootstrapError('Bun');
    if (!registration.isCurrent())
      throw new RustraCommandError(
        'transport.unavailable',
        'Bun bootstrap registration was replaced',
      );
  };
  const bootstrap = async (): Promise<FrameEngine> => {
    assertActive();
    const created = await createBunFfiEngine(options);
    try {
      assertActive();
      runtime = created;
      attachEvents(created);
      eventFailure = undefined;
      state = 'ready';
      return created.engine;
    } catch (error) {
      closeEvents();
      created.close();
      throw error;
    }
  };
  let registration = configureLazy(bootstrap, { ownerId: 'bun' });
  const ready = async (): Promise<FrameEngine> => {
    assertActive();
    const requestedRegistration = registration;
    try {
      const engine = (await ensureConfigured()) as FrameEngine;
      assertActive();
      if (requestedRegistration !== registration)
        throw new RustraCommandError(
          'transport.unavailable',
          'Bun readiness was superseded by reload; call ready() again',
        );
      state = 'ready';
      return engine;
    } catch (error) {
      if (!registration.isCurrent()) {
        closeEvents();
        runtime?.close();
        runtime = undefined;
      }
      throw error;
    }
  };
  return {
    get state() {
      return state;
    },
    ready,
    subscribeEvent(name, callback) {
      assertActive();
      if (eventFailure) throw eventFailure;
      const entry = { name, callback, unsubscribe: undefined as (() => void) | undefined };
      subscriptions.add(entry);
      if (runtime && state === 'ready') attachEvents(runtime);
      else
        void ready().catch((error: unknown) => {
          eventFailure = error;
        });
      return () => {
        if (!subscriptions.delete(entry)) return;
        entry.unsubscribe?.();
      };
    },
    dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      registration();
      closeEvents();
      runtime?.close();
      runtime = undefined;
      subscriptions.clear();
    },
    reload() {
      if (state === 'disposed') return Promise.reject(disposedBootstrapError('Bun'));
      if (reloadPromise) return reloadPromise;
      const operation = async () => {
        assertActive();
        if (state !== 'ready') await ready();
        assertActive();
        state = 'initializing';
        closeEvents();
        runtime?.close();
        runtime = undefined;
        registration = configureLazy(bootstrap, { ownerId: 'bun' });
        await ready();
        console.warn(
          '[bun] engine re-initialized. bun:ffi caches the library image: a rebuilt ' +
            'cdylib applies on the next process start (reload cannot swap bytes in-process).',
        );
      };
      reloadPromise = operation().finally(() => {
        reloadPromise = undefined;
      });
      return reloadPromise;
    },
  };
}
