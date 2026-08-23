import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { configure } from '@rustra/types';
import { createAsyncEngine, createFastEngine } from '../../packages/react-native/src';
import { benchEchoBytes } from '../calculator/generated/commands';
import { rkyvV2Registry } from '../calculator/generated/rkyv-registry';
import { getRustraNative, installRustraJSI } from 'rustra-jsi';

const LOG_PREFIX = '[RustraReloadStress]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/**
 * Development-only runtime reload probe.
 *
 * Each JS runtime installs JSI, proves a sync positional command, then leaves a
 * native async command in flight. The external stress runner reloads Metro as
 * soon as READY appears. A stale callback touching the old runtime would crash
 * the app; successful re-installation produces a new READY token instead.
 */
export default function ReloadStressApp() {
  const [status, setStatus] = useState('Installing JSI…');

  useEffect(() => {
    const token = String(Date.now());
    let active = true;

    async function run(): Promise<void> {
      try {
        await installRustraJSI();
        const native = getRustraNative();
        if (typeof native.invokeTypedPos !== 'function') {
          throw new Error('invokeTypedPos is unavailable');
        }

        const syncResult = native.invokeTypedPos(1, 42, 58) as { value?: unknown };
        if (syncResult?.value !== 100) {
          throw new Error(`sync probe returned ${JSON.stringify(syncResult)}`);
        }

        // Keep one Rust-owned external ArrayBuffer reachable from the old
        // Runtime until reload destroys it. Its finalizer must free the exact
        // Rust allocation without retaining or touching the superseded JSI
        // Runtime. Debug allocator guards turn a double/wrong free into a loud
        // process failure instead of allowing silent corruption.
        configure(createFastEngine(native, { rkyvV2Codecs: rkyvV2Registry }));
        const byteInput = new Uint8Array(64 * 1024);
        byteInput[0] = 17;
        byteInput[byteInput.length - 1] = 239;
        const byteResult = await benchEchoBytes({ data: byteInput });
        if (!(byteResult.data instanceof ArrayBuffer)) {
          throw new Error('direct byte probe did not return an ArrayBuffer');
        }
        const byteOutput = new Uint8Array(byteResult.data);
        if (
          byteOutput.length !== byteInput.length ||
          byteOutput[0] !== 17 ||
          byteOutput[byteOutput.length - 1] !== 239
        ) {
          throw new Error('direct byte probe returned different bytes');
        }
        (
          globalThis as typeof globalThis & { __rustraReloadOwnedBuffer?: ArrayBuffer }
        ).__rustraReloadOwnedBuffer = byteResult.data;
        log(`BUFFER_READY token=${token} bytes=${byteOutput.length}`);

        const engine = createAsyncEngine(native, { rkyvV2Codecs: rkyvV2Registry });
        configure(engine);
        if (active) setStatus(`READY ${token}`);
        log(`READY token=${token} value=100`);

        // Keep native work pending long enough for the external runner to
        // replace this Runtime. The C++ generation guard must discard the old
        // JS callbacks after module invalidation/re-installation.
        log(`PENDING token=${token}`);
        void engine
          .invoke<{ emitted: number }>('emitDemo', { ticks: 6_000, stepDelayMs: 10 })
          .then((result) => log(`ASYNC_COMPLETED token=${token} emitted=${result.emitted}`))
          .catch((error: unknown) =>
            log(
              `ASYNC_REJECTED token=${token} message=${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (active) setStatus(`FAILED ${message}`);
        console.error(`${LOG_PREFIX} FAILED token=${token} message=${message}`);
      }
    }

    void run();
    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rustra reload stress</Text>
      <Text selectable style={styles.status} testID="reload-stress-status">
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#111827',
    flex: 1,
    gap: 16,
    justifyContent: 'center',
    padding: 24,
  },
  status: {
    color: '#93c5fd',
    fontFamily: 'Courier',
    fontSize: 14,
    textAlign: 'center',
  },
  title: {
    color: '#f9fafb',
    fontSize: 24,
    fontWeight: '700',
  },
});
